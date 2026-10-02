import assert from 'node:assert/strict';
import test from 'node:test';
import { sequelize } from '../db/connection.js';
import { getAnalytics } from '../src/services/analytics.service.js';

test('organization analytics scopes every query and converts stored cents to EGP', async () => {
    const original = sequelize.query;
    const queries = [];
    sequelize.query = async (sql, options) => {
        queries.push({ sql, options });
        if (sql.includes('AS "bookedValue"')) return [{ total: 2, positions: 12, hires: 7, bookedValue: 7000, noShowFees: 250 }];
        if (sql.includes('avg(x.rating)')) return [{ count: 2, average: '4.5' }];
        if (sql.includes('FROM organizer_credit_entries')) return [{ cents: '12345' }];
        if (sql.includes('FROM organization_favorites')) return [{ count: 3 }];
        if (sql.includes('FROM event_fundings')) return [{ key: 'paymob', count: 2, cents: '10050' }];
        if (sql.includes('AS cents\n            FROM events e LEFT JOIN')) return [{ count: 1, cents: 5000 }];
        if (sql.includes('FROM event_action_requests')) return [{ count: 2 }];
        return [];
    };
    try {
        const data = await getAnalytics('11111111-1111-4111-8111-111111111111');
        assert.equal(data.scope, 'organization');
        assert.equal(data.events.hires, 7);
        assert.equal(data.finance.paidFunding.paymob.amountEgp, 100.5);
        assert.equal(data.finance.creditBalanceEgp, 123.45);
        assert.equal(data.finance.noShowFeesEgp, 2.5);
        assert.equal(data.people.favorites, 3);
        assert.equal(data.people.topOrganizations, undefined);
        assert.equal(data.staffing.reviews.average, 4.5);
        assert.equal(data.alerts.pendingEventRequests, 2);
        assert.equal(queries.length, 18);
        assert.ok(queries.every(({ options }) => options.replacements.organizerId === '11111111-1111-4111-8111-111111111111'));
        assert.ok(queries.filter(({ sql }) => sql.includes('FROM events e') || sql.includes('JOIN events e'))
            .every(({ sql }) => sql.includes('e."organizerId" = :organizerId')));
        assert.ok(queries.filter(({ sql }) => /FROM (organizer_credit_entries|funding_refunds|event_action_requests) x/.test(sql))
            .every(({ sql }) => sql.includes('x."organizerId" = :organizerId')));
    } finally {
        sequelize.query = original;
    }
});

test('platform analytics has no organization filter and handles an empty database', async () => {
    const original = sequelize.query;
    sequelize.query = async (sql) => {
        assert.doesNotMatch(sql, /:organizerId/);
        if (sql.includes('AS "bookedValue"')) return [{ total: 0, positions: 0, hires: 0, bookedValue: 0, noShowFees: 0 }];
        if (sql.includes('avg(x.rating)')) return [{ count: 0, average: 0 }];
        if (sql.includes('FROM organizer_credit_entries')) return [{ cents: 0 }];
        if (sql.includes('FROM organization_favorites')) return [{ count: 0 }];
        if (sql.includes('AS cents\n            FROM events e LEFT JOIN')) return [{ count: 0, cents: 0 }];
        if (sql.includes('FROM event_action_requests')) return [{ count: 0 }];
        if (sql.includes('lateExcuseCount')) return [{ count: 0 }];
        return [];
    };
    try {
        const data = await getAnalytics();
        assert.equal(data.scope, 'platform');
        assert.equal(data.events.total, 0);
        assert.deepEqual(data.people.usersByRole, {});
        assert.deepEqual(data.people.topOrganizations, []);
        assert.deepEqual(data.people.topUshers, []);
        assert.equal(data.finance.creditBalanceEgp, 0);
    } finally {
        sequelize.query = original;
    }
});
