import test from 'node:test';
import assert from 'node:assert/strict';
import { isProfileComplete } from '../src/utils/profileCompletion.js';
import { maskPaymentMethods, publicTalent, talentForOrganization } from '../src/utils/publicTalent.js';

test('complete talent remains searchable without exposing private fields', () => {
    const talent = {
        role: 'usher', fullName: 'Usher', city: 'Cairo', mobileNumber: '01012345678',
        email: 'usher@example.com', whatsappNumber: '01012345678',
        education: 'Cairo University',
        portfolioPicture: { secure_url: 'https://example.com/photo.jpg', public_id: 'photo' },
        workCities: ['Cairo'], languages: ['Arabic'], eventCategories: ['ushering'],
        paymentMethods: [{ provider: 'Cash - don\'t have account', type: 'cash', isDefault: true }],
    };
    assert.equal(isProfileComplete(talent), true);
    const result = publicTalent({ toJSON: () => ({ ...talent }) });
    assert.equal(result.mobileNumber, undefined);
    assert.equal(result.whatsappNumber, undefined);
    assert.equal(result.email, undefined);
    assert.equal(result.paymentMethods, undefined);
    assert.equal(result.fullName, 'Usher');
    assert.equal(talent.mobileNumber, '01012345678');
    assert.equal(talent.paymentMethods.length, 1);
});

test('public talent hides the phone alias added by the user serializer', () => {
    const result = publicTalent({ toJSON: () => ({ fullName: 'Usher', phoneNumber: '01012345678', refreshTokenHash: 'hash', otp: 'otp' }) });
    assert.equal(result.phoneNumber, undefined);
    assert.equal(result.refreshTokenHash, undefined);
    assert.equal(result.otp, undefined);
});

test('organizations see masked payout accounts and applicant contact details', () => {
    const result = talentForOrganization({ toJSON: () => ({
        fullName: 'Usher', phoneNumber: '01012345678', otpAttempts: 1, providerOwnerId: null,
        paymentMethods: [{ id: 'm1', provider: 'Vodafone Cash', type: 'wallet', mobileNumber: '01012345678', iban: 'EG000', isDefault: true }],
    }) });
    assert.equal(result.phoneNumber, '01012345678');
    assert.equal(result.otpAttempts, undefined);
    assert.deepEqual(result.paymentMethods, [{
        id: 'm1', _id: 'm1', provider: 'Vodafone Cash', type: 'wallet', numberOrDetail: '*******5678', isDefault: true,
    }]);
});

test('payment method masking never returns a short value in full', () => {
    assert.equal(maskPaymentMethods([{ id: 'x', provider: 'Bank', accountNumber: '1234' }])[0].numberOrDetail, '****');
    assert.deepEqual(maskPaymentMethods(undefined), []);
});
