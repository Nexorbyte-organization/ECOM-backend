const normalize = (value) => String(value || '').trim().toLowerCase();

const WALLET_ISSUERS = [
  { patterns: ['vodafone'], issuer: 'vodafone' },
  { patterns: ['orange'], issuer: 'orange' },
  { patterns: ['etisalat', 'e&'], issuer: 'etisalat' },
  { patterns: ['bank wallet'], issuer: 'bank_wallet' },
];

export const resolvePayoutMethod = (paymentMethods = [], talentName = '') => {
  const method = paymentMethods.find((item) => item.isDefault) || paymentMethods[0];
  if (!method) {
    return { type: 'cash', status: 'cash_due', provider: null, destination: null, metadata: null };
  }

  const provider = normalize(method.provider);
  const explicitType = normalize(method.type);
  const wallet = WALLET_ISSUERS.find(({ patterns }) => patterns.some((pattern) => provider.includes(pattern)));
  if (explicitType === 'wallet' || wallet) {
    const issuer = method.issuer || wallet?.issuer;
    const destination = method.mobileNumber || method.numberOrDetail;
    if (issuer && destination) {
      return {
        type: 'wallet',
        status: 'queued',
        provider: method.provider,
        destination,
        metadata: { issuer, fullName: method.accountHolderName || talentName },
      };
    }
  }

  if (explicitType === 'bank' || provider.includes('bank')) {
    const destination = method.iban || method.accountNumber || method.numberOrDetail;
    if (destination && method.bankCode) {
      return {
        type: 'bank',
        status: 'queued',
        provider: method.provider,
        destination,
        metadata: {
          issuer: 'instant_bank',
          bankCode: method.bankCode,
          fullName: method.accountHolderName || talentName,
        },
      };
    }
  }

  return {
    type: 'cash',
    status: 'cash_due',
    provider: method.provider,
    destination: method.numberOrDetail || null,
    metadata: { reason: 'Unsupported or incomplete automatic payout details' },
  };
};
