import { Op } from 'sequelize';
import { randomUUID } from 'crypto';
import { User, Event, Application, Attendance, Review, Referral, EventActionRequest } from '../../db/index.js';
import { AppError } from '../utils/appError.js';
import { messages } from '../utils/constant/messages.js';
import { CloudinaryService } from '../utils/cloudinary.js';
import { UploadFolders } from '../utils/uploadFolders.js';
import { ApiFeature } from '../utils/apiFeature.js';
import { checkAndAutoVerify } from './usher.controller.js';
import { getMissingProfileFields, isProfileComplete } from '../utils/profileCompletion.js';
import { publicTalent } from '../utils/publicTalent.js';
import { EventService } from '../services/event.service.js';
import { NotificationService } from '../services/notification.service.js';
import { updateApplicationDecision } from '../services/application-decision.service.js';
import { normalizeEventCategory } from '../utils/normalization.js';
import { sequelize } from '../../db/connection.js';
import { attendanceQrResponse } from '../utils/attendanceQr.js';

const getOrganizerId = (user) => user.role === 'organizer' ? user.id : user.providerOwnerId;

export class OrganizerController {

    // US-201: Get own organizer profile
    static async getMyProfile(req, res, next) {
        const userId = getOrganizerId(req.authUser);
        const user = await User.findByPk(userId, {
            attributes: { exclude: ['password', 'otp', 'otpExpiry', 'otpAttempts', 'lastOtpRequest', 'otpVerified'] },
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
            title, category, eventDate, applicationDeadline,
            startTime, endTime, location, requiredCount,
            gatheringLocation, genderPreference, specifyGenders,
            malesCount, femalesCount, budget, dressCode, notes, whatsappGroupLink,
        } = req.body;

        if (specifyGenders && Number(malesCount || 0) + Number(femalesCount || 0) !== Number(requiredCount)) {
            return next(new AppError('Male and female counts must add up to the required staff count', 400));
        }
        if (startTime >= endTime) return next(new AppError('End time must be after start time', 400));
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        if (new Date(eventDate) < startOfToday) return next(new AppError('Event date cannot be in the past', 400));

        const event = await Event.create({
            organizerId, title, category: normalizeEventCategory(category), eventDate, applicationDeadline,
            startTime, endTime, location, gatheringLocation, requiredCount,
            genderPreference: genderPreference || 'any', specifyGenders: Boolean(specifyGenders),
            malesCount, femalesCount, budget, dressCode, notes, whatsappGroupLink,
            status: 'open', hiredTalents: [], supervisorIds: [],
        });

        return res.status(201).json({
            success: true,
            message: messages.event.createSuccessfully,
            data: event,
        });
    }

    // US-200: Get own events (with optional status filter + ApiFeature pagination)
    static async getMyEvents(req, res, next) {
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

        const event = await Event.findOne({ where: { id, organizerId } });
        if (!event) return next(new AppError(messages.event.notfound, 404));

        return res.status(200).json({
            success: true,
            message: messages.event.getsuccessfully,
            data: event,
        });
    }

    static async generateAttendanceQr(req, res, next) {
        const organizerId = getOrganizerId(req.authUser);
        const event = await sequelize.transaction(async (transaction) => {
            const lockedEvent = await Event.findOne({
                where: { id: req.params.id, organizerId },
                transaction,
                lock: transaction.LOCK.UPDATE,
            });
            if (!lockedEvent) throw new AppError(messages.event.notfound, 404);
            if (lockedEvent.status !== 'open') {
                throw new AppError('Attendance QR can only be generated while the event is open', 409);
            }
            if (lockedEvent.attendanceQrCreatedAt) {
                throw new AppError('An attendance QR has already been generated for this event', 409);
            }

            lockedEvent.attendanceQrCreatedAt = new Date();
            await lockedEvent.save({ transaction });
            return lockedEvent;
        });

        return res.status(201).json({
            success: true,
            message: 'Attendance QR generated successfully',
            data: attendanceQrResponse(event),
        });
    }

    static async getAttendanceQr(req, res, next) {
        const organizerId = getOrganizerId(req.authUser);
        const event = await Event.findOne({ where: { id: req.params.id, organizerId } });
        if (!event) return next(new AppError(messages.event.notfound, 404));
        if (!event.attendanceQrCreatedAt) {
            return next(new AppError('Attendance QR has not been generated for this event', 404));
        }

        return res.status(200).json({
            success: true,
            data: attendanceQrResponse(event),
        });
    }

    // Update event details
    static async updateEvent(req, res, next) {
        const { id } = req.params;
        const organizerId = getOrganizerId(req.authUser);

        const event = await Event.findOne({ where: { id, organizerId } });
        if (!event) return next(new AppError(messages.event.notfound, 404));

        if (req.body.status !== undefined) {
            if (event.status !== 'open' || req.body.status !== 'cancelled') {
                return next(new AppError('Only an open event can be cancelled directly. Other status changes require an admin.', 409));
            }
            event.status = 'cancelled';
        }

        const allowedFields = [
            'title', 'category', 'eventDate', 'applicationDeadline',
            'startTime', 'endTime', 'location', 'requiredCount',
            'gatheringLocation', 'genderPreference', 'specifyGenders',
            'malesCount', 'femalesCount', 'budget', 'dressCode', 'notes', 'whatsappGroupLink',
        ];
        allowedFields.forEach(field => {
            if (req.body[field] !== undefined) event[field] = req.body[field];
        });

        if (req.body.category !== undefined) {
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
        if (event.startTime >= event.endTime) return next(new AppError('End time must be after start time', 400));
        if (req.body.eventDate !== undefined) {
            const startOfToday = new Date();
            startOfToday.setHours(0, 0, 0, 0);
            if (new Date(event.eventDate) < startOfToday) return next(new AppError('Event date cannot be in the past', 400));
        }
        if (Number(event.requiredCount) < (event.hiredTalents?.length || 0)) {
            return next(new AppError('Required staff count cannot be lower than the number already hired', 409));
        }
        await event.save();

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

        event.status = 'confirmed';
        await event.save();

        return res.status(200).json({
            success: true,
            message: 'Event closed for new applications',
            data: event,
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
            const talent = await User.findByPk(app.talentId, { attributes: { exclude: ['password', 'otp', 'otpExpiry', 'otpAttempts', 'lastOtpRequest', 'otpVerified'] } });
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

        const { application, event } = await sequelize.transaction(async (transaction) => {
            const lockedApplication = await Application.findByPk(applicationId, {
                transaction,
                lock: transaction.LOCK.UPDATE,
            });
            if (!lockedApplication) throw new AppError('Application not found', 404);

            await User.findByPk(lockedApplication.talentId, {
                transaction,
                lock: transaction.LOCK.UPDATE,
            });
            const lockedEvent = await Event.findOne({
                where: { id: lockedApplication.eventId, organizerId },
                transaction,
                lock: transaction.LOCK.UPDATE,
            });
            if (!lockedEvent) throw new AppError('Not authorized', 403);

            await updateApplicationDecision({
                application: lockedApplication,
                event: lockedEvent,
                status,
                transaction,
            });
            return { application: lockedApplication, event: lockedEvent };
        });

        await NotificationService.create({
            userId: application.talentId,
            title: status === 'accepted' ? 'Application accepted' : 'Application declined',
            message: `Your application to “${event.title}” was ${status === 'accepted' ? 'accepted' : 'not selected'}.`,
            type: status === 'accepted' ? 'success' : 'danger',
            link: `/talent/jobs/${event.id}`,
        });

        return res.status(200).json({
            success: true,
            message: `Application ${status} successfully`,
            data: application,
        });
    }

    // US-207: Mark attendance
    static async markAttendance(req, res, next) {
        const { id } = req.params; // eventId
        const { talentId, status, checkInTime } = req.body;
        const organizerId = getOrganizerId(req.authUser);

        const event = await Event.findOne({ where: { id, organizerId } });
        if (!event) return next(new AppError(messages.event.notfound, 404));

        // Attendance allowed only after deadline or when event is confirmed/closed (FR-ATT-02)
        const now = new Date();
        const deadline = new Date(event.applicationDeadline);
        if (now < deadline && event.status === 'open') {
            return next(new AppError('Attendance can only be marked after the application deadline has passed or event is closed', 400));
        }

        if (!event.hiredTalents.includes(talentId)) {
            return next(new AppError('Talent is not hired for this event', 400));
        }

        const previousAttendance = await Attendance.findOne({ where: { eventId: id, talentId } });
        const previousStatus = previousAttendance?.status;
        const [attendance, created] = await Attendance.findOrCreate({
            where: { eventId: id, talentId },
            defaults: { status, checkInTime: checkInTime || null },
        });

        if (!created) {
            attendance.status = status;
            if (checkInTime) attendance.checkInTime = checkInTime;
            await attendance.save();
        }

        // Update talent consecutive good events counter (BR-07)
        const talent = await User.findByPk(talentId);
        if (talent) {
            const isGood = status === 'present' || status === 'late';
            const wasGood = previousStatus === 'present' || previousStatus === 'late';
            if (isGood && (created || !wasGood)) {
                talent.consecutiveGoodEvents = (talent.consecutiveGoodEvents || 0) + 1;
                // Reset late excuse counter after 5 consecutive good events (BR-06, FR-EXC-08)
                if (talent.consecutiveGoodEvents >= 5) {
                    talent.lateExcuseCount = 0;
                    talent.consecutiveGoodEvents = 0;
                }
            } else if (status === 'absent') {
                talent.consecutiveGoodEvents = 0;
            }
            await talent.save();
        }

        // Check if talent should be auto-verified (FR-VER-01)
        await checkAndAutoVerify(talentId);

        return res.status(200).json({
            success: true,
            message: 'Attendance marked successfully',
            data: attendance,
        });
    }

    static async getEventAttendance(req, res, next) {
        const { id } = req.params;
        const organizerId = getOrganizerId(req.authUser);
        const event = await Event.findOne({ where: { id, organizerId } });
        if (!event) return next(new AppError(messages.event.notfound, 404));

        const records = await Attendance.findAll({
            where: { eventId: id },
            order: [['createdAt', 'ASC']],
        });
        const data = await Promise.all(records.map(async (attendance) => ({
            ...attendance.toJSON(),
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

        const existing = await Review.findOne({
            where: { eventId: id, reviewerId: organizerId, reviewedUserId: talentId },
        });
        if (existing) return next(new AppError('You have already reviewed this talent for this event', 400));

        const review = await Review.create({
            eventId: id, reviewerId: organizerId, reviewedUserId: talentId, rating, comment,
        });

        // Recalculate talent's average rating
        const talent = await User.findByPk(talentId);
        if (talent) {
            const allReviews = await Review.findAll({ where: { reviewedUserId: talentId } });
            const avg = allReviews.reduce((sum, r) => sum + r.rating, 0) / allReviews.length;
            talent.rate = Math.round(avg * 10) / 10;
            talent.totalRatings = allReviews.length;
            await talent.save();
        }

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
        const { talentId, eventId } = req.body;
        const organizerId = getOrganizerId(req.authUser);

        const event = await Event.findOne({ where: { id: eventId, organizerId } });
        if (!event) return next(new AppError(messages.event.notfound, 404));
        if (event.status !== 'open') return next(new AppError('Event is not open for bookings', 400));

        const talent = await User.findOne({ where: { id: talentId, role: 'usher', isBlocked: false } });
        if (!talent) return next(new AppError(messages.user.notfound, 404));
        if (!isProfileComplete(talent)) {
            return next(new AppError('This usher must complete their profile before they can be booked', 409));
        }

        // Prevent duplicate (BR-01)
        const existing = await Application.findOne({ where: { eventId, talentId } });
        if (existing) return next(new AppError('Talent already has an application for this event', 400));

        // A direct booking is an invitation and remains pending until the usher accepts it.
        const application = await Application.create({
            eventId, talentId, status: 'pending', isDirect: true, appliedAt: new Date(),
        });

        await NotificationService.create({
            userId: talentId,
            title: 'New booking invitation',
            message: `${req.authUser.fullName} invited you to work at “${event.title}”.`,
            type: 'success',
            link: `/talent/jobs/${event.id}`,
        });

        return res.status(201).json({
            success: true,
            message: 'Booking invitation sent to usher',
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

    // DELETE /organizer/events/:id — organizer deletes own event
    static async deleteEvent(req, res, next) {
        const { id } = req.params;
        const organizerId = getOrganizerId(req.authUser);

        const event = await Event.findOne({ where: { id, organizerId } });
        if (!event) return next(new AppError(messages.event.notfound, 404));
        if (event.status !== 'open') {
            return next(new AppError('Only open events can be deleted directly. Submit an admin action request instead.', 409));
        }

        await EventService.deleteWithRelations(id);
        if (event.photo?.public_id) await CloudinaryService.deleteImage(event.photo.public_id).catch(() => undefined);

        return res.status(200).json({
            success: true,
            message: messages.event.deleteSuccessfully,
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
        const message = `You are invited to “${event.title}” on ${new Date(event.eventDate).toLocaleDateString('en-GB')} at ${event.location}.`;
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

    static async requestEventAction(req, res, next) {
        const organizerId = getOrganizerId(req.authUser);
        const { id: eventId } = req.params;
        const { requestType, reason } = req.body;

        const event = await Event.findOne({ where: { id: eventId, organizerId } });
        if (!event) return next(new AppError(messages.event.notfound, 404));
        if (event.status === 'open') {
            return next(new AppError('Open events can be cancelled or deleted directly without admin approval', 409));
        }

        const existing = await EventActionRequest.findOne({
            where: { eventId, requestType, status: 'pending' },
        });
        if (existing) return next(new AppError('A pending request of this type already exists', 409));

        const request = await EventActionRequest.create({
            eventId,
            organizerId,
            requestType,
            reason: reason || null,
        });

        const admins = await User.findAll({ where: { role: 'admin', isBlocked: false }, attributes: ['id'] });
        await Promise.all(admins.map((admin) => NotificationService.create({
            userId: admin.id,
            title: 'New event action request',
            message: `${req.authUser.fullName} requested to ${requestType} “${event.title}”.`,
            type: 'warning',
            link: '/admin/events',
        })));

        return res.status(201).json({
            success: true,
            message: 'Event action request submitted for admin review',
            data: request,
        });
    }
}
