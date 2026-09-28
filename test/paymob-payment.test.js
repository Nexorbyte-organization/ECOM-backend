import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIntentionPayload,
  buildCardEnrollmentPayload,
  calculateCardTokenHmac,
  calculateTransactionHmac,
  getPaymobTestConfig,
  verifyCardTokenHmac,
  verifyTransactionHmac,
} from '../src/services/paymob.service.js';
import { decryptCardToken, encryptCardToken } from '../src/services/card-token.service.js';
import { resolvePayoutMethod, resolveSettlementPayoutMethod } from '../src/services/payout-method.service.js';
import { buildPayoutPayload, classifyPayoutStatus, isPayoutSandboxConfigured } from '../src/services/paymob-payout.service.js';

const setTestEnvironment = () => {
  process.env.PAYMOB_MODE = 'test';
  process.env.PAYMOB_SECRET_KEY = 'sk_test_example';
  process.env.PAYMOB_PUBLIC_KEY = 'pk_test_example';
  process.env.PAYMOB_HMAC_SECRET = 'hmac-test-secret';
  process.env.PAYMOB_INTEGRATION_IDS = '123,456';
  process.env.BASE_URL = 'https://api.example.test';
  process.env.FRONTEND_URL = 'https://app.example.test';
};

test('Paymob configuration accepts test values and rejects live credentials', () => {
  setTestEnvironment();
  const config = getPaymobTestConfig();
  assert.deepEqual(config.paymentMethods, [123, 456]);
  assert.equal(config.mode, 'test');

  process.env.PAYMOB_SECRET_KEY = 'sklive_forbidden';
  assert.throws(() => getPaymobTestConfig(), /Live credential/);
  setTestEnvironment();
});

test('Paymob transaction and card-token callbacks are HMAC verified', () => {
  const transaction = {
    amount_cents: 100000,
    created_at: '2026-06-13T11:33:44.592345',
    currency: 'EGP',
    error_occured: false,
    has_parent_transaction: false,
    id: 192036465,
    integration_id: 123,
    is_3d_secure: true,
    is_auth: false,
    is_capture: false,
    is_refunded: false,
    is_standalone_payment: true,
    is_voided: false,
    order: { id: 217503754 },
    owner: 302852,
    pending: false,
    source_data: { pan: '2346', sub_type: 'MasterCard', type: 'card' },
    success: true,
  };
  const transactionHmac = calculateTransactionHmac(transaction, 'secret');
  assert.equal(verifyTransactionHmac(transaction, transactionHmac, 'secret'), true);
  assert.equal(verifyTransactionHmac({ ...transaction, amount_cents: 1 }, transactionHmac, 'secret'), false);

  const card = {
    card_subtype: 'MasterCard',
    created_at: '2026-08-24T13:28:31.015314',
    email: 'owner@example.com',
    id: 15,
    masked_pan: 'xxxx-xxxx-xxxx-2346',
    merchant_id: 10,
    order_id: '20',
    token: 'test-card-token',
  };
  const cardHmac = calculateCardTokenHmac(card, 'secret');
  assert.equal(verifyCardTokenHmac(card, cardHmac, 'secret'), true);
  assert.equal(verifyCardTokenHmac({ ...card, token: 'changed' }, cardHmac, 'secret'), false);
});

test('card tokens are encrypted at rest with authenticated encryption', () => {
  process.env.PAYMOB_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
  const encrypted = encryptCardToken('paymob-test-token');
  assert.notEqual(encrypted.encryptedToken, 'paymob-test-token');
  assert.equal(decryptCardToken(encrypted), 'paymob-test-token');
});

test('settlement payout methods separate automatic and cash recipients', () => {
  const wallet = resolvePayoutMethod([
    { provider: 'Vodafone Cash', numberOrDetail: '01012345678', isDefault: true },
  ], 'Ahmed Ali');
  assert.equal(wallet.type, 'wallet');
  assert.equal(wallet.metadata.issuer, 'vodafone');

  const bank = resolvePayoutMethod([
    {
      type: 'bank',
      provider: 'Bank Account',
      numberOrDetail: 'EG123',
      bankCode: 'CIB',
      accountHolderName: 'Ahmed Ali',
      isDefault: true,
    },
  ], 'Ahmed Ali');
  assert.equal(bank.type, 'bank');

  const cash = resolvePayoutMethod([], 'No Account');
  assert.equal(cash.type, 'cash');
  assert.equal(cash.status, 'cash_due');
});

test('organization can choose cash for an usher with a valid payout account', () => {
  const methods = [{ provider: 'Vodafone Cash', numberOrDetail: '01012345678', isDefault: true }];
  const automatic = resolveSettlementPayoutMethod(methods, 'Ahmed Ali', false);
  const cash = resolveSettlementPayoutMethod(methods, 'Ahmed Ali', true);
  assert.equal(automatic.type, 'wallet');
  assert.equal(automatic.status, 'queued');
  assert.equal(cash.type, 'cash');
  assert.equal(cash.status, 'cash_due');
  assert.equal(cash.destination, null);
});

test('automatic payouts require all sandbox credentials before checkout', () => {
  const names = [
    'PAYMOB_PAYOUT_CLIENT_ID', 'PAYMOB_PAYOUT_CLIENT_SECRET',
    'PAYMOB_PAYOUT_USERNAME', 'PAYMOB_PAYOUT_PASSWORD',
  ];
  const previous = names.map((name) => process.env[name]);
  try {
    names.forEach((name) => { process.env[name] = 'test-value'; });
    assert.equal(isPayoutSandboxConfigured(), true);
    delete process.env.PAYMOB_PAYOUT_PASSWORD;
    assert.equal(isPayoutSandboxConfigured(), false);
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});

test('only a confirmed failed disbursement is safe for individual retry', () => {
  assert.deepEqual(classifyPayoutStatus('success'), { status: 'paid', retrySafe: false });
  assert.deepEqual(classifyPayoutStatus('rejected'), { status: 'failed', retrySafe: true });
  assert.deepEqual(classifyPayoutStatus('pending'), { status: 'processing', retrySafe: false });
  assert.deepEqual(classifyPayoutStatus(''), { status: 'processing', retrySafe: false });
});

test('intention charges digital payouts plus only the platform fee for cash ushers', () => {
  setTestEnvironment();
  const config = getPaymobTestConfig();
  const settlement = {
    id: 'settlement-id',
    organizerId: 'organizer-id',
    collectionAmountCents: 105000,
    currency: 'EGP',
    specialReference: 'OO-SET-1',
  };
  const lines = [
    { talentName: 'Digital Usher', grossAmountCents: 100000, collectionAmountCents: 100000, payoutMethodType: 'wallet' },
    { talentName: 'Cash Usher', grossAmountCents: 100000, collectionAmountCents: 5000, payoutMethodType: 'cash' },
  ];
  const payload = buildIntentionPayload({
    settlement,
    event: { id: 'event-id', title: 'Test Event' },
    organizer: { fullName: 'OO Events', email: 'owner@example.com', mobileNumber: '+201001234567', city: 'Cairo' },
    lines,
    config,
  });
  assert.equal(payload.amount, 105000);
  assert.equal(payload.items.reduce((total, item) => total + item.amount, 0), payload.amount);
  assert.match(payload.notification_url, /\/payments\/paymob\/webhook$/);
  assert.equal(payload.card_tokens, undefined);

  const savedCardPayload = buildIntentionPayload({
    settlement,
    event: { id: 'event-id', title: 'Test Event' },
    organizer: { fullName: 'OO Events', email: 'owner@example.com', mobileNumber: '+201001234567', city: 'Cairo' },
    lines,
    config,
    cardToken: 'saved-card-token',
  });
  assert.deepEqual(savedCardPayload.card_tokens, ['saved-card-token']);
});

test('card setup uses its own Paymob order and returns to the organizer profile', () => {
  setTestEnvironment();
  const payload = buildCardEnrollmentPayload({
    enrollment: { id: 'enrollment-id' },
    organizer: { fullName: 'OO Events', email: 'owner@example.com', mobileNumber: '+201001234567' },
    config: getPaymobTestConfig(),
    integrationId: 123,
  });
  assert.deepEqual(payload.payment_methods, [123]);
  assert.equal(payload.amount, payload.items[0].amount);
  assert.equal(payload.extras.card_enrollment_id, 'enrollment-id');
  assert.match(payload.redirection_url, /\/provider\/profile\?cardEnrollment=enrollment-id$/);
});

test('payout payloads keep Paymob fees on the platform side', () => {
  const payload = buildPayoutPayload({
    id: 'line-id',
    usherAmountCents: 95000,
    payoutMethodType: 'wallet',
    payoutDestination: '01012345678',
    payoutMetadata: { issuer: 'vodafone', fullName: 'Ahmed Ali' },
  }, { fullName: 'Ahmed Ali' });
  assert.equal(payload.amount, 950);
  assert.equal(payload.customer_bears_fees, false);
  assert.equal(payload.msisdn, '01012345678');
  assert.equal(payload.client_reference_id, 'line-id');
  assert.equal(buildPayoutPayload({
    id: 'line-id', payoutAttempt: 1, usherAmountCents: 95000,
    payoutMethodType: 'wallet', payoutDestination: '01012345678',
    payoutMetadata: { issuer: 'vodafone', fullName: 'Ahmed Ali' },
  }, { fullName: 'Ahmed Ali' }).client_reference_id, 'line-id-1');
});
