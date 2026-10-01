import { Op } from 'sequelize';
import { sequelize } from '../../db/connection.js';
import {
  AbsenceHold,
  Attendance,
  CreditWithdrawal,
  Event,
  EventSettlement,
  OrganizerCreditEntry,
  SettlementLine,
  User,
} from '../../db/index.js';
import { AppError } from '../utils/appError.js';
import { evaluateTier, lostDisputeSince, PAYABLE_ATTENDANCE, payAfterOverdueAt } from './funding-policy.js';
import { notifySafely } from './settlement.service.js';

export const MIN_WITHDRAWAL_CENTS = 100;

export class OrganizerCreditService {
  static async balance(organizerId, { transaction } = {}) {
    const total = await OrganizerCreditEntry.sum('amountCents', { where: { organizerId }, transaction });
    return Number(total || 0);
  }

  // Serializes credit spending for one organization. Additions do not need the lock because they
  // can only raise the balance; every debit takes it before checking the balance.
  static async lockOrganizer(organizerId, transaction) {
    const organizer = await User.findByPk(organizerId, { transaction, lock: transaction.LOCK.UPDATE, paranoid: false });
    if (!organizer) throw new AppError('Organization not found', 404);
    return organizer;
  }

  // Idempotent by reference: a repeated callback or request cannot credit or debit twice.
  static async addEntry({ organizerId, amountCents, type, reference, eventId = null, fundingId = null, withdrawalId = null, note = null, createdBy = null }, { transaction } = {}) {
    if (!Number.isSafeInteger(amountCents) || amountCents === 0) return { entry: null, created: false };
    const [entry, created] = await OrganizerCreditEntry.findOrCreate({
      where: { reference },
      defaults: { organizerId, amountCents, type, eventId, fundingId, withdrawalId, note, createdBy },
      transaction,
    });
    return { entry, created };
  }

  static async listEntries(organizerId, { limit = 50 } = {}) {
    return OrganizerCreditEntry.findAll({
      where: { organizerId },
      order: [['createdAt', 'DESC']],
      limit,
    });
  }

  static async requestWithdrawal({ organizerId, amountCents, requestedBy }) {
    if (!Number.isSafeInteger(amountCents) || amountCents < MIN_WITHDRAWAL_CENTS) {
      throw new AppError(`Withdrawals must be at least ${MIN_WITHDRAWAL_CENTS / 100} EGP`, 400);
    }
    const withdrawal = await sequelize.transaction(async (transaction) => {
      await this.lockOrganizer(organizerId, transaction);
      const pending = await CreditWithdrawal.count({ where: { organizerId, status: 'pending' }, transaction });
      if (pending) throw new AppError('A withdrawal request is already waiting for review', 409);
      const balance = await this.balance(organizerId, { transaction });
      if (amountCents > balance) throw new AppError('The withdrawal is larger than your available credit', 409);
      const created = await CreditWithdrawal.create({ organizerId, amountCents, requestedBy }, { transaction });
      await this.addEntry({
        organizerId, amountCents: -amountCents, type: 'withdrawal',
        reference: `withdrawal:${created.id}`, withdrawalId: created.id, createdBy: requestedBy,
      }, { transaction });
      return created;
    });
    const admins = await User.findAll({ where: { role: 'admin' }, attributes: ['id'] });
    await Promise.all(admins.map((admin) => notifySafely({
      userId: admin.id,
      title: 'Credit withdrawal requested',
      message: `An organization asked to withdraw ${amountCents / 100} EGP of credit.`,
      type: 'info',
      link: '/admin/payments',
    })));
    return withdrawal;
  }

  // Cancelling (by the organization) or rejecting (by an admin) returns the reserved credit.
  static async closeWithdrawal({ withdrawalId, organizerId = null, status, actorId, adminNote = null, payoutReference = null }) {
    if (!['paid', 'rejected', 'cancelled'].includes(status)) throw new AppError('Invalid withdrawal decision', 400);
    const withdrawal = await sequelize.transaction(async (transaction) => {
      const locked = await CreditWithdrawal.findOne({
        where: { id: withdrawalId, ...(organizerId ? { organizerId } : {}) },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!locked) throw new AppError('Withdrawal request not found', 404);
      if (locked.status !== 'pending') throw new AppError('This withdrawal request has already been resolved', 409);
      await locked.update({
        status, resolvedBy: actorId, resolvedAt: new Date(),
        adminNote: adminNote || null, payoutReference: payoutReference || null,
      }, { transaction });
      if (status !== 'paid') {
        await this.addEntry({
          organizerId: locked.organizerId, amountCents: locked.amountCents, type: 'withdrawal_reversal',
          reference: `withdrawal-reversal:${locked.id}`, withdrawalId: locked.id, createdBy: actorId,
          note: adminNote || null,
        }, { transaction });
      }
      return locked;
    });
    if (status !== 'cancelled') {
      await notifySafely({
        userId: withdrawal.organizerId,
        title: status === 'paid' ? 'Credit withdrawal paid' : 'Credit withdrawal rejected',
        message: status === 'paid'
          ? `Your ${withdrawal.amountCents / 100} EGP credit withdrawal was paid${payoutReference ? ` (reference ${payoutReference})` : ''}.`
          : `Your ${withdrawal.amountCents / 100} EGP credit withdrawal was rejected and the amount is back in your credit.${adminNote ? ` ${adminNote}` : ''}`,
        type: status === 'paid' ? 'success' : 'warning',
        link: '/provider/payments',
      });
    }
    return withdrawal;
  }

  // Events whose payments were completed: released prefunded events and pay-after events with a
  // paid checkout.
  static async paidEventsCount(organizerId) {
    const [released, paidSettlements] = await Promise.all([
      Event.findAll({ where: { organizerId, status: 'completed', fundsReleasedAt: { [Op.ne]: null } }, attributes: ['id'] }),
      EventSettlement.findAll({
        where: { organizerId, fundingSource: 'checkout', collectionStatus: 'paid' },
        attributes: ['eventId'],
      }),
    ]);
    return new Set([...released.map((event) => event.id), ...paidSettlements.map((item) => item.eventId)]).size;
  }

  // Pay-after events that ended long enough ago and still have a present usher without a paid line.
  static async overduePayAfterEvents(organizerId, now = new Date()) {
    const candidates = (await Event.findAll({
      where: { organizerId, status: 'completed', fundingMode: 'pay_after' },
      attributes: ['id', 'title', 'eventDate', 'startTime', 'endTime', 'hiredTalents'],
    })).filter((event) => {
      const overdueAt = payAfterOverdueAt(event);
      return overdueAt && now >= overdueAt;
    });
    if (!candidates.length) return [];
    const eventIds = candidates.map((event) => event.id);
    const [attendance, paidSettlements] = await Promise.all([
      Attendance.findAll({ where: { eventId: { [Op.in]: eventIds }, status: { [Op.in]: PAYABLE_ATTENDANCE } }, attributes: ['eventId', 'talentId'] }),
      EventSettlement.findAll({ where: { eventId: { [Op.in]: eventIds }, collectionStatus: 'paid' }, attributes: ['id'] }),
    ]);
    const paidLines = paidSettlements.length
      ? await SettlementLine.findAll({ where: { settlementId: { [Op.in]: paidSettlements.map((item) => item.id) } }, attributes: ['eventId', 'talentId'] })
      : [];
    const paidKeys = new Set(paidLines.map((line) => `${line.eventId}:${line.talentId}`));
    const hiredByEvent = new Map(candidates.map((event) => [event.id, new Set(event.hiredTalents || [])]));
    const overdueIds = new Set(attendance
      .filter((record) => hiredByEvent.get(record.eventId)?.has(record.talentId))
      .filter((record) => !paidKeys.has(`${record.eventId}:${record.talentId}`))
      .map((record) => record.eventId));
    return candidates.filter((event) => overdueIds.has(event.id));
  }

  static async evaluateOrganizerTier(organizerId) {
    const organizer = await User.findByPk(organizerId, { attributes: ['id', 'paymentTierOverride'], paranoid: false });
    if (!organizer) throw new AppError('Organization not found', 404);
    const [paidEventsCount, overdueEvents, lostDisputesCount, creditBalanceCents] = await Promise.all([
      this.paidEventsCount(organizerId),
      this.overduePayAfterEvents(organizerId),
      AbsenceHold.count({ where: { organizerId, resolution: 'admin_usher', resolvedAt: { [Op.gte]: lostDisputeSince() } } }),
      this.balance(organizerId),
    ]);
    return {
      ...evaluateTier({
        override: organizer.paymentTierOverride,
        paidEventsCount,
        overdueEventsCount: overdueEvents.length,
        lostDisputesCount,
        creditBalanceCents,
      }),
      overdueEvents: overdueEvents.map((event) => ({ _id: event.id, id: event.id, title: event.title })),
    };
  }
}
