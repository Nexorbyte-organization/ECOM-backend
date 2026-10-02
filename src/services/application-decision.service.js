import { Op } from 'sequelize';
import { Event, EventFunding } from '../../db/index.js';
import { AppError } from '../utils/appError.js';
import { eventDayRange } from '../utils/eventSchedule.js';
import { fundingDeadline, perUsherGrossCents } from './funding-policy.js';

export const AUTO_ACCEPT_MIN_RATING = 4.5;
// Ushers who reach this many late excuses cannot take new work until an admin resets the counter
// (or five good events reset it automatically).
export const LATE_EXCUSE_LIMIT = 5;

export function assertCanTakeNewBookings(talent, now = new Date()) {
    // Set automatically after repeated no-shows and lifts on its own.
    if (talent?.suspendedUntil && new Date(talent.suspendedUntil) > now) {
        throw new AppError(`Bookings are suspended until ${new Date(talent.suspendedUntil).toDateString()} because of missed check-ins`, 403);
    }
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

// Past the funding deadline, an usher can only be booked when their pay is already funded, so no
// one is booked into a spot that will be cancelled for lack of funding.
async function assertSeatFundedAfterDeadline({ event, hiredCount, transaction, now = new Date() }) {
    if (event.fundingMode !== 'prefund') return;
    const deadline = fundingDeadline(event);
    if (!deadline || now < deadline) return;
    const funded = Number(await EventFunding.sum('amountCents', {
        where: { eventId: event.id, collectionStatus: 'paid' },
        transaction,
    }) || 0);
    if (funded < hiredCount * perUsherGrossCents(event.budget)) {
        throw new AppError('The funding deadline has passed, so this usher can only be booked after their pay is funded. Fund an extra spot first.', 409);
    }
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
            await assertSeatFundedAfterDeadline({ event, hiredCount: hiredTalents.length + 1, transaction });
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
