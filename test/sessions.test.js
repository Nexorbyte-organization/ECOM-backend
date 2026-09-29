import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PG_URI = 'postgres://test:test@localhost:5432/session_tests';
process.env.JWT_SECRET_KEY = 'session-tests-only-secret-at-least-32-characters';
const { User } = await import('../db/index.js');
const { UserController } = await import('../src/controllers/user.controller.js');
const { AuthMiddleware } = await import('../src/middlewares/authentication.js');
const { HashService } = await import('../src/utils/hashAndcompare.js');
const { TokenService } = await import('../src/utils/token.js');
const { parseCookies } = await import('../src/utils/session.js');

test('single-device session lifecycle and stale request races', async (t) => {
  const user = {
    id: 'session-user', email: 'session@example.com', role: 'usher',
    password: HashService.hashPassword({ password: 'password123' }),
    isEmailVerified: true, isBlocked: false,
    async update(values) { Object.assign(this, values); },
    toJSON() { return { id: this.id, role: this.role }; },
  };
  let beforeUpdate;
  t.mock.method(User, 'findOne', async () => user);
  t.mock.method(User, 'findByPk', async () => user);
  t.mock.method(User, 'update', async (values, { where }) => {
    if (beforeUpdate) {
      const callback = beforeUpdate;
      beforeUpdate = null;
      await callback();
    }
    if (where.id !== user.id || where.refreshTokenHash !== user.refreshTokenHash) return [0];
    Object.assign(user, values);
    return [1];
  });
  const invoke = async (method, req) => {
    const result = { headers: {} };
    const res = {
      setHeader(name, value) { result.headers[name] = value; },
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
    };
    await method(req, res, (error) => { result.error = error; });
    result.cookies = (result.headers['Set-Cookie'] || []).map((value) => value.split(';')[0]).join('; ');
    return result;
  };
  const login = () => invoke(UserController.login, { body: { email: user.email, password: 'password123' } });
  const refresh = (session) => invoke(UserController.refreshSession, { headers: { cookie: session.cookies } });
  const logout = (session) => invoke(UserController.logout, { headers: { cookie: session.cookies } });
  const authenticate = (session, transport = 'authorization') => {
    const headers = transport === 'cookie'
      ? { cookie: session.cookies }
      : { [transport]: transport === 'authorization' ? `Bearer ${session.body.token}` : session.body.token };
    return invoke(AuthMiddleware.isAuthenticated(), { headers });
  };

  const first = await login();
  assert.equal(first.status, 200);
  assert.equal((await authenticate(first)).error, undefined);
  const second = await login();
  for (const transport of ['authorization', 'token', 'cookie']) {
    assert.equal((await authenticate(first, transport)).error.statusCode, 401);
    assert.equal((await authenticate(second, transport)).error, undefined);
  }
  assert.equal((await refresh(first)).error.statusCode, 401);
  await logout(first);
  assert.equal((await authenticate(second)).error, undefined);

  const rotated = await refresh(second);
  assert.equal(rotated.status, 200);
  assert.equal((await authenticate(second)).error.statusCode, 401);
  assert.equal((await authenticate(rotated)).error, undefined);
  assert.equal((await refresh(second)).error.statusCode, 401);
  await logout(second);
  assert.equal((await authenticate(rotated)).error, undefined);

  let newest;
  beforeUpdate = async () => { newest = await login(); };
  assert.equal((await refresh(rotated)).error.statusCode, 401);
  assert.equal((await authenticate(newest)).error, undefined);

  beforeUpdate = () => logout(newest);
  assert.equal((await refresh(newest)).error.statusCode, 401);
  assert.equal((await authenticate(newest)).error.statusCode, 401);

  const active = await login();
  const legacy = { body: { token: TokenService.generateAccessToken(user) } };
  assert.equal((await authenticate(legacy)).error.statusCode, 401);
  user.refreshTokenExpiresAt = new Date(0);
  assert.equal((await authenticate(active)).error.statusCode, 401);
  assert.equal((await refresh(active)).error.statusCode, 401);

  const resetSession = await login();
  const { hashToken } = await import('../src/utils/session.js');
  const resetToken = TokenService.generatePurposeToken({
    payload: { id: user.id, email: user.email, passwordVersion: hashToken(user.password) },
    purpose: 'password_reset', expiresIn: '10m',
  });
  assert.equal((await invoke(UserController.resetPassword, { body: { newPassword: 'newpassword123', resetToken } })).status, 200);
  assert.equal((await authenticate(resetSession)).error.statusCode, 401);
  assert.equal((await refresh(resetSession)).error.statusCode, 401);
  assert.ok(parseCookies(resetSession.cookies).oo_refresh);
});
