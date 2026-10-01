import test from 'node:test';
import assert from 'node:assert/strict';
import {
    checkInStatusAt,
    eventDayRange,
    eventEndsAt,
    eventStartsAt,
    hasEventEnded,
    zonedTimeToUtc,
} from '../src/utils/eventSchedule.js';

const event = { eventDate: '2026-10-05T00:00:00.000Z', startTime: '18:00', endTime: '23:00' };

test('event times are interpreted in the platform time zone', () => {
    // Cairo is UTC+3 on this date (summer time).
    assert.equal(eventStartsAt(event, 'Africa/Cairo').toISOString(), '2026-10-05T15:00:00.000Z');
    assert.equal(eventEndsAt(event, 'Africa/Cairo').toISOString(), '2026-10-05T20:00:00.000Z');
    assert.equal(zonedTimeToUtc(2026, 0, 15, 9, 0, 'Africa/Cairo').toISOString(), '2026-01-15T07:00:00.000Z');
});

test('an event ending after midnight ends the next day', () => {
    const overnight = { ...event, startTime: '22:00', endTime: '02:00' };
    assert.equal(eventEndsAt(overnight, 'Africa/Cairo').toISOString(), '2026-10-05T23:00:00.000Z');
});

test('missing times fall back to the whole day', () => {
    const untimed = { eventDate: event.eventDate };
    assert.equal(eventStartsAt(untimed, 'UTC').toISOString(), '2026-10-05T00:00:00.000Z');
    assert.equal(eventEndsAt(untimed, 'UTC').toISOString(), '2026-10-05T23:59:00.000Z');
});

test('check-in opens two hours before start, turns late after 15 minutes, and closes after the event', () => {
    process.env.APP_TIMEZONE = 'Africa/Cairo';
    assert.equal(checkInStatusAt(event, new Date('2026-10-04T15:00:00Z')), 'early');
    assert.equal(checkInStatusAt(event, new Date('2026-10-05T12:59:00Z')), 'early');
    assert.equal(checkInStatusAt(event, new Date('2026-10-05T13:00:00Z')), 'present');
    assert.equal(checkInStatusAt(event, new Date('2026-10-05T15:15:00Z')), 'present');
    assert.equal(checkInStatusAt(event, new Date('2026-10-05T15:16:00Z')), 'late');
    assert.equal(checkInStatusAt(event, new Date('2026-10-05T22:00:00Z')), 'late');
    assert.equal(checkInStatusAt(event, new Date('2026-10-05T22:01:00Z')), 'closed');
    assert.equal(hasEventEnded(event, new Date('2026-10-05T19:59:00Z')), false);
    assert.equal(hasEventEnded(event, new Date('2026-10-05T20:00:00Z')), true);
    delete process.env.APP_TIMEZONE;
});

test('event day range covers the stored calendar day', () => {
    const { start, end } = eventDayRange('2026-10-05T00:00:00.000Z');
    assert.equal(start.toISOString(), '2026-10-05T00:00:00.000Z');
    assert.equal(end.toISOString(), '2026-10-06T00:00:00.000Z');
});
