import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PG_URI = 'postgres://test:test@localhost:5432/impersonation_tests';
process.env.JWT_SECRET_KEY = 'admin-impersonation-tests-secret-at-least-32-characters';
const { User } = await import('../db/index.js');
const { AdminController } = await import('../src/controllers/admin.controller.js');
const { UserController } = await import('../src/controllers/user.controller.js');
const { AuthMiddleware } = await import('../src/middlewares/authentication.js');
const { issueSession } = await import('../src/services/session.service.js');

const adminId = '00000000-0000-4000-8000-000000000001';
const organizationId = '00000000-0000-4000-8000-000000000002';

test('admin switch retains actor, grants organization owner scope, refreshes, and stops', async (t) => {
  const admin = { id: adminId, role: 'admin', isBlocked: false, email: 'admin@example.test',
    async update(values) { Object.assign(this, values); },
    toJSON() { return { ...this, password: 'secret-hash' }; } };
  const organization = { id: organizationId, role: 'organizer', fullName: 'Example Company',
    isBlocked: false, password: 'owner-hash',
    toJSON() { return { id: this.id, role: this.role, fullName: this.fullName, password: this.password }; } };
  t.mock.method(User, 'findByPk', async (id) => id === adminId ? admin : id === organizationId ? organization : null);
  t.mock.method(User, 'findOne', async ({ where }) => where.id === organizationId
    && where.role === 'organizer' && where.isBlocked === false && !organization.isBlocked ? organization : null);
  t.mock.method(User, 'update', async (values, { where }) => {
    if (where.id !== admin.id || where.refreshTokenHash !== admin.refreshTokenHash) return [0];
    Object.assign(admin, values);
    return [1];
  });

  const invoke = async (handler, req = {}) => {
    const result = { headers: {} };
    const res = { setHeader(name, value) { result.headers[name] = value; },
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; }, on() {} };
    await handler(req, res, (error) => { result.error = error; });
    result.cookies = (result.headers['Set-Cookie'] || []).map((value) => value.split(';')[0]).join('; ');
    return result;
  };
  const original = await invoke((req, res) => issueSession(admin, res));
  const authenticate = async (session, options) => {
    const req = { headers: { cookie: session.cookies }, method: 'GET' };
    const result = await invoke(AuthMiddleware.isAuthenticated(options), req);
    return { req, ...result };
  };

  const adminSession = await authenticate(original);
  assert.equal(adminSession.req.authUser.id, adminId);
  const switched = await invoke(AdminController.switchToOrganization, {
    authUser: adminSession.req.authUser, params: { id: organizationId },
  });
  assert.equal(switched.status, 200);
  assert.equal((await authenticate(original)).error.statusCode, 401);

  const acting = await authenticate(switched);
  assert.equal(acting.req.authUser.id, organizationId);
  assert.equal(acting.req.adminActor.id, adminId);
  assert.equal((await invoke(AuthMiddleware.isAuthorized(['organizer']), acting.req)).error, undefined);
  assert.equal((await invoke(AuthMiddleware.isAuthorized(['admin']), acting.req)).error.statusCode, 403);

  const profile = await invoke(UserController.getMyProfile, acting.req);
  assert.equal(profile.body.data.actingAs.adminId, adminId);
  assert.equal(profile.body.data.actingAs.organizationName, 'Example Company');
  assert.equal(profile.body.data.password, undefined);

  const rotated = await invoke(UserController.refreshSession, { headers: { cookie: switched.cookies } });
  assert.equal(rotated.status, 200);
  assert.equal(rotated.body.data.user.actingAs.organizationId, organizationId);
  assert.equal((await authenticate(switched)).error.statusCode, 401);

  const stopRequest = await authenticate(rotated, { adminSession: true });
  assert.equal(stopRequest.req.authUser.id, adminId);
  const stopped = await invoke(AdminController.stopActingAsOrganization, stopRequest.req);
  assert.equal(stopped.status, 200);
  const restored = await authenticate(stopped);
  assert.equal(restored.req.authUser.id, adminId);
  assert.equal(restored.req.adminActor, undefined);
  assert.equal((await authenticate(rotated)).error.statusCode, 401);

  const switchedAgain = await invoke(AdminController.switchToOrganization, {
    authUser: restored.req.authUser, params: { id: organizationId },
  });
  organization.isBlocked = true;
  assert.equal((await authenticate(switchedAgain)).error.statusCode, 401);
  const recovered = await invoke(UserController.refreshSession, { headers: { cookie: switchedAgain.cookies } });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.data.user.role, 'admin');
  assert.equal((await authenticate(recovered)).req.authUser.id, adminId);
  assert.equal((await invoke(AdminController.switchToOrganization, {
    authUser: admin, params: { id: organizationId },
  })).error.statusCode, 404);
  assert.equal((await invoke(AdminController.switchToOrganization, {
    authUser: admin, params: { id: 'not-an-id' },
  })).error.statusCode, 400);
});
