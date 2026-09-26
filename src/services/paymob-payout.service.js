let cachedToken = null;
let cachedTokenExpiresAt = 0;

class PayoutConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 503;
  }
}

class PayoutRequestError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 502;
  }
}

const REQUIRED_ENV = [
  'PAYMOB_PAYOUT_CLIENT_ID',
  'PAYMOB_PAYOUT_CLIENT_SECRET',
  'PAYMOB_PAYOUT_USERNAME',
  'PAYMOB_PAYOUT_PASSWORD',
];

export const isPayoutSandboxConfigured = () => REQUIRED_ENV.every((name) => process.env[name]?.trim());

const getConfig = () => {
  if ((process.env.PAYMOB_MODE || 'test').toLowerCase() !== 'test') {
    throw new PayoutConfigurationError('Paymob Payouts is locked to Test Mode');
  }
  if (!isPayoutSandboxConfigured()) {
    throw new PayoutConfigurationError('Paymob Payouts Sandbox credentials are not configured');
  }

  const baseUrl = (process.env.PAYMOB_PAYOUT_BASE_URL || 'https://stagingpayouts.paymobsolutions.com')
    .replace(/\/$/, '');
  if (!baseUrl.includes('staging')) {
    throw new PayoutConfigurationError('PAYMOB_PAYOUT_BASE_URL must point to the Paymob staging service');
  }

  return {
    baseUrl,
    clientId: process.env.PAYMOB_PAYOUT_CLIENT_ID.trim(),
    clientSecret: process.env.PAYMOB_PAYOUT_CLIENT_SECRET.trim(),
    username: process.env.PAYMOB_PAYOUT_USERNAME.trim(),
    password: process.env.PAYMOB_PAYOUT_PASSWORD.trim(),
  };
};

const requestJson = async (url, options) => {
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
    if (!response.ok) {
      throw new PayoutRequestError(data.detail || data.message || `Paymob Payouts returned ${response.status}`);
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new PayoutRequestError('Paymob Payouts request timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const getAccessToken = async () => {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;
  const config = getConfig();
  const response = await requestJson(`${config.baseUrl}/api/secure/o/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      username: config.username,
      password: config.password,
      grant_type: 'password',
    }),
  });
  if (!response.access_token) throw new PayoutRequestError('Paymob Payouts did not return an access token');

  cachedToken = response.access_token;
  cachedTokenExpiresAt = Date.now() + Math.max(60, Number(response.expires_in || 3600) - 60) * 1000;
  return cachedToken;
};

export const buildPayoutPayload = (line, talent) => {
  const amount = Number((line.usherAmountCents / 100).toFixed(2));
  const base = {
    issuer: line.payoutMetadata?.issuer,
    amount,
    full_name: line.payoutMetadata?.fullName || talent.fullName,
    client_reference_id: line.id,
    customer_bears_fees: false,
  };

  if (line.payoutMethodType === 'wallet') {
    return { ...base, msisdn: line.payoutDestination };
  }
  if (line.payoutMethodType === 'bank') {
    return {
      ...base,
      bank_card_number: line.payoutDestination,
      bank_code: line.payoutMetadata?.bankCode,
    };
  }
  throw new PayoutRequestError('This settlement line does not have an automatic payout method');
};

export const sendSandboxPayout = async (line, talent) => {
  const config = getConfig();
  const accessToken = await getAccessToken();
  const response = await requestJson(`${config.baseUrl}/api/secure/disburse/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildPayoutPayload(line, talent)),
  });
  return {
    transactionId: response.transaction_id ? String(response.transaction_id) : null,
    status: String(response.disbursement_status || '').toLowerCase(),
    description: response.status_description || null,
    response,
  };
};

export const clearPayoutTokenCache = () => {
  cachedToken = null;
  cachedTokenExpiresAt = 0;
};
