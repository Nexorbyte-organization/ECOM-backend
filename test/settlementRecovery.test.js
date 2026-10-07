import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PG_URI ||= 'postgres://test:test@localhost:5432/settlement_recovery_tests';
process.env.JWT_SECRET_KEY ||= 'settlement-recovery-tests-secret-at-least-32-characters';
const {
    EXPIRED_CHECKOUT_GRACE_MS,
    STALE_PREPARATION_MS,
    UNVERIFIED_EXPIRY_GRACE_MS,
    staleCheckoutAction,
} = await import('../src/controllers/payment.controller.js');

const now = new Date('2026-10-01T12:00:00Z');
const ago = (ms) => new Date(now.getTime() - ms);

test('an active or recently expired checkout is left alone', () => {
    assert.equal(staleCheckoutAction({ collectionStatus: 'pending', expiresAt: new Date(now.getTime() + 60000) }, now, true), null);
    assert.equal(staleCheckoutAction({ collectionStatus: 'pending', expiresAt: ago(60000), paymobOrderId: '1' }, now, true), null);
    assert.equal(staleCheckoutAction({ collectionStatus: 'paid', expiresAt: ago(UNVERIFIED_EXPIRY_GRACE_MS * 2) }, now, true), null);
});

test('an expired checkout is checked with Paymob when inquiry is configured', () => {
    const settlement = { collectionStatus: 'pending', expiresAt: ago(EXPIRED_CHECKOUT_GRACE_MS + 1000), paymobOrderId: '42' };
    assert.equal(staleCheckoutAction(settlement, now, true), 'inquire');
    assert.equal(staleCheckoutAction(settlement, now, false), null);
});

test('without inquiry an expired checkout fails only after the long grace period', () => {
    const settlement = { collectionStatus: 'pending', expiresAt: ago(UNVERIFIED_EXPIRY_GRACE_MS + 1000), paymobOrderId: '42' };
    assert.equal(staleCheckoutAction(settlement, now, false), 'fail_expired');
});

test('an interrupted checkout preparation becomes restartable', () => {
    assert.equal(staleCheckoutAction({ collectionStatus: 'not_started', updatedAt: ago(60000) }, now), null);
    assert.equal(staleCheckoutAction({ collectionStatus: 'not_started', updatedAt: ago(STALE_PREPARATION_MS + 1000) }, now), 'fail_preparation');
});
