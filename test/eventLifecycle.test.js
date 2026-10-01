import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PG_URI ||= 'postgres://test:test@localhost:5432/event_lifecycle_tests';
process.env.JWT_SECRET_KEY ||= 'event-lifecycle-tests-secret-at-least-32-characters';
const { canTransitionEvent } = await import('../src/services/event.service.js');
const { assertCanTakeNewBookings, LATE_EXCUSE_LIMIT } = await import('../src/services/application-decision.service.js');

test('cancelled events are final and completed events cannot reopen applications', () => {
    for (const status of ['open', 'confirmed', 'completed']) assert.equal(canTransitionEvent('cancelled', status), false);
    assert.equal(canTransitionEvent('completed', 'open'), false);
    assert.equal(canTransitionEvent('completed', 'confirmed'), true);
    assert.equal(canTransitionEvent('open', 'completed'), true);
    assert.equal(canTransitionEvent('confirmed', 'open'), true);
    assert.equal(canTransitionEvent('open', 'open'), true);
});

test('ushers at the late-excuse limit cannot take new bookings', () => {
    assert.doesNotThrow(() => assertCanTakeNewBookings({ lateExcuseCount: LATE_EXCUSE_LIMIT - 1 }));
    assert.throws(() => assertCanTakeNewBookings({ lateExcuseCount: LATE_EXCUSE_LIMIT }), /late excuses/);
});
