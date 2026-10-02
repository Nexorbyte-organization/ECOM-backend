import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PG_URI ||= 'postgres://test:test@localhost:5432/check_in_tests';
process.env.JWT_SECRET_KEY ||= 'check-in-tests-secret-at-least-32-characters';
const {
    CODE_STEP_SECONDS,
    codeStep,
    distanceMeters,
    isWithinRadius,
    numericCodeFor,
    numericCodeMatchesPoint,
    pointReportedSince,
    qrTokenFor,
    qrTokenMatchesPoint,
} = await import('../src/utils/checkInCode.js');
const { suspensionUntil } = await import('../src/services/attendance.service.js');

const point = { id: 'point-1', secret: 'a'.repeat(64), active: true };
const stepMs = CODE_STEP_SECONDS * 1000;

test('rotating QR tokens and codes expire after a short grace', () => {
    const now = 1_800_000_000_000;
    const token = qrTokenFor(point, codeStep(now));
    assert.equal(qrTokenMatchesPoint(token, point, now), true);
    assert.equal(qrTokenMatchesPoint(token, point, now + 2 * stepMs), true);
    assert.equal(qrTokenMatchesPoint(token, point, now + 3 * stepMs), false);
    assert.equal(qrTokenMatchesPoint(token, { ...point, secret: 'b'.repeat(64) }, now), false);
    assert.equal(qrTokenMatchesPoint(`${token}x`, point, now), false);

    const code = numericCodeFor(point, codeStep(now));
    assert.match(code, /^\d{6}$/);
    assert.equal(numericCodeMatchesPoint(code, point, now + stepMs), true);
    assert.equal(numericCodeMatchesPoint(code, point, now + 3 * stepMs), false);
});

test('location must be within 200 m of a staff phone that reported recently', () => {
    const staff = { latitude: 30.0444, longitude: 31.2357 };
    const near = { latitude: 30.0454, longitude: 31.2357 }; // ~111 m north
    const far = { latitude: 30.0474, longitude: 31.2357 }; // ~333 m north
    assert.ok(Math.abs(distanceMeters(staff, near) - 111) < 2);
    assert.equal(isWithinRadius(near, staff), true);
    assert.equal(isWithinRadius(far, staff), false);
    assert.equal(isWithinRadius(near, { latitude: null, longitude: null }), false);

    const now = Date.now();
    const reported = { ...point, ...staff, locationUpdatedAt: new Date(now - 60_000) };
    assert.equal(pointReportedSince(reported, 3 * 60_000, now), true);
    assert.equal(pointReportedSince({ ...reported, locationUpdatedAt: new Date(now - 10 * 60_000) }, 3 * 60_000, now), false);
    assert.equal(pointReportedSince({ ...reported, active: false }, 3 * 60_000, now), false);
});

test('three no-shows within 90 days suspend bookings for 30 days from the latest', () => {
    const now = new Date('2026-10-02T12:00:00Z');
    const daysAgo = (days) => new Date(now.getTime() - days * 86400000);
    assert.equal(suspensionUntil([daysAgo(1), daysAgo(10)], now), null);
    assert.equal(suspensionUntil([daysAgo(1), daysAgo(10), daysAgo(100)], now), null);
    assert.equal(suspensionUntil([daysAgo(2), daysAgo(10), daysAgo(80)], now).toISOString(), '2026-10-30T12:00:00.000Z');
    // The suspension lifts on its own.
    assert.equal(suspensionUntil([daysAgo(31), daysAgo(40), daysAgo(50)], now), null);
});
