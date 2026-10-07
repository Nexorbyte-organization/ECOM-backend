// Business rules for card-hold ("preauth") event payments, kept free of database and Paymob access
// so they can be tested directly. Amounts are integer piasters (cents).
//
// The organization pays the platform fee for the whole booking up front as an ordinary charge that
// is never refunded. The usher wages (the rest of the pay) are never charged in advance: a card
// hold is placed for one event day at a time shortly before that day, because a card hold only
// lasts about a week. Each hold is captured after its day for the ushers who checked in, and the
// unused part of the hold is released.
import { dayEndsAt, dayStartsAt, eventDays } from '../utils/eventSchedule.js';
import { CANCELLATION_TIERS, PAYABLE_ATTENDANCE, perUsherDayCents } from './funding-policy.js';
import { splitPlatformFee } from './settlement.service.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const PREAUTH_MODE = 'preauth';
// A day's hold can be placed from this long before the day starts (card holds last about 7 days).
export const HOLD_LEAD_DAYS = 5;
// A day with no hold this long before it starts is unsecured: its ushers are not covered.
export const HOLD_DEADLINE_HOURS = 24;
// The hold is captured this long after the day ends, once check-in has closed.
export const CAPTURE_AFTER_DAY_END_HOURS = 24;
// Reminders to place a hold are sent at most this often.
export const HOLD_REMINDER_HOURS = 24;

export const isPreauthEvent = (event) => event?.fundingMode === PREAUTH_MODE;

// Each seat is booked for every day, so fee and wage are worked out per usher per day.
export const seatDayAmounts = (event) => splitPlatformFee(perUsherDayCents(event));

const seatCount = (event) => Math.max(0, Number(event.requiredCount) || 0);

// Charged once at creation on the full team size and every day; never refunded.
export const preauthFeeCents = (event) => seatCount(event) * eventDays(event).length * seatDayAmounts(event).platformFeeCents;

// The hold for one day covers the wage of every seat, so ushers hired later are covered too.
export const dayHoldCents = (event) => seatCount(event) * seatDayAmounts(event).usherAmountCents;

export const dayCount = (event) => Math.max(1, eventDays(event).length);

const dayAt = (event, dayIndex) => eventDays(event)[dayIndex] || null;

export const dayStartOf = (event, dayIndex) => dayStartsAt(dayAt(event, dayIndex));
export const dayEndOf = (event, dayIndex) => dayEndsAt(dayAt(event, dayIndex));
export const holdOpensAt = (event, dayIndex) => new Date(dayStartOf(event, dayIndex).getTime() - HOLD_LEAD_DAYS * DAY_MS);
export const holdDeadline = (event, dayIndex) => new Date(dayStartOf(event, dayIndex).getTime() - HOLD_DEADLINE_HOURS * HOUR_MS);
export const captureDueAt = (event, dayIndex) => new Date(dayEndOf(event, dayIndex).getTime() + CAPTURE_AFTER_DAY_END_HOURS * HOUR_MS);

export const HOLD_LIVE_STATUSES = ['pending', 'authorized', 'closing', 'paid'];

// Where each day stands. `fundings` are the event's funding rows; only day holds are considered.
export const dayStates = (event, fundings, now = new Date()) => eventDays(event).map((day, dayIndex) => {
  const holds = fundings.filter((funding) => funding.kind === 'day_hold' && funding.dayIndex === dayIndex);
  const live = holds.find((hold) => HOLD_LIVE_STATUSES.includes(hold.collectionStatus));
  const voided = holds.find((hold) => hold.collectionStatus === 'voided');
  let state;
  if (live?.collectionStatus === 'paid') state = 'captured';
  else if (voided) state = 'voided';
  else if (live?.collectionStatus === 'authorized' || live?.collectionStatus === 'closing') state = 'authorized';
  else if (live?.collectionStatus === 'pending') state = 'pending';
  else if (now < holdOpensAt(event, dayIndex)) state = 'scheduled';
  else if (now >= holdDeadline(event, dayIndex)) state = 'unsecured';
  else state = 'awaiting_hold';
  return {
    dayIndex,
    date: day.date,
    state,
    holdCents: dayHoldCents(event),
    opensAt: holdOpensAt(event, dayIndex),
    deadline: holdDeadline(event, dayIndex),
    captureDueAt: captureDueAt(event, dayIndex),
    funding: live || voided || null,
  };
});

// What hired ushers see about their pay: secured only for days whose hold is in place.
export const preauthProtection = (event, states) => {
  if (event.fundsReleasedAt) return 'released';
  const upcoming = states.filter((day) => !['captured', 'voided'].includes(day.state));
  if (!upcoming.length) return 'released';
  if (upcoming.every((day) => day.state === 'authorized' || day.state === 'pending' || day.state === 'scheduled')) {
    return upcoming.some((day) => day.state === 'scheduled') ? 'hold_pending' : 'secured';
  }
  return 'awaiting_funding';
};

// Pays the ushers who checked in on a day from that day's hold. `records` are the day's attendance
// rows. A missed day costs the organization nothing beyond the fee already kept.
export const planDayCapture = ({ hiredTalentIds, records, wagePerUsherCents, authorizedCents }) => {
  const hired = new Set(hiredTalentIds || []);
  const byTalent = new Map();
  for (const record of records) {
    if (!hired.has(record.talentId) || !PAYABLE_ATTENDANCE.includes(record.status)) continue;
    const previous = byTalent.get(record.talentId);
    if (!previous || record.status === 'late') byTalent.set(record.talentId, record);
  }
  const payable = [...byTalent.entries()].map(([talentId, record]) => ({
    talentId, attendanceStatus: record.status, usherAmountCents: wagePerUsherCents,
  }));
  const captureCents = Math.min(authorizedCents, payable.length * wagePerUsherCents);
  return { payable, captureCents, voidCents: authorizedCents - captureCents };
};

// Share of an unused day's wage paid to each hired usher when the event is cancelled, by how far
// ahead of that day the cancellation happens (the same tiers as before: 72h+ none, 24-72h half,
// under 24h all).
export const cancellationCompensationPercent = (event, dayIndex, now = new Date()) => {
  const hoursBefore = (dayStartOf(event, dayIndex).getTime() - now.getTime()) / HOUR_MS;
  const tier = CANCELLATION_TIERS.find((candidate) => hoursBefore >= candidate.minHoursBeforeStart);
  return 100 - tier.refundPercent;
};

export const planDayCancellation = ({ hiredTalentIds, wagePerUsherCents, authorizedCents, compensationPercent }) => {
  const ushers = [...new Set(hiredTalentIds || [])];
  const wanted = Math.round(wagePerUsherCents * (compensationPercent / 100));
  const perUsherCents = ushers.length ? Math.min(wanted, Math.floor(authorizedCents / ushers.length)) : 0;
  const captureCents = perUsherCents * ushers.length;
  return { ushers, perUsherCents, captureCents, voidCents: authorizedCents - captureCents, compensationPercent };
};
