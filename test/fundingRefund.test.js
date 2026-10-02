import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PG_URI ||= 'postgres://test:test@localhost:5432/funding_refund_tests';
process.env.JWT_SECRET_KEY ||= 'funding-refund-tests-secret-at-least-32-characters';
const { allocateReturn } = await import('../src/services/funding-refund.service.js');

const funding = (id, source, amountCents, day, collectionStatus = 'paid') => ({
    id, source, amountCents, collectionStatus, createdAt: new Date(Date.UTC(2026, 9, day)),
});

test('returned money goes back to the paying cards, latest first, and only the rest to credit', () => {
    const fundings = [funding('card-1', 'paymob', 100000, 1), funding('credit', 'credit', 50000, 2), funding('card-2', 'paymob', 30000, 3)];
    const plan = allocateReturn({ amountCents: 120000, fundings });
    assert.deepEqual(plan.refunds.map(({ funding: row, amountCents }) => [row.id, amountCents]), [['card-2', 30000], ['card-1', 90000]]);
    assert.equal(plan.creditCents, 0);

    const beyondCards = allocateReturn({ amountCents: 150000, fundings, refundedByFunding: new Map([['card-1', 90000]]) });
    assert.deepEqual(beyondCards.refunds.map(({ funding: row, amountCents }) => [row.id, amountCents]), [['card-2', 30000], ['card-1', 10000]]);
    assert.equal(beyondCards.creditCents, 110000);

    const unpaid = allocateReturn({ amountCents: 5000, fundings: [funding('card-3', 'paymob', 5000, 1, 'refunded')] });
    assert.equal(unpaid.refunds.length, 0);
    assert.equal(unpaid.creditCents, 5000);
});
