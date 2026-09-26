import test from 'node:test';
import assert from 'node:assert/strict';
import { eventForTalent } from '../src/utils/eventVisibility.js';

const event = {
    id: 'event-1',
    title: 'Event',
    whatsappGroupLink: 'https://chat.whatsapp.com/test',
    whatsappGroupId: 'secret',
    attendanceQrCreatedAt: '2030-03-01T10:00:00.000Z',
    attendanceQrGenerated: true,
};

test('hides WhatsApp group data from unaccepted talent without mutating the event', () => {
    const result = eventForTalent({ toJSON: () => ({ ...event }) });
    assert.equal(result.whatsappGroupLink, undefined);
    assert.equal(result.whatsappGroupId, undefined);
    assert.equal(result.attendanceQrCreatedAt, undefined);
    assert.equal(result.attendanceQrGenerated, undefined);
    assert.equal(result.title, 'Event');
    assert.equal(event.whatsappGroupLink, 'https://chat.whatsapp.com/test');
});

test('includes WhatsApp group data for accepted talent', () => {
    assert.equal(eventForTalent(event, true).whatsappGroupLink, event.whatsappGroupLink);
});
