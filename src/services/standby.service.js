import { Op } from 'sequelize';
import { sequelize } from '../../db/connection.js';
import { Application, Event, User } from '../../db/index.js';
import { AppError } from '../utils/appError.js';
import { hasEventStarted } from '../utils/eventSchedule.js';
import { NotificationService } from './notification.service.js';
import { assertCanTakeNewBookings, PROMOTION_GRACE_MS, updateApplicationDecision } from './application-decision.service.js';

const notifySafely = (notification) => NotificationService.create(notification).catch(() => undefined);

const canBeMovedIn = (talent, now) => {
    if (!talent || talent.isBlocked) return false;
    try {
        assertCanTakeNewBookings(talent, now);
        return true;
    } catch {
        return false;
    }
};

// Standby ushers are on call, unpaid, and not at the venue. When a hired spot opens before the
// event starts, the earliest usher on the list who can still be booked is moved in.
export class StandbyService {
    // 1-based place in the standby queue, earliest first.
    static async positionOf(application) {
        if (application?.status !== 'standby') return null;
        const ahead = await Application.count({
            where: {
                eventId: application.eventId,
                status: 'standby',
                standbySince: { [Op.lt]: application.standbySince },
            },
        });
        return ahead + 1;
    }

    // Runs after the change that opened a spot has committed. Ushers who can no longer be booked
    // (suspended, booked elsewhere that day, or an unfunded spot after the funding deadline) are
    // skipped and stay on the list.
    static async fillOpenSpots(eventId, now = new Date()) {
        const outcome = await sequelize.transaction(async (transaction) => {
            const event = await Event.findByPk(eventId, { transaction, lock: transaction.LOCK.UPDATE });
            if (!event || !['open', 'confirmed'].includes(event.status) || hasEventStarted(event, now)) return null;
            if ((event.hiredTalents || []).length >= event.requiredCount) return null;

            const queue = await Application.findAll({
                where: { eventId, status: 'standby' },
                order: [['standbySince', 'ASC'], ['createdAt', 'ASC']],
                transaction,
                lock: transaction.LOCK.UPDATE,
            });
            const promoted = [];
            for (const application of queue) {
                if ((event.hiredTalents || []).length >= event.requiredCount) break;
                const talent = await User.findByPk(application.talentId, { transaction, lock: transaction.LOCK.UPDATE });
                if (!canBeMovedIn(talent, now)) continue;
                try {
                    await updateApplicationDecision({ application, event, status: 'accepted', transaction });
                    promoted.push({ application, talent });
                } catch (error) {
                    if (error instanceof AppError && error.statusCode === 409) continue;
                    throw error;
                }
            }
            return {
                event,
                promoted,
                openSpots: event.requiredCount - (event.hiredTalents || []).length,
                hadQueue: queue.length > 0,
            };
        });
        if (!outcome) return [];

        const { event, promoted, openSpots, hadQueue } = outcome;
        const graceHours = PROMOTION_GRACE_MS / (60 * 60 * 1000);
        await Promise.all(promoted.map(({ application }) => notifySafely({
            userId: application.talentId,
            title: 'You’re booked from standby',
            message: `A spot opened at “${event.title}” and you were moved from standby into the team. If you can’t make it, excuse yourself within ${graceHours} hours with no penalty.`,
            type: 'success',
            link: `/talent/jobs/${event.id}`,
        })));
        if (promoted.length) {
            await notifySafely({
                userId: event.organizerId,
                title: 'Standby ushers moved in',
                message: `${promoted.map(({ talent }) => talent.fullName).join(', ')} moved from standby into “${event.title}”.`,
                type: 'success',
                link: `/provider/events/${event.id}`,
            });
        }
        if (hadQueue && openSpots > 0) {
            await notifySafely({
                userId: event.organizerId,
                title: 'Open spot not filled from standby',
                message: `${openSpots} spot(s) at “${event.title}” are still open because no one left on standby could be booked.`,
                type: 'warning',
                link: `/provider/events/${event.id}`,
            });
        }
        return promoted.map(({ application }) => application.talentId);
    }

    // For callers whose own change is already saved: a failure here must not fail their request.
    static async fillOpenSpotsQuietly(eventId) {
        try {
            return await this.fillOpenSpots(eventId);
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error(JSON.stringify({ level: 'error', scope: 'standby', eventId, message: error.message }));
            return [];
        }
    }

    // Once the event starts, nobody else is moved in and the remaining standby ushers are free.
    static async releaseAtStart(event, now = new Date()) {
        if (!hasEventStarted(event, now)) return [];
        const [, released] = await Application.update(
            { status: 'rejected' },
            { where: { eventId: event.id, status: 'standby' }, returning: true },
        );
        await Promise.all((released || []).map((application) => notifySafely({
            userId: application.talentId,
            title: 'Released from standby',
            message: `“${event.title}” has started and your standby spot wasn’t needed. Thanks for being available.`,
            type: 'info',
            link: `/talent/jobs/${event.id}`,
            sendEmail: false,
        })));
        return (released || []).map((application) => application.talentId);
    }
}
