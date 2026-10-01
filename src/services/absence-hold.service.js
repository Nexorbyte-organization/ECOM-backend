import { Op } from 'sequelize';
import { sequelize } from '../../db/connection.js';
import { AbsenceHold, Attendance, Event, EventSettlement, SettlementLine, User } from '../../db/index.js';
import { AppError } from '../utils/appError.js';
import { OrganizerCreditService } from './organizer-credit.service.js';
import { resolvePayoutMethod } from './payout-method.service.js';
import { notifySafely, processAutomaticPayouts, splitPlatformFee } from './settlement.service.js';

const MAX_DISPUTE_REASON_LENGTH = 1000;
const ACTIVE_HOLD_STATUSES = ['held', 'disputed'];

// Settlement line values for a prefunded payment. Ushers without a supported payout account keep
// their pay held (awaiting_method) instead of being paid in cash by the organization.
export const prefundedLineValues = ({ talent, amounts, settlementId, eventId, lineType, attendanceStatus = null }) => {
  const payout = resolvePayoutMethod(talent?.paymentMethods || [], talent?.fullName || '');
  const digital = payout.type !== 'cash';
  return {
    settlementId,
    eventId,
    talentId: talent.id,
    lineType,
    attendanceStatus,
    grossAmountCents: amounts.grossAmountCents,
    collectionAmountCents: amounts.grossAmountCents,
    platformFeeCents: amounts.platformFeeCents,
    usherAmountCents: amounts.usherAmountCents,
    payoutMethodType: digital ? payout.type : 'cash',
    payoutProvider: digital ? payout.provider : null,
    payoutDestination: digital ? payout.destination : null,
    payoutMetadata: digital ? payout.metadata : null,
    payoutStatus: digital ? 'queued' : 'awaiting_method',
    failureReason: digital ? null : 'Waiting for the usher to add a supported payout account',
  };
};

export const settlementTotals = (lines) => lines.reduce((totals, line) => ({
  grossAmountCents: totals.grossAmountCents + line.grossAmountCents,
  collectionAmountCents: totals.collectionAmountCents + line.collectionAmountCents,
  platformFeeCents: totals.platformFeeCents + line.platformFeeCents,
  usherAmountCents: totals.usherAmountCents + line.usherAmountCents,
}), { grossAmountCents: 0, collectionAmountCents: 0, platformFeeCents: 0, usherAmountCents: 0 });

// A settlement paid from funds already held for the event, so no Paymob collection is needed.
export const createPrefundedSettlement = async ({ event, targetTalentId = null, specialReference, lineDrafts, transaction }) => {
  const settlement = await EventSettlement.create({
    eventId: event.id,
    organizerId: event.organizerId,
    targetTalentId,
    ...settlementTotals(lineDrafts.map(({ amounts }) => ({ ...amounts, collectionAmountCents: amounts.grossAmountCents }))),
    cashDueAmountCents: 0,
    collectionStatus: 'paid',
    payoutStatus: 'not_started',
    specialReference,
    fundingSource: 'prefund',
    collectedAt: new Date(),
    paymentMethod: 'Event funds held in advance',
    isLive: false,
  }, { transaction });
  await SettlementLine.bulkCreate(lineDrafts.map((draft) => prefundedLineValues({
    ...draft, settlementId: settlement.id, eventId: event.id,
  })), { transaction });
  return settlement;
};

const notifyAdmins = async (notification) => {
  const admins = await User.findAll({ where: { role: 'admin' }, attributes: ['id'] });
  await Promise.all(admins.map((admin) => notifySafely({ ...notification, userId: admin.id })));
};

export class AbsenceHoldService {
  // Returns undisputed holds whose window has closed to the organization's credit. Called lazily
  // whenever holds or credit are read, because the platform has no scheduled jobs.
  static async settleExpired({ organizerId, talentId, eventId } = {}) {
    const expired = await AbsenceHold.findAll({
      where: {
        status: 'held',
        releaseAfter: { [Op.lte]: new Date() },
        ...(organizerId ? { organizerId } : {}),
        ...(talentId ? { talentId } : {}),
        ...(eventId ? { eventId } : {}),
      },
      limit: 200,
    });
    for (const hold of expired) {
      await sequelize.transaction(async (transaction) => {
        const [claimed] = await AbsenceHold.update(
          { status: 'returned_to_organizer', resolution: 'expired', resolvedAt: new Date() },
          { where: { id: hold.id, status: 'held' }, transaction },
        );
        if (!claimed) return;
        await OrganizerCreditService.addEntry({
          organizerId: hold.organizerId, amountCents: hold.amountCents, type: 'absence_release',
          reference: `absence:${hold.id}`, eventId: hold.eventId,
        }, { transaction });
      });
    }
    return expired.length;
  }

  static async createForRelease({ event, absent, transaction, releaseAfter }) {
    if (!absent.length) return [];
    return AbsenceHold.bulkCreate(absent.map(({ talentId, amountCents }) => ({
      eventId: event.id, organizerId: event.organizerId, talentId, amountCents, releaseAfter,
    })), { transaction });
  }

  static async dispute({ holdId, talentId, reason }) {
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (!text) throw new AppError('Explain why the absent mark is wrong', 400);
    if (text.length > MAX_DISPUTE_REASON_LENGTH) throw new AppError(`Keep the explanation under ${MAX_DISPUTE_REASON_LENGTH} characters`, 400);
    const [claimed] = await AbsenceHold.update(
      { status: 'disputed', disputeReason: text, disputedAt: new Date() },
      { where: { id: holdId, talentId, status: 'held', releaseAfter: { [Op.gt]: new Date() } } },
    );
    const hold = await AbsenceHold.findOne({ where: { id: holdId, talentId } });
    if (!hold) throw new AppError('Held payment not found', 404);
    if (!claimed) {
      if (hold.status === 'disputed') throw new AppError('You have already disputed this absent mark', 409);
      if (hold.status !== 'held') throw new AppError('This held payment has already been settled', 409);
      throw new AppError('The dispute window for this event has closed', 409);
    }
    const event = await Event.findByPk(hold.eventId, { paranoid: false, attributes: ['id', 'title'] });
    const title = event?.title || 'an event';
    await notifySafely({
      userId: hold.organizerId,
      title: 'Absent mark disputed',
      message: `An usher disputed being marked absent at “${title}”. Their pay stays held until an admin reviews it. If the mark was a mistake, change their attendance to present.`,
      type: 'warning',
      link: `/provider/events/${hold.eventId}`,
    });
    await notifyAdmins({
      title: 'Attendance dispute opened',
      message: `An usher disputed an absent mark at “${title}”.`,
      type: 'warning',
      link: '/admin/payments',
    });
    return hold;
  }

  // Pays a held absence to the usher after the organization corrects the mark or an admin rules
  // for the usher. The hold is claimed atomically so the pay cannot be released twice.
  static async payToUsher({ hold, resolution, actorId = null, note = null, attendanceStatus = 'present' }) {
    const settlement = await sequelize.transaction(async (transaction) => {
      const [claimed] = await AbsenceHold.update(
        { status: 'paid_to_usher', resolution, resolvedBy: actorId, resolvedAt: new Date(), resolutionNote: note },
        { where: { id: hold.id, status: { [Op.in]: ACTIVE_HOLD_STATUSES } }, transaction },
      );
      if (!claimed) throw new AppError('This held payment has already been settled', 409);
      const event = await Event.findByPk(hold.eventId, { paranoid: false, transaction });
      const talent = await User.findByPk(hold.talentId, { paranoid: false, transaction });
      if (!event || !talent) throw new AppError('The event or usher for this held payment no longer exists', 409);
      const created = await createPrefundedSettlement({
        event,
        targetTalentId: talent.id,
        specialReference: `OO-AWARD-${hold.id}`,
        lineDrafts: [{ talent, amounts: splitPlatformFee(hold.amountCents), lineType: 'dispute_award', attendanceStatus }],
        transaction,
      });
      await AbsenceHold.update({ settlementId: created.id }, { where: { id: hold.id }, transaction });
      if (resolution === 'admin_usher') {
        await Attendance.update(
          { status: attendanceStatus, checkInMethod: 'admin' },
          { where: { eventId: hold.eventId, talentId: hold.talentId }, transaction },
        );
      }
      return created;
    });
    await processAutomaticPayouts(settlement);
    const event = await Event.findByPk(hold.eventId, { paranoid: false, attributes: ['id', 'title'] });
    const title = event?.title || 'the event';
    await notifySafely({
      userId: hold.talentId,
      title: 'Held pay released to you',
      message: resolution === 'organizer_corrected'
        ? `The organization corrected your attendance at “${title}”, so your pay is being sent.`
        : `An admin reviewed your dispute for “${title}” and released your pay.`,
      type: 'success',
      link: '/talent/events',
    });
    if (resolution === 'admin_usher') {
      await notifySafely({
        userId: hold.organizerId,
        title: 'Attendance dispute resolved for the usher',
        message: `An admin found the usher attended “${title}”, so their held pay was sent to them.${note ? ` ${note}` : ''}`,
        type: 'warning',
        link: `/provider/events/${hold.eventId}`,
      });
    }
    return settlement;
  }

  static async returnToOrganizer({ hold, actorId, note = null }) {
    await sequelize.transaction(async (transaction) => {
      const [claimed] = await AbsenceHold.update(
        { status: 'returned_to_organizer', resolution: 'admin_organizer', resolvedBy: actorId, resolvedAt: new Date(), resolutionNote: note },
        { where: { id: hold.id, status: { [Op.in]: ACTIVE_HOLD_STATUSES } }, transaction },
      );
      if (!claimed) throw new AppError('This held payment has already been settled', 409);
      await OrganizerCreditService.addEntry({
        organizerId: hold.organizerId, amountCents: hold.amountCents, type: 'absence_release',
        reference: `absence:${hold.id}`, eventId: hold.eventId, createdBy: actorId,
      }, { transaction });
    });
    const event = await Event.findByPk(hold.eventId, { paranoid: false, attributes: ['id', 'title'] });
    await notifySafely({
      userId: hold.talentId,
      title: 'Attendance dispute closed',
      message: `An admin reviewed your dispute for “${event?.title || 'the event'}” and upheld the absent mark.${note ? ` ${note}` : ''}`,
      type: 'danger',
      link: '/talent/events',
    });
  }

  static async resolveByAdmin({ holdId, decision, adminId, note }) {
    if (!['usher', 'organizer'].includes(decision)) throw new AppError('Decision must be usher or organizer', 400);
    const hold = await AbsenceHold.findByPk(holdId);
    if (!hold) throw new AppError('Held payment not found', 404);
    const cleanNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, MAX_DISPUTE_REASON_LENGTH) : null;
    if (decision === 'usher') {
      await this.payToUsher({ hold, resolution: 'admin_usher', actorId: adminId, note: cleanNote });
    } else {
      await this.returnToOrganizer({ hold, actorId: adminId, note: cleanNote });
    }
    return AbsenceHold.findByPk(holdId);
  }

  static async listWithDetails(where, { limit = 100 } = {}) {
    const holds = await AbsenceHold.findAll({ where, order: [['createdAt', 'DESC']], limit });
    const eventIds = [...new Set(holds.map((hold) => hold.eventId))];
    const userIds = [...new Set(holds.flatMap((hold) => [hold.talentId, hold.organizerId]))];
    const [events, users] = await Promise.all([
      eventIds.length ? Event.findAll({ where: { id: { [Op.in]: eventIds } }, paranoid: false, attributes: ['id', 'title', 'eventDate'] }) : [],
      userIds.length ? User.findAll({ where: { id: { [Op.in]: userIds } }, paranoid: false, attributes: ['id', 'fullName', 'portfolioPicture'] }) : [],
    ]);
    const eventsById = new Map(events.map((event) => [event.id, event]));
    const usersById = new Map(users.map((user) => [user.id, user]));
    const person = (id) => {
      const user = usersById.get(id);
      return user ? { _id: user.id, fullName: user.fullName, photo: user.portfolioPicture?.secure_url || '' } : null;
    };
    return holds.map((hold) => {
      const event = eventsById.get(hold.eventId);
      return {
        ...hold.toJSON(),
        canDispute: hold.status === 'held' && new Date(hold.releaseAfter) > new Date(),
        event: event ? { _id: event.id, title: event.title, eventDate: event.eventDate } : null,
        talent: person(hold.talentId),
        organization: person(hold.organizerId),
      };
    });
  }
}
