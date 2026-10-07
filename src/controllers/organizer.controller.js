import { Op } from 'sequelize';
import { randomUUID } from 'crypto';
import { User, Event, Application, Attendance, Review, Referral } from '../../db/index.js';
import { FundingService } from '../services/funding.service.js';
import { MIN_PAY_PER_DAY_EGP } from '../services/funding-policy.js';
import { AttendanceService } from '../services/attendance.service.js';
import { EventAutomationService } from '../services/event-automation.service.js';
import { AppError } from '../utils/appError.js';
import { messages } from '../utils/constant/messages.js';
import { CloudinaryService } from '../utils/cloudinary.js';
import { UploadFolders } from '../utils/uploadFolders.js';
import { ApiFeature } from '../utils/apiFeature.js';
import { checkAndAutoVerify, refreshTalentRating } from '../services/talent-stats.service.js';
import { getMissingProfileFields, isProfileComplete } from '../utils/profileCompletion.js';
import { publicTalent, SECRET_USER_FIELDS, talentForOrganization } from '../utils/publicTalent.js';
import { EventService } from '../services/event.service.js';
import { NotificationService } from '../services/notification.service.js';
import { findBookingConflict, maxStandbyCount, updateApplicationDecision } from '../services/application-decision.service.js';
import { StandbyService } from '../services/standby.service.js';
import { normalizeEventCategory } from '../utils/normalization.js';
import { sequelize } from '../../db/connection.js';
import { eventDays, hasEventEnded, hasEventStarted, normalizeEventDays, scheduleFromDays } from '../utils/eventSchedule.js';
import { EVENT_FIELD_LABELS, changedEventFields, lockedEventFields, withScheduleChanges } from '../utils/eventEditing.js';
import { getAnalytics } from '../services/analytics.service.js';
import { PreauthService } from '../services/preauth.service.js';
import { isPreauthConfigured } from '../services/paymob.service.js';

// Changes hired ushers need to hear about.
const SCHEDULE_FIELDS = ['schedule', 'location', 'gatheringLocation', 'budget', 'dressCode'];
const SCHEDULE_FIELD_LABELS = {
    schedule: 'dates and times', location: 'location',
    gatheringLocation: 'meeting point', budget: 'pay', dressCode: 'dress code',
};
const scheduleSnapshot = (event) => ({
    schedule: JSON.stringify(eventDays(event)),
    location: String(event.location ?? ''),
    gatheringLocation: String(event.gatheringLocation ?? ''),
    budget: Number(event.budget),
    dressCode: String(event.dressCode ?? ''),
});

const getOrganizerId = (user) => user.role === 'organizer' ? user.id : user.providerOwnerId;

const minimumPayError = () => new AppError(`Pay must be at least ${MIN_PAY_PER_DAY_EGP} EGP per usher for each event day`, 400);

const isBeforeToday = (date) => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    return new Date(date) < startOfToday;
};

const standbyLimitError = (requiredCount) => new AppError(
    `Standby can be at most half the staff count (${maxStandbyCount(requiredCount)} for ${requiredCount} ushers)`, 400,
);

const APPLICATION_DECISION_NOTICES = {
    accepted: (title) => ({ title: 'Application accepted', message: `Your application to “${title}” was accepted.`, type: 'success' }),
    standby: (title) => ({
        title: 'Added to standby',
        message: `You’re on standby for “${title}”. If a spot opens before the event starts, you’ll be moved in automatically and notified.`,
        type: 'info',
    }),
    rejected: (title) => ({ title: 'Application declined', message: `Your application to “${title}” was not selected.`, type: 'danger' }),
    removedFromStandby: (title) => ({ title: 'Removed from standby', message: `You were removed from the standby list for “${title}”.`, type: 'info' }),
};

export class OrganizerController {
    static async getAnalytics(req, res) {
        const data = await getAnalytics(getOrganizerId(req.authUser));
        return res.status(200).json({ success: true, data });
    }

    // US-201: Get own organizer profile
    static async getMyProfile(req, res, next) {
        const userId = getOrganizerId(req.authUser);
        const user = await User.findByPk(userId, {
            attributes: { exclude: SECRET_USER_FIELDS },
        });
        if (!user) return next(new AppError(messages.user.notfound, 404));

        return res.status(200).json({
            success: true,
            message: messages.user.getsuccessfully,
            data: {
                ...user.toJSON(),
                profileCompleted: isProfileComplete(user),
                missingProfileFields: getMissingProfileFields(user),
            },
        });
    }

    // US-201: Update organizer profile — description & website stored in organizationInfo JSON field
    static async updateMyProfile(req, res, next) {
        const userId = req.authUser.id;
        const {
            fullName, companyName, description, city, location,
            mobileNumber, phone, website, autoAcceptHighRatedTalents,
        } = req.body;

        const user = await User.findByPk(userId);
        if (!user) return next(new AppError(messages.user.notfound, 404));

        if (fullName !== undefined || companyName !== undefined) user.fullName = fullName ?? companyName;
        if (city !== undefined || location !== undefined) user.city = city ?? location;
        if (mobileNumber !== undefined || phone !== undefined) {
            const requestedMobile = mobileNumber ?? phone ?? null;
            const duplicate = requestedMobile ? await User.findOne({
                where: { mobileNumber: requestedMobile, id: { [Op.ne]: userId } },
                paranoid: false,
            }) : null;
            if (duplicate) return next(new AppError('This mobile number is already in use', 409));
            user.mobileNumber = requestedMobile;
        }

        // Store organizer-specific fields in the dedicated organizationInfo JSON field
        if (description !== undefined || website !== undefined || autoAcceptHighRatedTalents !== undefined) {
            user.organizationInfo = {
                ...(user.organizationInfo || {}),
                ...(description !== undefined ? { description } : {}),
                ...(website !== undefined ? { website } : {}),
                ...(autoAcceptHighRatedTalents !== undefined
                    ? { autoAcceptHighRatedTalents: autoAcceptHighRatedTalents === true || autoAcceptHighRatedTalents === 'true' }
                    : {}),
            };
        }

        await user.save();

        return res.status(200).json({
            success: true,
            message: messages.user.updateSuccessfully,
            data: {
                ...user.toJSON(),
                profileCompleted: isProfileComplete(user),
                missingProfileFields: getMissingProfileFields(user),
            },
        });
    }

    // US-202: Upload / change company logo (reuses portfolioPicture field)
    static async uploadLogo(req, res, next) {
        if (!req.file) return next(new AppError('Image file is required', 400));

        const userId = req.authUser.id;
        const user = await User.findByPk(userId);
        if (!user) return next(new AppError(messages.user.notfound, 404));

        const previousPublicId = user.portfolioPicture?.public_id;
        const uploaded = await CloudinaryService.uploadBuffer(req.file.buffer, UploadFolders.organizationLogo(user.id));
        user.portfolioPicture = uploaded;
        await user.save();
        if (previousPublicId && previousPublicId !== 'default_avatar') {
            await CloudinaryService.deleteImage(previousPublicId).catch(() => undefined);
        }

        return res.status(200).json({
            success: true,
            message: 'Company logo updated successfully',
            data: {
                logo: uploaded,
                profileCompleted: isProfileComplete(user),
                missingProfileFields: getMissingProfileFields(user),
            },
        });
    }

    static async uploadEventPhoto(req, res, next) {
        if (!req.file) return next(new AppError('Image file is required', 400));

        const organizerId = getOrganizerId(req.authUser);
        const event = await Event.findOne({ where: { id: req.params.id, organizerId } });
        if (!event) return next(new AppError(messages.event.notfound, 404));

        const uploaded = await CloudinaryService.uploadBuffer(req.file.buffer, UploadFolders.eventPhoto(event.organizerId, event.id));
        const previousPublicId = event.photo?.public_id;
        event.photo = uploaded;
        await event.save();

        if (previousPublicId) await CloudinaryService.deleteImage(previousPublicId).catch(() => undefined);

        return res.status(200).json({
            success: true,
            message: 'Event photo updated successfully',
            data: event,
        });
    }

    // US-200: Get organizer dashboard stats
    static async getDashboard(req, res, next) {
        await EventAutomationService.sweepQuietly({ organizerId: getOrganizerId(req.authUser) });
        const organizerId = getOrganizerId(req.authUser);

        // Read the small set of fields needed for totals once. Four separate
        // count queries plus another scan made this request expensive on cold starts.
        const allEvents = await Event.findAll({
            where: { organizerId },
            attributes: ['id', 'status', 'hiredTalents'],
        });
        const totalEvents = allEvents.length;
        const openEvents = allEvents.filter(e => e.status === 'open').length;
        const confirmedEvents = allEvents.filter(e => e.status === 'confirmed').length;
        const completedEvents = allEvents.filter(e => e.status === 'completed').length;
        const totalHired = allEvents.reduce((sum, e) => sum + (e.hiredTalents?.length || 0), 0);
        const eventIds = allEvents.map(e => e.id).filter(Boolean);
        const [recentEvents, activeEvents, pendingApplicationsCount] = await Promise.all([
            Event.findAll({ where: { organizerId }, order: [['createdAt', 'DESC']], limit: 5 }),
            Event.findAll({
                where: { organizerId, status: { [Op.in]: ['open', 'confirmed'] } },
                order: [['eventDate', 'ASC']],
            }),
            eventIds.length
                ? Application.count({ where: { eventId: { [Op.in]: eventIds }, status: 'pending' } })
                : Promise.resolve(0),
        ]);

        return res.status(200).json({
            success: true,
            message: 'Dashboard retrieved successfully',
            data: {
                totalEvents,
                openEvents,
                confirmedEvents,
                completedEvents,
                activeEventsCount: openEvents + confirmedEvents,
                totalHired,
                pendingApplicationsCount,
                activeEvents,
                recentEvents,
            },
        });
    }

    // US-203: Create a new event
    static async createEvent(req, res, next) {
        const organizerId = getOrganizerId(req.authUser);
        const {
            title, category, days, eventDate, applicationDeadline,
            startTime, endTime, location, requiredCount, standbyCount = 0,
            gatheringLocation, genderPreference, specifyGenders,
            malesCount, femalesCount, budget, dressCode, notes, whatsappGroupLink,
            venueLatitude, venueLongitude,
        } = req.body;

        if (specifyGenders && Number(malesCount || 0) + Number(femalesCount || 0) !== Number(requiredCount)) {
            return next(new AppError('Male and female counts must add up to the required staff count', 400));
        }
        if (Number(standbyCount) > maxStandbyCount(requiredCount)) return next(standbyLimitError(requiredCount));
        // A one-day event may send eventDate/startTime/endTime instead of `days`.
        const normalized = normalizeEventDays(days ?? [{ date: eventDate, startTime, endTime }]);
        if (normalized.error) return next(new AppError(normalized.error, 400));
        const schedule = scheduleFromDays(normalized.days);
        if (isBeforeToday(schedule.eventDate)) return next(new AppError('Event date cannot be in the past', 400));
        if (new Date(applicationDeadline) >= schedule.eventDate) {
            return next(new AppError('Application deadline must be before the first event day', 400));
        }
        if (Number(budget) < MIN_PAY_PER_DAY_EGP) return next(minimumPayError());

        const event = await Event.create({
            organizerId, title, category: normalizeEventCategory(category), ...schedule, applicationDeadline,
            location, gatheringLocation, requiredCount, standbyCount: Number(standbyCount) || 0,
            genderPreference: genderPreference || 'any', specifyGenders: Boolean(specifyGenders),
            malesCount, femalesCount, budget, dressCode, notes, whatsappGroupLink,
            venueLatitude: venueLatitude ?? null, venueLongitude: venueLongitude ?? null,
            status: 'open', hiredTalents: [], supervisorIds: [],
            // With a Paymob Auth integration configured, usher pay is held on the card day by day.
            fundingMode: isPreauthConfigured() ? 'preauth' : 'prefund',
        });

        return res.status(201).json({
            success: true,
            message: messages.event.createSuccessfully,
            data: event,
        });
    }

    // US-200: Get own events (with optional status filter + ApiFeature pagination)
    static async getMyEvents(req, res, next) {
        await EventAutomationService.sweepQuietly({ organizerId: getOrganizerId(req.authUser) });
        const organizerId = getOrganizerId(req.authUser);
        const { status } = req.query;

        const where = { organizerId };
        if (status) where.status = status;

        const feature = new ApiFeature(req.query).pagination().sort().build();
        const page = parseInt(req.query.page) || 1;

        const { count, rows: events } = await Event.findAndCountAll({
            where,
            order: feature.order.length ? feature.order : [['createdAt', 'DESC']],
            limit: feature.limit,
            offset: feature.offset,
        });

        return res.status(200).json({
            success: true,
            message: messages.event.getsuccessfully,
            ...ApiFeature.paginateResponse(events, page, feature.limit, count),
        });
    }

    // Get single event detail (organizer must own it)
    static async getEventById(req, res, next) {
        const { id } = req.params;
        const organizerId = getOrganizerId(req.authUser);

        await EventAutomationService.sweepQuietly({ organizerId });
        const event = await Event.findOne({ where: { id, organizerId } });
        if (!event) return next(new AppError(messages.event.notfound, 404));

        return res.status(200).json({
            success: true,
            message: messages.event.getsuccessfully,
            data: event,
        });
    }

    static async listCheckInPoints(req, res, next) {
        const event = await Event.findOne({ where: { id: req.params.id, organizerId: getOrganizerId(req.authUser) } });
        if (!event) return next(new AppError(messages.event.notfound, 404));
        return res.status(200).json({ success: true, data: await AttendanceService.listPoints(event) });
    }

    // The staff check-in screen calls this every few seconds with the phone's location and
    // receives the current QR and 6-digit code.
    static async openCheckInPoint(req, res, next) {
        const event = await Event.findOne({ where: { id: req.params.id, organizerId: getOrganizerId(req.authUser) } });
        if (!event) return next(new AppError(messages.event.notfound, 404));
        const data = await AttendanceService.openPoint({
            event, staffUser: req.authUser, location: req.body.location, label: req.body.label,
        });
        return res.status(200).json({ success: true, data });
    }

    static async closeCheckInPoint(req, res, next) {
        const event = await Event.findOne({ where: { id: req.params.id, organizerId: getOrganizerId(req.authUser) } });
        if (!event) return next(new AppError(messages.event.notfound, 404));
        await AttendanceService.closePoint({ event, staffUser: req.authUser });
        return res.status(200).json({ success: true, message: 'Check-in point closed' });
    }

    // Update event details
    static async updateEvent(req, res, next) {
        const { id } = req.params;
        const organizerId = getOrganizerId(req.authUser);

        const event = await Event.findOne({ where: { id, organizerId } });
        if (!event) return next(new AppError(messages.event.notfound, 404));

        if (['completed', 'cancelled'].includes(event.status)) {
            return next(new AppError(`A ${event.status} event can no longer be edited`, 409));
        }
        const schedule = withScheduleChanges(event, req.body);
        if (schedule.error) return next(new AppError(schedule.error, 400));
        const changes = schedule.changes;
        const locked = lockedEventFields(event, changes);
        if (locked.length) {
            const stage = hasEventStarted(event) ? 'an event that has started' : `a ${event.status} event`;
            return next(new AppError(`The ${locked.map((field) => EVENT_FIELD_LABELS[field]).join(', ')} of ${stage} can no longer be changed`, 409));
        }
        const changed = changedEventFields(event, changes);
        if (event.fundingMode === 'preauth' && changed.some((field) => ['budget', 'requiredCount'].includes(field)
            || (field === 'days' && changes.days.length !== eventDays(event).length))
            && await PreauthService.feeIsPaid(event.id)) {
            return next(new AppError('The booking fee was already paid and is not refundable, so the pay, staff count, and number of days can no longer change', 409));
        }
        if (changed.includes('budget') && Number(changes.budget) < Number(event.budget) && event.hiredTalents?.length) {
            return next(new AppError('Pay cannot be lowered after ushers are hired', 409));
        }
        if (changed.includes('days')) {
            // Pay covers every day, so the number of days is fixed with the pay.
            const dayCountBefore = eventDays(event).length;
            if (changes.days.length !== dayCountBefore && event.status !== 'open') {
                return next(new AppError(`The number of days of a ${event.status} event can no longer change; only their dates and times can`, 409));
            }
            if (changes.days.length < dayCountBefore && event.hiredTalents?.length) {
                return next(new AppError('Event days cannot be removed after ushers are hired', 409));
            }
        }
        const scheduleBefore = scheduleSnapshot(event);

        changed.forEach(field => {
            event[field] = changes[field];
        });
        if (changed.includes('days')) event.endDate = schedule.endDate;

        if (changed.includes('category')) {
            const category = normalizeEventCategory(req.body.category);
            if (!category) return next(new AppError('Invalid event category', 400));
            event.category = category;
        }

        if (event.specifyGenders && Number(event.malesCount || 0) + Number(event.femalesCount || 0) !== Number(event.requiredCount)) {
            return next(new AppError('Male and female counts must add up to the required staff count', 400));
        }
        if (new Date(event.applicationDeadline) >= new Date(event.eventDate)) {
            return next(new AppError('Application deadline must be before the event date', 400));
        }
        if (changed.includes('budget') && Number(event.budget) < MIN_PAY_PER_DAY_EGP) return next(minimumPayError());
        if (changed.includes('days') && isBeforeToday(event.eventDate)) {
            return next(new AppError('Event date cannot be in the past', 400));
        }
        if (Number(event.requiredCount) < (event.hiredTalents?.length || 0)) {
            return next(new AppError('Required staff count cannot be lower than the number already hired', 409));
        }
        if (Number(event.standbyCount || 0) > maxStandbyCount(event.requiredCount)) return next(standbyLimitError(event.requiredCount));
        if (changed.includes('standbyCount')) {
            const onStandby = await Application.count({ where: { eventId: event.id, status: 'standby' } });
            if (Number(event.standbyCount) < onStandby) {
                return next(new AppError(`Standby count cannot be lower than the ${onStandby} usher(s) already on standby`, 409));
            }
        }
        const hiredTalents = event.hiredTalents || [];
        const scheduleAfter = scheduleSnapshot(event);
        const changedScheduleFields = SCHEDULE_FIELDS.filter((field) => scheduleBefore[field] !== scheduleAfter[field]);
        if (changedScheduleFields.includes('schedule') && hiredTalents.length
            && await findBookingConflict({ event, talentIds: hiredTalents })) {
            return next(new AppError('Some hired ushers are already booked for another event on one of the new dates', 409));
        }
        await event.save();
        // A larger team is filled from standby first.
        if (changed.includes('requiredCount')) await StandbyService.fillOpenSpotsQuietly(event.id);

        if (changedScheduleFields.length && hiredTalents.length) {
            await Promise.all(hiredTalents.map((userId) => NotificationService.create({
                userId,
                title: 'Event details changed',
                message: `The organization updated “${event.title}” (${changedScheduleFields.map((field) => SCHEDULE_FIELD_LABELS[field]).join(', ')}). Check the new details.`,
                type: 'warning',
                link: `/talent/jobs/${event.id}`,
            }).catch(() => undefined)));
        }

        return res.status(200).json({
            success: true,
            message: messages.event.updateSuccessfully,
            data: event,
        });
    }

    // US-206: Close event / set to confirmed
    static async closeEvent(req, res, next) {
        const { id } = req.params;
        const organizerId = getOrganizerId(req.authUser);

        const event = await Event.findOne({ where: { id, organizerId } });
        if (!event) return next(new AppError(messages.event.notfound, 404));
        if (event.status !== 'open') return next(new AppError('Only an open event can be closed', 409));
        await FundingService.assertCanConfirm(event);

        event.status = 'confirmed';
        await event.save();

        return res.status(200).json({
            success: true,
            message: 'Event closed for new applications',
            data: event,
        });
    }

    // The owner marks an event completed once it has ended, which unlocks usher payments.
    static async completeEvent(req, res, next) {
        const organizerId = getOrganizerId(req.authUser);
        const event = await Event.findOne({ where: { id: req.params.id, organizerId } });
        if (!event) return next(new AppError(messages.event.notfound, 404));
        if (!['open', 'confirmed'].includes(event.status)) {
            return next(new AppError('Only an open or confirmed event can be completed', 409));
        }
        if (!hasEventEnded(event)) {
            return next(new AppError('The event can be completed after it ends', 409));
        }

        const { event: completed } = await EventService.changeStatus(event.id, 'completed', { organizerId });
        return res.status(200).json({
            success: true,
            message: 'Event marked as completed',
            data: completed,
        });
    }

    // US-205: View event applicants
    static async getEventApplicants(req, res, next) {
        const { id } = req.params;
        const organizerId = getOrganizerId(req.authUser);

        const event = await Event.findOne({ where: { id, organizerId } });
        if (!event) return next(new AppError(messages.event.notfound, 404));

        const applications = await Application.findAll({
            where: { eventId: id },
            order: [['appliedAt', 'ASC']],
        });

        const enriched = await Promise.all(applications.map(async (app) => {
            const talent = talentForOrganization(await User.findByPk(app.talentId), { booked: app.status === 'accepted' });
            let referredByName = null;
            if (app.referredBy) {
                const referrer = await User.findByPk(app.referredBy, { attributes: ['fullName'] });
                referredByName = referrer?.fullName || null;
            }
            return { ...app.toJSON(), talent, referredByName };
        }));

        return res.status(200).json({
            success: true,
            message: messages.event.getsuccessfully,
            data: enriched,
        });
    }

    // US-205: Accept or reject an applicant
    static async updateApplicationStatus(req, res, next) {
        const { applicationId } = req.params;
        const { status } = req.body;
        const organizerId = getOrganizerId(req.authUser);

        const { application, event, outcome, previousStatus } = await sequelize.transaction(async (transaction) => {
            const lockedApplication = await Application.findByPk(applicationId, {
                transaction,
                lock: transaction.LOCK.UPDATE,
            });
            if (!lockedApplication) throw new AppError('Application not found', 404);

            const talent = await User.findByPk(lockedApplication.talentId, {
                transaction,
                lock: transaction.LOCK.UPDATE,
            });
            const lockedEvent = await Event.findOne({
                where: { id: lockedApplication.eventId, organizerId },
                transaction,
                lock: transaction.LOCK.UPDATE,
            });
            if (!lockedEvent) throw new AppError('Not authorized', 403);
            if (['cancelled', 'completed'].includes(lockedEvent.status)) {
                throw new AppError(`Applications for a ${lockedEvent.status} event can no longer change`, 409);
            }
            if (['excused', 'withdrawn'].includes(lockedApplication.status)) {
                throw new AppError(lockedApplication.status === 'excused'
                    ? 'This usher excused themselves from the event'
                    : 'This usher left the standby list', 409);
            }
            if (hasEventStarted(lockedEvent)) {
                throw new AppError('The event has started; record attendance instead of changing applications', 409);
            }
            const booking = status === 'accepted' || status === 'standby';
            if (booking && (!talent || talent.isBlocked)) {
                throw new AppError('This usher can no longer be booked', 409);
            }
            if (booking && talent.suspendedUntil && new Date(talent.suspendedUntil) > new Date()) {
                throw new AppError('This usher is suspended from new bookings after missed check-ins', 409);
            }
            if (lockedApplication.isDirect && lockedApplication.status === 'pending' && booking) {
                throw new AppError('This booking invitation is waiting for the usher to accept it', 409);
            }

            const previous = lockedApplication.status;
            const result = await updateApplicationDecision({
                application: lockedApplication,
                event: lockedEvent,
                status,
                transaction,
                // Accepting into a full event puts an usher who agreed to standby on the list.
                overflowToStandby: true,
            });
            return { application: lockedApplication, event: lockedEvent, outcome: result, previousStatus: previous };
        });

        const notice = outcome === 'rejected' && previousStatus === 'standby' ? 'removedFromStandby' : outcome;
        await NotificationService.create({
            userId: application.talentId,
            ...APPLICATION_DECISION_NOTICES[notice](event.title),
            link: `/talent/jobs/${event.id}`,
        });
        // Removing a hired usher opens a spot for the standby list.
        if (previousStatus === 'accepted' && outcome === 'rejected') await StandbyService.fillOpenSpotsQuietly(event.id);

        const overflowed = status === 'accepted' && outcome === 'standby';
        return res.status(200).json({
            success: true,
            message: overflowed
                ? 'The event is fully staffed, so this usher was added to standby'
                : `Application ${outcome === 'standby' ? 'moved to standby' : outcome} successfully`,
            data: application,
        });
    }

    // US-207: Staff check-in for an usher whose phone cannot check in. Present or late only: a
    // missed check-in becomes absent automatically, so nobody can be marked absent by hand.
    static async markAttendance(req, res, next) {
        const event = await Event.findOne({ where: { id: req.params.id, organizerId: getOrganizerId(req.authUser) } });
        if (!event) return next(new AppError(messages.event.notfound, 404));
        const attendance = await AttendanceService.staffCheckIn({
            event,
            talentId: req.body.talentId,
            status: req.body.status,
            staffUser: req.authUser,
            location: req.body.location,
            dayIndex: req.body.dayIndex,
        });
        return res.status(200).json({
            success: true,
            message: 'Usher checked in',
            data: attendance,
        });
    }

    static async getEventAttendance(req, res, next) {
        const { id } = req.params;
        const organizerId = getOrganizerId(req.authUser);
        const found = await Event.findOne({ where: { id, organizerId } });
        if (!found) return next(new AppError(messages.event.notfound, 404));
        await EventAutomationService.sweepQuietly({ eventIds: [found.id] });

        // One record per usher and event day.
        const records = await Attendance.findAll({
            where: { eventId: id },
            order: [['dayIndex', 'ASC'], ['createdAt', 'ASC']],
        });
        const days = eventDays(found);
        const data = await Promise.all(records.map(async (attendance) => ({
            ...attendance.toJSON(),
            date: days[attendance.dayIndex]?.date || null,
            talent: await User.findByPk(attendance.talentId, {
                attributes: ['id', 'fullName', 'portfolioPicture', 'city', 'rate', 'isVerified'],
            }),
        })));

        return res.status(200).json({ success: true, data, count: data.length });
    }

    // US-208: Review & rate talent
    static async reviewTalent(req, res, next) {
        const { id } = req.params; // eventId
        const { rating, comment } = req.body;
        const talentId = req.body.talentId || req.body.reviewedUserId;
        const organizerId = getOrganizerId(req.authUser);

        const event = await Event.findOne({ where: { id, organizerId } });
        if (!event) return next(new AppError(messages.event.notfound, 404));

        if (!event.hiredTalents.includes(talentId)) {
            return next(new AppError('Talent was not hired for this event', 400));
        }
        if (event.status === 'cancelled') return next(new AppError('A cancelled event cannot be reviewed', 409));
        if (event.status !== 'completed' && !hasEventEnded(event)) {
            return next(new AppError('Ushers can be reviewed after the event ends', 409));
        }
        const attendance = await Attendance.findOne({ where: { eventId: id, talentId, status: { [Op.in]: ['present', 'late'] } } });
        if (!attendance) {
            return next(new AppError('Only ushers who attended can be reviewed', 409));
        }

        const existing = await Review.findOne({
            where: { eventId: id, reviewerId: organizerId, reviewedUserId: talentId },
        });
        if (existing) return next(new AppError('You have already reviewed this talent for this event', 400));

        const review = await Review.create({
            eventId: id, reviewerId: organizerId, reviewedUserId: talentId, rating, comment: comment || null,
        });

        // Repeat reviews from the same organization count less toward the rating.
        await refreshTalentRating(talentId);

        // Check auto-verify after new review updates rating (FR-VER-01)
        await checkAndAutoVerify(talentId);

        return res.status(201).json({
            success: true,
            message: messages.review.createSuccessfully,
            data: review,
        });
    }

    static async getEventReviews(req, res, next) {
        const { id } = req.params;
        const organizerId = getOrganizerId(req.authUser);
        const event = await Event.findOne({ where: { id, organizerId } });
        if (!event) return next(new AppError(messages.event.notfound, 404));

        const reviews = await Review.findAll({
            where: { eventId: id },
            order: [['createdAt', 'DESC']],
        });
        return res.status(200).json({ success: true, data: reviews, count: reviews.length });
    }

    // US-209: Search talent directory (with ApiFeature pagination)
    static async searchTalents(req, res, next) {
        const { city, category, experience, minExperience, maxExperience, availableDate } = req.query;

        const where = { role: 'usher', isBlocked: false };
        if (city) {
            where[Op.or] = [
                { city: { [Op.iLike]: `%${city}%` } },
                { workCities: { [Op.contains]: [city] } },
                { workCities: { [Op.contains]: ['all'] } },
                { workCities: { [Op.contains]: ['all cities'] } },
            ];
        }
        if (experience || minExperience || maxExperience) {
            where.experience = {};
            if (experience || minExperience) where.experience[Op.gte] = parseInt(experience || minExperience);
            if (maxExperience) where.experience[Op.lte] = parseInt(maxExperience);
        }
        if (category) {
            const normalizedCategory = normalizeEventCategory(category);
            if (!normalizedCategory) return next(new AppError('Invalid event category', 400));
            where.eventCategories = { [Op.contains]: [normalizedCategory] };
        }
        if (availableDate) where.availabilityDates = { [Op.contains]: [availableDate] };

        const feature = new ApiFeature(req.query).pagination().sort().build();
        const page = parseInt(req.query.page) || 1;

        const matchingTalents = await User.findAll({
            where,
            order: feature.order.length ? feature.order : [['rate', 'DESC']],
        });

        const completeTalents = matchingTalents.filter(isProfileComplete);
        const talents = completeTalents.slice(feature.offset, feature.offset + feature.limit).map(publicTalent);
        const count = completeTalents.length;

        return res.status(200).json({
            success: true,
            message: messages.user.getsuccessfully,
            ...ApiFeature.paginateResponse(talents, page, feature.limit, count),
        });
    }

    // US-211: Direct book a talent
    static async directBookTalent(req, res, next) {
        const { talentId, eventId, asStandby = false } = req.body;
        const organizerId = getOrganizerId(req.authUser);

        const event = await Event.findOne({ where: { id: eventId, organizerId } });
        if (!event) return next(new AppError(messages.event.notfound, 404));
        // Standby is filled up to the start, so standby invitations also work after hiring closes.
        const invitable = asStandby ? ['open', 'confirmed'].includes(event.status) && !hasEventStarted(event) : event.status === 'open';
        if (!invitable) return next(new AppError('Event is not open for bookings', 400));
        if (asStandby) {
            const onStandby = await Application.count({ where: { eventId, status: 'standby' } });
            if (onStandby >= Number(event.standbyCount || 0)) {
                return next(new AppError(event.standbyCount ? 'The standby list for this event is full' : 'This event has no standby spots', 409));
            }
        }

        const talent = await User.findOne({ where: { id: talentId, role: 'usher', isBlocked: false } });
        if (!talent) return next(new AppError(messages.user.notfound, 404));
        if (!isProfileComplete(talent)) {
            return next(new AppError('This usher must complete their profile before they can be booked', 409));
        }
        if (talent.suspendedUntil && new Date(talent.suspendedUntil) > new Date()) {
            return next(new AppError('This usher is suspended from new bookings after missed check-ins', 409));
        }

        // Prevent duplicate (BR-01)
        const existing = await Application.findOne({ where: { eventId, talentId } });
        if (existing) return next(new AppError('Talent already has an application for this event', 400));

        // A direct booking is an invitation and remains pending until the usher accepts it.
        const application = await Application.create({
            eventId, talentId, status: 'pending', isDirect: true, standbyInvite: Boolean(asStandby), appliedAt: new Date(),
        });

        await NotificationService.create({
            userId: talentId,
            title: asStandby ? 'New standby invitation' : 'New booking invitation',
            message: asStandby
                ? `${req.authUser.fullName} invited you to be on standby for “${event.title}”. Standby is unpaid unless a spot opens and you’re moved in.`
                : `${req.authUser.fullName} invited you to work at “${event.title}”.`,
            type: 'success',
            link: `/talent/jobs/${event.id}`,
        });

        return res.status(201).json({
            success: true,
            message: asStandby ? 'Standby invitation sent to usher' : 'Booking invitation sent to usher',
            data: application,
        });
    }

    // GET referrals for an event
    static async getEventReferrals(req, res, next) {
        const { id } = req.params; // eventId
        const organizerId = getOrganizerId(req.authUser);

        const event = await Event.findOne({ where: { id, organizerId } });
        if (!event) return next(new AppError(messages.event.notfound, 404));

        const referrals = await Referral.findAll({
            where: { eventId: id },
            order: [['createdAt', 'DESC']],
        });

        const enriched = await Promise.all(referrals.map(async (ref) => {
            const referrer = await User.findByPk(ref.referrerTalentId, { attributes: ['id', 'fullName'] });
            const referred = await User.findByPk(ref.referredTalentId, { attributes: ['id', 'fullName', 'rate', 'isVerified', 'lateExcuseCount'] });
            return { ...ref.toJSON(), referrer, referred };
        }));

        return res.status(200).json({
            success: true,
            message: messages.referral.getsuccessfully,
            data: enriched,
        });
    }

    // PATCH /organizer/events/:id/supervisor — assign / remove supervisor from event
    static async assignSupervisor(req, res, next) {
        const { id } = req.params;
        const organizerId = getOrganizerId(req.authUser);
        const { supervisorUserId, add = true } = req.body;

        const event = await Event.findOne({ where: { id, organizerId } });
        if (!event) return next(new AppError(messages.event.notfound, 404));

        if (!supervisorUserId) return next(new AppError('Supervisor user id is required', 400));

        const supervisor = await User.findOne({
            where: { id: supervisorUserId, role: 'organizer_supervisor', providerOwnerId: organizerId },
        });
        if (!supervisor) return next(new AppError('Selected user is not a valid supervisor for your company', 400));

        const supervisorIds = Array.isArray(event.supervisorIds) ? event.supervisorIds : [];
        event.supervisorIds = add
            ? [...new Set([...supervisorIds, supervisorUserId])]
            : supervisorIds.filter((userId) => userId !== supervisorUserId);
        event.supervisorId = event.supervisorIds[0] || null;

        await event.save();

        if (add) {
            await NotificationService.create({
                userId: supervisorUserId,
                title: 'Assigned as event supervisor',
                message: `You were assigned as a supervisor for “${event.title}”.`,
                type: 'info',
                link: `/provider/events/${event.id}`,
            });
        }

        return res.status(200).json({
            success: true,
            message: add ? 'Supervisor assigned successfully' : 'Supervisor removed successfully',
            data: event,
        });
    }

    static async createWhatsAppGroup(req, res, next) {
        const { id } = req.params;
        const organizerId = getOrganizerId(req.authUser);
        const event = await Event.findOne({ where: { id, organizerId } });
        if (!event) return next(new AppError(messages.event.notfound, 404));
        if (event.whatsappGroupLink) return next(new AppError('A WhatsApp group link already exists for this event', 409));
        if (!event.hiredTalents?.length) return next(new AppError('No ushers are assigned to this event yet', 409));

        const talents = await User.findAll({
            where: { id: { [Op.in]: event.hiredTalents }, role: 'usher' },
            attributes: ['id', 'fullName', 'mobileNumber', 'whatsappNumber', 'portfolioPicture'],
        });
        const includedTalents = talents.filter((talent) => talent.whatsappNumber || talent.mobileNumber);
        const excludedNoPhone = talents.filter((talent) => !talent.whatsappNumber && !talent.mobileNumber);
        const days = eventDays(event);
        const formatDay = (day) => new Date(`${day.date}T00:00:00.000Z`).toLocaleDateString('en-GB', { timeZone: 'UTC' });
        const when = days.length > 1
            ? `on ${days.length} days from ${formatDay(days[0])} to ${formatDay(days.at(-1))}`
            : `on ${formatDay(days[0])}`;
        const message = `You are invited to “${event.title}” ${when} at ${event.location}.`;
        const groupLink = `https://wa.me/?text=${encodeURIComponent(message)}`;

        event.whatsappGroupId = randomUUID();
        event.whatsappGroupLink = groupLink;
        await event.save();

        return res.status(201).json({
            success: true,
            data: {
                groupLink,
                groupId: event.whatsappGroupId,
                includedTalents,
                excludedNoPhone,
            },
        });
    }
}
