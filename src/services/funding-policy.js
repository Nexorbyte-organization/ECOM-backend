// Business rules for advance event funding, kept free of database access so they can be tested
// directly. Amounts are integer piasters (cents).
import { eventEndsAt, eventStartsAt } from '../utils/eventSchedule.js';
import { calculateSettlementLineAmounts, splitPlatformFee } from './settlement.service.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// A standard organization must fund the full team before confirming it; later hires or pay rises
// are due this long before the event starts.
export const FUNDING_DEADLINE_HOURS = 48;
// An usher marked absent can dispute the mark for this long after the payments are released.
export const DISPUTE_WINDOW_HOURS = 72;
// Share of the funding credited back to the organization when an admin cancels the event, by how
// far ahead of the start the cancellation happens. The rest compensates the hired ushers.
export const CANCELLATION_TIERS = [
  { minHoursBeforeStart: 72, refundPercent: 100 },
  { minHoursBeforeStart: 24, refundPercent: 50 },
  { minHoursBeforeStart: -Infinity, refundPercent: 0 },
];
export const TRUSTED_MIN_PAID_EVENTS = 3;
export const PAY_AFTER_OVERDUE_DAYS = 7;
export const LOST_DISPUTE_LOOKBACK_DAYS = 90;

export const PAYABLE_ATTENDANCE = ['present', 'late'];

export const perUsherGrossCents = (budget) => calculateSettlementLineAmounts(budget).grossAmountCents;

export const fundingRequiredCents = (event) => {
  const hiredCount = (event.hiredTalents || []).length;
  return hiredCount ? hiredCount * perUsherGrossCents(event.budget) : 0;
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

// Decides how held funding is paid out after the event. Every hired usher must have an
// attendance mark (or `unmarkedAs` decides it), and the funding must cover the whole team.
export const planRelease = ({ hiredTalentIds, attendanceByTalent, perUsherCents, fundedCents, unmarkedAs = null }) => {
  const ushers = [...new Set(hiredTalentIds || [])];
  const payable = [];
  const absent = [];
  const unmarked = [];
  for (const talentId of ushers) {
    const attendance = attendanceByTalent.get(talentId);
    const status = attendance?.status || unmarkedAs;
    if (PAYABLE_ATTENDANCE.includes(status)) payable.push({ talentId, attendanceStatus: status, ...splitPlatformFee(perUsherCents) });
    else if (status === 'absent') absent.push({ talentId, amountCents: perUsherCents });
    else unmarked.push(talentId);
  }
  const requiredCents = ushers.length * perUsherCents;
  const blockers = [];
  if (unmarked.length) blockers.push({ code: 'unmarked_attendance', talentIds: unmarked });
  if (fundedCents < requiredCents) blockers.push({ code: 'underfunded', shortfallCents: requiredCents - fundedCents });
  return {
    payable,
    absent,
    unmarked,
    blockers,
    requiredCents,
    surplusCents: Math.max(0, fundedCents - requiredCents),
  };
};

export const payAfterOverdueAt = (event) => {
  const endsAt = eventEndsAt(event);
  return endsAt ? new Date(endsAt.getTime() + PAY_AFTER_OVERDUE_DAYS * DAY_MS) : null;
};

export const lostDisputeSince = (now = new Date()) => new Date(now.getTime() - LOST_DISPUTE_LOOKBACK_DAYS * DAY_MS);

// Trusted organizations may pay after the event. An admin override always wins.
export const evaluateTier = ({ override = null, paidEventsCount, overdueEventsCount, lostDisputesCount, creditBalanceCents }) => {
  const reasons = [];
  if (paidEventsCount < TRUSTED_MIN_PAID_EVENTS) reasons.push('not_enough_paid_events');
  if (overdueEventsCount > 0) reasons.push('overdue_payment');
  if (lostDisputesCount > 0) reasons.push('lost_attendance_dispute');
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
    lostDisputesCount,
  };
};
