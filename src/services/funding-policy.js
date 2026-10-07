// Business rules for advance event funding, kept free of database access so they can be tested
// directly. Amounts are integer piasters (cents).
import { eventDayCount, eventEndsAt, eventStartsAt } from '../utils/eventSchedule.js';
import { calculateSettlementLineAmounts, splitPlatformFee } from './settlement.service.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// A standard organization must fund the full team before confirming it; ushers hired later are
// due this long before the event starts, after which unfunded bookings are cancelled.
export const FUNDING_DEADLINE_HOURS = 48;
// Payments are released automatically this long after the event ends. Until then staff can still
// check in an usher whose phone failed.
export const RELEASE_AFTER_END_HOURS = 24;
// The lowest pay an event may offer each usher for each day it runs.
export const MIN_PAY_PER_DAY_EGP = 600;
// Share of the funding credited back to the organization when an admin cancels the event, by how
// far ahead of the start the cancellation happens. The rest compensates the hired ushers.
export const CANCELLATION_TIERS = [
  { minHoursBeforeStart: 72, refundPercent: 100 },
  { minHoursBeforeStart: 24, refundPercent: 50 },
  { minHoursBeforeStart: -Infinity, refundPercent: 0 },
];
export const TRUSTED_MIN_PAID_EVENTS = 3;
export const PAY_AFTER_OVERDUE_DAYS = 7;

export const PAYABLE_ATTENDANCE = ['present', 'late'];

export { eventDayCount };

// `budget` is the pay per usher for each event day; an usher's full pay covers every day.
export const perUsherDayCents = (event) => calculateSettlementLineAmounts(event.budget).grossAmountCents;
export const perUsherGrossCents = (event) => perUsherDayCents(event) * eventDayCount(event);

export const minimumBudget = () => MIN_PAY_PER_DAY_EGP;

export const releaseDueAt = (event) => {
  const endsAt = eventEndsAt(event);
  return endsAt ? new Date(endsAt.getTime() + RELEASE_AFTER_END_HOURS * HOUR_MS) : null;
};

export const fundingRequiredCents = (event) => {
  const hiredCount = (event.hiredTalents || []).length;
  return hiredCount ? hiredCount * perUsherGrossCents(event) : 0;
};

export const fundingDeadline = (event) => {
  const startsAt = eventStartsAt(event);
  return startsAt ? new Date(startsAt.getTime() - FUNDING_DEADLINE_HOURS * HOUR_MS) : null;
};

// Paid funding counts toward the event; refunded and unfinished checkouts do not.
export const summarizeFunding = (event, fundings, now = new Date()) => {
  const requiredCents = fundingRequiredCents(event);
  const fundedCents = fundings
    .filter((funding) => funding.collectionStatus === 'paid')
    .reduce((total, funding) => total + funding.amountCents, 0);
  const pendingCheckout = fundings.find((funding) => funding.source === 'paymob'
    && ['not_started', 'pending'].includes(funding.collectionStatus)) || null;
  const shortfallCents = Math.max(0, requiredCents - fundedCents);
  const deadline = fundingDeadline(event);
  const released = Boolean(event.fundsReleasedAt);
  const active = !released && event.status !== 'cancelled';
  return {
    fundingMode: event.fundingMode,
    requiredCents,
    fundedCents,
    shortfallCents: active ? shortfallCents : 0,
    surplusCents: Math.max(0, fundedCents - requiredCents),
    fullyFunded: shortfallCents === 0,
    deadline,
    overdue: Boolean(active && event.fundingMode === 'prefund' && shortfallCents > 0 && deadline && now >= deadline),
    released,
    pendingCheckout,
  };
};

// What an usher sees about the money behind their booking.
export const paymentProtection = (event, summary) => {
  if (event.fundingMode === 'pay_after') return 'pay_after';
  if (summary.released) return 'released';
  return summary.fullyFunded ? 'secured' : 'awaiting_funding';
};

export const cancellationRefundPercent = (event, now = new Date()) => {
  const startsAt = eventStartsAt(event);
  const hoursBeforeStart = startsAt ? (startsAt.getTime() - now.getTime()) / HOUR_MS : -Infinity;
  return CANCELLATION_TIERS.find((tier) => hoursBeforeStart >= tier.minHoursBeforeStart).refundPercent;
};

// Splits held funding between the organization's credit and compensation for each hired usher.
// When the event was underfunded, the compensation is shared out of what was actually paid.
export const planCancellation = ({ fundedCents, hiredTalentIds, perUsherCents, refundPercent }) => {
  const ushers = [...new Set(hiredTalentIds || [])];
  const targetPerUsher = Math.round(perUsherCents * ((100 - refundPercent) / 100));
  const perUsher = ushers.length && targetPerUsher > 0
    ? Math.min(targetPerUsher, Math.floor(fundedCents / ushers.length))
    : 0;
  const compensation = perUsher > 0
    ? ushers.map((talentId) => ({ talentId, ...splitPlatformFee(perUsher) }))
    : [];
  return {
    refundPercent,
    compensation,
    compensationCents: perUsher * compensation.length,
    creditCents: fundedCents - perUsher * compensation.length,
  };
};

// Decides how held funding is paid out after the event. Attendance is final by then: a day without
// a present or late record was not worked. Each usher is paid for the days they checked in. The
// platform fee is earned for every booked day, so a missed day returns only its wage; skipping
// check-in therefore saves nothing. `attendanceByTalent` maps an usher to their attendance records
// (or a single record for a one-day event); `perUsherCents` is the pay for one day.
export const planRelease = ({ hiredTalentIds, attendanceByTalent, perUsherCents, fundedCents, dayCount = 1 }) => {
  const ushers = [...new Set(hiredTalentIds || [])];
  const payable = [];
  const noShows = [];
  for (const talentId of ushers) {
    const records = [attendanceByTalent.get(talentId) || []].flat();
    const attended = records.filter((record) => PAYABLE_ATTENDANCE.includes(record.status)
      && Number(record.dayIndex || 0) < dayCount);
    const attendedDays = new Set(attended.map((record) => Number(record.dayIndex || 0))).size;
    const missedDays = dayCount - attendedDays;
    if (attendedDays) {
      payable.push({
        talentId,
        attendanceStatus: attended.some((record) => record.status === 'late') ? 'late' : 'present',
        attendedDays,
        ...splitPlatformFee(perUsherCents * attendedDays),
      });
    }
    if (missedDays) {
      const { platformFeeCents, usherAmountCents } = splitPlatformFee(perUsherCents * missedDays);
      noShows.push({ talentId, missedDays, feeCents: platformFeeCents, wageCents: usherAmountCents });
    }
  }
  const hiredCents = ushers.length * perUsherCents * dayCount;
  const noShowFeeCents = noShows.reduce((total, line) => total + line.feeCents, 0);
  const noShowWageCents = noShows.reduce((total, line) => total + line.wageCents, 0);
  const surplusCents = Math.max(0, fundedCents - hiredCents);
  const blockers = [];
  if (fundedCents < hiredCents) blockers.push({ code: 'underfunded', shortfallCents: hiredCents - fundedCents });
  return {
    payable,
    noShows,
    blockers,
    requiredCents: hiredCents,
    noShowFeeCents,
    noShowWageCents,
    surplusCents,
    returnCents: noShowWageCents + surplusCents,
  };
};

// Bookings the funding does not cover once the deadline passes, latest hires first.
export const planUnfundedSeatDrops = ({ hiredTalentIds, perUsherCents, fundedCents }) => {
  const ushers = [...new Set(hiredTalentIds || [])];
  if (perUsherCents <= 0) return [];
  const fundedSeats = Math.max(0, Math.floor(fundedCents / perUsherCents));
  return ushers.slice(fundedSeats);
};

export const payAfterOverdueAt = (event) => {
  const endsAt = eventEndsAt(event);
  return endsAt ? new Date(endsAt.getTime() + PAY_AFTER_OVERDUE_DAYS * DAY_MS) : null;
};

// Trusted organizations may pay after the event. An admin override always wins.
export const evaluateTier = ({ override = null, paidEventsCount, overdueEventsCount, creditBalanceCents }) => {
  const reasons = [];
  if (paidEventsCount < TRUSTED_MIN_PAID_EVENTS) reasons.push('not_enough_paid_events');
  if (overdueEventsCount > 0) reasons.push('overdue_payment');
  if (creditBalanceCents < 0) reasons.push('negative_credit_balance');
  const automaticTier = reasons.length ? 'standard' : 'trusted';
  return {
    tier: override || automaticTier,
    automaticTier,
    override: override || null,
    reasons,
    paidEventsCount,
    requiredPaidEvents: TRUSTED_MIN_PAID_EVENTS,
    overdueEventsCount,
  };
};
