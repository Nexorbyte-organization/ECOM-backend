import test from 'node:test';
import assert from 'node:assert/strict';
import { changedEventFields, editableEventFields, lockedEventFields } from '../src/utils/eventEditing.js';

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
