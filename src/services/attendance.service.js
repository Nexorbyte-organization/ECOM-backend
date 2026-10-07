import { Op } from 'sequelize';
import { randomBytes } from 'crypto';
import { sequelize } from '../../db/connection.js';
import { Attendance, CheckInPoint, Event, User } from '../../db/index.js';
import { SELF_CHECK_IN_METHODS } from '../../db/models/attendance.model.js';
import { AppError } from '../utils/appError.js';
import { checkInDayAt, closedCheckInDays, eventDays } from '../utils/eventSchedule.js';
import {
    CHECK_IN_RADIUS_METERS,
    MAX_LOCATION_ACCURACY_METERS,
    POINT_LOCATION_FRESH_MS,
    POINT_LOCATION_RECENT_MS,
    codeExpiresAt,
    isValidCoordinate,
    isWithinRadius,
    numericCodeFor,
    numericCodeMatchesPoint,
    parseQrToken,
    pointLocation,
    pointReportedSince,
    qrTokenFor,
    qrTokenMatchesPoint,
} from '../utils/checkInCode.js';
import { checkAndAutoVerify } from './talent-stats.service.js';
import { notifySafely } from './settlement.service.js';

// Three missed check-ins within 90 days suspend an usher from new work for 30 days.
export const NO_SHOW_LIMIT = 3;
export const NO_SHOW_WINDOW_DAYS = 90;
export const NO_SHOW_SUSPENSION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const GOOD_EVENTS_TO_RESET_EXCUSES = 5;
const PAYABLE = ['present', 'late'];

// The suspension end implied by an usher's recent no-shows, or null. Pass one date per event: missing
// several days of one event counts as one no-show.
export const suspensionUntil = (noShowDates, now = new Date()) => {
    const since = now.getTime() - NO_SHOW_WINDOW_DAYS * DAY_MS;
    const recent = noShowDates
        .map((date) => new Date(date).getTime())
        .filter((time) => Number.isFinite(time) && time >= since)
        .sort((a, b) => b - a);
    if (recent.length < NO_SHOW_LIMIT) return null;
    const until = new Date(recent[0] + NO_SHOW_SUSPENSION_DAYS * DAY_MS);
    return until > now ? until : null;
};

const readLocation = (input) => {
    const location = {
        latitude: Number(input?.latitude),
        longitude: Number(input?.longitude),
        accuracy: input?.accuracy === undefined || input?.accuracy === null ? null : Number(input.accuracy),
    };
    if (!isValidCoordinate(location)) {
        throw new AppError('Turn on location so we can confirm you are at the event', 400);
    }
    if (location.accuracy !== null && (!Number.isFinite(location.accuracy) || location.accuracy > MAX_LOCATION_ACCURACY_METERS)) {
        throw new AppError('Your location is not precise enough. Turn on precise location and try again.', 400);
    }
    return location;
};

const dayLabel = (event, dayIndex) => (eventDays(event).length > 1 ? `day ${dayIndex + 1}` : 'the event');

// The day an usher is checking in for right now and whether they are on time.
const assertWindowOpen = (event) => {
    if (event.status === 'cancelled' || event.status === 'completed' || event.fundsReleasedAt) {
        throw new AppError('Check-in is closed for this event', 409);
    }
    const { status, dayIndex } = checkInDayAt(event);
    if (status === 'early') {
        throw new AppError(dayIndex === 0
            ? 'Check-in opens 2 hours before the event starts'
            : `Check-in for day ${dayIndex + 1} opens 2 hours before it starts`, 409);
    }
    if (status === 'closed') throw new AppError('Check-in is closed for this event', 409);
    return { arrival: status, dayIndex };
};

// The day a staff check-in is for: the requested day once its check-in has opened, otherwise the
// current day, or the latest day that has started when check-in is between days or closed.
const staffCheckInDay = (event, requested, now = new Date()) => {
    const days = eventDays(event);
    const current = checkInDayAt(event, now);
    const opened = current.status === 'early' ? current.dayIndex - 1 : current.dayIndex;
    if (requested === undefined || requested === null) {
        if (opened < 0) throw new AppError('Check-in opens 2 hours before the event starts', 409);
        return opened;
    }
    const dayIndex = Number(requested);
    if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= days.length) {
        throw new AppError('This event does not have that day', 400);
    }
    if (dayIndex > opened) throw new AppError(`Check-in for ${dayLabel(event, dayIndex)} has not opened yet`, 409);
    return dayIndex;
};

// The streak counts events, so on a multi-day event only the first day checked in adds to it.
const updateStreak = (talent, previousStatus, status, { eventAlreadyCounted = false } = {}) => {
    const wasGood = PAYABLE.includes(previousStatus);
    if (PAYABLE.includes(status) && !wasGood && !eventAlreadyCounted) {
        talent.consecutiveGoodEvents = (talent.consecutiveGoodEvents || 0) + 1;
        if (talent.consecutiveGoodEvents >= GOOD_EVENTS_TO_RESET_EXCUSES) {
            talent.lateExcuseCount = 0;
            talent.consecutiveGoodEvents = 0;
        }
    } else if (status === 'absent') {
        talent.consecutiveGoodEvents = 0;
    }
};

const attendedAnotherDay = async ({ eventId, talentId, dayIndex, transaction }) => Boolean(await Attendance.count({
    where: { eventId, talentId, dayIndex: { [Op.ne]: dayIndex }, status: { [Op.in]: PAYABLE } },
    transaction,
}));

// One usher's attendance on an event across its days: present or late when they worked at least
// one day (late if any day was late), absent when every recorded day was missed.
export const summarizeAttendance = (records, dayCount = 1) => {
    const worked = records.filter((record) => PAYABLE.includes(record.status));
    const attendanceStatus = worked.length
        ? (worked.some((record) => record.status === 'late') ? 'late' : 'present')
        : records.some((record) => record.status === 'absent') ? 'absent' : null;
    return {
        attendanceStatus,
        attendedDays: new Set(worked.map((record) => record.dayIndex)).size,
        dayCount,
        attendanceDays: [...records]
            .sort((a, b) => a.dayIndex - b.dayIndex)
            .map((record) => ({ dayIndex: record.dayIndex, status: record.status, checkInTime: record.checkInTime })),
    };
};

export class AttendanceService {
    // ── Staff check-in points ──────────────────────────────────────────────────
    // opensAt/closesAt are the current day's check-in window, or the next day's between days.
    static pointView(point, event, now = Date.now()) {
        const { opensAt, closesAt, status, dayIndex } = checkInDayAt(event, new Date(now));
        const open = point.active && ['present', 'late'].includes(status)
            && !event.fundsReleasedAt && !['cancelled', 'completed'].includes(event.status);
        const view = { point: point.toJSON(), open, opensAt, closesAt, dayIndex, dayCount: eventDays(event).length };
        if (!open) return view;
        const token = qrTokenFor(point);
        const configuredFrontend = (process.env.FRONTEND_URL || '').split(',')[0].trim();
        const frontendUrl = configuredFrontend || 'http://localhost:3001';
        return {
            ...view,
            checkInUrl: new URL(`/talent/check-in/${encodeURIComponent(token)}`, frontendUrl).toString(),
            code: numericCodeFor(point),
            expiresAt: codeExpiresAt(now),
        };
    }

    // Opens or refreshes the caller's check-in point. The staff screen calls this every few
    // seconds with its location, which keeps the point present and returns the current codes.
    static async openPoint({ event, staffUser, location: input, label }) {
        if (['cancelled', 'completed'].includes(event.status) || event.fundsReleasedAt) {
            throw new AppError(`Check-in is closed for this ${event.status === 'cancelled' ? 'cancelled' : 'finished'} event`, 409);
        }
        const location = readLocation(input);
        const cleanLabel = typeof label === 'string' && label.trim() ? label.trim().slice(0, 80) : null;
        const [point] = await CheckInPoint.findOrCreate({
            where: { eventId: event.id, staffUserId: staffUser.id },
            defaults: { secret: randomBytes(32).toString('hex'), label: cleanLabel },
        });
        await point.update({
            active: true,
            latitude: location.latitude,
            longitude: location.longitude,
            accuracyMeters: location.accuracy,
            locationUpdatedAt: new Date(),
            ...(cleanLabel ? { label: cleanLabel } : {}),
        });
        return this.pointView(point, event);
    }

    static async closePoint({ event, staffUser }) {
        await CheckInPoint.update({ active: false }, { where: { eventId: event.id, staffUserId: staffUser.id } });
    }

    static async listPoints(event) {
        const points = await CheckInPoint.findAll({ where: { eventId: event.id }, order: [['createdAt', 'ASC']] });
        const staff = points.length
            ? await User.findAll({ where: { id: { [Op.in]: points.map((point) => point.staffUserId) } }, attributes: ['id', 'fullName'], paranoid: false })
            : [];
        const names = new Map(staff.map((user) => [user.id, user.fullName]));
        const now = Date.now();
        return points.map((point) => ({
            ...point.toJSON(),
            staffName: names.get(point.staffUserId) || null,
            live: pointReportedSince(point, POINT_LOCATION_FRESH_MS, now),
        }));
    }

    // ── Usher check-in ─────────────────────────────────────────────────────────
    // method qr: a scanned token; code: the 6-digit code typed for an event; location: "I'm here"
    // near any staff phone that reported recently, or near the venue pin.
    static async selfCheckIn({ talentId, method, token, code, eventId, location: input }) {
        const location = readLocation(input);
        let event;
        let point = null;
        if (method === 'qr') {
            const parsed = parseQrToken(token);
            point = parsed ? await CheckInPoint.findByPk(parsed.pointId) : null;
            if (!point || !point.active || !qrTokenMatchesPoint(token, point)) {
                throw new AppError('This check-in code has expired. Scan the live code on the staff screen again.', 400);
            }
            event = await Event.findByPk(point.eventId);
        } else {
            event = await Event.findByPk(eventId);
        }
        if (!event) throw new AppError('Event not found', 404);
        if (!(event.hiredTalents || []).includes(talentId)) throw new AppError('You are not hired for this event', 403);
        assertWindowOpen(event);

        if (method === 'code') {
            const normalized = String(code || '').replace(/\D/g, '');
            if (normalized.length !== 6) throw new AppError('Enter the 6-digit code shown on the staff screen', 400);
            const points = await CheckInPoint.findAll({ where: { eventId: event.id, active: true } });
            point = points.find((candidate) => numericCodeMatchesPoint(normalized, candidate)) || null;
            if (!point) throw new AppError('This code is wrong or has expired. Enter the code currently on the staff screen.', 400);
        }

        if (point) {
            if (!pointReportedSince(point, POINT_LOCATION_FRESH_MS)) {
                throw new AppError('The staff phone is not sharing its location. Ask them to keep the check-in screen open.', 409);
            }
            if (!isWithinRadius(location, pointLocation(point))) {
                throw new AppError(`You must be within ${CHECK_IN_RADIUS_METERS} m of the staff phone to check in`, 409);
            }
        } else {
            const points = await CheckInPoint.findAll({ where: { eventId: event.id, active: true } });
            point = points.find((candidate) => pointReportedSince(candidate, POINT_LOCATION_RECENT_MS)
                && isWithinRadius(location, pointLocation(candidate))) || null;
            const venue = { latitude: event.venueLatitude, longitude: event.venueLongitude };
            if (!point && !isWithinRadius(location, venue)) {
                throw new AppError('You are not near the event staff or venue yet. Move closer, or ask staff to show the check-in code.', 409);
            }
        }

        return this.recordSelfCheckIn({ event, talentId, method, point, location });
    }

    static async recordSelfCheckIn({ event, talentId, method, point, location }) {
        const result = await sequelize.transaction(async (transaction) => {
            const lockedEvent = await Event.findByPk(event.id, { transaction, lock: transaction.LOCK.UPDATE });
            const { arrival, dayIndex } = assertWindowOpen(lockedEvent);
            const talent = await User.findByPk(talentId, { transaction, lock: transaction.LOCK.UPDATE });
            const existing = await Attendance.findOne({ where: { eventId: event.id, talentId, dayIndex }, transaction, lock: transaction.LOCK.UPDATE });
            const previousStatus = existing?.status || null;
            if (existing && PAYABLE.includes(previousStatus)) {
                // A repeated check-in keeps the first arrival; staff check-in becomes self-proven.
                if (!SELF_CHECK_IN_METHODS.includes(existing.checkInMethod)) {
                    await existing.update({
                        checkInMethod: method, checkInPointId: point?.id || null,
                        checkInLatitude: location.latitude, checkInLongitude: location.longitude,
                    }, { transaction });
                }
                return { attendance: existing, alreadyCheckedIn: true };
            }
            const values = {
                status: arrival,
                checkInTime: new Date(),
                checkInMethod: method,
                checkInPointId: point?.id || null,
                checkInLatitude: location.latitude,
                checkInLongitude: location.longitude,
                recordedBy: talentId,
            };
            const attendance = existing
                ? await existing.update(values, { transaction })
                : await Attendance.create({ eventId: event.id, talentId, dayIndex, ...values }, { transaction });
            if (talent) {
                const eventAlreadyCounted = await attendedAnotherDay({ eventId: event.id, talentId, dayIndex, transaction });
                updateStreak(talent, previousStatus, arrival, { eventAlreadyCounted });
                await talent.save({ transaction });
            }
            return { attendance, alreadyCheckedIn: false };
        });
        await this.afterAttendanceChange(talentId);
        return { ...result, event };
    }

    // Staff can check in an usher whose phone cannot (no camera, no location, dead battery). They
    // can never mark anyone absent and never change an usher's own check-in, so this only ever
    // adds pay. It stays possible until the payments are released, for any day whose check-in has
    // opened (the current day by default).
    static async staffCheckIn({ event, talentId, status, staffUser, location: input, dayIndex: requestedDay }) {
        if (!PAYABLE.includes(status)) throw new AppError('Staff can only check ushers in as present or late', 400);
        if (event.status === 'cancelled') throw new AppError('Attendance cannot be recorded for a cancelled event', 409);
        if (event.fundsReleasedAt) throw new AppError('This event’s payments were already released', 409);
        if (!(event.hiredTalents || []).includes(talentId)) throw new AppError('This usher is not hired for this event', 400);
        const dayIndex = staffCheckInDay(event, requestedDay);
        const location = input && isValidCoordinate({ latitude: Number(input.latitude), longitude: Number(input.longitude) })
            ? { latitude: Number(input.latitude), longitude: Number(input.longitude) }
            : null;

        const attendance = await sequelize.transaction(async (transaction) => {
            const existing = await Attendance.findOne({ where: { eventId: event.id, talentId, dayIndex }, transaction, lock: transaction.LOCK.UPDATE });
            if (existing && SELF_CHECK_IN_METHODS.includes(existing.checkInMethod) && PAYABLE.includes(existing.status)) {
                throw new AppError(`This usher already checked in for ${dayLabel(event, dayIndex)} with their own phone`, 409);
            }
            if (existing?.status === 'present' && status === 'late') {
                throw new AppError('An usher checked in as present cannot be changed to late', 409);
            }
            const previousStatus = existing?.status || null;
            const values = {
                status,
                checkInTime: existing?.checkInTime || new Date(),
                checkInMethod: 'staff',
                recordedBy: staffUser.id,
                checkInLatitude: location?.latitude ?? null,
                checkInLongitude: location?.longitude ?? null,
            };
            const record = existing
                ? await existing.update(values, { transaction })
                : await Attendance.create({ eventId: event.id, talentId, dayIndex, ...values }, { transaction });
            const talent = await User.findByPk(talentId, { transaction, lock: transaction.LOCK.UPDATE });
            if (talent) {
                const eventAlreadyCounted = await attendedAnotherDay({ eventId: event.id, talentId, dayIndex, transaction });
                updateStreak(talent, previousStatus, status, { eventAlreadyCounted });
                await talent.save({ transaction });
            }
            return record;
        });
        await this.afterAttendanceChange(talentId);
        return attendance;
    }

    // When a day's check-in closes, every hired usher without a check-in that day missed it.
    // Idempotent.
    static async finalizeAttendance(event, now = new Date()) {
        if (event.status === 'cancelled' || event.fundsReleasedAt) return [];
        const closedDays = closedCheckInDays(event, now);
        if (!closedDays.length) return [];
        const hired = [...new Set(event.hiredTalents || [])];
        if (!hired.length) return [];
        const existing = await Attendance.findAll({
            where: { eventId: event.id, talentId: { [Op.in]: hired }, dayIndex: { [Op.in]: closedDays } },
            attributes: ['talentId', 'dayIndex'],
        });
        const marked = new Set(existing.map((record) => `${record.talentId}:${record.dayIndex}`));
        const multiDay = eventDays(event).length > 1;
        const created = [];
        for (const dayIndex of closedDays) {
            for (const talentId of hired.filter((id) => !marked.has(`${id}:${dayIndex}`))) {
                const [record, isNew] = await Attendance.findOrCreate({
                    where: { eventId: event.id, talentId, dayIndex },
                    defaults: { status: 'absent', checkInMethod: 'auto' },
                });
                if (!isNew) continue;
                created.push(record);
                const talent = await User.findByPk(talentId);
                if (talent) {
                    updateStreak(talent, null, 'absent');
                    await talent.save();
                }
                await this.afterAttendanceChange(talentId);
                await notifySafely({
                    userId: talentId,
                    title: 'Missed check-in',
                    message: multiDay
                        ? `You did not check in on day ${dayIndex + 1} of “${event.title}”, so you will not be paid for that day and it counts as a no-show. ${NO_SHOW_LIMIT} no-show events within ${NO_SHOW_WINDOW_DAYS} days suspend new bookings for ${NO_SHOW_SUSPENSION_DAYS} days.`
                        : `You did not check in at “${event.title}”, so it counts as a no-show and you will not be paid for it. ${NO_SHOW_LIMIT} no-shows within ${NO_SHOW_WINDOW_DAYS} days suspend new bookings for ${NO_SHOW_SUSPENSION_DAYS} days.`,
                    type: 'danger',
                    link: '/talent/events',
                });
            }
        }
        return created;
    }

    static async afterAttendanceChange(talentId) {
        await this.refreshSuspension(talentId);
        await checkAndAutoVerify(talentId);
    }

    static async refreshSuspension(talentId, now = new Date()) {
        const since = new Date(now.getTime() - NO_SHOW_WINDOW_DAYS * DAY_MS);
        const noShows = await Attendance.findAll({
            where: { talentId, status: 'absent', updatedAt: { [Op.gte]: since } },
            attributes: ['eventId', 'updatedAt'],
        });
        const talent = await User.findByPk(talentId);
        if (!talent) return null;
        // Missing several days of one event counts once, at the latest missed day.
        const latestByEvent = new Map();
        noShows.forEach((record) => {
            const time = new Date(record.updatedAt).getTime();
            latestByEvent.set(record.eventId, Math.max(latestByEvent.get(record.eventId) || 0, time));
        });
        const until = suspensionUntil([...latestByEvent.values()].map((time) => new Date(time)), now);
        const current = talent.suspendedUntil ? new Date(talent.suspendedUntil) : null;
        const changed = (until?.getTime() || null) !== (current?.getTime() || null);
        if (!changed) return until;
        talent.suspendedUntil = until;
        await talent.save();
        if (until && (!current || current <= now)) {
            await notifySafely({
                userId: talentId,
                title: 'Bookings suspended',
                message: `You missed ${NO_SHOW_LIMIT} check-ins within ${NO_SHOW_WINDOW_DAYS} days, so you cannot take new events until ${until.toDateString()}.`,
                type: 'danger',
                link: '/talent/events',
            });
        }
        return until;
    }
}
