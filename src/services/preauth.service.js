import { Op } from 'sequelize';
import { sequelize } from '../../db/connection.js';
import { Attendance, Event, EventFunding, User } from '../../db/index.js';
import { AppError } from '../utils/appError.js';
import { decryptCardToken } from './card-token.service.js';
import {
  captureTransaction, createFundingIntention, inquireOrderTransaction, refundTransaction, voidTransaction,
} from './paymob.service.js';
import { createPrefundedSettlement } from './prefund-settlement.js';
import {
  HOLD_LIVE_STATUSES,
  HOLD_REMINDER_HOURS,
  cancellationCompensationPercent,
  dayCount,
  dayHoldCents,
  dayStartOf,
  dayStates,
  holdDeadline,
  holdOpensAt,
  planDayCancellation,
  planDayCapture,
  preauthFeeCents,
  preauthProtection,
  seatDayAmounts,
} from './preauth-policy.js';
import {
  getCheckoutCard, isPaidTransaction, notifySafely, processAutomaticPayouts, reconcileStaleCheckout,
} from './settlement.service.js';

const egp = (cents) => cents / 100;
const HOUR_MS = 60 * 60 * 1000;
const LIVE_CHECKOUT = ['not_started', 'pending'];
const TERMINAL_OR_ADVANCED = ['authorized', 'closing', 'paid', 'voided'];
const succeeded = (result) => result?.success === true && result?.error_occured !== true;

const assertChargeable = (event) => {
  if (event.fundingMode !== 'preauth') throw new AppError('This event does not use card holds', 409);
  if (event.status === 'cancelled') throw new AppError('A cancelled event cannot be paid for', 409);
  if (event.status === 'completed') throw new AppError('A completed event cannot be paid for', 409);
};

export class PreauthService {
  static async fundingsFor(eventId, { transaction } = {}) {
    return EventFunding.findAll({ where: { eventId }, order: [['createdAt', 'ASC']], transaction });
  }

  static feeFunding(fundings) {
    return fundings.find((funding) => funding.kind === 'fee' && funding.collectionStatus === 'paid') || null;
  }

  static async feeIsPaid(eventId) {
    return Boolean(this.feeFunding(await this.fundingsFor(eventId)));
  }

  static async reconcileStale(eventId) {
    const active = await EventFunding.findAll({
      where: { eventId, source: 'paymob', kind: { [Op.ne]: 'advance' }, collectionStatus: { [Op.in]: LIVE_CHECKOUT } },
    });
    for (const funding of active) {
      await reconcileStaleCheckout(funding, (checkout, obj) => this.applyTransaction(checkout, obj), inquireOrderTransaction);
    }
  }

  static async protectionFor(event) {
    return preauthProtection(event, dayStates(event, await this.fundingsFor(event.id)));
  }

  static async assertCanConfirm(event) {
    if (!this.feeFunding(await this.fundingsFor(event.id))) {
      throw new AppError(`Pay the ${egp(preauthFeeCents(event))} EGP booking fee before confirming the team`, 409);
    }
  }

  // Starts the checkout for the booking fee or for one day's hold. Both open Paymob's hosted
  // checkout, where the organization pays or authorizes the card (a saved card can be preselected).
  static async startCharge({ eventId, organizerId, kind, dayIndex = -1, cardId = null, now = new Date() }) {
    if (!['fee', 'day_hold'].includes(kind)) throw new AppError('kind must be fee or day_hold', 400);
    const event = await Event.findOne({ where: { id: eventId, organizerId } });
    if (!event) throw new AppError('Event not found', 404);
    assertChargeable(event);
    if (kind === 'day_hold') {
      if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= dayCount(event)) throw new AppError('dayIndex is not a day of this event', 400);
      if (now < holdOpensAt(event, dayIndex)) throw new AppError('The hold for this day opens 5 days before it starts', 409);
      if (now >= dayStartOf(event, dayIndex)) throw new AppError('This day has already started', 409);
    }
    await this.reconcileStale(event.id);
    const card = await getCheckoutCard(cardId || event.fundingCardId, organizerId);
    const organizer = await User.findByPk(organizerId);
    const amountCents = kind === 'fee' ? preauthFeeCents(event) : dayHoldCents(event);
    const index = kind === 'fee' ? -1 : dayIndex;

    const prepared = await sequelize.transaction(async (transaction) => {
      const locked = await Event.findOne({ where: { id: event.id, organizerId }, transaction, lock: transaction.LOCK.UPDATE });
      assertChargeable(locked);
      const existing = await EventFunding.findAll({ where: { eventId: locked.id, kind, dayIndex: index }, transaction });
      const live = existing.find((funding) => [...HOLD_LIVE_STATUSES, 'not_started'].includes(funding.collectionStatus));
      if (live?.collectionStatus === 'not_started') throw new AppError('A checkout is being prepared. Try again shortly.', 409);
      if (live && ['authorized', 'closing', 'paid'].includes(live.collectionStatus)) {
        throw new AppError(kind === 'fee' ? 'The booking fee is already paid' : 'This day already has a hold', 409);
      }
      if (live) {
        const usable = live.checkoutUrl && live.expiresAt && new Date(live.expiresAt) > now;
        if (!usable) throw new AppError('Wait for Paymob to confirm the previous checkout before starting another.', 409);
        return { checkout: live, reused: true, event: locked };
      }
      const checkout = await EventFunding.create({
        eventId: locked.id, organizerId, source: 'paymob', kind, dayIndex: index, amountCents,
        collectionStatus: 'not_started', selectedCardId: card?.id || null,
        specialReference: `OO-${kind === 'fee' ? 'FEE' : 'HOLD'}-${locked.id}-${index}-${Date.now()}`, isLive: false,
      }, { transaction });
      return { checkout, reused: false, event: locked };
    });

    if (!prepared.reused) {
      try {
        const intention = await createFundingIntention({
          funding: prepared.checkout, event: prepared.event, organizer, cardToken: card ? decryptCardToken(card) : undefined,
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
        await prepared.checkout.update({ collectionStatus: 'failed', collectionFailureReason: error.message });
        throw error;
      }
    }
    return prepared;
  }

  // Records a Paymob transaction for a fee or hold checkout. Callbacks about captures, voids, and
  // refunds the platform sent itself are already recorded.
  static async applyTransaction(funding, obj) {
    if (obj.is_capture === true || obj.is_voided === true || obj.is_void === true
      || obj.is_refund === true || obj.is_refunded === true) return { ignored: true };
    if (Number(obj.amount_cents) !== funding.amountCents || obj.currency !== funding.currency) {
      throw new AppError('Paymob callback amount or currency does not match the funding', 409);
    }
    const hold = funding.kind === 'day_hold';
    const ok = isPaidTransaction(obj);
    // An Auth integration reports is_auth. A hold that was charged outright means the integration
    // is not an Auth one; the money is returned at once instead of being treated as a hold.
    const chargedOutright = hold && ok && obj.is_auth !== true;
    const next = chargedOutright ? 'failed' : ok ? (hold ? 'authorized' : 'paid') : obj.pending ? 'pending' : 'failed';

    const outcome = await sequelize.transaction(async (transaction) => {
      const locked = await EventFunding.findByPk(funding.id, { transaction, lock: transaction.LOCK.UPDATE, paranoid: false });
      if (TERMINAL_OR_ADVANCED.includes(locked.collectionStatus)) return { ignored: true };
      const event = await Event.findByPk(locked.eventId, { transaction, paranoid: false });
      await locked.update({
        collectionStatus: next,
        paymobTransactionId: String(obj.id),
        paymentMethod: [obj.source_data?.type, obj.source_data?.sub_type].filter(Boolean).join(' — ') || null,
        lastCallbackAt: new Date(),
        collectionFailureReason: next === 'failed'
          ? (chargedOutright ? 'PAYMOB_AUTH_INTEGRATION_ID is not an Auth integration, so the card was charged and is being refunded'
            : obj.data?.message || 'Paymob reported an unsuccessful payment')
          : null,
        ...(next === 'paid' && !locked.collectedAt ? { collectedAt: new Date() } : {}),
      }, { transaction });
      Object.assign(funding, locked.get());
      return { ignored: false, event, status: next, chargedOutright };
    });
    if (outcome.ignored) return outcome;

    if (outcome.chargedOutright) {
      try {
        await refundTransaction({ transactionId: funding.paymobTransactionId, amountCents: funding.amountCents });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({ level: 'error', scope: 'preauth', fundingId: funding.id, message: `Refund of an outright-charged hold failed: ${error.message}` }));
      }
      return outcome;
    }
    const eventGone = !outcome.event || outcome.event.deletedAt || outcome.event.status === 'cancelled';
    if (outcome.status === 'authorized' && eventGone) {
      // A hold placed after the event stopped needing it is released straight away.
      await this.closeHold(funding.id, { captureCents: 0, reason: 'late_hold' });
      return outcome;
    }
    if (outcome.status === 'paid' || outcome.status === 'authorized') {
      await notifySafely({
        userId: funding.organizerId,
        title: funding.kind === 'fee' ? 'Booking fee received' : 'Pay secured for an event day',
        message: funding.kind === 'fee'
          ? `Paymob confirmed the ${egp(funding.amountCents)} EGP booking fee for “${outcome.event?.title || 'your event'}”. It is not refundable.`
          : `${egp(funding.amountCents)} EGP is held on your card for day ${funding.dayIndex + 1} of “${outcome.event?.title || 'your event'}”. Only the pay of ushers who check in is charged, after the day.`,
        type: 'success',
        link: `/provider/events/${funding.eventId}`,
      });
    }
    return outcome;
  }

  // What to capture from a hold that is being closed. A cancelled event pays the compensation fixed
  // when it was cancelled; otherwise the ushers who checked in on that day are paid.
  static async planFor(event, funding) {
    const wage = seatDayAmounts(event);
    if (funding.closeReason?.startsWith('cancellation')) {
      const hired = [...new Set(event.hiredTalents || [])];
      const perUsher = hired.length ? Math.floor((funding.capturedCents || 0) / hired.length) : 0;
      return {
        captureCents: perUsher * hired.length,
        lines: perUsher > 0 ? hired.map((talentId) => ({
          talentId, lineType: 'cancellation_compensation', attendanceStatus: null,
          amounts: { grossAmountCents: perUsher, platformFeeCents: 0, usherAmountCents: perUsher },
        })) : [],
      };
    }
    const records = await Attendance.findAll({ where: { eventId: event.id, dayIndex: funding.dayIndex } });
    const plan = planDayCapture({
      hiredTalentIds: event.hiredTalents, records, wagePerUsherCents: wage.usherAmountCents, authorizedCents: funding.amountCents,
    });
    return {
      captureCents: plan.captureCents,
      lines: plan.payable.map((line) => ({
        talentId: line.talentId, lineType: 'attendance', attendanceStatus: line.attendanceStatus,
        // The fee for this seat-day was already kept at booking; it is shown on the line for the record.
        amounts: { grossAmountCents: wage.grossAmountCents, platformFeeCents: wage.platformFeeCents, usherAmountCents: wage.usherAmountCents },
      })),
    };
  }

  // Captures (or voids) an authorized hold exactly once: the row is claimed before Paymob is called,
  // and the ushers' payout lines are only created after Paymob confirms the money moved.
  static async closeHold(fundingId, { captureCents = null, reason = 'attendance' } = {}) {
    const [claimed] = await EventFunding.update(
      { collectionStatus: 'closing' },
      { where: { id: fundingId, collectionStatus: 'authorized' } },
    );
    if (!claimed) return null;
    const funding = await EventFunding.findByPk(fundingId, { paranoid: false });
    const event = await Event.findByPk(funding.eventId, { paranoid: false });
    try {
      const plan = captureCents === null ? await this.planFor(event, funding) : { captureCents, lines: [] };
      const result = plan.captureCents > 0
        ? await captureTransaction({ transactionId: funding.paymobTransactionId, amountCents: plan.captureCents })
        : await voidTransaction({ transactionId: funding.paymobTransactionId });
      if (!succeeded(result)) throw new Error(result?.data?.message || 'Paymob did not accept the request');
      return await this.recordClosed({ funding, event, plan, reason });
    } catch (error) {
      // Paymob never confirmed it, so the hold stays authorized and the next sweep tries again.
      await EventFunding.update(
        { collectionStatus: 'authorized', collectionFailureReason: String(error?.message || error).slice(0, 500) },
        { where: { id: funding.id, collectionStatus: 'closing' } },
      );
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ level: 'error', scope: 'preauth', fundingId: funding.id, message: error.message }));
      return null;
    }
  }

  static async recordClosed({ funding, event, plan, reason }) {
    const cancelled = funding.closeReason?.startsWith('cancellation');
    const settlement = await sequelize.transaction(async (transaction) => {
      let created = null;
      if (plan.captureCents > 0) {
        const talents = await User.findAll({ where: { id: { [Op.in]: plan.lines.map((line) => line.talentId) } }, paranoid: false, transaction });
        const byId = new Map(talents.map((talent) => [talent.id, talent]));
        const drafts = plan.lines.filter((line) => byId.has(line.talentId)).map((line) => ({ ...line, talent: byId.get(line.talentId) }));
        if (drafts.length) {
          created = await createPrefundedSettlement({
            event,
            specialReference: `OO-${cancelled ? 'CANCEL' : 'DAY'}-${event.id}-${funding.dayIndex}`,
            lineDrafts: drafts,
            dayIndex: funding.dayIndex,
            transaction,
          });
        }
      }
      await EventFunding.update({
        collectionStatus: plan.captureCents > 0 ? 'paid' : 'voided',
        capturedCents: plan.captureCents,
        closeReason: funding.closeReason || reason,
        collectionFailureReason: null,
        ...(plan.captureCents > 0 ? { collectedAt: new Date() } : {}),
      }, { where: { id: funding.id }, transaction });
      return created;
    });
    if (settlement) await processAutomaticPayouts(settlement);
    await this.notifyClosed({ funding, event, plan, settlement });
    return { funding, settlement, plan };
  }

  static async notifyClosed({ funding, event, plan, settlement }) {
    const cancelled = funding.closeReason?.startsWith('cancellation');
    await Promise.all(plan.lines.map((line) => notifySafely({
      userId: line.talentId,
      title: cancelled ? 'Cancellation compensation' : 'Your pay was released',
      message: cancelled
        ? `“${event.title}” was cancelled close to day ${funding.dayIndex + 1}, so you receive ${egp(line.amounts.usherAmountCents)} EGP compensation.`
        : `Your ${egp(line.amounts.usherAmountCents)} EGP for day ${funding.dayIndex + 1} of “${event.title}” is on its way to your payout account.`,
      type: cancelled ? 'info' : 'success',
      link: '/talent/events',
    })));
    await notifySafely({
      userId: funding.organizerId,
      title: plan.captureCents > 0 ? 'Day payment captured' : 'Card hold released',
      message: plan.captureCents > 0
        ? `${egp(plan.captureCents)} EGP was charged to your card for day ${funding.dayIndex + 1} of “${event.title}”; the other ${egp(funding.amountCents - plan.captureCents)} EGP of the hold was released.`
        : `The ${egp(funding.amountCents)} EGP hold for day ${funding.dayIndex + 1} of “${event.title}” was released. Nothing was charged.`,
      type: 'info',
      link: `/provider/events/${event.id}`,
    });
    return settlement;
  }

  // Places the cancellation compensation on each open hold inside the cancelling transaction; the
  // holds are closed with Paymob after it commits. The booking fee is never refunded.
  static async settleCancellation(event, { transaction, now = new Date() }) {
    const fundings = await this.fundingsFor(event.id, { transaction });
    const holds = fundings.filter((funding) => funding.kind === 'day_hold' && funding.collectionStatus === 'authorized');
    const wage = seatDayAmounts(event);
    for (const hold of holds) {
      const percent = cancellationCompensationPercent(event, hold.dayIndex, now);
      const plan = planDayCancellation({
        hiredTalentIds: event.hiredTalents, wagePerUsherCents: wage.usherAmountCents,
        authorizedCents: hold.amountCents, compensationPercent: percent,
      });
      await hold.update({ capturedCents: plan.captureCents, closeReason: `cancellation:${percent}` }, { transaction });
    }
    event.fundsReleasedAt = new Date();
    return { preauth: true, fundingIds: holds.map((hold) => hold.id) };
  }

  static async afterCancellation(event, result) {
    for (const fundingId of result?.fundingIds || []) await this.closeHold(fundingId);
    await notifySafely({
      userId: event.organizerId,
      title: 'Cancelled event settled',
      message: `Holds on your card for “${event.title}” were released or partly charged as ushers' cancellation compensation. The booking fee is not refundable.`,
      type: 'info',
      link: '/provider/payments',
    });
  }

  // Holds on cancelled events whose Paymob call failed earlier.
  static async closeCancelledHolds({ limit = 50 } = {}) {
    const pending = await EventFunding.findAll({
      where: { kind: 'day_hold', collectionStatus: 'authorized', closeReason: { [Op.like]: 'cancellation%' } },
      limit,
    });
    for (const funding of pending) await this.closeHold(funding.id);
    return pending.length;
  }

  static async holdsBlockDeletion(eventId, { transaction } = {}) {
    const held = await EventFunding.count({
      where: { eventId, kind: 'day_hold', collectionStatus: { [Op.in]: ['authorized', 'closing'] } }, transaction,
    });
    return held > 0;
  }

  // Runs an event's card-hold steps: remind the organization to place holds, close holds after
  // their day, cancel an event whose first day is unsecured at its deadline, and finish the event.
  static async runForEvent(event, now = new Date()) {
    if (event.status === 'cancelled' || event.deletedAt) return;
    await this.reconcileStale(event.id);
    const fundings = await this.fundingsFor(event.id);
    const states = dayStates(event, fundings, now);

    for (const day of states) {
      if (day.funding?.collectionStatus === 'authorized' && now >= day.captureDueAt) {
        await this.closeHold(day.funding.id);
      }
    }

    const feePaid = Boolean(this.feeFunding(fundings));
    const first = states[0];
    if (['open', 'confirmed'].includes(event.status) && first && now < dayStartOf(event, 0)
      && now >= holdDeadline(event, 0) && (first.state === 'unsecured' || !feePaid)) {
      await this.cancelUnsecured(event);
      return;
    }

    await this.remindOrganizer(event, states, feePaid, now);

    const refreshed = dayStates(event, await this.fundingsFor(event.id), now);
    const finished = refreshed.every((day) => ['captured', 'voided'].includes(day.state)
      || (day.state === 'unsecured' && now >= day.captureDueAt));
    if (finished && !event.fundsReleasedAt) {
      await event.reload();
      if (event.status !== 'completed') {
        const { EventService } = await import('./event.service.js');
        await EventService.changeStatus(event.id, 'completed');
        await event.reload();
      }
      event.fundsReleasedAt = new Date();
      await event.save();
    }
  }

  static async cancelUnsecured(event) {
    const { EventService } = await import('./event.service.js');
    const result = await EventService.changeStatus(event.id, 'cancelled');
    await EventService.notifyCancellation(result.event, result.notifyUserIds, result.fundingResult);
    await notifySafely({
      userId: event.organizerId,
      title: 'Event cancelled: payment not secured',
      message: `“${event.title}” was cancelled because its booking fee or the hold for its first day was not in place 24 hours before it started.`,
      type: 'danger',
      link: `/provider/events/${event.id}`,
    });
  }

  // Reminds the organization (at most daily) of the fee or hold it still has to place.
  static async remindOrganizer(event, states, feePaid, now) {
    const reminders = { ...(event.holdReminders || {}) };
    const due = [];
    if (!feePaid && ['open', 'confirmed'].includes(event.status)) due.push({ key: 'fee', message: `Pay the ${egp(preauthFeeCents(event))} EGP booking fee for “${event.title}” to secure your team.` });
    for (const day of states) {
      if (['awaiting_hold', 'unsecured'].includes(day.state) && now < dayStartOf(event, day.dayIndex)) {
        due.push({
          key: String(day.dayIndex),
          message: day.state === 'unsecured'
            ? `The pay hold for day ${day.dayIndex + 1} of “${event.title}” is overdue. Place it now so the ushers are covered.`
            : `Authorize the ${egp(day.holdCents)} EGP hold for day ${day.dayIndex + 1} of “${event.title}”. You are only charged for ushers who check in.`,
        });
      }
    }
    const fresh = due.filter((item) => !reminders[item.key] || now - new Date(reminders[item.key]) >= HOLD_REMINDER_HOURS * HOUR_MS);
    if (!fresh.length) return;
    for (const item of fresh) {
      reminders[item.key] = now.toISOString();
      await notifySafely({
        userId: event.organizerId, title: 'Payment needed', message: item.message, type: 'warning', link: `/provider/events/${event.id}`,
      });
    }
    await Event.update({ holdReminders: reminders }, { where: { id: event.id } });
  }

  static async publicSummary(event) {
    await this.reconcileStale(event.id);
    const fundings = await this.fundingsFor(event.id);
    const states = dayStates(event, fundings);
    const fee = this.feeFunding(fundings);
    const pendingCheckout = fundings.find((funding) => funding.source === 'paymob'
      && LIVE_CHECKOUT.includes(funding.collectionStatus)) || null;
    const wage = seatDayAmounts(event);
    return {
      eventId: event.id,
      fundingMode: 'preauth',
      eventStatus: event.status,
      protection: preauthProtection(event, states),
      requiredCount: event.requiredCount,
      dayCount: dayCount(event),
      perUsherDayAmount: egp(wage.grossAmountCents),
      perUsherDayWage: egp(wage.usherAmountCents),
      perUsherDayFee: egp(wage.platformFeeCents),
      fee: {
        amount: egp(preauthFeeCents(event)),
        paid: Boolean(fee),
        refundable: false,
        funding: fee ? fee.toJSON() : null,
        pendingCheckout: pendingCheckout?.kind === 'fee' ? pendingCheckout.toJSON() : null,
      },
      days: states.map((day) => ({
        dayIndex: day.dayIndex,
        date: day.date,
        state: day.state,
        holdAmount: egp(day.holdCents),
        capturedAmount: day.funding?.capturedCents !== null && day.funding?.capturedCents !== undefined ? egp(day.funding.capturedCents) : null,
        opensAt: day.opensAt,
        deadline: day.deadline,
        captureDueAt: day.captureDueAt,
        funding: day.funding ? day.funding.toJSON() : null,
        pendingCheckout: pendingCheckout?.kind === 'day_hold' && pendingCheckout.dayIndex === day.dayIndex ? pendingCheckout.toJSON() : null,
      })),
      holdLeadDays: 5,
      captureAfterHours: 24,
      fundsReleasedAt: event.fundsReleasedAt,
      fundings: fundings.map((funding) => funding.toJSON()),
    };
  }
}
