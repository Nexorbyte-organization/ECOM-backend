import test from 'node:test';
import assert from 'node:assert/strict';
import { changedEventFields, editableEventFields, lockedEventFields, withScheduleChanges } from '../src/utils/eventEditing.js';

const event = {
    status: 'open',
    title: 'Expo',
    category: 'conference',
    eventDate: new Date('2026-10-20T00:00:00.000Z'),
    applicationDeadline: new Date('2026-10-15T00:00:00.000Z'),
    startTime: '10:00',
    endTime: '18:00',
    location: 'Cairo',
    requiredCount: 4,
    budget: 500,
    notes: '',
};
const beforeEvent = new Date('2026-10-10T12:00:00.000Z');
const duringEvent = new Date('2026-10-20T12:00:00.000Z');

test('resending unchanged values does not count as a change', () => {
    assert.deepEqual(changedEventFields(event, {
        title: 'Expo', eventDate: '2026-10-20', budget: '500', requiredCount: 4, notes: null, category: 'Conference',
    }), []);
    assert.deepEqual(changedEventFields(event, { title: 'Expo 2026', budget: 600 }), ['title', 'budget']);
});

test('an open event can change every editable field', () => {
    assert.deepEqual(lockedEventFields(event, { budget: 600, requiredCount: 5, category: 'wedding' }, beforeEvent), []);
});

test('a confirmed event keeps staffing and pay fixed', () => {
    const confirmed = { ...event, status: 'confirmed' };
    assert.deepEqual(lockedEventFields(confirmed, { budget: 600, requiredCount: 5, location: 'Giza' }, beforeEvent), ['requiredCount', 'budget']);
    assert.deepEqual(lockedEventFields(confirmed, { startTime: '09:00', dressCode: 'Black' }, beforeEvent), []);
});

test('a started event only accepts notes and the group link', () => {
    assert.deepEqual(lockedEventFields(event, { location: 'Giza', notes: 'Gate 3' }, duringEvent), ['location']);
});

test('completed and cancelled events are read-only', () => {
    assert.deepEqual(editableEventFields({ ...event, status: 'completed' }, beforeEvent), []);
    assert.deepEqual(editableEventFields({ ...event, status: 'cancelled' }, beforeEvent), []);
});

test('a schedule edit is stored as days with the first day mirrored in the old columns', () => {
    const twoDays = [
        { date: '2026-10-21', startTime: '09:00', endTime: '17:00' },
        { date: '2026-10-20', startTime: '10:00', endTime: '18:00' },
    ];
    const { changes, endDate } = withScheduleChanges(event, { days: twoDays });
    assert.deepEqual(changedEventFields(event, changes), ['days']);
    assert.equal(changes.eventDate.toISOString(), '2026-10-20T00:00:00.000Z');
    assert.equal(endDate.toISOString(), '2026-10-21T00:00:00.000Z');

    // Resending the stored schedule changes nothing, including for events created before days.
    const same = withScheduleChanges(event, { days: [{ date: '2026-10-20', startTime: '10:00', endTime: '18:00' }] });
    assert.deepEqual(changedEventFields(event, same.changes), []);

    // A one-day event may still change its date or times through the old fields.
    const moved = withScheduleChanges(event, { startTime: '09:00' });
    assert.deepEqual(changedEventFields(event, moved.changes), ['days', 'startTime']);

    // A multi-day event must send its days.
    const multiDay = { ...event, days: changes.days };
    assert.match(withScheduleChanges(multiDay, { startTime: '08:00' }).error, /several days/);
    assert.match(withScheduleChanges(event, { days: [{ date: '2026-10-20', startTime: '18:00', endTime: '10:00' }] }).error, /after start/);
});

test('days follow the date rules: editable while confirmed, locked once the event starts', () => {
    const days = [{ date: '2026-10-20', startTime: '11:00', endTime: '18:00' }];
    assert.deepEqual(lockedEventFields({ ...event, status: 'confirmed' }, { days }, beforeEvent), []);
    assert.deepEqual(lockedEventFields(event, { days }, duringEvent), ['days']);
});
