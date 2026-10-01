import { Op } from 'sequelize';
import { Event } from '../../db/index.js';
import { AppError } from '../utils/appError.js';
import { eventDayRange } from '../utils/eventSchedule.js';

export const AUTO_ACCEPT_MIN_RATING = 4.5;
// Ushers who reach this many late excuses cannot take new work until an admin resets the counter
// (or five good events reset it automatically).
export const LATE_EXCUSE_LIMIT = 5;

export function assertCanTakeNewBookings(talent) {
    if ((talent?.lateExcuseCount || 0) >= LATE_EXCUSE_LIMIT) {
        throw new AppError(`You have ${LATE_EXCUSE_LIMIT} late excuses, so you cannot take new events until an administrator reviews your account`, 403);
    }
}

export function isAutoAcceptHighRatedTalentsEnabled(organizer) {
    const value = organizer?.organizationInfo?.autoAcceptHighRatedTalents;
    return value === true || value === 'true';
}

export function qualifiesForHighRatedAutoAccept(talent) {
    return Number(talent?.rate || 0) > AUTO_ACCEPT_MIN_RATING;
}

export async function updateApplicationDecision({ application, event, status, transaction }) {
    const hiredTalents = Array.isArray(event.hiredTalents) ? event.hiredTalents : [];

    if (status === 'accepted') {
        if (!hiredTalents.includes(application.talentId) && hiredTalents.length >= event.requiredCount) {
            throw new AppError('This event is already fully staffed', 409);
        }

        // eventDate is a timestamp, so compare the whole calendar day rather than the exact instant.
        const { start, end } = eventDayRange(event.eventDate);
        const conflictingEvent = await Event.findOne({
            where: {
                id: { [Op.ne]: event.id },
                eventDate: { [Op.gte]: start, [Op.lt]: end },
                status: { [Op.ne]: 'cancelled' },
                hiredTalents: { [Op.contains]: [application.talentId] },
            },
            transaction,
        });
        if (conflictingEvent) {
            throw new AppError('This usher is already booked for another event on this date', 409);
        }

        if (!hiredTalents.includes(application.talentId)) {
            event.hiredTalents = [...hiredTalents, application.talentId];
        }
    } else {
        event.hiredTalents = hiredTalents.filter((id) => id !== application.talentId);
        event.mapPins = (event.mapPins || []).map((pin) => ({
            ...pin, usherIds: (pin.usherIds || []).filter((id) => id !== application.talentId),
        }));
    }

    application.status = status;
    await event.save({ transaction });
    await application.save({ transaction });
}

export async function tryAutoAcceptApplication({ application, event, organizer, talent, transaction }) {
    if (!isAutoAcceptHighRatedTalentsEnabled(organizer) || !qualifiesForHighRatedAutoAccept(talent)) {
        return { accepted: false };
    }

    try {
        await updateApplicationDecision({ application, event, status: 'accepted', transaction });
        return { accepted: true };
    } catch (error) {
        if (error instanceof AppError && error.statusCode === 409) {
            return { accepted: false, reason: error.message };
        }
        throw error;
    }
}
