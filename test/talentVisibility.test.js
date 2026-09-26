import test from 'node:test';
import assert from 'node:assert/strict';
import { canViewTalentPaymentMethods } from '../src/utils/talentVisibility.js';

test('organizer workspace and admin can view talent payment accounts', () => {
    for (const role of ['organizer', 'organizer_member', 'organizer_supervisor', 'admin']) {
        assert.equal(canViewTalentPaymentMethods(role), true);
    }
});

test('other talent cannot view payment accounts', () => {
    assert.equal(canViewTalentPaymentMethods('usher'), false);
});
