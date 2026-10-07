import { Op } from 'sequelize';
import { Application, Event, EventFunding } from '../../db/index.js';
import { AppError } from '../utils/appError.js';
import { eventDayRange, hasEventStarted } from '../utils/eventSchedule.js';
import { fundingDeadline, perUsherGrossCents } from './funding-policy.js';

export const AUTO_ACCEPT_MIN_RATING = 4.5;
// Ushers who reach this many late excuses cannot take new work until an admin resets the counter
// (or five good events reset it automatically).
export const LATE_EXCUSE_LIMIT = 5;
// An event may keep up to half its staff count (rounded up) on standby.
export const STANDBY_SHARE = 0.5;
// An usher moved in from standby can excuse themselves within this time without a late penalty,
// since they did not choose the moment they were booked.
export const PROMOTION_GRACE_MS = 2 * 60 * 60 * 1000;

export const maxStandbyCount = (requiredCount) => Math.ceil(Math.max(Number(requiredCount) || 0, 0) * STANDBY_SHARE);

export const isWithinPromotionGrace = (application, now = new Date()) => Boolean(
    application?.promotedAt && now - new Date(application.promotedAt) <= PROMOTION_GRACE_MS,
);

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

// Another non-cancelled event the same calendar day that already has this usher hired.
async function sameDayBooking({ event, talentId, transaction }) {
    // eventDate is a timestamp, so compare the whole calendar day rather than the exact instant.
    const { start, end } = eventDayRange(event.eventDate);
    return Event.findOne({
        where: {
            id: { [Op.ne]: event.id },
            eventDate: { [Op.gte]: start, [Op.lt]: end },
            status: { [Op.ne]: 'cancelled' },
            hiredTalents: { [Op.contains]: [talentId] },
        },
        transaction,
    });
}

// Standby does not block other work. Once the usher is booked elsewhere that day they could not
// be moved in, so they leave the standby lists of that day's other events.
async function withdrawSameDayStandby({ event, talentId, transaction }) {
    const standby = await Application.findAll({
        where: { talentId, status: 'standby', eventId: { [Op.ne]: event.id } },
        attributes: ['id', 'eventId'],
        transaction,
    });
    if (!standby.length) return;
    const { start, end } = eventDayRange(event.eventDate);
    const sameDay = await Event.findAll({
        where: { id: { [Op.in]: standby.map((application) => application.eventId) }, eventDate: { [Op.gte]: start, [Op.lt]: end } },
        attributes: ['id'],
        transaction,
    });
    if (!sameDay.length) return;
    await Application.update(
        { status: 'withdrawn' },
        { where: { talentId, status: 'standby', eventId: { [Op.in]: sameDay.map((item) => item.id) } }, transaction },
    );
}

// Standby is unpaid, so only ushers who agreed to it can be put on the list.
async function placeOnStandby({ application, event, transaction, now = new Date() }) {
    if (application.status === 'standby') return 'standby';
    if (application.status !== 'pending') {
        throw new AppError('Only a pending application can be moved to standby', 409);
    }
    if (!application.standbyOk) {
        throw new AppError('This usher did not agree to be on standby', 409);
    }
    if (hasEventStarted(event, now)) {
        throw new AppError('The event has started, so no one can join its standby list', 409);
    }
    const standbyCount = Number(event.standbyCount) || 0;
    if (!standbyCount) throw new AppError('This event has no standby spots', 409);
    const onStandby = await Application.count({ where: { eventId: event.id, status: 'standby' }, transaction });
    if (onStandby >= standbyCount) throw new AppError('The standby list for this event is full', 409);
    if (await sameDayBooking({ event, talentId: application.talentId, transaction })) {
        throw new AppError('This usher is already booked for another event on this date', 409);
    }

    application.status = 'standby';
    application.standbySince = now;
    await application.save({ transaction });
    return 'standby';
}

// Applies an organization or usher decision and returns the resulting status. With
// `overflowToStandby`, accepting into a full event puts an usher who agreed to standby on the list.
export async function updateApplicationDecision({ application, event, status, transaction, overflowToStandby = false }) {
    const hiredTalents = Array.isArray(event.hiredTalents) ? event.hiredTalents : [];

    if (status === 'standby') {
        return placeOnStandby({ application, event, transaction });
    }

    if (status === 'accepted') {
        if (!hiredTalents.includes(application.talentId) && hiredTalents.length >= event.requiredCount) {
            if (overflowToStandby && application.status === 'pending' && application.standbyOk) {
                return placeOnStandby({ application, event, transaction });
            }
            throw new AppError('This event is already fully staffed', 409);
        }

        if (await sameDayBooking({ event, talentId: application.talentId, transaction })) {
            throw new AppError('This usher is already booked for another event on this date', 409);
        }

        if (!hiredTalents.includes(application.talentId)) {
            await assertSeatFundedAfterDeadline({ event, hiredCount: hiredTalents.length + 1, transaction });
            event.hiredTalents = [...hiredTalents, application.talentId];
        }
        if (application.status === 'standby') application.promotedAt = new Date();
        await withdrawSameDayStandby({ event, talentId: application.talentId, transaction });
    } else {
        event.hiredTalents = hiredTalents.filter((id) => id !== application.talentId);
        event.mapPins = (event.mapPins || []).map((pin) => ({
            ...pin, usherIds: (pin.usherIds || []).filter((id) => id !== application.talentId),
        }));
    }

    application.status = status;
    await event.save({ transaction });
    await application.save({ transaction });
    return status;
}

export async function tryAutoAcceptApplication({ application, event, organizer, talent, transaction }) {
    if (!isAutoAcceptHighRatedTalentsEnabled(organizer) || !qualifiesForHighRatedAutoAccept(talent)) {
        return { accepted: false };
    }

    try {
        const status = await updateApplicationDecision({ application, event, status: 'accepted', transaction, overflowToStandby: true });
        return { accepted: status === 'accepted', standby: status === 'standby' };
    } catch (error) {
        if (error instanceof AppError && error.statusCode === 409) {
            return { accepted: false, reason: error.message };
        }
        throw error;
    }
}
