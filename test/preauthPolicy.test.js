import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PG_URI ||= 'postgres://test:test@localhost:5432/preauth_policy_tests';
process.env.JWT_SECRET_KEY ||= 'preauth-policy-tests-secret-at-least-32-characters';
process.env.APP_TIMEZONE = 'Africa/Cairo';
const policy = await import('../src/services/preauth-policy.js');
const paymob = await import('../src/services/paymob.service.js');

const day = (date) => ({ date, startTime: '10:00', endTime: '18:00' });
// 3 seats, 600 EGP per usher per day, 3 days. Fee 5% = 30 EGP, wage 570 EGP per seat-day.
const event = (overrides = {}) => ({
    id: 'event-1', fundingMode: 'preauth', status: 'open', requiredCount: 3, budget: 600,
    days: [day('2026-10-20'), day('2026-10-21'), day('2026-10-22')], hiredTalents: ['a', 'b'],
    ...overrides,
});

test('the fee covers every seat and day, and a day hold covers the wage of every seat', () => {
    assert.equal(policy.preauthFeeCents(event()), 3 * 3 * 3000);
    assert.equal(policy.dayHoldCents(event()), 3 * 57000);
    assert.equal(policy.preauthFeeCents(event()) + 3 * policy.dayHoldCents(event()), 3 * 3 * 60000);
});

test('a hold opens 5 days before its day, is due 24h before, and is captured 24h after it ends', () => {
    const e = event();
    const start = policy.dayStartOf(e, 1);
    assert.equal(start - policy.holdOpensAt(e, 1), 5 * 24 * 3600 * 1000);
    assert.equal(start - policy.holdDeadline(e, 1), 24 * 3600 * 1000);
    assert.equal(policy.captureDueAt(e, 1) - policy.dayEndOf(e, 1), 24 * 3600 * 1000);
});

test('each day is scheduled, awaiting its hold, authorized, captured, or unsecured', () => {
    const e = event();
    const hold = (dayIndex, collectionStatus) => ({ kind: 'day_hold', dayIndex, collectionStatus });
    const now = new Date('2026-10-16T12:00:00Z');
    const states = (fundings, at = now) => policy.dayStates(e, fundings, at).map((item) => item.state);
    assert.deepEqual(states([]), ['awaiting_hold', 'awaiting_hold', 'scheduled']);
    assert.deepEqual(states([hold(0, 'authorized'), hold(1, 'paid')]), ['authorized', 'captured', 'scheduled']);
    assert.deepEqual(states([hold(0, 'pending')]), ['pending', 'awaiting_hold', 'scheduled']);
    assert.deepEqual(states([hold(0, 'failed')]), ['awaiting_hold', 'awaiting_hold', 'scheduled']);
    assert.deepEqual(states([hold(0, 'voided')]), ['voided', 'awaiting_hold', 'scheduled']);
    assert.equal(states([], new Date('2026-10-19T12:00:00Z'))[0], 'unsecured');
});

test('ushers see their pay as secured only when every upcoming day is covered', () => {
    const e = event();
    const states = (list) => list.map((state) => ({ state }));
    assert.equal(policy.preauthProtection(e, states(['authorized', 'scheduled'])), 'hold_pending');
    assert.equal(policy.preauthProtection(e, states(['authorized', 'authorized'])), 'secured');
    assert.equal(policy.preauthProtection(e, states(['captured', 'awaiting_hold'])), 'awaiting_funding');
    assert.equal(policy.preauthProtection(e, states(['captured', 'unsecured'])), 'awaiting_funding');
    assert.equal(policy.preauthProtection(e, states(['captured', 'voided'])), 'released');
});

test('a day capture pays only hired ushers who checked in, once each, and releases the rest', () => {
    const plan = policy.planDayCapture({
        hiredTalentIds: ['a', 'b', 'c'],
        records: [
            { talentId: 'a', status: 'present' }, { talentId: 'a', status: 'late' },
            { talentId: 'b', status: 'absent' }, { talentId: 'z', status: 'present' },
        ],
        wagePerUsherCents: 57000, authorizedCents: 3 * 57000,
    });
    assert.deepEqual(plan.payable, [{ talentId: 'a', attendanceStatus: 'late', usherAmountCents: 57000 }]);
    assert.equal(plan.captureCents, 57000);
    assert.equal(plan.voidCents, 2 * 57000);
    const nobody = policy.planDayCapture({ hiredTalentIds: ['a'], records: [], wagePerUsherCents: 57000, authorizedCents: 57000 });
    assert.equal(nobody.captureCents, 0);
    assert.equal(nobody.voidCents, 57000);
});

test('cancellation compensates by how close the day is, and never beyond the hold', () => {
    const e = event();
    const start = policy.dayStartOf(e, 0);
    const before = (hours) => new Date(start.getTime() - hours * 3600 * 1000);
    assert.equal(policy.cancellationCompensationPercent(e, 0, before(80)), 0);
    assert.equal(policy.cancellationCompensationPercent(e, 0, before(48)), 50);
    assert.equal(policy.cancellationCompensationPercent(e, 0, before(2)), 100);
    const half = policy.planDayCancellation({ hiredTalentIds: ['a', 'b'], wagePerUsherCents: 57000, authorizedCents: 3 * 57000, compensationPercent: 50 });
    assert.equal(half.perUsherCents, 28500);
    assert.equal(half.captureCents, 57000);
    assert.equal(half.voidCents, 3 * 57000 - 57000);
    const none = policy.planDayCancellation({ hiredTalentIds: ['a', 'b'], wagePerUsherCents: 57000, authorizedCents: 3 * 57000, compensationPercent: 0 });
    assert.equal(none.captureCents, 0);
    assert.equal(none.voidCents, 3 * 57000);
});

test('the fee is an ordinary charge while a day hold uses the Auth integration', () => {
    process.env.PAYMOB_AUTH_INTEGRATION_ID = '777';
    const config = { paymentMethods: [111], backendUrl: 'https://api.test', frontendUrl: 'https://app.test' };
    const base = { event: { id: 'e1', title: 'Fair' }, organizer: { id: 'o1', email: 'o@test.dev', fullName: 'Org One' }, config };
    const fee = paymob.buildFundingIntentionPayload({ ...base, funding: { id: 'f1', kind: 'fee', dayIndex: -1, amountCents: 27000, currency: 'EGP', organizerId: 'o1', specialReference: 'OO-FEE-1' } });
    assert.deepEqual(fee.payment_methods, [111]);
    assert.equal(fee.extras.day_index, undefined);
    assert.match(fee.items[0].description, /non-refundable/);
    const hold = paymob.buildFundingIntentionPayload({ ...base, funding: { id: 'f2', kind: 'day_hold', dayIndex: 1, amountCents: 171000, currency: 'EGP', organizerId: 'o1', specialReference: 'OO-HOLD-1' } });
    assert.deepEqual(hold.payment_methods, [777]);
    assert.equal(hold.extras.day_index, 1);
    delete process.env.PAYMOB_AUTH_INTEGRATION_ID;
    assert.throws(() => paymob.buildFundingIntentionPayload({ ...base, funding: { id: 'f2', kind: 'day_hold', dayIndex: 1, amountCents: 1, currency: 'EGP', organizerId: 'o1', specialReference: 'x' } }), /PAYMOB_AUTH_INTEGRATION_ID/);
    assert.equal(paymob.isPreauthConfigured(), false);
});

test('capture and void call Paymob with the authorized transaction', async () => {
    Object.assign(process.env, {
        PAYMOB_SECRET_KEY: 'egy_sk_test_x', PAYMOB_PUBLIC_KEY: 'egy_pk_test_x', PAYMOB_HMAC_SECRET: 'h',
        PAYMOB_INTEGRATION_IDS: '111', BASE_URL: 'https://api.test', FRONTEND_URL: 'https://app.test',
    });
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body), auth: options.headers.Authorization });
        return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
    };
    try {
        await paymob.captureTransaction({ transactionId: '555', amountCents: 57000 });
        await paymob.voidTransaction({ transactionId: '555' });
        await assert.rejects(() => paymob.captureTransaction({ transactionId: null, amountCents: 1 }), /unknown/);
    } finally {
        globalThis.fetch = realFetch;
    }
    assert.equal(calls[0].url, 'https://accept.paymob.com/api/acceptance/capture');
    assert.deepEqual(calls[0].body, { transaction_id: 555, amount_cents: 57000 });
    assert.equal(calls[1].url, 'https://accept.paymob.com/api/acceptance/void_refund/void');
    assert.deepEqual(calls[1].body, { transaction_id: 555 });
    assert.equal(calls[0].auth, 'Token egy_sk_test_x');
});
