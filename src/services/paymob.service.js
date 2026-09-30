import crypto from 'crypto';

const TRANSACTION_HMAC_FIELDS = [
  'amount_cents',
  'created_at',
  'currency',
  'error_occured',
  'has_parent_transaction',
  'id',
  'integration_id',
  'is_3d_secure',
  'is_auth',
  'is_capture',
  'is_refunded',
  'is_standalone_payment',
  'is_voided',
  'order.id',
  'owner',
  'pending',
  'source_data.pan',
  'source_data.sub_type',
  'source_data.type',
  'success',
];

const CARD_TOKEN_HMAC_FIELDS = [
  'card_subtype',
  'created_at',
  'email',
  'id',
  'masked_pan',
  'merchant_id',
  'order_id',
  'token',
];

class PaymobConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 503;
    this.publicMessage = message;
  }
}

class PaymobRequestError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 502;
    this.publicMessage = message;
  }
}

const summarizePaymobError = (value, path = '') => {
  if (Array.isArray(value)) return value.map((item) => summarizePaymobError(item, path)).filter(Boolean).join('; ');
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => summarizePaymobError(item, path ? `${path}.${key}` : key))
      .filter(Boolean)
      .join('; ');
  }
  if (value === null || value === undefined) return '';
  const label = path && !['detail', 'message', 'error'].includes(path) ? `${path}: ` : '';
  return `${label}${String(value)}`;
};

const safePaymobDetail = (data) => summarizePaymobError(data)
  .replace(/\b(?:sk|pk|csk)_(?:test|live)_[A-Za-z0-9_-]+\b/gi, '[redacted key]')
  .replace(/\b[A-Fa-f0-9]{64,}\b/g, '[redacted value]')
  .slice(0, 300);

const requireValue = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new PaymobConfigurationError(`${name} is required for Paymob Test Mode`);
  return value;
};

const rejectLiveCredential = (name, value) => {
  if (/(^|_)live(_|$)/i.test(value) || /^(sk|pk)live/i.test(value)) {
    throw new PaymobConfigurationError(`${name} appears to be a Live credential. This app is locked to Test Mode.`);
  }
};

const parsePaymentMethods = (raw) => raw
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => (/^\d+$/.test(value) ? Number(value) : value));

export const getPaymobTestConfig = () => {
  const mode = (process.env.PAYMOB_MODE || 'test').trim().toLowerCase();
  if (mode !== 'test') {
    throw new PaymobConfigurationError('Only PAYMOB_MODE=test is enabled');
  }

  const secretKey = requireValue('PAYMOB_SECRET_KEY');
  const publicKey = requireValue('PAYMOB_PUBLIC_KEY');
  const hmacSecret = requireValue('PAYMOB_HMAC_SECRET');
  const paymentMethods = parsePaymentMethods(requireValue('PAYMOB_INTEGRATION_IDS'));
  const backendUrl = requireValue('BASE_URL').replace(/\/$/, '');
  const frontendUrl = requireValue('FRONTEND_URL').replace(/\/$/, '');
  const baseUrl = (process.env.PAYMOB_BASE_URL || 'https://accept.paymob.com').replace(/\/$/, '');

  rejectLiveCredential('PAYMOB_SECRET_KEY', secretKey);
  rejectLiveCredential('PAYMOB_PUBLIC_KEY', publicKey);
  if (paymentMethods.length === 0) {
    throw new PaymobConfigurationError('At least one Test Integration ID is required');
  }

  return {
    mode,
    secretKey,
    publicKey,
    hmacSecret,
    paymentMethods,
    backendUrl,
    frontendUrl,
    baseUrl,
  };
};

const getPathValue = (source, path) => path
  .split('.')
  .reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), source);

const calculateHmac = (obj, fields, secret) => {
  const concatenated = fields
    .map((field) => {
      const value = getPathValue(obj, field);
      return value === null || value === undefined ? '' : String(value);
    })
    .join('');

  return crypto.createHmac('sha512', secret).update(concatenated).digest('hex');
};

const safeEqual = (left, right) => {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(String(left).toLowerCase(), 'utf8');
  const rightBuffer = Buffer.from(String(right).toLowerCase(), 'utf8');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

export const calculateTransactionHmac = (obj, secret) => calculateHmac(obj, TRANSACTION_HMAC_FIELDS, secret);
export const calculateCardTokenHmac = (obj, secret) => calculateHmac(obj, CARD_TOKEN_HMAC_FIELDS, secret);

export const verifyTransactionHmac = (obj, receivedHmac, secret) => (
  safeEqual(calculateTransactionHmac(obj, secret), receivedHmac)
);

export const verifyCardTokenHmac = (obj, receivedHmac, secret) => (
  safeEqual(calculateCardTokenHmac(obj, secret), receivedHmac)
);

const splitName = (fullName = '') => {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || 'OO-Ushers',
    lastName: parts.slice(1).join(' ') || 'Organizer',
  };
};

const billingData = (organizer) => {
  const { firstName, lastName } = splitName(organizer.fullName);
  return {
    first_name: firstName,
    last_name: lastName,
    email: organizer.email,
    phone_number: organizer.mobileNumber,
    country: 'EG',
    city: organizer.city || 'Cairo',
    state: 'NA',
    street: 'NA',
    building: 'NA',
    floor: 'NA',
    apartment: 'NA',
    postal_code: 'NA',
  };
};

export const buildIntentionPayload = ({ settlement, event, organizer, lines, config, cardToken }) => {
  return {
    amount: settlement.collectionAmountCents,
    currency: settlement.currency,
    payment_methods: cardToken ? [getCardEnrollmentIntegrationId(config)] : config.paymentMethods,
    items: lines.map((line) => ({
      name: `${event.title} — ${line.talentName}`.slice(0, 255),
      amount: line.collectionAmountCents,
      description: line.payoutMethodType === 'cash'
        ? 'OO-Ushers platform fee; usher amount is due in cash'
        : 'OO-Ushers event usher payment',
      quantity: 1,
    })),
    billing_data: billingData(organizer),
    ...(cardToken ? { card_tokens: [cardToken] } : {}),
    extras: {
      settlement_id: settlement.id,
      event_id: event.id,
      organizer_id: settlement.organizerId,
    },
    special_reference: settlement.specialReference,
    expiration: 3600,
    notification_url: `${config.backendUrl}/payments/paymob/webhook`,
    redirection_url: `${config.frontendUrl}/provider/payments/result?settlementId=${settlement.id}`,
  };
};

export const buildCardEnrollmentPayload = ({ enrollment, organizer, config, integrationId }) => ({
  amount: 1000,
  currency: 'EGP',
  payment_methods: [integrationId],
  items: [{ name: 'OO-Ushers test card setup', amount: 1000, description: 'Sandbox card setup', quantity: 1 }],
  billing_data: billingData(organizer),
  extras: { card_enrollment_id: enrollment.id, save_card: true },
  special_reference: `OO-CARD-${enrollment.id}`,
  expiration: 3600,
  notification_url: `${config.backendUrl}/payments/paymob/webhook`,
  redirection_url: `${config.frontendUrl}/provider/profile?cardEnrollment=${enrollment.id}`,
});

const requestJson = async (url, options, allowNotFound = false) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { detail: text };
    }

    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      const detail = safePaymobDetail(data);
      throw new PaymobRequestError(`Paymob rejected checkout (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new PaymobRequestError('Paymob Test API timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const postIntention = async (payload, config) => {
  const intention = await requestJson(`${config.baseUrl}/v1/intention/`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${config.secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!intention.client_secret || !intention.id || !intention.intention_order_id) {
    throw new PaymobRequestError('Paymob Test API returned an incomplete intention');
  }

  const checkoutUrl = new URL('/unifiedcheckout/', config.baseUrl);
  checkoutUrl.searchParams.set('publicKey', config.publicKey);
  checkoutUrl.searchParams.set('clientSecret', intention.client_secret);

  return {
    intentionId: String(intention.id),
    orderId: String(intention.intention_order_id),
    clientSecret: intention.client_secret,
    checkoutUrl: checkoutUrl.toString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
};

export const createPaymobIntention = async ({ settlement, event, organizer, lines, cardToken }) => {
  const config = getPaymobTestConfig();
  return postIntention(buildIntentionPayload({ settlement, event, organizer, lines, config, cardToken }), config);
};

export const getCardEnrollmentIntegrationId = () => {
  const configured = process.env.PAYMOB_CARD_INTEGRATION_ID?.trim();
  const integrationId = Number(configured);
  if (!configured || !Number.isSafeInteger(integrationId) || integrationId <= 0) {
    throw new PaymobConfigurationError('PAYMOB_CARD_INTEGRATION_ID must be a Test Normal 3DS or Auth card integration with card saving enabled');
  }
  return integrationId;
};

export const inquireCardTokens = async (orderId) => {
  const apiKey = process.env.PAYMOB_API_KEY?.trim();
  if (!apiKey) return [];
  const config = getPaymobTestConfig();
  const auth = await requestJson(`${config.baseUrl}/api/auth/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey }),
  });
  if (!auth.token) throw new PaymobRequestError('Paymob did not return an inquiry auth token');
  const tokens = await requestJson(`${config.baseUrl}/api/acceptance/order_card_tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_token: auth.token, order_id: Number(orderId) }),
  }, true);
  if (tokens === null) return [];
  if (!Array.isArray(tokens)) throw new PaymobRequestError('Paymob returned an invalid card-token inquiry');
  return tokens;
};

export const createCardEnrollmentIntention = async ({ enrollment, organizer }) => {
  const config = getPaymobTestConfig();
  const integrationId = getCardEnrollmentIntegrationId();
  return postIntention(buildCardEnrollmentPayload({ enrollment, organizer, config, integrationId }), config);
};
