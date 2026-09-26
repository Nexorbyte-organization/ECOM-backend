import { Op } from 'sequelize';
import { Event } from '../../db/index.js';
import { AppError } from '../utils/appError.js';

export const AUTO_ACCEPT_MIN_RATING = 4.5;

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

        const conflictingEvent = await Event.findOne({
            where: {
                id: { [Op.ne]: event.id },
                eventDate: event.eventDate,
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
