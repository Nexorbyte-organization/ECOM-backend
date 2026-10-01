import { Op } from 'sequelize';
import { randomUUID } from 'crypto';
import { sequelize } from '../../db/connection.js';
import {
  AbsenceHold, Attendance, Event, EventFunding, EventSettlement, OrganizerCreditEntry, SettlementLine, User,
} from '../../db/index.js';
import { AppError } from '../utils/appError.js';
import { decryptCardToken } from './card-token.service.js';
import { createFundingIntention, inquireOrderTransaction } from './paymob.service.js';
import { isPayoutSandboxConfigured } from './paymob-payout.service.js';
import { resolvePayoutMethod } from './payout-method.service.js';
import { OrganizerCreditService } from './organizer-credit.service.js';
import { AbsenceHoldService, createPrefundedSettlement } from './absence-hold.service.js';
import {
  CANCELLATION_TIERS,
  DISPUTE_WINDOW_HOURS,
  FUNDING_DEADLINE_HOURS,
  cancellationRefundPercent,
  paymentProtection,
  perUsherGrossCents,
  planCancellation,
  planRelease,
  summarizeFunding,
} from './funding-policy.js';
import {
  getCheckoutCard,
  isPaidTransaction,
  notifySafely,
  processAutomaticPayouts,
  reconcileStaleCheckout,
  serializeSettlement,
} from './settlement.service.js';

const HOUR_MS = 60 * 60 * 1000;
const egp = (cents) => cents / 100;

const assertFundable = (event) => {
  if (event.fundingMode !== 'prefund') throw new AppError('This event is paid after it ends, so it does not take advance funding', 409);
  if (event.status === 'cancelled') throw new AppError('A cancelled event cannot be funded', 409);
  if (event.fundsReleasedAt) throw new AppError('This event’s payments have already been released', 409);
};

const releaseBlockerMessage = (blockers) => blockers.map((blocker) => (blocker.code === 'underfunded'
  ? `${egp(blocker.shortfallCents)} EGP of usher pay is still unfunded`
  : `${blocker.talentIds.length} hired usher(s) have no attendance mark`)).join('; ');

export class FundingService {
  static async fundingsFor(eventId, { transaction } = {}) {
    return EventFunding.findAll({ where: { eventId }, order: [['createdAt', 'ASC']], transaction });
  }

  static async summary(event, { transaction } = {}) {
    return summarizeFunding(event, await this.fundingsFor(event.id, { transaction }));
  }

  static async reconcileStaleFundings(eventId) {
    const active = await EventFunding.findAll({
      where: { eventId, source: 'paymob', collectionStatus: { [Op.in]: ['not_started', 'pending'] } },
    });
    for (const funding of active) {
      await reconcileStaleCheckout(funding, (checkout, obj) => this.applyFundingTransaction(checkout, obj), inquireOrderTransaction);
    }
  }

  // What hired ushers see about their pay for this event.
  static async protectionFor(event) {
    if (!event || event.fundingMode === 'pay_after') return 'pay_after';
    return paymentProtection(event, await this.summary(event));
  }

  static async startFunding({ eventId, organizerId, cardId = null, useCredit = true, actorId }) {
    if (typeof useCredit !== 'boolean') throw new AppError('useCredit must be a boolean', 400);
    const event = await Event.findOne({ where: { id: eventId, organizerId } });
    if (!event) throw new AppError('Event not found', 404);
    assertFundable(event);
    await this.reconcileStaleFundings(event.id);
    await AbsenceHoldService.settleExpired({ organizerId });
    const card = await getCheckoutCard(cardId, organizerId);
    const organizer = await User.findByPk(organizerId);

    const prepared = await sequelize.transaction(async (transaction) => {
      const locked = await Event.findOne({ where: { id: event.id, organizerId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!locked) throw new AppError('Event not found', 404);
      assertFundable(locked);
      await OrganizerCreditService.lockOrganizer(organizerId, transaction);
      const before = summarizeFunding(locked, await this.fundingsFor(locked.id, { transaction }));

      const active = before.pendingCheckout;
      if (active) {
        if (active.collectionStatus === 'not_started') throw new AppError('A funding checkout is being prepared. Try again shortly.', 409);
        const live = active.checkoutUrl && active.expiresAt && new Date(active.expiresAt) > new Date();
        if (!live) throw new AppError('Wait for Paymob to confirm the previous funding checkout before starting another payment.', 409);
        if ((cardId || null) !== (active.selectedCardId || null) || active.amountCents !== before.shortfallCents) {
          throw new AppError('A funding checkout is still active. Continue it or retry after it expires.', 409);
        }
        return { event: locked, checkout: active, reused: true, fullyFundedNow: false };
      }
      if (before.shortfallCents <= 0) throw new AppError('This event is already fully funded', 409);

      let remaining = before.shortfallCents;
      if (useCredit) {
        const applied = Math.min(await OrganizerCreditService.balance(organizerId, { transaction }), remaining);
        if (applied > 0) {
          const creditFunding = await EventFunding.create({
            eventId: locked.id, organizerId, source: 'credit', amountCents: applied,
            collectionStatus: 'paid', collectedAt: new Date(), paymentMethod: 'Organization credit',
            specialReference: `OO-CREDIT-${locked.id}-${randomUUID()}`, isLive: false,
          }, { transaction });
          await OrganizerCreditService.addEntry({
            organizerId, amountCents: -applied, type: 'funding_applied', reference: `funding:${creditFunding.id}`,
            eventId: locked.id, fundingId: creditFunding.id, createdBy: actorId,
          }, { transaction });
          remaining -= applied;
        }
      }
      const checkout = remaining > 0 ? await EventFunding.create({
        eventId: locked.id, organizerId, source: 'paymob', amountCents: remaining,
        collectionStatus: 'not_started', selectedCardId: card?.id || null,
        specialReference: `OO-FUND-${locked.id}-${Date.now()}`, isLive: false,
      }, { transaction }) : null;
      return { event: locked, checkout, reused: false, fullyFundedNow: remaining === 0 };
    });

    if (prepared.checkout && !prepared.reused) {
      try {
        const intention = await createFundingIntention({
          funding: prepared.checkout, event: prepared.event, organizer,
          cardToken: card ? decryptCardToken(card) : undefined,
        });
        await prepared.checkout.update({
          collectionStatus: 'pending',
          paymobIntentionId: intention.intentionId,
          paymobOrderId: intention.orderId,
          paymobClientSecret: intention.clientSecret,
          checkoutUrl: intention.checkoutUrl,
          expiresAt: intention.expiresAt,
        });
      } catch (error) {
        // Credit already applied stays on the event; only the checkout part has to be retried.
        await prepared.checkout.update({ collectionStatus: 'failed', collectionFailureReason: error.message });
        throw error;
      }
    }
    if (prepared.fullyFundedNow) await this.notifyFullyFunded(prepared.event);
    return prepared;
  }

  // Records a Paymob transaction for a funding checkout. A payment that arrives after the event
  // stopped needing it (cancelled, released, deleted, or switched to pay-after) becomes credit.
  static async applyFundingTransaction(funding, obj) {
    if (Number(obj.amount_cents) !== funding.amountCents || obj.currency !== funding.currency) {
      throw new AppError('Paymob callback amount or currency does not match the funding', 409);
    }
    const isPaid = isPaidTransaction(obj);
    const isRefunded = obj.is_refunded === true;

    const outcome = await sequelize.transaction(async (transaction) => {
      const event = await Event.findByPk(funding.eventId, { transaction, lock: transaction.LOCK.UPDATE, paranoid: false });
      const locked = await EventFunding.findByPk(funding.id, { transaction, lock: transaction.LOCK.UPDATE, paranoid: false });
      const wasPaid = locked.collectionStatus === 'paid';
      if (locked.collectionStatus === 'refunded') return { ignored: true };
      if (wasPaid && !isPaid && !isRefunded) return { ignored: true };
      const fundedBefore = event ? summarizeFunding(event, await this.fundingsFor(event.id, { transaction })).fullyFunded : false;

      const status = isRefunded ? 'refunded' : isPaid ? 'paid' : obj.pending ? 'pending' : 'failed';
      await locked.update({
        collectionStatus: status,
        paymobTransactionId: String(obj.id),
        paymentMethod: [obj.source_data?.type, obj.source_data?.sub_type].filter(Boolean).join(' — ') || null,
        lastCallbackAt: new Date(),
        collectionFailureReason: status === 'failed' ? obj.data?.message || 'Paymob reported an unsuccessful payment' : null,
        ...(status === 'paid' && !locked.collectedAt ? { collectedAt: new Date() } : {}),
      }, { transaction });
      Object.assign(funding, locked.get());

      const noLongerNeeded = !event || event.deletedAt || event.status === 'cancelled'
        || event.fundsReleasedAt || event.fundingMode !== 'prefund';
      let lateCredit = false;
      if (status === 'paid' && !wasPaid && noLongerNeeded) {
        ({ created: lateCredit } = await OrganizerCreditService.addEntry({
          organizerId: locked.organizerId, amountCents: locked.amountCents, type: 'late_funding_refund',
          reference: `late-funding:${locked.id}`, eventId: locked.eventId, fundingId: locked.id,
          note: 'Paid after the event no longer needed it',
        }, { transaction }));
      }
      if (status === 'refunded' && wasPaid) {
        const lateEntry = await OrganizerCreditEntry.findOne({ where: { reference: `late-funding:${locked.id}` }, transaction });
        // Money already paid out or credited cannot be taken back from the event, so it is owed.
        if (event?.fundsReleasedAt || lateEntry) {
          await OrganizerCreditService.addEntry({
            organizerId: locked.organizerId, amountCents: -locked.amountCents, type: 'chargeback',
            reference: `chargeback:${locked.id}`, eventId: locked.eventId, fundingId: locked.id,
            note: 'Paymob refunded funding that had already been used',
          }, { transaction });
        }
      }
      const fundedAfter = event && !noLongerNeeded
        ? summarizeFunding(event, await this.fundingsFor(event.id, { transaction })).fullyFunded
        : false;
      return { ignored: false, event, wasPaid, status, lateCredit, becameFullyFunded: !fundedBefore && fundedAfter };
    });

    if (outcome.ignored) return outcome;
    if (outcome.status === 'paid' && !outcome.wasPaid) {
      await notifySafely({
        userId: funding.organizerId,
        title: outcome.lateCredit ? 'Funding added to your credit' : 'Event funding received',
        message: outcome.lateCredit
          ? `Paymob confirmed ${egp(funding.amountCents)} EGP after the event no longer needed it, so it was added to your credit.`
          : `Paymob confirmed ${egp(funding.amountCents)} EGP for “${outcome.event?.title || 'your event'}”. It is held until the event's payments are released.`,
        type: 'success',
        link: outcome.lateCredit ? '/provider/payments' : `/provider/events/${funding.eventId}`,
      });
    }
    if (outcome.becameFullyFunded) await this.notifyFullyFunded(outcome.event);
    return outcome;
  }

  static async notifyFullyFunded(event) {
    await Promise.all((event.hiredTalents || []).map((userId) => notifySafely({
      userId,
      title: 'Your pay is secured',
      message: `The organization funded the usher pay for “${event.title}” in advance. It is released to you after the event.`,
      type: 'success',
      link: `/talent/jobs/${event.id}`,
    })));
  }

  static async assertCanConfirm(event) {
    if (event.fundingMode === 'prefund') {
      const summary = await this.summary(event);
      if (summary.shortfallCents > 0) {
        throw new AppError(`Fund the hired team before confirming it: ${egp(summary.shortfallCents)} EGP is still due`, 409);
      }
      return;
    }
    const tier = await OrganizerCreditService.evaluateOrganizerTier(event.organizerId);
    if (tier.tier !== 'trusted') {
      throw new AppError('Your organization must fund events in advance. Switch this event to advance funding before confirming the team.', 409);
    }
  }

  static async changeFundingMode({ eventId, organizerId, mode }) {
    if (!['prefund', 'pay_after'].includes(mode)) throw new AppError('Funding mode must be prefund or pay_after', 400);
    if (mode === 'pay_after') {
      const tier = await OrganizerCreditService.evaluateOrganizerTier(organizerId);
      if (tier.tier !== 'trusted') throw new AppError('Only trusted organizations can pay after the event', 403);
    }
    return sequelize.transaction(async (transaction) => {
      const event = await Event.findOne({ where: { id: eventId, organizerId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!event) throw new AppError('Event not found', 404);
      if (event.fundingMode === mode) return event;
      if (['completed', 'cancelled'].includes(event.status) || event.fundsReleasedAt) {
        throw new AppError(`The payment method of a ${event.status} event can no longer change`, 409);
      }
      if (mode === 'pay_after') {
        const held = await EventFunding.count({
          where: { eventId, collectionStatus: { [Op.in]: ['not_started', 'pending', 'paid'] } }, transaction,
        });
        if (held) throw new AppError('This event already has advance funding, so it stays on advance funding', 409);
      } else {
        const settlements = await EventSettlement.count({ where: { eventId }, paranoid: false, transaction });
        if (settlements) throw new AppError('A post-event payment was already started for this event', 409);
      }
      event.fundingMode = mode;
      await event.save({ transaction });
      return event;
    });
  }

  // Pays present ushers from the held funds, holds absent ushers' pay for the dispute window, and
  // credits any surplus. `unmarkedAs` lets an admin release an event the organization never marked.
  static async releaseEventFunds({ eventId, organizerId = null, actorId = null, unmarkedAs = null }) {
    if (unmarkedAs !== null && !['present', 'absent'].includes(unmarkedAs)) {
      throw new AppError('unmarkedAs must be present or absent', 400);
    }
    const event = await Event.findOne({ where: { id: eventId, ...(organizerId ? { organizerId } : {}) } });
    if (!event) throw new AppError('Event not found', 404);
    if (event.fundingMode !== 'prefund') throw new AppError('This event is paid through a post-event checkout', 409);
    await this.reconcileStaleFundings(event.id);

    const released = await sequelize.transaction(async (transaction) => {
      const locked = await Event.findByPk(event.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (locked.status !== 'completed') throw new AppError('Complete the event before releasing its payments', 409);
      if (locked.fundsReleasedAt) throw new AppError('This event’s payments have already been released', 409);
      const hired = [...new Set(locked.hiredTalents || [])];
      const [summary, attendance] = await Promise.all([
        this.summary(locked, { transaction }),
        hired.length ? Attendance.findAll({ where: { eventId: locked.id, talentId: { [Op.in]: hired } }, transaction }) : [],
      ]);
      const plan = planRelease({
        hiredTalentIds: hired,
        attendanceByTalent: new Map(attendance.map((record) => [record.talentId, record])),
        perUsherCents: perUsherGrossCents(locked.budget),
        fundedCents: summary.fundedCents,
        unmarkedAs,
      });
      if (plan.blockers.length) throw new AppError(`Payments cannot be released yet: ${releaseBlockerMessage(plan.blockers)}`, 409);

      let settlement = null;
      if (plan.payable.length) {
        const talents = await User.findAll({ where: { id: { [Op.in]: plan.payable.map((line) => line.talentId) } }, paranoid: false, transaction });
        const talentsById = new Map(talents.map((talent) => [talent.id, talent]));
        const drafts = plan.payable
          .filter((line) => talentsById.has(line.talentId))
          .map((line) => ({
            talent: talentsById.get(line.talentId),
            amounts: { grossAmountCents: line.grossAmountCents, platformFeeCents: line.platformFeeCents, usherAmountCents: line.usherAmountCents },
            lineType: 'attendance',
            attendanceStatus: line.attendanceStatus,
          }));
        if (drafts.length !== plan.payable.length) throw new AppError('A hired usher account could not be found', 409);
        settlement = await createPrefundedSettlement({
          event: locked, specialReference: `OO-REL-${locked.id}`, lineDrafts: drafts, transaction,
        });
      }
      if (unmarkedAs) {
        for (const talentId of plan.unmarked) {
          await Attendance.findOrCreate({
            where: { eventId: locked.id, talentId },
            defaults: { status: unmarkedAs, checkInMethod: 'admin' },
            transaction,
          });
        }
      }
      const releaseAfter = new Date(Date.now() + DISPUTE_WINDOW_HOURS * HOUR_MS);
      const holds = await AbsenceHoldService.createForRelease({ event: locked, absent: plan.absent, transaction, releaseAfter });
      if (plan.surplusCents > 0) {
        await OrganizerCreditService.addEntry({
          organizerId: locked.organizerId, amountCents: plan.surplusCents, type: 'event_surplus',
          reference: `surplus:${locked.id}`, eventId: locked.id, createdBy: actorId,
        }, { transaction });
      }
      locked.fundsReleasedAt = new Date();
      await locked.save({ transaction });
      return { event: locked, settlement, holds, plan, releaseAfter };
    });

    if (released.settlement) await processAutomaticPayouts(released.settlement);
    await this.notifyRelease(released);
    return released;
  }

  static async notifyRelease({ event, settlement, holds, plan, releaseAfter }) {
    const lines = settlement ? await SettlementLine.findAll({ where: { settlementId: settlement.id } }) : [];
    await Promise.all(lines.filter((line) => line.payoutStatus === 'awaiting_method').map((line) => notifySafely({
      userId: line.talentId,
      title: 'Add a payout account to receive your pay',
      message: `Your ${egp(line.usherAmountCents)} EGP for “${event.title}” is ready. Add a mobile wallet or bank account in your profile and it will be sent automatically.`,
      type: 'warning',
      link: '/talent/profile',
    })));
    await Promise.all(holds.map((hold) => notifySafely({
      userId: hold.talentId,
      title: 'You were marked absent',
      message: `The organization marked you absent at “${event.title}”, so your pay is on hold. If you attended, dispute it before ${releaseAfter.toUTCString()}.`,
      type: 'danger',
      link: '/talent/events',
    })));
    await notifySafely({
      userId: event.organizerId,
      title: 'Event payments released',
      message: `Payments for “${event.title}” were released.${plan.surplusCents ? ` ${egp(plan.surplusCents)} EGP of unused funding was added to your credit.` : ''}${holds.length ? ` Pay for ${holds.length} absent usher(s) is held for ${DISPUTE_WINDOW_HOURS} hours in case they dispute.` : ''}`,
      type: 'success',
      link: `/provider/events/${event.id}`,
    });
  }

  // Runs inside EventService.changeStatus when an event is cancelled. The caller saves the event
  // and calls afterCancellation once the transaction commits.
  static async settleCancellation(event, { transaction }) {
    if (event.fundingMode !== 'prefund' || event.fundsReleasedAt) return null;
    const summary = await this.summary(event, { transaction });
    if (summary.fundedCents <= 0) return null;
    const refundPercent = cancellationRefundPercent(event);
    const plan = planCancellation({
      fundedCents: summary.fundedCents,
      hiredTalentIds: event.hiredTalents,
      perUsherCents: perUsherGrossCents(event.budget),
      refundPercent,
    });
    let settlement = null;
    if (plan.compensation.length) {
      const talents = await User.findAll({ where: { id: { [Op.in]: plan.compensation.map((line) => line.talentId) } }, paranoid: false, transaction });
      const talentsById = new Map(talents.map((talent) => [talent.id, talent]));
      const drafts = plan.compensation.filter((line) => talentsById.has(line.talentId)).map((line) => ({
        talent: talentsById.get(line.talentId),
        amounts: { grossAmountCents: line.grossAmountCents, platformFeeCents: line.platformFeeCents, usherAmountCents: line.usherAmountCents },
        lineType: 'cancellation_compensation',
      }));
      const missingCents = plan.compensationCents - drafts.reduce((total, draft) => total + draft.amounts.grossAmountCents, 0);
      plan.creditCents += missingCents;
      if (drafts.length) {
        settlement = await createPrefundedSettlement({
          event, specialReference: `OO-CANCEL-${event.id}`, lineDrafts: drafts, transaction,
        });
      }
    }
    if (plan.creditCents > 0) {
      await OrganizerCreditService.addEntry({
        organizerId: event.organizerId, amountCents: plan.creditCents, type: 'cancellation_refund',
        reference: `cancellation:${event.id}`, eventId: event.id,
        note: `${refundPercent}% refund for a cancellation`,
      }, { transaction });
    }
    event.fundsReleasedAt = new Date();
    return { settlement, plan, refundPercent };
  }

  static async afterCancellation(event, result) {
    if (!result) return;
    if (result.settlement) await processAutomaticPayouts(result.settlement);
    await Promise.all(result.plan.compensation.map((line) => notifySafely({
      userId: line.talentId,
      title: 'Cancellation compensation',
      message: `“${event.title}” was cancelled close to its start, so you receive ${egp(line.usherAmountCents)} EGP compensation.`,
      type: 'info',
      link: '/talent/events',
    })));
    await notifySafely({
      userId: event.organizerId,
      title: 'Cancelled event funding settled',
      message: `${egp(result.plan.creditCents)} EGP of the funding for “${event.title}” was added to your credit (${result.refundPercent}% refund).${result.plan.compensationCents ? ` ${egp(result.plan.compensationCents)} EGP compensates the hired ushers.` : ''}`,
      type: 'info',
      link: '/provider/payments',
    });
  }

  // Sends prefunded pay that was waiting for this usher's payout account.
  static async resumeAwaitingPayouts(talentId) {
    const talent = await User.findByPk(talentId);
    if (!talent) return 0;
    const payout = resolvePayoutMethod(talent.paymentMethods || [], talent.fullName);
    if (payout.type === 'cash') return 0;
    const waiting = await SettlementLine.findAll({ where: { talentId, payoutStatus: 'awaiting_method' } });
    const settlementIds = new Set();
    for (const line of waiting) {
      const [claimed] = await SettlementLine.update({
        payoutMethodType: payout.type, payoutProvider: payout.provider, payoutDestination: payout.destination,
        payoutMetadata: payout.metadata, payoutStatus: 'queued', failureReason: null,
      }, { where: { id: line.id, payoutStatus: 'awaiting_method' } });
      if (claimed) settlementIds.add(line.settlementId);
    }
    if (!isPayoutSandboxConfigured()) return settlementIds.size;
    for (const settlementId of settlementIds) {
      const settlement = await EventSettlement.findByPk(settlementId, { paranoid: false });
      if (settlement) await processAutomaticPayouts(settlement);
    }
    return settlementIds.size;
  }

  static async publicSummary(event, { includeRelease = true } = {}) {
    await this.reconcileStaleFundings(event.id);
    await AbsenceHoldService.settleExpired({ eventId: event.id });
    const fundings = await this.fundingsFor(event.id);
    const summary = summarizeFunding(event, fundings);
    const [tier, creditBalanceCents, settlements, holds] = await Promise.all([
      OrganizerCreditService.evaluateOrganizerTier(event.organizerId),
      OrganizerCreditService.balance(event.organizerId),
      EventSettlement.findAll({ where: { eventId: event.id, fundingSource: 'prefund' }, order: [['createdAt', 'ASC']] }),
      AbsenceHoldService.listWithDetails({ eventId: event.id }),
    ]);
    const perUsherCents = perUsherGrossCents(event.budget);
    let releasePreview = null;
    if (includeRelease && event.fundingMode === 'prefund' && !event.fundsReleasedAt && event.status !== 'cancelled') {
      const hired = [...new Set(event.hiredTalents || [])];
      const attendance = hired.length ? await Attendance.findAll({ where: { eventId: event.id, talentId: { [Op.in]: hired } } }) : [];
      const plan = planRelease({
        hiredTalentIds: hired,
        attendanceByTalent: new Map(attendance.map((record) => [record.talentId, record])),
        perUsherCents,
        fundedCents: summary.fundedCents,
      });
      const ushers = hired.length ? await User.findAll({ where: { id: { [Op.in]: hired } }, paranoid: false, attributes: ['id', 'fullName', 'portfolioPicture', 'paymentMethods'] }) : [];
      const usersById = new Map(ushers.map((user) => [user.id, user]));
      const describe = (talentId) => {
        const user = usersById.get(talentId);
        const payout = resolvePayoutMethod(user?.paymentMethods || [], user?.fullName || '');
        return { talentId, fullName: user?.fullName || 'Usher', photo: user?.portfolioPicture?.secure_url || '', hasPayoutAccount: payout.type !== 'cash' };
      };
      releasePreview = {
        canRelease: event.status === 'completed' && plan.blockers.length === 0,
        eventCompleted: event.status === 'completed',
        blockers: plan.blockers.map((blocker) => ({ ...blocker, ...(blocker.shortfallCents ? { shortfall: egp(blocker.shortfallCents) } : {}) })),
        payable: plan.payable.map((line) => ({ ...describe(line.talentId), attendanceStatus: line.attendanceStatus, usherAmount: egp(line.usherAmountCents), platformFee: egp(line.platformFeeCents), grossAmount: egp(line.grossAmountCents) })),
        absent: plan.absent.map((line) => ({ ...describe(line.talentId), amount: egp(line.amountCents) })),
        unmarked: plan.unmarked.map(describe),
        surplus: egp(plan.surplusCents),
        disputeWindowHours: DISPUTE_WINDOW_HOURS,
      };
    }
    const pendingCheckout = summary.pendingCheckout;
    return {
      eventId: event.id,
      fundingMode: event.fundingMode,
      eventStatus: event.status,
      tier,
      hiredCount: (event.hiredTalents || []).length,
      perUsherAmount: egp(perUsherCents),
      requiredAmount: egp(summary.requiredCents),
      fundedAmount: egp(summary.fundedCents),
      shortfallAmount: egp(summary.shortfallCents),
      surplusAmount: egp(summary.surplusCents),
      fullyFunded: summary.fullyFunded,
      deadline: summary.deadline,
      deadlineHours: FUNDING_DEADLINE_HOURS,
      overdue: summary.overdue,
      released: summary.released,
      fundsReleasedAt: event.fundsReleasedAt,
      protection: paymentProtection(event, summary),
      creditBalance: egp(creditBalanceCents),
      creditToApply: egp(Math.min(Math.max(creditBalanceCents, 0), summary.shortfallCents)),
      pendingCheckout: pendingCheckout ? {
        ...pendingCheckout.toJSON(),
        active: pendingCheckout.collectionStatus === 'pending' && Boolean(pendingCheckout.checkoutUrl)
          && Boolean(pendingCheckout.expiresAt) && new Date(pendingCheckout.expiresAt) > new Date(),
      } : null,
      fundings: fundings.map((funding) => funding.toJSON()),
      cancellationPolicy: {
        tiers: CANCELLATION_TIERS.map((tier) => ({ ...tier, minHoursBeforeStart: Number.isFinite(tier.minHoursBeforeStart) ? tier.minHoursBeforeStart : null })),
        currentRefundPercent: event.status === 'cancelled' ? null : cancellationRefundPercent(event),
      },
      releasePreview,
      settlements: await Promise.all(settlements.map(serializeSettlement)),
      holds,
      payoutSandboxConfigured: isPayoutSandboxConfigured(),
    };
  }

  // Admin view of prefunded events that still owe funding.
  static async underfundedEvents({ limit = 100 } = {}) {
    const events = await Event.findAll({
      where: { fundingMode: 'prefund', fundsReleasedAt: null, status: { [Op.in]: ['open', 'confirmed', 'completed'] } },
      order: [['eventDate', 'ASC']],
      limit: 500,
    });
    if (!events.length) return [];
    const fundings = await EventFunding.findAll({ where: { eventId: { [Op.in]: events.map((event) => event.id) } } });
    const byEvent = new Map();
    fundings.forEach((funding) => byEvent.set(funding.eventId, [...(byEvent.get(funding.eventId) || []), funding]));
    const organizerIds = [...new Set(events.map((event) => event.organizerId))];
    const organizers = await User.findAll({ where: { id: { [Op.in]: organizerIds } }, paranoid: false, attributes: ['id', 'fullName'] });
    const organizersById = new Map(organizers.map((organizer) => [organizer.id, organizer]));
    return events
      .map((event) => ({ event, summary: summarizeFunding(event, byEvent.get(event.id) || []) }))
      .filter(({ summary }) => summary.shortfallCents > 0)
      .slice(0, limit)
      .map(({ event, summary }) => ({
        event: { _id: event.id, id: event.id, title: event.title, eventDate: event.eventDate, status: event.status },
        organization: { _id: event.organizerId, fullName: organizersById.get(event.organizerId)?.fullName || '' },
        requiredAmount: egp(summary.requiredCents),
        fundedAmount: egp(summary.fundedCents),
        shortfallAmount: egp(summary.shortfallCents),
        deadline: summary.deadline,
        overdue: summary.overdue,
      }));
  }

  static async heldFundsBlockDeletion(eventId, { transaction } = {}) {
    const event = await Event.findByPk(eventId, { transaction, paranoid: false, attributes: ['id', 'fundingMode', 'fundsReleasedAt'] });
    if (!event || event.fundsReleasedAt) return false;
    const held = await EventFunding.count({ where: { eventId, collectionStatus: 'paid' }, transaction });
    return held > 0;
  }

  static async activeHoldsCount(organizerId) {
    return AbsenceHold.count({ where: { organizerId, status: { [Op.in]: ['held', 'disputed'] } } });
  }
}
