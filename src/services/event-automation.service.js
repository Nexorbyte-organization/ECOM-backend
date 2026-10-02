import { Op } from 'sequelize';
import { Event } from '../../db/index.js';
import { AttendanceService } from './attendance.service.js';
import { EventService } from './event.service.js';
import { FundingService } from './funding.service.js';
import { fundingDeadline, releaseDueAt } from './funding-policy.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Lazy sweeps run at most this often per scope in one server instance.
const SWEEP_THROTTLE_MS = 60 * 1000;
const lastSweep = new Map();

// Runs an event's time-based steps without anyone acting: cancel unfunded bookings at the funding
// deadline, mark missed check-ins as no-shows when check-in closes, and complete the event and
// release its payments 24 hours after it ends. Each step is idempotent, so the steps run whenever
// an event is read and from the scheduled sweep.
export class EventAutomationService {
    static async runForEvent(event, now = new Date()) {
        if (!event || event.deletedAt || event.status === 'cancelled') return;
        if (fundingDeadline(event) && now >= fundingDeadline(event)) {
            await FundingService.enforceFundingDeadline(event, now);
            await event.reload();
        }
        await AttendanceService.finalizeAttendance(event, now);

        const due = releaseDueAt(event);
        if (event.fundsReleasedAt || !due || now < due) return;
        if (event.status !== 'completed') {
            await EventService.changeStatus(event.id, 'completed');
            await event.reload();
        }
        if (event.fundingMode === 'prefund') {
            await FundingService.releaseEventFunds({ eventId: event.id, automatic: true });
        }
    }

    // Events whose next automatic step may be due: unreleased and from shortly before their
    // funding deadline until a month after.
    static async dueEvents({ organizerId = null, talentId = null, eventIds = null, now = new Date(), limit = 100 } = {}) {
        return Event.findAll({
            where: {
                status: { [Op.in]: ['open', 'confirmed', 'completed'] },
                fundsReleasedAt: null,
                eventDate: { [Op.between]: [new Date(now.getTime() - 30 * DAY_MS), new Date(now.getTime() + 3 * DAY_MS)] },
                ...(organizerId ? { organizerId } : {}),
                ...(talentId ? { hiredTalents: { [Op.contains]: [talentId] } } : {}),
                ...(eventIds ? { id: { [Op.in]: eventIds } } : {}),
            },
            order: [['eventDate', 'ASC']],
            limit,
        });
    }

    static async sweep(scope = {}, now = new Date()) {
        const events = await this.dueEvents({ ...scope, now });
        const failures = [];
        for (const event of events) {
            try {
                await this.runForEvent(event, now);
            } catch (error) {
                failures.push({ eventId: event.id, message: error.message });
                // eslint-disable-next-line no-console
                console.error(JSON.stringify({ level: 'error', scope: 'event-automation', eventId: event.id, message: error.message }));
            }
        }
        return { checked: events.length, failures };
    }

    // Called from read paths. Never fails the request and runs at most once a minute per scope.
    static async sweepQuietly(scope = {}) {
        const key = JSON.stringify(scope);
        const now = Date.now();
        if (now - (lastSweep.get(key) || 0) < SWEEP_THROTTLE_MS) return;
        lastSweep.set(key, now);
        try {
            await this.sweep(scope);
        } catch {
            // The scheduled sweep retries.
        }
    }
}
