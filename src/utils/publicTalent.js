export function publicTalent(talent) {
    const data = talent.toJSON();
    [
        'mobileNumber',
        'whatsappNumber',
        'email',
        'paymentMethods',
        'providerOwnerId',
        'password',
        'otp',
        'otpExpiry',
        'otpAttempts',
        'lastOtpRequest',
        'otpVerified',
        'refreshTokenHash',
        'refreshTokenExpiresAt',
    ].forEach((field) => delete data[field]);
    return data;
}
