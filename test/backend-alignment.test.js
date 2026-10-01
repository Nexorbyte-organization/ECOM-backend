import test from 'node:test';
import assert from 'node:assert/strict';
import { getMissingProfileFields, isProfileComplete } from '../src/utils/profileCompletion.js';
import {
  normalizeEventCategory,
  normalizeLanguage,
  normalizeRole,
} from '../src/utils/normalization.js';
import { EventValidator, PaymentMethodValidator } from '../src/validators/event.validator.js';
import { OrganizerProfileValidator, UserValidator } from '../src/validators/user.validator.js';
import { ApiFeature } from '../src/utils/apiFeature.js';
import { TokenService } from '../src/utils/token.js';
import { hashToken, parseCookies, tokenHashesMatch } from '../src/utils/session.js';

test('purpose-scoped session tokens cannot be reused for another action', () => {
  process.env.JWT_SECRET_KEY = 'route-contract-test-secret-at-least-32-characters';
  const user = { id: 'user-1', email: 'user@example.com', role: 'usher' };
  const access = TokenService.generateAccessToken(user);
  const reset = TokenService.generatePurposeToken({ payload: { id: user.id }, purpose: 'password_reset', expiresIn: '10m' });
  assert.equal(TokenService.verifyPurposeToken({ token: access, purpose: 'access' }).id, user.id);
  assert.throws(() => TokenService.verifyPurposeToken({ token: reset, purpose: 'access' }));
});

test('refresh token hashes and cookie parsing are deterministic and safe', () => {
  const hash = hashToken('refresh-token');
  assert.equal(hash.length, 64);
  assert.equal(tokenHashesMatch(hash, hashToken('refresh-token')), true);
  assert.equal(tokenHashesMatch(hash, hashToken('different-token')), false);
  assert.deepEqual(parseCookies('oo_access=abc; oo_refresh=def%20123'), { oo_access: 'abc', oo_refresh: 'def 123' });
});

test('frontend role aliases map to backend roles', () => {
  assert.equal(normalizeRole('talent'), 'usher');
  assert.equal(normalizeRole('provider'), 'organizer');
  assert.equal(normalizeRole('provider_member'), 'organizer_member');
  assert.equal(normalizeRole('provider_supervisor'), 'organizer_supervisor');
});

test('frontend event and language labels normalize safely', () => {
  assert.equal(normalizeEventCategory('Private Party'), 'private_party');
  assert.equal(normalizeEventCategory('Sports Event'), 'sport_event');
  assert.equal(normalizeLanguage('Chinese (Mandarin)'), 'chinese_mandarin');
  assert.equal(normalizeLanguage('Arabic'), 'arabic');
  assert.equal(normalizeEventCategory('Unknown category'), null);
});

test('usher profile completion matches required frontend fields', () => {
  const usher = {
    role: 'usher',
    fullName: 'Ahmed Ali',
    portfolioPicture: { secure_url: 'https://example.com/photo.jpg', public_id: 'photo_1' },
    city: 'Cairo',
    mobileNumber: '+201001234567',
    education: 'Cairo University',
    workCities: ['Cairo'],
    languages: ['arabic'],
    eventCategories: ['conference'],
    paymentMethods: [{ provider: 'Cash - don\'t have account', type: 'cash', isDefault: true }],
  };
  assert.equal(isProfileComplete(usher), true);
  assert.deepEqual(getMissingProfileFields({ ...usher, workCities: [] }), ['workCities']);
  assert.deepEqual(getMissingProfileFields({ ...usher, education: '' }), ['education']);
  assert.deepEqual(getMissingProfileFields({ ...usher, paymentMethods: [] }), ['paymentMethods']);
});

test('organizer profile completion requires company identity and contact details', () => {
  const organizer = {
    role: 'organizer',
    fullName: 'OO Events',
    portfolioPicture: { secure_url: 'https://example.com/logo.png', public_id: 'logo_1' },
    organizationInfo: { description: 'Event organizer' },
    city: 'Cairo',
    mobileNumber: '+201001234567',
  };
  assert.equal(isProfileComplete(organizer), true);
  assert.deepEqual(getMissingProfileFields({ ...organizer, mobileNumber: null }), ['phone']);
  assert.equal(OrganizerProfileValidator.update.validate({ autoAcceptHighRatedTalents: true }).error, undefined);
});

test('public signup rejects privileged roles', () => {
  const base = { email: 'user@example.com', password: 'password123' };
  assert.equal(UserValidator.signup.validate({ ...base, role: 'talent' }).error, undefined);
  assert.ok(UserValidator.signup.validate({ ...base, role: 'admin' }).error);
  assert.ok(UserValidator.signup.validate({ ...base, role: 'provider_member' }).error);
});

test('event validation accepts frontend display categories', () => {
  const payload = {
    title: 'Conference Event',
    category: 'Sports Event',
    eventDate: '2030-03-10',
    applicationDeadline: '2030-03-08',
    startTime: '10:00',
    endTime: '18:00',
    location: 'Cairo',
    requiredCount: 10,
    genderPreference: 'any',
    budget: 500,
  };
  assert.equal(EventValidator.create.validate(payload).error, undefined);
});

test('cash is a valid payment preference without account details', () => {
  const { error } = PaymentMethodValidator.add.validate({
    provider: 'Cash - don\'t have account',
    type: 'cash',
  });
  assert.equal(error, undefined);
});

test('pagination supports the frontend limit parameter and caps large pages', () => {
  const normal = new ApiFeature({ page: '2', limit: '25' }).pagination().build();
  assert.equal(normal.limit, 25);
  assert.equal(normal.offset, 25);

  const capped = new ApiFeature({ limit: '1000' }).pagination().build();
  assert.equal(capped.limit, 100);
});

test('all frontend-alignment route groups are registered', async () => {
  process.env.PG_URI ||= 'postgresql://user:pass@127.0.0.1:5432/route_contract_test';
  process.env.JWT_SECRET_KEY ||= 'route-contract-test';
  const routers = await import('../src/index.js');
  const routes = new Set();

  for (const [routerName, router] of Object.entries(routers)) {
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        routes.add(`${routerName}:${method.toUpperCase()} ${layer.route.path}`);
      }
    }
  }

  assert.equal(routes.size, 131);
  assert.ok(routes.has('organizerRouter:POST /events/:id/funding'));
  assert.ok(routes.has('organizerRouter:POST /events/:id/release-payments'));
  assert.ok(routes.has('organizerRouter:POST /credit/withdrawals'));
  assert.ok(routes.has('paymentRouter:GET /fundings/:fundingId'));
  assert.ok(routes.has('usherRouter:POST /payments/holds/:holdId/dispute'));
  assert.ok(routes.has('adminRouter:PATCH /payments/holds/:holdId/resolve'));
  assert.ok(routes.has('adminRouter:PATCH /organizers/:id/payment-tier'));
  assert.ok(routes.has('authRouter:POST /resend-verification'));
  assert.ok(routes.has('organizerRouter:PATCH /events/:id/complete'));
  assert.ok(routes.has('usherRouter:PATCH /applications/:applicationId/respond'));
  assert.ok(routes.has('adminRouter:POST /organizations/:id/switch'));
  assert.ok(routes.has('adminRouter:POST /organizations/stop'));
  assert.ok(routes.has('organizerRouter:GET /events/:id/map'));
  assert.ok(routes.has('usherRouter:GET /events/:id/map'));
  assert.ok(routes.has('organizerRouter:GET /events/:id/attendance'));
  assert.ok(routes.has('organizerRouter:POST /events/:id/attendance-qr'));
  assert.ok(routes.has('organizerRouter:GET /events/:id/attendance-qr'));
  // Organizations cannot cancel or delete events, directly or by request.
  assert.ok(!routes.has('organizerRouter:POST /events/:id/action-requests'));
  assert.ok(!routes.has('organizerRouter:DELETE /events/:id'));
  assert.ok(routes.has('adminRouter:PATCH /event-action-requests/:id'));
  assert.ok(routes.has('notificationRouter:PATCH /read-all'));
  assert.ok(routes.has('usherRouter:GET /profile/:id/reviews'));
  assert.ok(routes.has('authRouter:POST /refresh'));
  assert.ok(routes.has('authRouter:POST /logout'));
  assert.ok(routes.has('authRouter:GET /referral-invites/:token'));
  assert.ok(routes.has('usherRouter:POST /profile/portfolio'));
  assert.ok(routes.has('usherRouter:POST /referral-invites'));
  assert.ok(routes.has('usherRouter:POST /attendance/check-in'));
  assert.ok(routes.has('organizerRouter:PATCH /events/:id/photo'));
  assert.ok(routes.has('organizerRouter:POST /events/:id/settlement'));
  assert.ok(routes.has('organizerRouter:GET /events/:id/individual-settlements'));
  assert.ok(routes.has('organizerRouter:POST /events/:id/ushers/:talentId/settlement'));
  assert.ok(routes.has('organizerRouter:POST /settlements/:settlementId/lines/:lineId/retry-payout'));
  assert.ok(routes.has('organizerRouter:POST /payment-cards/enrollments'));
  assert.ok(routes.has('organizerRouter:GET /payment-cards/enrollments/:enrollmentId'));
  assert.ok(routes.has('organizerRouter:PATCH /payment-cards/:cardId/default'));
  assert.ok(routes.has('organizerRouter:PATCH /settlements/:settlementId/lines/:lineId/cash-paid'));
  assert.ok(routes.has('paymentRouter:POST /paymob/webhook'));

  const { User, Event } = await import('../db/index.js');
  const userJson = User.build({
    id: '7de9086a-aa5c-4aa9-af63-0fd1facb3f10',
    role: 'usher',
    portfolioPicture: { secure_url: 'https://example.com/photo.jpg', public_id: 'photo' },
    experience: 3,
    eventCategories: ['conference'],
    rate: 4.5,
  }).toJSON();
  assert.equal(userJson._id, userJson.id);
  assert.equal(userJson.frontendRole, 'talent');
  assert.equal(userJson.photo, 'https://example.com/photo.jpg');
  assert.deepEqual(userJson.categories, ['conference']);

  const eventJson = Event.build({
    id: '43575802-c57f-451a-b3ed-086b55f90d4c',
    organizerId: 'e31b7076-6ba3-499f-bbf4-561152bef806',
  }).toJSON();
  assert.equal(eventJson._id, eventJson.id);
  assert.equal(eventJson.providerId, eventJson.organizerId);
  assert.equal(eventJson.attendanceQrGenerated, false);

  const eventWithQrJson = Event.build({
    id: '43575802-c57f-451a-b3ed-086b55f90d4c',
    organizerId: 'e31b7076-6ba3-499f-bbf4-561152bef806',
    attendanceQrCreatedAt: new Date('2030-03-01T10:00:00.000Z'),
  }).toJSON();
  assert.equal(eventWithQrJson.attendanceQrGenerated, true);
  assert.equal(eventWithQrJson.attendanceQrCreatedAt, undefined);

  const organizerJson = User.build({
    id: 'fed362c9-6d0f-4eab-a260-23289c3e4ba7',
    role: 'organizer',
    fullName: 'OO Events',
    portfolioPicture: { secure_url: 'https://example.com/logo.png', public_id: 'logo' },
    organizationInfo: { autoAcceptHighRatedTalents: true },
    rate: 0,
  }).toJSON();
  assert.equal(organizerJson.autoAcceptHighRatedTalents, true);
});

test('sorting ignores secret, contact, and malformed fields', async () => {
  const { ApiFeature } = await import('../src/utils/apiFeature.js');
  const { order } = new ApiFeature({ sort: '-rate,password,refreshTokenHash,email,createdAt,"x" desc' }).sort().build();
  assert.deepEqual(order, [['rate', 'DESC'], ['createdAt', 'ASC']]);
});
