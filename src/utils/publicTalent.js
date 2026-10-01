// Credentials and session state never leave the server, whoever is asking.
export const SECRET_USER_FIELDS = [
    'password',
    'otp',
    'otpExpiry',
    'otpAttempts',
    'lastOtpRequest',
    'otpVerified',
    'refreshTokenHash',
    'refreshTokenExpiresAt',
];

const CONTACT_FIELDS = ['mobileNumber', 'phoneNumber', 'whatsappNumber', 'email'];

const toData = (user) => (typeof user?.toJSON === 'function' ? user.toJSON() : { ...user });

export function withoutSecrets(user) {
    if (!user) return user;
    const data = toData(user);
    SECRET_USER_FIELDS.forEach((field) => delete data[field]);
    return data;
}

const maskValue = (value) => {
    const normalized = String(value || '').replace(/\s+/g, '');
    if (!normalized) return '';
    if (normalized.length <= 4) return '*'.repeat(normalized.length);
    return `${'*'.repeat(Math.max(4, normalized.length - 4))}${normalized.slice(-4)}`;
};

// Organizations may see which payout accounts an usher has, never the full numbers.
export function maskPaymentMethods(methods) {
    if (!Array.isArray(methods)) return [];
    return methods.map((method) => {
        const id = method?.id || method?._id;
        return {
            id,
            _id: id,
            provider: method?.provider,
            ...(method?.type ? { type: method.type } : {}),
            ...(method?.issuer ? { issuer: method.issuer } : {}),
            numberOrDetail: maskValue(method?.numberOrDetail || method?.mobileNumber || method?.iban || method?.accountNumber),
            isDefault: Boolean(method?.isDefault),
        };
    });
}

export function publicTalent(talent) {
    const data = withoutSecrets(talent);
    [...CONTACT_FIELDS, 'paymentMethods', 'providerOwnerId'].forEach((field) => delete data[field]);
    return data;
}

// Applicants share their contact details with the organization they applied to.
export function talentForOrganization(talent) {
    if (!talent) return talent;
    const data = withoutSecrets(talent);
    delete data.providerOwnerId;
    data.paymentMethods = maskPaymentMethods(data.paymentMethods);
    return data;
}
