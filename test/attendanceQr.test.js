import test from 'node:test';
import assert from 'node:assert/strict';
import {
    attendanceQrMatchesEvent,
    createAttendanceQrToken,
    parseAttendanceQrToken,
} from '../src/utils/attendanceQr.js';

process.env.JWT_SECRET_KEY = 'attendance-qr-test-secret-at-least-32-characters';

const event = {
    id: '43575802-c57f-451a-b3ed-086b55f90d4c',
    attendanceQrCreatedAt: new Date('2030-03-01T10:00:00.000Z'),
};

test('attendance QR token is deterministic and bound to one event generation', () => {
    const token = createAttendanceQrToken(event);
    assert.equal(createAttendanceQrToken(event), token);
    assert.deepEqual(parseAttendanceQrToken(token), {
        eventId: event.id,
        generatedAt: event.attendanceQrCreatedAt.getTime(),
    });
    assert.equal(attendanceQrMatchesEvent(token, event), true);
});

test('attendance QR validation rejects tampered and regenerated tokens', () => {
    const token = createAttendanceQrToken(event);
    assert.equal(parseAttendanceQrToken(`${token.slice(0, -1)}x`), null);
    assert.equal(attendanceQrMatchesEvent(token, {
        ...event,
        attendanceQrCreatedAt: new Date('2030-03-01T10:00:01.000Z'),
    }), false);
});
