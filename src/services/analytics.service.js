import { QueryTypes } from 'sequelize';
import { sequelize } from '../../db/connection.js';

const number = (value) => Number(value || 0);
const money = (cents) => number(cents) / 100;
const counts = (rows) => Object.fromEntries(rows.map((row) => [row.key, number(row.count)]));
const scoped = (organizerId) => organizerId ? 'AND e."organizerId" = :organizerId' : '';

// All event-related metrics join through live events. A company query always filters the
// event owner in SQL; no unbounded event IDs or customer records are sent to the browser.
export async function getAnalytics(organizerId = null) {
    const replacements = { organizerId };
    const eventScope = scoped(organizerId);
    const run = (sql) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });
    const eventJoin = `JOIN events e ON e.id = x."eventId" AND e."deletedAt" IS NULL ${eventScope}`;
    const directScope = organizerId ? 'AND x."organizerId" = :organizerId' : '';

    const [eventSummary, eventStatuses, categories, monthlyEvents, applications, attendance,
        reviewSummary, referrals, funding, settlements, payouts, credit, refunds,
        recentEvents, users, favorites, underfunded, actionRequests, flaggedUshers,
        topOrganizations, topUshers] = await Promise.all([
        run(`SELECT count(*)::int AS "total", COALESCE(sum(e."requiredCount"), 0) AS "positions",
            COALESCE(sum(cardinality(e."hiredTalents")) FILTER (WHERE e.status <> 'cancelled'), 0) AS "hires",
            COALESCE(round(sum(e.budget::numeric * cardinality(e."hiredTalents"))
                FILTER (WHERE e.status <> 'cancelled'), 2), 0) AS "bookedValue",
            COALESCE(sum(e."noShowFeeCents"), 0) AS "noShowFees"
            FROM events e WHERE e."deletedAt" IS NULL ${eventScope}`),
        run(`SELECT e.status AS key, count(*)::int AS count FROM events e
            WHERE e."deletedAt" IS NULL ${eventScope} GROUP BY e.status`),
        run(`SELECT e.category AS key, count(*)::int AS count FROM events e
            WHERE e."deletedAt" IS NULL ${eventScope} GROUP BY e.category ORDER BY count DESC`),
        run(`SELECT to_char(date_trunc('month', e."createdAt"), 'YYYY-MM') AS month, count(*)::int AS count
            FROM events e WHERE e."deletedAt" IS NULL ${eventScope}
            AND e."createdAt" >= date_trunc('month', now()) - interval '11 months'
            GROUP BY 1 ORDER BY 1`),
        run(`SELECT x.status AS key, count(*)::int AS count,
            count(*) FILTER (WHERE x."isDirect")::int AS direct
            FROM applications x ${eventJoin} WHERE x."deletedAt" IS NULL GROUP BY x.status`),
        run(`SELECT x.status AS key, count(*)::int AS count,
            count(*) FILTER (WHERE x."checkInMethod" = 'qr')::int AS qr
            FROM attendances x ${eventJoin} WHERE x."deletedAt" IS NULL GROUP BY x.status`),
        run(`SELECT count(*)::int AS count, COALESCE(avg(x.rating), 0) AS average
            FROM reviews x ${eventJoin} WHERE x."deletedAt" IS NULL`),
        run(`SELECT x.status AS key, count(*)::int AS count
            FROM referrals x ${eventJoin} WHERE x."deletedAt" IS NULL GROUP BY x.status`),
        run(`SELECT x.source AS key, count(*)::int AS count, COALESCE(sum(x."amountCents"), 0) AS cents
            FROM event_fundings x ${eventJoin}
            WHERE x."deletedAt" IS NULL AND x."collectionStatus" = 'paid' GROUP BY x.source`),
        run(`SELECT x."collectionStatus" AS key, count(*)::int AS count,
            COALESCE(sum(x."collectionAmountCents"), 0) AS cents,
            COALESCE(sum(x."platformFeeCents"), 0) AS fees
            FROM event_settlements x ${eventJoin} WHERE x."deletedAt" IS NULL GROUP BY x."collectionStatus"`),
        run(`SELECT x."payoutStatus" AS key, count(*)::int AS count,
            COALESCE(sum(x."usherAmountCents"), 0) AS cents
            FROM settlement_lines x ${eventJoin}
            JOIN event_settlements s ON s.id = x."settlementId" AND s."deletedAt" IS NULL
                AND s."collectionStatus" = 'paid'
            WHERE x."deletedAt" IS NULL GROUP BY x."payoutStatus"`),
        run(`SELECT COALESCE(sum(x."amountCents"), 0) AS cents
            FROM organizer_credit_entries x WHERE x."deletedAt" IS NULL ${directScope}`),
        run(`SELECT x.status AS key, count(*)::int AS count,
            COALESCE(sum(x."amountCents"), 0) AS cents
            FROM funding_refunds x WHERE x."deletedAt" IS NULL ${directScope} GROUP BY x.status`),
        run(`SELECT e.id, e.title, e.status, e."eventDate", e."requiredCount",
            cardinality(e."hiredTalents") AS "hires", e."organizerId", u."fullName" AS organization
            FROM events e JOIN users u ON u.id = e."organizerId"
            WHERE e."deletedAt" IS NULL ${eventScope} ORDER BY e."createdAt" DESC LIMIT 6`),
        organizerId
            ? run(`SELECT role AS key, count(*)::int AS count FROM users
                WHERE "deletedAt" IS NULL AND "providerOwnerId" = :organizerId GROUP BY role`)
            : run(`SELECT role AS key, count(*)::int AS count,
                count(*) FILTER (WHERE "isBlocked")::int AS blocked,
                count(*) FILTER (WHERE "isVerified")::int AS verified
                FROM users WHERE "deletedAt" IS NULL GROUP BY role`),
        organizerId
            ? run(`SELECT count(*)::int AS count FROM organization_favorites
                WHERE "deletedAt" IS NULL AND "organizerId" = :organizerId`)
            : run(`SELECT count(*)::int AS count FROM organization_favorites WHERE "deletedAt" IS NULL`),
        run(`SELECT count(*)::int AS count,
            COALESCE(sum(greatest(cardinality(e."hiredTalents") * round(e.budget * 100)
                - COALESCE(f.cents, 0), 0)), 0) AS cents
            FROM events e LEFT JOIN (
                SELECT "eventId", sum("amountCents") AS cents FROM event_fundings
                WHERE "deletedAt" IS NULL AND "collectionStatus" = 'paid' GROUP BY "eventId"
            ) f ON f."eventId" = e.id
            WHERE e."deletedAt" IS NULL ${eventScope} AND e."fundingMode" = 'prefund'
                AND e."fundsReleasedAt" IS NULL AND e.status IN ('open', 'confirmed', 'completed')
                AND cardinality(e."hiredTalents") * round(e.budget * 100) > COALESCE(f.cents, 0)`),
        run(`SELECT count(*)::int AS count FROM event_action_requests x
            WHERE x."deletedAt" IS NULL AND x.status = 'pending' ${directScope}`),
        organizerId ? Promise.resolve([{ count: 0 }]) : run(`SELECT count(*)::int AS count FROM users
            WHERE "deletedAt" IS NULL AND role = 'usher' AND "lateExcuseCount" >= 5`),
        organizerId ? Promise.resolve([]) : run(`SELECT u.id, u."fullName" AS name,
            count(e.id)::int AS events,
            count(e.id) FILTER (WHERE e.status = 'completed')::int AS completed
            FROM users u JOIN events e ON e."organizerId" = u.id AND e."deletedAt" IS NULL
            WHERE u."deletedAt" IS NULL AND u.role = 'organizer'
            GROUP BY u.id, u."fullName" ORDER BY events DESC, completed DESC LIMIT 5`),
        organizerId ? Promise.resolve([]) : run(`SELECT id, "fullName" AS name, rate,
            "completedEventsCount" AS completed FROM users
            WHERE "deletedAt" IS NULL AND role = 'usher' AND "completedEventsCount" > 0
            ORDER BY rate DESC, "completedEventsCount" DESC LIMIT 5`),
    ]);

    const fundingBySource = Object.fromEntries(funding.map((row) => [row.key, { count: number(row.count), amountEgp: money(row.cents) }]));
    const settlementByStatus = Object.fromEntries(settlements.map((row) => [row.key, { count: number(row.count), amountEgp: money(row.cents), feeEgp: money(row.fees) }]));
    const payoutByStatus = Object.fromEntries(payouts.map((row) => [row.key, { count: number(row.count), amountEgp: money(row.cents) }]));
    const refundByStatus = Object.fromEntries(refunds.map((row) => [row.key, { count: number(row.count), amountEgp: money(row.cents) }]));
    const applicationCounts = counts(applications);
    const attendanceCounts = counts(attendance);
    return {
        scope: organizerId ? 'organization' : 'platform',
        generatedAt: new Date().toISOString(),
        events: {
            total: number(eventSummary[0].total), positions: number(eventSummary[0].positions),
            hires: number(eventSummary[0].hires), bookedValueEgp: number(eventSummary[0].bookedValue),
            byStatus: counts(eventStatuses), byCategory: counts(categories),
            monthlyCreated: monthlyEvents.map((row) => ({ month: row.month, count: number(row.count) })),
            recent: recentEvents.map((row) => ({ ...row, hires: number(row.hires) })),
        },
        staffing: {
            applications: applicationCounts,
            directInvitations: applications.reduce((sum, row) => sum + number(row.direct), 0),
            attendance: attendanceCounts,
            qrCheckIns: attendance.reduce((sum, row) => sum + number(row.qr), 0),
            referrals: counts(referrals),
            reviews: { count: number(reviewSummary[0].count), average: Number(number(reviewSummary[0].average).toFixed(2)) },
        },
        finance: {
            paidFunding: fundingBySource, settlements: settlementByStatus,
            payouts: payoutByStatus, creditBalanceEgp: money(credit[0].cents),
            cardRefunds: refundByStatus, noShowFeesEgp: money(eventSummary[0].noShowFees),
        },
        alerts: {
            underfundedEvents: number(underfunded[0].count),
            underfundedAmountEgp: money(underfunded[0].cents),
            pendingEventRequests: number(actionRequests[0].count),
            flaggedUshers: number(flaggedUshers[0].count),
        },
        people: organizerId
            ? { staffByRole: counts(users), favorites: number(favorites[0].count) }
            : { usersByRole: counts(users), blocked: users.reduce((sum, row) => sum + number(row.blocked), 0),
                verified: users.reduce((sum, row) => sum + number(row.verified), 0),
                favorites: number(favorites[0].count),
                topOrganizations: topOrganizations.map((row) => ({ ...row, events: number(row.events), completed: number(row.completed) })),
                topUshers: topUshers.map((row) => ({ ...row, rate: number(row.rate), completed: number(row.completed) })) },
    };
}
