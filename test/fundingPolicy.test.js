import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PG_URI ||= 'postgres://test:test@localhost:5432/funding_policy_tests';
process.env.JWT_SECRET_KEY ||= 'funding-policy-tests-secret-at-least-32-characters';
process.env.APP_TIMEZONE = 'Africa/Cairo';
const {
    cancellationRefundPercent,
    evaluateTier,
    eventDayCount,
    fundingDeadline,
    minimumBudget,
    paymentProtection,
    planCancellation,
    planRelease,
    planUnfundedSeatDrops,
    releaseDueAt,
    summarizeFunding,
} = await import('../src/services/funding-policy.js');

const event = (overrides = {}) => ({
    eventDate: '2026-10-20T00:00:00.000Z', startTime: '10:00', endTime: '18:00',
    budget: 500, hiredTalents: ['a', 'b', 'c'], fundingMode: 'prefund', status: 'open', fundsReleasedAt: null,
    ...overrides,
});
const paid = (amountCents, extra = {}) => ({ source: 'paymob', collectionStatus: 'paid', amountCents, ...extra });

test('funding counts only paid rows and reports shortfall, surplus, and pending checkout', () => {
    const summary = summarizeFunding(event(), [
        paid(100000),
        { source: 'credit', collectionStatus: 'paid', amountCents: 20000 },
        { source: 'paymob', collectionStatus: 'failed', amountCents: 99999 },
        { source: 'paymob', collectionStatus: 'refunded', amountCents: 50000 },
        { source: 'paymob', collectionStatus: 'pending', amountCents: 30000 },
    ], new Date('2026-10-01T00:00:00Z'));
    assert.equal(summary.requiredCents, 150000);
    assert.equal(summary.fundedCents, 120000);
    assert.equal(summary.shortfallCents, 30000);
    assert.equal(summary.surplusCents, 0);
    assert.equal(summary.pendingCheckout.amountCents, 30000);
    assert.equal(summary.overdue, false);

    const overfunded = summarizeFunding(event({ hiredTalents: ['a'] }), [paid(150000)]);
    assert.equal(overfunded.shortfallCents, 0);
    assert.equal(overfunded.surplusCents, 100000);
    assert.equal(overfunded.fullyFunded, true);
});

test('the funding deadline is 48 hours before the start in the platform time zone', () => {
    // 10:00 Cairo (UTC+3 on this date) is 07:00 UTC.
    assert.equal(fundingDeadline(event()).toISOString(), '2026-10-18T07:00:00.000Z');
    const underfunded = event();
    assert.equal(summarizeFunding(underfunded, [], new Date('2026-10-18T06:59:00Z')).overdue, false);
    assert.equal(summarizeFunding(underfunded, [], new Date('2026-10-18T07:00:00Z')).overdue, true);
    assert.equal(summarizeFunding({ ...underfunded, fundingMode: 'pay_after' }, [], new Date('2026-10-19T00:00:00Z')).overdue, false);
    assert.equal(summarizeFunding({ ...underfunded, status: 'cancelled' }, [], new Date('2026-10-19T00:00:00Z')).shortfallCents, 0);
});

test('ushers see whether their pay is secured', () => {
    assert.equal(paymentProtection(event(), summarizeFunding(event(), [])), 'awaiting_funding');
    assert.equal(paymentProtection(event(), summarizeFunding(event(), [paid(150000)])), 'secured');
    assert.equal(paymentProtection(event({ fundingMode: 'pay_after' }), summarizeFunding(event(), [])), 'pay_after');
    const released = event({ fundsReleasedAt: new Date() });
    assert.equal(paymentProtection(released, summarizeFunding(released, [paid(150000)])), 'released');
});

test('cancellation refund depends on how far ahead the event starts', () => {
    const start = new Date('2026-10-20T07:00:00Z');
    const hoursBefore = (hours) => new Date(start.getTime() - hours * 3600000);
    assert.equal(cancellationRefundPercent(event(), hoursBefore(100)), 100);
    assert.equal(cancellationRefundPercent(event(), hoursBefore(72)), 100);
    assert.equal(cancellationRefundPercent(event(), hoursBefore(71.9)), 50);
    assert.equal(cancellationRefundPercent(event(), hoursBefore(24)), 50);
    assert.equal(cancellationRefundPercent(event(), hoursBefore(23)), 0);
    assert.equal(cancellationRefundPercent(event(), hoursBefore(-5)), 0);
});

test('cancellation splits funding into credit and per-usher compensation with the platform fee', () => {
    const half = planCancellation({ fundedCents: 150000, hiredTalentIds: ['a', 'b', 'c'], perUsherCents: 50000, refundPercent: 50 });
    assert.equal(half.compensation.length, 3);
    assert.deepEqual(half.compensation[0], { talentId: 'a', grossAmountCents: 25000, platformFeeCents: 1250, usherAmountCents: 23750 });
    assert.equal(half.creditCents, 75000);

    const full = planCancellation({ fundedCents: 150000, hiredTalentIds: ['a', 'b', 'c'], perUsherCents: 50000, refundPercent: 100 });
    assert.equal(full.compensation.length, 0);
    assert.equal(full.creditCents, 150000);

    // Underfunded: compensation shares what was actually paid; surplus from excused ushers is credited.
    const short = planCancellation({ fundedCents: 40000, hiredTalentIds: ['a', 'b'], perUsherCents: 50000, refundPercent: 0 });
    assert.equal(short.compensationCents, 40000);
    assert.equal(short.creditCents, 0);
    const surplus = planCancellation({ fundedCents: 150000, hiredTalentIds: ['a'], perUsherCents: 50000, refundPercent: 0 });
    assert.equal(surplus.compensationCents, 50000);
    assert.equal(surplus.creditCents, 100000);

    const nobody = planCancellation({ fundedCents: 150000, hiredTalentIds: [], perUsherCents: 50000, refundPercent: 0 });
    assert.equal(nobody.creditCents, 150000);
});

test('release pays ushers who checked in and keeps the booking fee for no-shows', () => {
    // 30 booked at 1,000 EGP, 20 attended: 19,000 to ushers, 1,500 fee, 9,500 returned.
    const hired = Array.from({ length: 30 }, (_, index) => `u${index}`);
    const attended = new Map(hired.slice(0, 20).map((id, index) => [id, { status: index % 5 ? 'present' : 'late' }]));
    const plan = planRelease({ hiredTalentIds: hired, attendanceByTalent: attended, perUsherCents: 100000, fundedCents: 3000000 });
    assert.equal(plan.payable.length, 20);
    assert.equal(plan.payable.reduce((total, line) => total + line.usherAmountCents, 0), 1900000);
    assert.equal(plan.payable.reduce((total, line) => total + line.platformFeeCents, 0) + plan.noShowFeeCents, 150000);
    assert.equal(plan.noShows.length, 10);
    assert.equal(plan.noShowWageCents, 950000);
    assert.equal(plan.returnCents, 950000);
    assert.deepEqual(plan.blockers, []);

    // Absent and missing records are both no-shows; surplus funding returns too.
    const attendance = new Map([['a', { status: 'present' }], ['c', { status: 'absent' }]]);
    const mixed = planRelease({ hiredTalentIds: ['a', 'b', 'c', 'a'], attendanceByTalent: attendance, perUsherCents: 50000, fundedCents: 200000 });
    assert.deepEqual(mixed.payable.map((line) => line.talentId), ['a']);
    assert.deepEqual(mixed.noShows.map((line) => line.talentId), ['b', 'c']);
    assert.equal(mixed.surplusCents, 50000);
    assert.equal(mixed.returnCents, 2 * 47500 + 50000);

    const underfunded = planRelease({ hiredTalentIds: ['a', 'b'], attendanceByTalent: attendance, perUsherCents: 50000, fundedCents: 60000 });
    assert.deepEqual(underfunded.blockers, [{ code: 'underfunded', shortfallCents: 40000 }]);
});

test('unfunded bookings are dropped latest first', () => {
    assert.deepEqual(planUnfundedSeatDrops({ hiredTalentIds: ['a', 'b', 'c'], perUsherCents: 50000, fundedCents: 100000 }), ['c']);
    assert.deepEqual(planUnfundedSeatDrops({ hiredTalentIds: ['a', 'b'], perUsherCents: 50000, fundedCents: 0 }), ['a', 'b']);
    assert.deepEqual(planUnfundedSeatDrops({ hiredTalentIds: ['a', 'b'], perUsherCents: 50000, fundedCents: 100000 }), []);
});

test('pay must be at least 600 EGP for each event day, and release is due a day after the end', () => {
    assert.equal(eventDayCount(event()), 1);
    assert.equal(minimumBudget(event()), 600);
    // 18:00 Cairo is 15:00 UTC; release is due 24 hours later.
    assert.equal(releaseDueAt(event()).toISOString(), '2026-10-21T15:00:00.000Z');
});

test('trust needs three paid events and a clean record; an admin override wins', () => {
    const clean = { paidEventsCount: 3, overdueEventsCount: 0, creditBalanceCents: 0 };
    assert.equal(evaluateTier(clean).tier, 'trusted');
    assert.deepEqual(evaluateTier({ ...clean, paidEventsCount: 2 }).reasons, ['not_enough_paid_events']);
    assert.equal(evaluateTier({ ...clean, overdueEventsCount: 1 }).tier, 'standard');
    assert.equal(evaluateTier({ ...clean, creditBalanceCents: -1 }).tier, 'standard');
    assert.equal(evaluateTier({ ...clean, paidEventsCount: 0, override: 'trusted' }).tier, 'trusted');
    const forced = evaluateTier({ ...clean, override: 'standard' });
    assert.equal(forced.tier, 'standard');
    assert.equal(forced.automaticTier, 'trusted');
});
