import test from 'node:test';
import assert from 'node:assert/strict';
import { isProfileComplete } from '../src/utils/profileCompletion.js';
import { publicTalent } from '../src/utils/publicTalent.js';

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
