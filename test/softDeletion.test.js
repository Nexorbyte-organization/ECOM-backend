import test from 'node:test';
import assert from 'node:assert/strict';
import { Op } from 'sequelize';

process.env.PG_URI = 'postgres://test:test@localhost:5432/soft_deletion_tests';
process.env.JWT_SECRET_KEY = 'soft-deletion-tests-secret-at-least-32-characters';
const models = await import('../db/index.js');
const { sequelize } = await import('../db/connection.js');
const { migrateExistingSchema } = await import('../db/migrate.js');
const { AdminController } = await import('../src/controllers/admin.controller.js');
const { EventService } = await import('../src/services/event.service.js');
const { AuthMiddleware } = await import('../src/middlewares/authentication.js');
const { UserController } = await import('../src/controllers/user.controller.js');
const { PaymentController } = await import('../src/controllers/payment.controller.js');
const { TokenService } = await import('../src/utils/token.js');
const { calculateTransactionHmac, calculateCardTokenHmac } = await import('../src/services/paymob.service.js');
const { User, Event, EventSettlement, SettlementLine, OrganizerCard, OrganizerCardEnrollment } = models;

const response = () => ({
  status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; },
});
const transaction = { LOCK: { UPDATE: 'UPDATE' } };

test('all database models retain destroyed rows with deletedAt and filter normal reads/counts', async (t) => {
  const qi = sequelize.getQueryInterface();
  t.mock.method(qi, 'bulkDelete', () => { throw new Error('Physical deletion is forbidden'); });
  t.mock.method(qi, 'bulkUpdate', async (table, values, where) => {
    assert.ok(values.deletedAt instanceof Date);
    assert.match(qi.queryGenerator.whereQuery(where), /"deletedAt" IS NULL/);
    return 1;
  });
  t.mock.method(qi, 'select', async (model, table, options) => {
    const sql = qi.queryGenerator.selectQuery(table, options, model);
    assert.match(sql, /"deletedAt" IS NULL/);
    return options.plain ? null : [];
  });
  t.mock.method(qi, 'rawSelect', async (table, options) => {
    assert.match(qi.queryGenerator.whereQuery(options.where), /"deletedAt" IS NULL/);
    return 0;
  });
  for (const model of Object.values(models)) {
    assert.equal(model.options.paranoid, true, model.name);
    assert.notEqual(model.rawAttributes.deletedAt.allowNull, false);
    assert.equal(model._timestampAttributes.deletedAt, 'deletedAt');
    assert.equal(await model.destroy({ where: { id: 'record-1' } }), 1);
    assert.deepEqual(await model.findAll({ where: { id: 'record-1' } }), []);
    assert.equal(await model.findByPk('record-1'), null);
    assert.equal(await model.count(), 0);
    assert.deepEqual(await model.findAndCountAll(), { count: 0, rows: [] });
  }
});

test('deleting an account instance saves its timestamp and retains its identity', async (t) => {
  const qi = sequelize.getQueryInterface();
  const user = User.build({
    id: '7de9086a-aa5c-4aa9-af63-0fd1facb3f10', fullName: 'Archived Organization',
    userName: 'archived_org', email: 'archive@example.test', role: 'organizer',
    password: 'hashed-password', rate: 0, deletedAt: null,
  }, { isNewRecord: false, raw: true });
  let writes = 0;
  t.mock.method(qi, 'delete', () => { throw new Error('Physical deletion is forbidden'); });
  t.mock.method(qi, 'update', async (instance, table, values, where) => {
    writes++;
    assert.equal(instance, user);
    assert.equal(table, 'users');
    assert.ok(values.deletedAt instanceof Date);
    assert.equal(where.id, user.id);
    return [instance, 1];
  });
  await user.destroy();
  assert.equal(writes, 1);
  assert.equal(user.isSoftDeleted(), true);
  assert.equal(user.toJSON().email, 'archive@example.test');
  assert.ok(user.toJSON().deletedAt instanceof Date);
});

test('explicit archived reads are possible internally while ordinary queries stay filtered', async (t) => {
  const qi = sequelize.getQueryInterface();
  t.mock.method(qi, 'select', async (model, table, options) => {
    const sql = qi.queryGenerator.selectQuery(table, options, model);
    assert.doesNotMatch(sql, /"deletedAt" IS NULL/);
    const row = User.build({ id: 'archived-user', deletedAt: new Date() }, { isNewRecord: false, raw: true });
    return options.plain ? row : [row];
  });
  const archived = await User.findByPk('archived-user', { paranoid: false });
  assert.ok(archived.deletedAt instanceof Date);
});

test('organization deletion uses one transaction for staff, events and all dependent soft deletes', async (t) => {
  let accountDeleted = false;
  let transactionCalls = 0;
  t.mock.method(sequelize, 'transaction', async (callback) => {
    transactionCalls++;
    return callback(transaction);
  });
  t.mock.method(User, 'findByPk', async () => ({
    id: 'organization-1', role: 'organizer',
    async destroy(options) { assert.equal(options.transaction, transaction); accountDeleted = true; },
  }));
  t.mock.method(User, 'findAll', async (options) => {
    assert.equal(options.transaction, transaction);
    assert.equal(options.where.providerOwnerId, 'organization-1');
    return [{ id: 'staff-1' }];
  });
  t.mock.method(Event, 'findAll', async (options) => {
    assert.equal(options.transaction, transaction);
    assert.equal(options.where.organizerId, 'organization-1');
    return [{ id: 'event-1' }];
  });
  t.mock.method(Event, 'findByPk', async (id, options) => {
    assert.equal(options.transaction, transaction);
    assert.equal(options.lock, transaction.LOCK.UPDATE);
    return { id };
  });
  const calls = [];
  for (const model of Object.values(models)) {
    t.mock.method(model, 'destroy', async (options) => {
      assert.equal(options.transaction, transaction);
      assert.equal(options.force, undefined);
      calls.push({ model: model.name, where: options.where });
      return 1;
    });
  }
  const res = response();
  await AdminController.deleteUser({ params: { id: 'organization-1' }, authUser: { id: 'admin-1' } }, res);
  assert.equal(res.code, 200);
  assert.equal(accountDeleted, true);
  assert.equal(transactionCalls, 1);
  for (const name of ['User', 'Event', 'Application', 'Attendance', 'Review', 'Referral', 'EventActionRequest', 'Notification', 'EventSettlement', 'OrganizerCard', 'OrganizerCardEnrollment']) {
    assert.ok(calls.some(call => call.model === name), name);
  }
  assert.deepEqual(calls.find(call => call.model === 'Notification').where.userId[Op.in], ['staff-1']);
  assert.equal(calls.some(call => call.model === 'SettlementLine'), false);
});

test('a failed cascade rejects the transaction and does not delete the organization account', async (t) => {
  let accountDeleted = false;
  t.mock.method(sequelize, 'transaction', async (callback) => callback(transaction));
  t.mock.method(User, 'findByPk', async () => ({ role: 'organizer', async destroy() { accountDeleted = true; } }));
  t.mock.method(Event, 'findAll', async () => [{ id: 'event-1' }]);
  t.mock.method(EventService, 'deleteWithRelations', async () => { throw new Error('Relation write failed'); });
  await assert.rejects(AdminController.deleteUser({ params: { id: 'organization-1' }, authUser: { id: 'admin-1' } }, response()), /Relation write failed/);
  assert.equal(accountDeleted, false);
});

test('event deletion keeps resolved action history when requested and retains payment lines', async (t) => {
  t.mock.method(sequelize, 'transaction', async callback => callback(transaction));
  t.mock.method(Event, 'findByPk', async () => ({ id: 'event-1' }));
  const deleted = [];
  for (const model of Object.values(models)) {
    t.mock.method(model, 'destroy', async options => {
      assert.equal(options.transaction, transaction);
      deleted.push(model.name);
      return 1;
    });
  }
  assert.equal(await EventService.deleteWithRelations('event-1', { preserveActionRequests: true }), 1);
  assert.ok(deleted.includes('EventSettlement'));
  assert.ok(deleted.includes('Event'));
  assert.equal(deleted.includes('EventActionRequest'), false);
  assert.equal(deleted.includes('SettlementLine'), false);
});

test('soft-deleted accounts cannot authenticate, log in or refresh', async (t) => {
  t.mock.method(User, 'findByPk', async () => null);
  t.mock.method(User, 'findOne', async () => null);
  const token = TokenService.generateAccessToken({ id: 'deleted-user', role: 'organizer', email: 'deleted@example.test' });
  let error;
  await AuthMiddleware.isAuthenticated()({ headers: { authorization: 'Bearer ' + token } }, response(), value => { error = value; });
  assert.equal(error.statusCode, 401);
  await UserController.login({ body: { email: 'deleted@example.test', password: 'password123' } }, response(), value => { error = value; });
  assert.equal(error.statusCode, 401);
  const refreshToken = TokenService.generateRefreshToken({ id: 'deleted-user', role: 'organizer', email: 'deleted@example.test' });
  await UserController.refreshSession({ headers: { cookie: 'oo_refresh=' + refreshToken } }, { ...response(), setHeader() {} }, value => { error = value; });
  assert.equal(error.statusCode, 401);
});

test('migration adds nullable deletedAt to every registered table and preserves retry history', async (t) => {
  const statements = [];
  t.mock.method(sequelize, 'query', async sql => {
    statements.push(sql);
    if (sql.includes('AS "hasLines"')) return [[{ hasLines: true }]];
    return [[{}]];
  });
  await migrateExistingSchema();
  for (const model of Object.values(models)) {
    assert.ok(statements.some(sql => sql.includes('ALTER TABLE IF EXISTS "' + model.getTableName() + '" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP WITH TIME ZONE')));
  }
  assert.ok(statements.some(sql => sql.includes('settlement_lines_active_talent_unique') && sql.includes('WHERE "deletedAt" IS NULL')));
  assert.doesNotMatch(statements.join(' '), /DELETE FROM|DROP TABLE|TRUNCATE/);
  const firstRun = [...statements];
  statements.length = 0;
  await migrateExistingSchema();
  assert.deepEqual(statements, firstRun);
  const index = SettlementLine.options.indexes.find(index => index.name === 'settlement_lines_active_talent_unique');
  assert.deepEqual(index.where, { deletedAt: null });
});

test('removing a saved card soft deletes it and chooses another default', async (t) => {
  let deleted = false;
  let replacementDefault = false;
  const card = { organizerId: 'org-1', isDefault: true, async save() {}, async destroy() { deleted = true; } };
  t.mock.method(OrganizerCard, 'findOne', async options => options.where.id ? card : { async update(values) { replacementDefault = values.isDefault; } });
  const res = response();
  await PaymentController.removeOrganizerCard({ params: { cardId: 'card-1' }, authUser: { id: 'org-1', role: 'organizer' } }, res);
  assert.equal(res.code, 200);
  assert.equal(deleted, true);
  assert.equal(card.isActive, false);
  assert.equal(replacementDefault, true);
});

const setPaymentEnvironment = () => {
  process.env.PAYMOB_MODE = 'test';
  process.env.PAYMOB_SECRET_KEY = 'sk_test_example';
  process.env.PAYMOB_PUBLIC_KEY = 'pk_test_example';
  process.env.PAYMOB_HMAC_SECRET = 'hmac-test-secret';
  process.env.PAYMOB_INTEGRATION_IDS = '123,456';
  process.env.BASE_URL = 'https://api.example.test';
  process.env.FRONTEND_URL = 'https://app.example.test';
};

test('a valid payment callback reconciles an archived settlement without exposing it', async (t) => {
  setPaymentEnvironment();
  delete process.env.PAYMOB_PAYOUT_USERNAME;
  let saved = false;
  const settlement = { deletedAt: new Date(), collectionAmountCents: 1000, currency: 'EGP', collectionStatus: 'pending', async save() { saved = true; } };
  t.mock.method(EventSettlement, 'findOne', async options => { assert.equal(options.paranoid, false); return settlement; });
  t.mock.method(SettlementLine, 'findAll', async () => []);
  const obj = { integration_id: 123, is_live: false, amount_cents: 1000, currency: 'EGP', order: { id: 1 }, id: 2, success: true, pending: false, error_occured: false };
  const res = response();
  await PaymentController.paymobWebhook({ body: { type: 'TRANSACTION', obj }, query: { hmac: calculateTransactionHmac(obj, process.env.PAYMOB_HMAC_SECRET) } }, res);
  assert.equal(res.code, 200);
  assert.equal(settlement.collectionStatus, 'paid');
  assert.equal(saved, true);
});

test('late card-token callbacks cannot recreate a removed card', async (t) => {
  setPaymentEnvironment();
  t.mock.method(EventSettlement, 'findOne', async () => null);
  t.mock.method(OrganizerCardEnrollment, 'findOne', async () => ({ organizerId: 'org-1' }));
  t.mock.method(User, 'findByPk', async () => ({ id: 'org-1' }));
  t.mock.method(OrganizerCard, 'findOne', async options => { assert.equal(options.paranoid, false); return { organizerId: 'org-1', deletedAt: new Date() }; });
  t.mock.method(OrganizerCard, 'findOrCreate', async () => { throw new Error('Removed card must stay deleted'); });
  const obj = { order_id: 1, id: 2, token: 'test-token' };
  const res = response();
  await PaymentController.paymobWebhook({ body: { type: 'TOKEN', obj }, query: { hmac: calculateCardTokenHmac(obj, process.env.PAYMOB_HMAC_SECRET) } }, res);
  assert.equal(res.body.ignored, true);
});
