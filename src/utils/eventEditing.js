import { hasEventStarted } from './eventSchedule.js';
import { normalizeEventCategory } from './normalization.js';

export const EVENT_EDITABLE_FIELDS = [
    'title', 'category', 'eventDate', 'applicationDeadline',
    'startTime', 'endTime', 'location', 'requiredCount',
    'gatheringLocation', 'genderPreference', 'specifyGenders',
    'malesCount', 'femalesCount', 'budget', 'dressCode', 'notes', 'whatsappGroupLink',
    'venueLatitude', 'venueLongitude',
];

// Once applications close, staffing and pay are fixed; ushers can still be told about
// practical changes to the schedule, venue, and instructions.
const CONFIRMED_EDITABLE_FIELDS = [
    'title', 'eventDate', 'startTime', 'endTime', 'location', 'gatheringLocation',
    'dressCode', 'notes', 'whatsappGroupLink', 'venueLatitude', 'venueLongitude',
];
// After the event starts only information for the people on site can change.
const STARTED_EDITABLE_FIELDS = ['notes', 'whatsappGroupLink'];

export const EVENT_FIELD_LABELS = {
    title: 'title', category: 'category', eventDate: 'date', applicationDeadline: 'application deadline',
    startTime: 'start time', endTime: 'end time', location: 'location', requiredCount: 'staff count',
    gatheringLocation: 'meeting point', genderPreference: 'gender preference', specifyGenders: 'gender split',
    malesCount: 'male count', femalesCount: 'female count', budget: 'pay', dressCode: 'dress code',
    notes: 'notes', whatsappGroupLink: 'WhatsApp group link',
    venueLatitude: 'venue pin', venueLongitude: 'venue pin',
};

const DATE_FIELDS = new Set(['eventDate', 'applicationDeadline']);
const NUMBER_FIELDS = new Set(['requiredCount', 'malesCount', 'femalesCount', 'budget', 'venueLatitude', 'venueLongitude']);

const comparable = (field, value) => {
    if (value === undefined || value === null || value === '') return null;
    if (DATE_FIELDS.has(field)) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
    }
    if (NUMBER_FIELDS.has(field)) return Number(value);
    if (field === 'specifyGenders') return Boolean(value);
    if (field === 'category') return normalizeEventCategory(value) ?? String(value);
    return String(value).trim();
};

export const editableEventFields = (event, now = new Date()) => {
    if (['completed', 'cancelled'].includes(event.status)) return [];
    if (hasEventStarted(event, now)) return STARTED_EDITABLE_FIELDS;
    if (event.status === 'confirmed') return CONFIRMED_EDITABLE_FIELDS;
    return EVENT_EDITABLE_FIELDS;
};

// Fields in the request whose value differs from the stored event; unchanged values are
// ignored so a form can resend the whole event.
export const changedEventFields = (event, changes) => EVENT_EDITABLE_FIELDS.filter((field) => (
    changes[field] !== undefined && comparable(field, changes[field]) !== comparable(field, event[field])
));

export const lockedEventFields = (event, changes, now = new Date()) => {
    const editable = editableEventFields(event, now);
    return changedEventFields(event, changes).filter((field) => !editable.includes(field));
};
