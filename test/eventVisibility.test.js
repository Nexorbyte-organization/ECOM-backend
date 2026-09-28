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

test('ordinary talent event data exposes assignment status without map or other usher locations', () => {
    const mappedEvent = {
        ...event,
        hiredTalents: ['usher-1', 'usher-2'],
        mapImage: { secure_url: 'https://example.com/map.png', public_id: 'map' },
        mapPins: [
            { id: 'pin-1', name: 'North gate', x: 10, y: 20, usherIds: ['usher-1'] },
            { id: 'pin-2', name: 'South gate', x: 80, y: 70, usherIds: ['usher-2'] },
        ],
    };
    const assigned = eventForTalent(mappedEvent, true, 'usher-1');
    assert.equal(assigned.hasMapAssignment, true);
    assert.equal(assigned.mapImage, undefined);
    assert.equal(assigned.mapPins, undefined);
    assert.equal(eventForTalent(mappedEvent, true, 'usher-3').hasMapAssignment, false);
    assert.equal(mappedEvent.mapPins.length, 2);
});
