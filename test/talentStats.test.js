import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PG_URI ||= 'postgres://test:test@localhost:5432/talent_stats_tests';
process.env.JWT_SECRET_KEY ||= 'talent-stats-tests-secret-at-least-32-characters';
const { qualifiesForVerification, weightedRating } = await import('../src/services/talent-stats.service.js');

const review = (reviewerId, rating, day) => ({ reviewerId, rating, createdAt: new Date(Date.UTC(2026, 0, day)) });

test('repeat reviews from one organization count a quarter after the first two', () => {
    assert.equal(weightedRating([]), 0);
    assert.equal(weightedRating([review('a', 5, 1), review('b', 3, 2)]), 4);
    // Two full-weight 3s, then eight 5s from the same organization at 0.25 each: (6 + 10) / 4.
    const inflated = [review('a', 3, 1), review('a', 3, 2), ...Array.from({ length: 8 }, (_, i) => review('a', 5, 3 + i))];
    assert.equal(weightedRating(inflated), 4);
});

test('the verified badge needs events from at least three organizations', () => {
    assert.equal(qualifiesForVerification({ attendedEvents: 10, rating: 4.5, organizations: 3 }), true);
    assert.equal(qualifiesForVerification({ attendedEvents: 10, rating: 4.5, organizations: 2 }), false);
    assert.equal(qualifiesForVerification({ attendedEvents: 9, rating: 4.5, organizations: 5 }), false);
    assert.equal(qualifiesForVerification({ attendedEvents: 12, rating: 3.9, organizations: 5 }), false);
});
