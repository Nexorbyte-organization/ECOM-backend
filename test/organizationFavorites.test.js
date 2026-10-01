import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PG_URI = 'postgres://test:test@localhost:5432/favorites_tests';
const { Application, Event, OrganizationFavorite, User } = await import('../db/index.js');
const { sequelize } = await import('../db/connection.js');
const { NotificationService } = await import('../src/services/notification.service.js');
const { OrganizationTalentController } = await import('../src/controllers/organization-talent.controller.js');

const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});
const completeTalent = (id) => ({
  id, role: 'usher', isBlocked: false, fullName: `Usher ${id}`,
  portfolioPicture: { secure_url: 'https://example.test/photo', public_id: 'photo' },
  city: 'Cairo', mobileNumber: '123456789', education: 'University',
  workCities: ['Cairo'], languages: ['Arabic'], eventCategories: ['Conference'],
  paymentMethods: [{ type: 'cash' }],
  toJSON() { return { ...this }; },
});

test('staff favorites use their organization and omit unavailable ushers', async (t) => {
  t.mock.method(OrganizationFavorite, 'findAll', async ({ where }) => {
    assert.deepEqual(where, { organizerId: 'company-1' });
    return [{ talentId: 'available' }, { talentId: 'blocked' }];
  });
  t.mock.method(User, 'findAll', async () => [completeTalent('available'), {
    ...completeTalent('blocked'), isBlocked: true,
  }]);
  const res = response();
  await OrganizationTalentController.listFavorites({
    authUser: { id: 'staff-1', role: 'organizer_member', providerOwnerId: 'company-1' },
  }, res);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.data[0].id, 'available');
  assert.equal(res.body.data[0].mobileNumber, undefined);
});

test('rebook last team sends only available invitations within capacity', async (t) => {
  const target = {
    id: 'target', organizerId: 'company-1', status: 'open',
    title: 'Next event', eventDate: new Date(Date.now() + 86400000),
    requiredCount: 3, hiredTalents: ['hired'],
  };
  const source = { id: 'source', hiredTalents: ['already', 'unavailable', 'new-1', 'new-2'] };
  t.mock.method(sequelize, 'transaction', async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }));
  t.mock.method(Event, 'findOne', async ({ where }) => {
    if (where.id === 'target') {
      assert.equal(where.organizerId, 'company-1');
      return target;
    }
    return source;
  });
  t.mock.method(Application, 'count', async () => 0);
  t.mock.method(Application, 'findOne', async ({ where }) => where.talentId === 'already' ? { id: 'existing' } : null);
  t.mock.method(User, 'findByPk', async (id) => id === 'unavailable' ? null : completeTalent(id));
  t.mock.method(Application, 'findOrCreate', async ({ where }) => [{ talentId: where.talentId }, true]);
  const notified = [];
  t.mock.method(NotificationService, 'create', async ({ userId }) => { notified.push(userId); });

  const res = response();
  await OrganizationTalentController.rebookLastTeam({
    authUser: { id: 'staff-1', role: 'organizer_member', providerOwnerId: 'company-1', fullName: 'Staff' },
    params: { id: 'target' },
  }, res);
  assert.deepEqual(res.body.data.invited, ['new-1', 'new-2']);
  assert.deepEqual(res.body.data.skipped, [
    { talentId: 'already', reason: 'already_applied' },
    { talentId: 'unavailable', reason: 'unavailable' },
  ]);
  assert.deepEqual(notified, ['new-1', 'new-2']);
});
