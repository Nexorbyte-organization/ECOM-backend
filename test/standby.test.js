import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PG_URI ||= 'postgres://test:test@localhost:5432/standby_tests';
process.env.JWT_SECRET_KEY ||= 'standby-tests-secret-at-least-32-characters';
const { Application, Event } = await import('../db/index.js');
const {
    isWithinPromotionGrace,
    maxStandbyCount,
    PROMOTION_GRACE_MS,
    updateApplicationDecision,
} = await import('../src/services/application-decision.service.js');
const { lockedEventFields } = await import('../src/utils/eventEditing.js');
const { ApplicationValidator, EventValidator } = await import('../src/validators/event.validator.js');

const originals = {
    applicationCount: Application.count,
    applicationFindAll: Application.findAll,
    applicationUpdate: Application.update,
    eventFindOne: Event.findOne,
    eventFindAll: Event.findAll,
};

// In-memory stand-ins for the queries the decision service makes.
function stubDatabase({ onStandby = 0, bookedElsewhere = false, otherStandby = [], sameDayEventIds = [] } = {}) {
    const withdrawn = [];
    Application.count = async () => onStandby;
    Application.findAll = async () => otherStandby;
    Application.update = async (values, { where }) => {
        withdrawn.push({ values, eventIds: where.eventId });
        return [1];
    };
    Event.findOne = async () => (bookedElsewhere ? { id: 'other-event' } : null);
    Event.findAll = async () => sameDayEventIds.map((id) => ({ id }));
    return { withdrawn };
}

test.afterEach(() => {
    Application.count = originals.applicationCount;
    Application.findAll = originals.applicationFindAll;
    Application.update = originals.applicationUpdate;
    Event.findOne = originals.eventFindOne;
    Event.findAll = originals.eventFindAll;
});

const futureEvent = (overrides = {}) => ({
    id: 'event-1',
    status: 'open',
    eventDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
    startTime: '10:00',
    endTime: '18:00',
    requiredCount: 2,
    standbyCount: 1,
    hiredTalents: ['a', 'b'],
    fundingMode: 'pay_after',
    save: async () => undefined,
    ...overrides,
});

const pendingApplication = (overrides = {}) => ({
    id: 'application-1',
    eventId: 'event-1',
    talentId: 'c',
    status: 'pending',
    standbyOk: true,
    save: async () => undefined,
    ...overrides,
});

test('standby can be up to half the staff count, rounded up', () => {
    assert.equal(maxStandbyCount(10), 5);
    assert.equal(maxStandbyCount(3), 2);
    assert.equal(maxStandbyCount(1), 1);
    assert.equal(maxStandbyCount(0), 0);
});

test('an usher moved in from standby has a short grace period to excuse without penalty', () => {
    const now = new Date('2026-10-10T12:00:00.000Z');
    assert.equal(isWithinPromotionGrace({ promotedAt: new Date(now - PROMOTION_GRACE_MS + 1000) }, now), true);
    assert.equal(isWithinPromotionGrace({ promotedAt: new Date(now - PROMOTION_GRACE_MS - 1000) }, now), false);
    assert.equal(isWithinPromotionGrace({ promotedAt: null }, now), false);
});

test('accepting into a full event puts an usher who agreed to standby on the list', async () => {
    stubDatabase();
    const application = pendingApplication();
    const event = futureEvent();
    const status = await updateApplicationDecision({ application, event, status: 'accepted', overflowToStandby: true });
    assert.equal(status, 'standby');
    assert.equal(application.status, 'standby');
    assert.ok(application.standbySince instanceof Date);
    assert.deepEqual(event.hiredTalents, ['a', 'b']);
});

test('a full event still refuses ushers who did not agree to standby', async () => {
    stubDatabase();
    const application = pendingApplication({ standbyOk: false });
    await assert.rejects(
        updateApplicationDecision({ application, event: futureEvent(), status: 'accepted', overflowToStandby: true }),
        /fully staffed/,
    );
    await assert.rejects(
        updateApplicationDecision({ application, event: futureEvent(), status: 'standby' }),
        /did not agree/,
    );
    assert.equal(application.status, 'pending');
});

test('the standby list respects its size and same-day bookings', async () => {
    stubDatabase({ onStandby: 1 });
    await assert.rejects(
        updateApplicationDecision({ application: pendingApplication(), event: futureEvent(), status: 'standby' }),
        /standby list for this event is full/,
    );
    stubDatabase();
    await assert.rejects(
        updateApplicationDecision({ application: pendingApplication(), event: futureEvent({ standbyCount: 0 }), status: 'standby' }),
        /no standby spots/,
    );
    stubDatabase({ bookedElsewhere: true });
    await assert.rejects(
        updateApplicationDecision({ application: pendingApplication(), event: futureEvent(), status: 'standby' }),
        /already booked/,
    );
});

test('only pending applications can move to standby', async () => {
    stubDatabase();
    await assert.rejects(
        updateApplicationDecision({ application: pendingApplication({ status: 'accepted' }), event: futureEvent(), status: 'standby' }),
        /Only a pending application/,
    );
});

test('moving in from standby records the time and leaves that day’s other standby lists', async () => {
    const { withdrawn } = stubDatabase({
        otherStandby: [{ id: 'x', eventId: 'event-2' }, { id: 'y', eventId: 'event-3' }],
        sameDayEventIds: ['event-2'],
    });
    const application = pendingApplication({ status: 'standby', standbySince: new Date() });
    const event = futureEvent({ hiredTalents: ['a'] });
    const status = await updateApplicationDecision({ application, event, status: 'accepted' });
    assert.equal(status, 'accepted');
    assert.deepEqual(event.hiredTalents, ['a', 'c']);
    assert.ok(application.promotedAt instanceof Date);
    assert.equal(withdrawn.length, 1);
    assert.equal(withdrawn[0].values.status, 'withdrawn');
});

test('the standby count stays editable after hiring closes, until the start', () => {
    const event = {
        status: 'confirmed',
        eventDate: new Date('2026-10-20T00:00:00.000Z'),
        startTime: '10:00',
        endTime: '18:00',
        requiredCount: 4,
        standbyCount: 1,
    };
    assert.deepEqual(lockedEventFields(event, { standbyCount: 2 }, new Date('2026-10-10T12:00:00.000Z')), []);
    assert.deepEqual(lockedEventFields(event, { standbyCount: 2 }, new Date('2026-10-20T12:00:00.000Z')), ['standbyCount']);
});

test('requests accept the standby fields', () => {
    assert.equal(ApplicationValidator.updateStatus.validate({ status: 'standby' }).error, undefined);
    assert.equal(ApplicationValidator.apply.validate({ eventId: '0b0f0d1e-5b6a-4c1d-9f3e-2a1b3c4d5e6f', standbyOk: true }).error, undefined);
    assert.equal(ApplicationValidator.directBook.validate({
        eventId: '0b0f0d1e-5b6a-4c1d-9f3e-2a1b3c4d5e6f', talentId: '1b0f0d1e-5b6a-4c1d-9f3e-2a1b3c4d5e6f', asStandby: true,
    }).error, undefined);
    assert.ok(EventValidator.update.validate({ standbyCount: -1 }).error);
});

test('an open spot is filled from standby in order, skipping ushers who cannot be booked', async () => {
    const { sequelize } = await import('../db/connection.js');
    const { User } = await import('../db/index.js');
    const { NotificationService } = await import('../src/services/notification.service.js');
    const { StandbyService } = await import('../src/services/standby.service.js');
    const saved = { transaction: sequelize.transaction, findByPk: Event.findByPk, userFindByPk: User.findByPk, notify: NotificationService.create };

    const event = futureEvent({ requiredCount: 3, hiredTalents: ['a', 'b'], organizerId: 'org', title: 'Expo' });
    const suspended = pendingApplication({ id: 's1', talentId: 'suspended', status: 'standby', standbySince: new Date(1) });
    const next = pendingApplication({ id: 's2', talentId: 'next', status: 'standby', standbySince: new Date(2) });
    const later = pendingApplication({ id: 's3', talentId: 'later', status: 'standby', standbySince: new Date(3) });
    const talents = {
        suspended: { id: 'suspended', fullName: 'Suspended', suspendedUntil: new Date(Date.now() + 60_000) },
        next: { id: 'next', fullName: 'Next' },
        later: { id: 'later', fullName: 'Later' },
    };
    const notifications = [];
    stubDatabase();
    Application.findAll = async ({ where }) => (where.status === 'standby' && where.eventId === 'event-1' ? [suspended, next, later] : []);
    sequelize.transaction = async (work) => work({ LOCK: { UPDATE: 'UPDATE' } });
    Event.findByPk = async () => event;
    User.findByPk = async (id) => talents[id];
    NotificationService.create = async (notification) => { notifications.push(notification); };

    try {
        const promoted = await StandbyService.fillOpenSpots('event-1');
        assert.deepEqual(promoted, ['next']);
        assert.deepEqual(event.hiredTalents, ['a', 'b', 'next']);
        assert.equal(suspended.status, 'standby');
        assert.equal(later.status, 'standby');
        assert.deepEqual(notifications.map((item) => item.userId), ['next', 'org']);
    } finally {
        sequelize.transaction = saved.transaction;
        Event.findByPk = saved.findByPk;
        User.findByPk = saved.userFindByPk;
        NotificationService.create = saved.notify;
    }
});
