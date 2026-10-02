import test from 'node:test';
import assert from 'node:assert/strict';
import { Op } from 'sequelize';

process.env.PG_URI ||= 'postgres://test:test@localhost:5432/reminder_tests';
process.env.APP_TIMEZONE = 'Africa/Cairo';
process.env.FRONTEND_URL = 'https://app.example.test';
process.env.EMAIL_USER = 'sender@example.test';
process.env.EMAIL_PASS = 'test-only';
const { sequelize } = await import('../db/connection.js');
const { Event } = await import('../db/models/event.model.js');
const { EventReminder } = await import('../db/models/event-reminder.model.js');
const { User } = await import('../db/models/user.model.js');
const { EmailService } = await import('../src/utils/email.js');
const { EventReminderService, reminderIsDue } = await import('../src/services/event-reminder.service.js');
const { eventStartsAt } = await import('../src/utils/eventSchedule.js');
const DAY_MS = 86400000;
const fixture = () => ({
  id: 'event-1', status: 'confirmed', eventDate: '2026-10-10', startTime: '18:00',
  title: 'Evening <Show>', location: 'Main hall', gatheringLocation: 'Gate A',
  dressCode: 'Black shirt', hiredTalents: ['usher-1'],
});
const dueAt = (event) => new Date(eventStartsAt(event).getTime() - DAY_MS);

test('reminder uses local event time and opens exactly 24 hours before start', () => {
  const event = fixture();
  assert.equal(dueAt(event).toISOString(), '2026-10-09T15:00:00.000Z');
  assert.equal(reminderIsDue(event, new Date(dueAt(event).getTime() - 1)), false);
  assert.equal(reminderIsDue(event, dueAt(event)), true);
  assert.equal(reminderIsDue(event, new Date(eventStartsAt(event).getTime() - 1)), true);
  assert.equal(reminderIsDue(event, eventStartsAt(event)), false);
  for (const status of ['cancelled', 'completed']) {
    assert.equal(reminderIsDue({ ...event, status }, dueAt(event)), false);
  }
  assert.equal(reminderIsDue({ ...event, deletedAt: new Date() }, dueAt(event)), false);
  assert.equal(reminderIsDue({ ...event, status: 'open' }, dueAt(event)), true);
  assert.equal(reminderIsDue({ ...event, eventDate: 'invalid' }, dueAt(event)), false);
});

function mockDelivery(t, event) {
  const records = new Map();
  const messages = [];
  let queue = Promise.resolve();
  t.mock.method(sequelize, 'transaction', (callback) => {
    const operation = queue.then(() => callback({ LOCK: { UPDATE: 'UPDATE' } }));
    queue = operation.catch(() => {});
    return operation;
  });
  t.mock.method(Event, 'findByPk', async (_id, options) => {
    assert.equal(options.lock, 'UPDATE');
    return event;
  });
  t.mock.method(User, 'findByPk', async () => ({ email: 'usher@example.test' }));
  const key = (row) => `${row.eventId}:${row.userId}:${row.startsAt.toISOString()}`;
  t.mock.method(EventReminder, 'findOne', async ({ where, paranoid }) => {
    assert.equal(paranoid, false);
    return records.get(key(where));
  });
  t.mock.method(EventReminder, 'create', async (row) => records.set(key(row), row));
  t.mock.method(EmailService, 'sendEmail', async (message) => messages.push(message));
  return { records, messages };
}

test('repeated and overlapping deliveries send one branded email per usher and start time', async (t) => {
  const event = fixture();
  const { records, messages } = mockDelivery(t, event);
  const results = await Promise.all([
    EventReminderService.sendForUsher(event.id, 'usher-1', dueAt(event)),
    EventReminderService.sendForUsher(event.id, 'usher-1', dueAt(event)),
  ]);
  assert.deepEqual(results, [true, false]);
  assert.equal(records.size, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, 'usher@example.test');
  assert.match(messages[0].text, /Gate A/);
  assert.match(messages[0].text, /Black shirt/);
  assert.match(messages[0].text, /18:00.*Africa\/Cairo/);
  assert.match(messages[0].text, /https:\/\/app.example.test\/talent\/jobs\/event-1/);
  assert.match(messages[0].html, /Evening &lt;Show&gt;/);
});

test('delivery failure leaves reminder retryable', async (t) => {
  const event = fixture();
  const { records } = mockDelivery(t, event);
  let attempts = 0;
  t.mock.method(EmailService, 'sendEmail', async () => {
    if (++attempts === 1) throw new Error('SMTP unavailable');
  });
  await assert.rejects(EventReminderService.sendForUsher(event.id, 'usher-1', dueAt(event)), /SMTP unavailable/);
  assert.equal(records.size, 0);
  assert.equal(await EventReminderService.sendForUsher(event.id, 'usher-1', dueAt(event)), true);
  assert.equal(attempts, 2);
});

test('current assignment and status are rechecked before email; missing email is skipped', async (t) => {
  const event = fixture();
  const { messages } = mockDelivery(t, event);
  assert.equal(await EventReminderService.sendForUsher(event.id, 'applicant', dueAt(event)), false);
  event.status = 'cancelled';
  assert.equal(await EventReminderService.sendForUsher(event.id, 'usher-1', dueAt(event)), false);
  event.status = 'confirmed';
  t.mock.method(User, 'findByPk', async () => null);
  assert.equal(await EventReminderService.sendForUsher(event.id, 'usher-1', dueAt(event)), false);
  assert.equal(messages.length, 0);
});

test('rescheduling and a newly hired usher each get their own reminder', async (t) => {
  const event = fixture();
  const { messages } = mockDelivery(t, event);
  await EventReminderService.sendForUsher(event.id, 'usher-1', dueAt(event));
  event.eventDate = '2026-10-11';
  await EventReminderService.sendForUsher(event.id, 'usher-1', dueAt(event));
  event.hiredTalents.push('usher-2');
  await EventReminderService.sendForUsher(event.id, 'usher-2', dueAt(event));
  assert.equal(messages.length, 3);
});

test('sweep paginates and continues after one recipient fails', async (t) => {
  let page = 0;
  t.mock.method(Event, 'findAll', async ({ where }) => {
    page++;
    if (page === 1) return [{ id: 'event-1', hiredTalents: ['bad', 'good', 'good'] }];
    if (page === 2) {
      assert.equal(where.id[Op.gt], 'event-1');
      return [{ id: 'event-2', hiredTalents: ['late-hire'] }];
    }
    return [];
  });
  t.mock.method(EventReminderService, 'sendForUsher', async (_id, userId) => {
    if (userId === 'bad') throw new Error('SMTP error');
    return true;
  });
  const result = await EventReminderService.sweep(dueAt(fixture()));
  assert.equal(result.checked, 2);
  assert.equal(result.sent, 2);
  assert.equal(result.failures.length, 1);
  assert.equal(page, 3);
});
