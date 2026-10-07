import test from 'node:test';
import assert from 'node:assert/strict';
import {
    checkInDayAt,
    checkInStatusAt,
    checkInWindow,
    closedCheckInDays,
    eventDayCount,
    eventDayRange,
    eventDays,
    eventEndsAt,
    eventStartsAt,
    hasEventEnded,
    normalizeEventDays,
    scheduleFromDays,
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

const threeDays = {
    eventDate: '2026-10-05T00:00:00.000Z',
    startTime: '18:00',
    endTime: '23:00',
    days: [
        { date: '2026-10-07', startTime: '09:00', endTime: '13:00' },
        { date: '2026-10-05', startTime: '18:00', endTime: '23:00' },
        { date: '2026-10-06', startTime: '10:00', endTime: '20:00' },
    ],
};

test('a multi-day event runs from the first day start to the last day end, each day with its own hours', () => {
    process.env.APP_TIMEZONE = 'Africa/Cairo';
    assert.deepEqual(eventDays(threeDays).map((day) => day.date), ['2026-10-05', '2026-10-06', '2026-10-07']);
    assert.equal(eventDayCount(threeDays), 3);
    assert.equal(eventStartsAt(threeDays).toISOString(), '2026-10-05T15:00:00.000Z');
    assert.equal(eventEndsAt(threeDays).toISOString(), '2026-10-07T10:00:00.000Z');
    // Events created before multi-day support run on eventDate only.
    assert.deepEqual(eventDays(event), [{ date: '2026-10-05', startTime: '18:00', endTime: '23:00' }]);
    assert.equal(eventDayCount(event), 1);
    delete process.env.APP_TIMEZONE;
});

test('check-in opens for each day separately and late is measured from that day start', () => {
    process.env.APP_TIMEZONE = 'Africa/Cairo';
    // Day 2 starts 10:00 Cairo (07:00 UTC); its check-in opens at 05:00 UTC.
    assert.deepEqual(pick(checkInDayAt(threeDays, new Date('2026-10-05T22:30:00Z'))), { dayIndex: 1, status: 'early' });
    assert.deepEqual(pick(checkInDayAt(threeDays, new Date('2026-10-06T05:00:00Z'))), { dayIndex: 1, status: 'present' });
    assert.deepEqual(pick(checkInDayAt(threeDays, new Date('2026-10-06T07:16:00Z'))), { dayIndex: 1, status: 'late' });
    assert.deepEqual(pick(checkInDayAt(threeDays, new Date('2026-10-07T06:00:00Z'))), { dayIndex: 2, status: 'present' });
    assert.deepEqual(pick(checkInDayAt(threeDays, new Date('2026-10-07T12:01:00Z'))), { dayIndex: 2, status: 'closed' });
    assert.deepEqual(closedCheckInDays(threeDays, new Date('2026-10-06T19:00:00Z')), [0]);
    assert.deepEqual(closedCheckInDays(threeDays, new Date('2026-10-06T19:01:00Z')), [0, 1]);
    assert.equal(checkInWindow(threeDays).closesAt.toISOString(), '2026-10-07T12:00:00.000Z');
    delete process.env.APP_TIMEZONE;
});

test('event days are validated and stored with the first day mirrored in the old columns', () => {
    const { days } = normalizeEventDays(threeDays.days);
    assert.deepEqual(days.map((day) => day.date), ['2026-10-05', '2026-10-06', '2026-10-07']);
    const schedule = scheduleFromDays(days);
    assert.equal(schedule.eventDate.toISOString(), '2026-10-05T00:00:00.000Z');
    assert.equal(schedule.endDate.toISOString(), '2026-10-07T00:00:00.000Z');
    assert.equal(schedule.startTime, '18:00');
    assert.equal(schedule.endTime, '23:00');

    assert.match(normalizeEventDays([]).error, /at least one/);
    assert.match(normalizeEventDays([threeDays.days[0], threeDays.days[0]]).error, /different date/);
    assert.match(normalizeEventDays([{ date: '2026-10-05', startTime: '18:00', endTime: '09:00' }]).error, /after start/);
    assert.match(normalizeEventDays([{ date: '2026-10-05', startTime: '9', endTime: '18:00' }]).error, /start and end times/);
    assert.match(normalizeEventDays([
        { date: '2026-10-01', startTime: '09:00', endTime: '18:00' },
        { date: '2026-11-15', startTime: '09:00', endTime: '18:00' },
    ]).error, /within 30 days/);
    const tooMany = Array.from({ length: 15 }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, '0')}`, startTime: '09:00', endTime: '18:00' }));
    assert.match(normalizeEventDays(tooMany).error, /at most 14 days/);
});

const pick = ({ dayIndex, status }) => ({ dayIndex, status });
