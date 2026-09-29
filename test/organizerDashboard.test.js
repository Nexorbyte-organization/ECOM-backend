import test from 'node:test';
import assert from 'node:assert/strict';
import { Op } from 'sequelize';

process.env.PG_URI = 'postgres://test:test@localhost:5432/dashboard_tests';
const { Event, Application } = await import('../db/index.js');
const { OrganizerController } = await import('../src/controllers/organizer.controller.js');

test('organization dashboard returns totals and pending applications from owned events', async (t) => {
  const organizerId = 'organizer-1';
  const events = [
    { id: 'event-1', status: 'open', hiredTalents: ['talent-1'] },
    { id: 'event-2', status: 'confirmed', hiredTalents: ['talent-2', 'talent-3'] },
    { id: 'event-3', status: 'completed', hiredTalents: [] },
  ];
  const eventQueries = [];
  t.mock.method(Event, 'findAll', async (options) => {
    eventQueries.push(options);
    if (options.attributes) return events;
    if (options.limit) return [events[2]];
    return events.slice(0, 2);
  });
  t.mock.method(Application, 'count', async (options) => {
    assert.equal(options.where.status, 'pending');
    assert.deepEqual(options.where.eventId[Op.in], events.map(event => event.id));
    return 4;
  });

  let response;
  await OrganizerController.getDashboard(
    { authUser: { id: organizerId, role: 'organizer' } },
    { status(code) { assert.equal(code, 200); return this; }, json(body) { response = body; } },
  );

  assert.equal(eventQueries.length, 3);
  assert.deepEqual(eventQueries[0].attributes, ['id', 'status', 'hiredTalents']);
  assert.ok(eventQueries.every(query => query.where.organizerId === organizerId));
  assert.deepEqual(response.data, {
    totalEvents: 3,
    openEvents: 1,
    confirmedEvents: 1,
    completedEvents: 1,
    activeEventsCount: 2,
    totalHired: 3,
    pendingApplicationsCount: 4,
    activeEvents: events.slice(0, 2),
    recentEvents: [events[2]],
  });
});
