import { Op } from 'sequelize';
import { randomUUID } from 'crypto';
import { User, Event, Application, Attendance, Review, Referral } from '../../db/index.js';
import { AppError } from '../utils/appError.js';
import { messages } from '../utils/constant/messages.js';
import { CloudinaryService } from '../utils/cloudinary.js';
import { UploadFolders } from '../utils/uploadFolders.js';
import { ApiFeature } from '../utils/apiFeature.js';
import { getMissingProfileFields, isProfileComplete } from '../utils/profileCompletion.js';
import { normalizeEventCategories, normalizeEventCategory, normalizeLanguages } from '../utils/normalization.js';
import { NotificationService } from '../services/notification.service.js';
import { tryAutoAcceptApplication } from '../services/application-decision.service.js';
import { TokenService } from '../utils/token.js';
import { eventForTalent } from '../utils/eventVisibility.js';
import { publicTalent } from '../utils/publicTalent.js';
import { canViewTalentPaymentMethods } from '../utils/talentVisibility.js';
import { sequelize } from '../../db/connection.js';
import { attendanceQrMatchesEvent, parseAttendanceQrToken } from '../utils/attendanceQr.js';

const SAFE_USER_ATTRS = { exclude: ['password', 'otp', 'otpExpiry', 'otpAttempts', 'lastOtpRequest', 'otpVerified', 'refreshTokenHash', 'refreshTokenExpiresAt'] };

// FR-VER-01: Auto-verify talent after hitting performance thresholds
const AUTO_VERIFY_MIN_EVENTS = 10;
const AUTO_VERIFY_MIN_RATING = 4.0;

async function maybeAutoAcceptHighRatedApplication({ application, event, talent }) {
    return sequelize.transaction(async (transaction) => {
        const lockedApplication = await Application.findByPk(application.id, {
            transaction,
            lock: transaction.LOCK.UPDATE,
        });
        if (!lockedApplication || lockedApplication.status !== 'pending') {
            return { application, autoAccepted: false };
        }

        const lockedEvent = await Event.findByPk(event.id, {
            transaction,
            lock: transaction.LOCK.UPDATE,
        });
        if (!lockedEvent) return { application: lockedApplication, autoAccepted: false };

        const organizer = await User.findByPk(lockedEvent.organizerId, { transaction });
        const currentTalent = await User.findByPk(talent.id, { transaction });
        const result = await tryAutoAcceptApplication({
            application: lockedApplication,
            event: lockedEvent,
            organizer,
            talent: currentTalent,
            transaction,
        });

        return {
            application: lockedApplication,
            autoAccepted: result.accepted,
        };
    });
}

async function checkAndAutoVerify(userId) {
    const user = await User.findByPk(userId);
    if (!user || user.role !== 'usher') return;

    const acceptedApps = await Application.findAll({ where: { talentId: userId, status: 'accepted' } });
    const eventIds = acceptedApps.map(a => a.eventId);

    const presentCount = eventIds.length > 0
        ? await Attendance.count({
            where: { talentId: userId, eventId: { [Op.in]: eventIds }, status: { [Op.in]: ['present', 'late'] } }
          })
        : 0;

    const attendanceCount = eventIds.length > 0
        ? await Attendance.count({ where: { talentId: userId, eventId: { [Op.in]: eventIds } } })
        : 0;

    user.completedEventsCount = presentCount;
    user.reliabilityScore = attendanceCount > 0 ? Math.round((presentCount / attendanceCount) * 100) : 100;

    if (presentCount >= AUTO_VERIFY_MIN_EVENTS && (user.rate || 0) >= AUTO_VERIFY_MIN_RATING) {
        user.isVerified = true;
    }
    await user.save();
}

export class UsherController {

    // US-100: Get own profile
    static async getUsherProfile(req, res, next) {
        const { id } = req.params;
        const authUserId = req.authUser.id;

        if (id !== authUserId) {
            return next(new AppError('Unauthorized: You can only access your own profile', 403));
        }

        const user = await User.findByPk(id, { attributes: SAFE_USER_ATTRS });
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

    // US-210: Get usher profile by id (for organizers/admins to view — read-only)
    static async getUsherProfileById(req, res, next) {
        const { id } = req.params;
        const excludedAttributes = [
            'mobileNumber', 'whatsappNumber', 'email', 'password', 'role',
            'otp', 'otpExpiry', 'otpAttempts', 'lastOtpRequest', 'otpVerified', 'providerOwnerId',
        ];
        if (!canViewTalentPaymentMethods(req.authUser.role)) excludedAttributes.push('paymentMethods');

        const user = await User.findByPk(id, {
            attributes: { exclude: excludedAttributes },
        });
        if (!user) return next(new AppError(messages.user.notfound, 404));

        const applications = await Application.findAll({
            where: { talentId: id, status: { [Op.in]: ['accepted', 'excused'] } },
        });
        const eventIds = applications.map(a => a.eventId);
        const events = eventIds.length
            ? await Event.findAll({ where: { id: { [Op.in]: eventIds } }, order: [['eventDate', 'DESC']] })
            : [];

        const history = await Promise.all(events.map(async (event) => {
            const attendance = await Attendance.findOne({ where: { eventId: event.id, talentId: id } });
            const review = await Review.findOne({ where: { eventId: event.id, reviewedUserId: id } });
            return { event: eventForTalent(event), attendanceStatus: attendance?.status || null, rating: review?.rating || null, comment: review?.comment || null };
        }));

        const reviews = await Review.findAll({ where: { reviewedUserId: id }, order: [['createdAt', 'DESC']] });

        return res.status(200).json({
            success: true,
            message: messages.user.getsuccessfully,
            data: { user, eventHistory: history, reviews },
        });
    }

    // US-101: Update own profile
    static async updateProfile(req, res, next) {
        const authUserId = req.authUser.id;
        const {
            fullName,
            city,
            experience,
            experienceYears,
            languages,
            eventCategories,
            categories,
            workCities,
            education,
            refusedCategories,
            availabilityDates,
            mobileNumber,
            phoneNumber,
            whatsappNumber,
            whatsappConsentGiven,
            portfolio,
            portfolioImages,
        } = req.body;

        const user = await User.findByPk(authUserId);
        if (!user) return next(new AppError(messages.user.notfound, 404));

        if (fullName !== undefined) user.fullName = fullName;
        if (city !== undefined) user.city = city;
        if (experience !== undefined || experienceYears !== undefined) user.experience = experience ?? experienceYears;
        if (languages !== undefined) {
            const normalized = normalizeLanguages(languages);
            if (normalized.length !== languages.length) return next(new AppError('One or more languages are not supported', 400));
            user.languages = normalized;
        }
        if (eventCategories !== undefined || categories !== undefined) {
            const requestedCategories = eventCategories ?? categories;
            const normalized = normalizeEventCategories(requestedCategories);
            if (normalized.length !== requestedCategories.length) return next(new AppError('One or more event categories are not supported', 400));
            user.eventCategories = normalized;
        }
        if (workCities !== undefined) user.workCities = workCities;
        if (education !== undefined) user.education = education;
        if (refusedCategories !== undefined) user.refusedCategories = refusedCategories;
        if (availabilityDates !== undefined) user.availabilityDates = availabilityDates;
        if (mobileNumber !== undefined || phoneNumber !== undefined) {
            const requestedMobile = mobileNumber ?? phoneNumber ?? null;
            const duplicate = requestedMobile ? await User.findOne({
                where: { mobileNumber: requestedMobile, id: { [Op.ne]: authUserId } },
            }) : null;
            if (duplicate) return next(new AppError('This mobile number is already in use', 409));
            user.mobileNumber = requestedMobile;
        }
        if (whatsappNumber !== undefined) user.whatsappNumber = whatsappNumber || null;
        if (portfolio !== undefined || portfolioImages !== undefined) user.portfolio = portfolio ?? portfolioImages;
        if (whatsappConsentGiven !== undefined) {
            user.whatsappConsentGiven = whatsappConsentGiven;
            user.whatsappConsentGivenAt = whatsappConsentGiven ? new Date() : null;
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

    // US-102: Upload / change profile picture
    static async uploadProfilePicture(req, res, next) {
        if (!req.file) return next(new AppError('Image file is required', 400));

        const userId = req.authUser.id;
        const user = await User.findByPk(userId);
        if (!user) return next(new AppError(messages.user.notfound, 404));

        const previousPublicId = user.portfolioPicture?.public_id;
        const uploaded = await CloudinaryService.uploadBuffer(req.file.buffer, UploadFolders.profilePicture(user.id));
        user.portfolioPicture = uploaded;
        await user.save();
        if (previousPublicId && previousPublicId !== 'default_avatar') {
            await CloudinaryService.deleteImage(previousPublicId).catch(() => undefined);
        }

        return res.status(200).json({
            success: true,
            message: 'Profile picture updated successfully',
            data: {
                portfolioPicture: uploaded,
                profileCompleted: isProfileComplete(user),
                missingProfileFields: getMissingProfileFields(user),
            },
        });
    }

    // US-103: Browse available open events (with ApiFeature pagination)
    static async browseEvents(req, res, next) {
        const { category, city } = req.query;

        const where = {
            status: 'open',
            applicationDeadline: { [Op.gt]: new Date() },
        };
        if (category) {
            const normalizedCategory = normalizeEventCategory(category);
            if (!normalizedCategory) return next(new AppError('Invalid event category', 400));
            where.category = normalizedCategory;
        }
        if (city) where.location = { [Op.iLike]: `%${city}%` };

        const feature = new ApiFeature(req.query).pagination().sort().build();
        const page = parseInt(req.query.page) || 1;

        const { rows: events, count } = await Event.findAndCountAll({
            where,
            order: feature.order.length ? feature.order : [['eventDate', 'ASC']],
            limit: feature.limit,
            offset: feature.offset,
        });

        return res.status(200).json({
            success: true,
            message: messages.event.getsuccessfully,
            ...ApiFeature.paginateResponse(events.map(event => eventForTalent(event)), page, feature.limit, count),
        });
    }

    static async getEventById(req, res, next) {
        const event = await Event.findByPk(req.params.id);
        if (!event) return next(new AppError(messages.event.notfound, 404));

        const application = await Application.findOne({
            where: { eventId: event.id, talentId: req.authUser.id },
        });
        if (event.status !== 'open') {
            if (!application) return next(new AppError(messages.event.notfound, 404));
        }

        return res.status(200).json({ success: true, data: eventForTalent(event, application?.status === 'accepted') });
    }

    static async checkInWithAttendanceQr(req, res, next) {
        const { token } = req.body;
        const parsedToken = parseAttendanceQrToken(token);
        if (!parsedToken) return next(new AppError('Invalid attendance QR code', 400));

        const talentId = req.authUser.id;
        const { attendance, event, previousStatus } = await sequelize.transaction(async (transaction) => {
            const event = await Event.findByPk(parsedToken.eventId, { transaction });
            if (!event || !attendanceQrMatchesEvent(token, event)) {
                throw new AppError('Invalid attendance QR code', 400);
            }
            if (event.status === 'cancelled' || event.status === 'completed') {
                throw new AppError('Check-in is closed for this event', 409);
            }
            if (event.status === 'open' && new Date() < new Date(event.applicationDeadline)) {
                throw new AppError('Check-in is not open yet', 409);
            }
            if (!(event.hiredTalents || []).includes(talentId)) {
                throw new AppError('You are not hired for this event', 403);
            }

            const talent = await User.findByPk(talentId, {
                transaction,
                lock: transaction.LOCK.UPDATE,
            });
            const existingAttendance = await Attendance.findOne({
                where: { eventId: event.id, talentId },
                transaction,
                lock: transaction.LOCK.UPDATE,
            });
            const previousStatus = existingAttendance?.status || null;
            const attendance = existingAttendance || await Attendance.create({
                eventId: event.id,
                talentId,
                status: 'present',
                checkInTime: new Date(),
            }, { transaction });

            if (existingAttendance) {
                attendance.status = 'present';
                attendance.checkInTime ||= new Date();
                await attendance.save({ transaction });
            }

            const wasGood = previousStatus === 'present' || previousStatus === 'late';
            if (talent && !wasGood) {
                talent.consecutiveGoodEvents = (talent.consecutiveGoodEvents || 0) + 1;
                if (talent.consecutiveGoodEvents >= 5) {
                    talent.lateExcuseCount = 0;
                    talent.consecutiveGoodEvents = 0;
                }
                await talent.save({ transaction });
            }

            return { attendance, event, previousStatus };
        });

        await checkAndAutoVerify(talentId);

        return res.status(200).json({
            success: true,
            message: previousStatus === 'present' ? 'You are already checked in' : 'Attendance confirmed',
            data: {
                attendance,
                event: { id: event.id, title: event.title, eventDate: event.eventDate },
                alreadyCheckedIn: previousStatus === 'present',
            },
        });
    }

    static async listTalents(req, res) {
        const feature = new ApiFeature(req.query).pagination().sort().build();
        const page = parseInt(req.query.page) || 1;
        const talents = await User.findAll({
            where: { role: 'usher', isBlocked: false },
            order: feature.order.length ? feature.order : [['rate', 'DESC']],
        });
        const completeTalents = talents.filter(isProfileComplete);
        const data = completeTalents.slice(feature.offset, feature.offset + feature.limit).map(publicTalent);
        return res.status(200).json({
            success: true,
            ...ApiFeature.paginateResponse(data, page, feature.limit, completeTalents.length),
        });
    }

    // US-104: Apply to an event
    static async applyToEvent(req, res, next) {
        const { eventId } = req.body;
        const talentId = req.authUser.id;

        const event = await Event.findByPk(eventId);
        if (!event) return next(new AppError(messages.event.notfound, 404));
        if (event.status !== 'open') return next(new AppError('This event is not open for applications', 400));

        // Enforce deadline (BR-02)
        if (new Date() > new Date(event.applicationDeadline)) {
            return next(new AppError('Application deadline has passed', 400));
        }

        // Prevent duplicate (BR-01)
        const existing = await Application.findOne({ where: { eventId, talentId } });
        if (existing) return next(new AppError('You have already applied to this event', 400));

        const application = await Application.create({
            eventId, talentId, status: 'pending', isDirect: false, appliedAt: new Date(),
        });
        const {
            application: finalApplication,
            autoAccepted,
        } = await maybeAutoAcceptHighRatedApplication({
            application,
            event,
            talent: req.authUser,
        });

        await NotificationService.create({
            userId: event.organizerId,
            title: autoAccepted ? 'Application auto-accepted' : 'New event application',
            message: autoAccepted
                ? `${req.authUser.fullName} was auto-accepted for “${event.title}” based on their rating.`
                : `${req.authUser.fullName} applied to “${event.title}”.`,
            type: autoAccepted ? 'success' : 'info',
            link: `/provider/events/${event.id}`,
        });
        if (autoAccepted) {
            await NotificationService.create({
                userId: talentId,
                title: 'Application accepted',
                message: `Your application to “${event.title}” was accepted automatically.`,
                type: 'success',
                link: `/talent/jobs/${event.id}`,
            });
        }

        return res.status(201).json({
            success: true,
            message: autoAccepted
                ? 'Application submitted and accepted automatically'
                : 'Application submitted successfully',
            data: finalApplication,
        });
    }

    // US-105: Track my applications & events (with ApiFeature pagination)
    static async getMyApplications(req, res, next) {
        const talentId = req.authUser.id;
        const { filter } = req.query;
        const page = parseInt(req.query.page) || 1;
        const size = parseInt(req.query.size) || 10;

        // Fetch all for in-memory enrichment and date-based filtering
        const applications = await Application.findAll({
            where: { talentId },
            order: [['appliedAt', 'DESC']],
        });

        const now = new Date();
        let enriched = await Promise.all(applications.map(async (app) => {
            const event = await Event.findByPk(app.eventId);
            let referredByName = null;
            if (app.referredBy) {
                const referrer = await User.findByPk(app.referredBy, { attributes: ['fullName'] });
                referredByName = referrer?.fullName || null;
            }
            return { ...app.toJSON(), event: eventForTalent(event, app.status === 'accepted'), referredByName };
        }));

        if (filter === 'upcoming') {
            enriched = enriched.filter(a => a.event && new Date(a.event.eventDate) >= now);
        } else if (filter === 'past') {
            enriched = enriched.filter(a => a.event && new Date(a.event.eventDate) < now);
        }

        const total = enriched.length;
        const paginated = enriched.slice((page - 1) * size, page * size);

        return res.status(200).json({
            success: true,
            message: messages.event.getsuccessfully,
            ...ApiFeature.paginateResponse(paginated, page, size, total),
        });
    }

    // US-106: Get event history on profile page
    static async getMyEventHistory(req, res, next) {
        const talentId = req.authUser.id;

        const applications = await Application.findAll({
            where: { talentId, status: { [Op.in]: ['accepted', 'excused'] } },
        });

        const history = await Promise.all(applications.map(async (app) => {
            const event = await Event.findByPk(app.eventId);
            const attendance = await Attendance.findOne({ where: { eventId: app.eventId, talentId } });
            const review = await Review.findOne({ where: { eventId: app.eventId, reviewedUserId: talentId } });
            return {
                event: eventForTalent(event, app.status === 'accepted'),
                applicationStatus: app.status,
                attendanceStatus: attendance?.status || null,
                rating: review?.rating || null,
                comment: review?.comment || null,
            };
        }));

        history.sort((a, b) => {
            if (!a.event || !b.event) return 0;
            return new Date(b.event.eventDate) - new Date(a.event.eventDate);
        });

        return res.status(200).json({
            success: true,
            message: messages.event.getsuccessfully,
            data: history,
            count: history.length,
        });
    }

    // US-107 & US-108: Excuse from an accepted event
    static async excuseFromEvent(req, res, next) {
        const { applicationId } = req.params;
        const talentId = req.authUser.id;

        const application = await Application.findOne({ where: { id: applicationId, talentId } });
        if (!application) return next(new AppError('Application not found', 404));

        // Can only excuse from accepted (BR-03)
        if (application.status !== 'accepted') {
            return next(new AppError('You can only excuse from accepted applications', 400));
        }

        const event = await Event.findByPk(application.eventId);
        if (!event) return next(new AppError(messages.event.notfound, 404));

        if (new Date() > new Date(event.eventDate)) {
            return next(new AppError('Cannot excuse from an event that has already occurred', 400));
        }

        // Determine late excuse (BR-04)
        const now = new Date();
        const deadline = new Date(event.applicationDeadline);
        const msIn3Days = 3 * 24 * 60 * 60 * 1000;
        const isLateExcuse = (deadline - now) <= msIn3Days;

        application.status = 'excused';
        await application.save();

        event.hiredTalents = event.hiredTalents.filter(id => id !== talentId);
        await event.save();

        const talent = await User.findByPk(talentId);
        let lateExcuseCount = talent.lateExcuseCount || 0;

        if (isLateExcuse) {
            lateExcuseCount += 1;
            talent.lateExcuseCount = lateExcuseCount;
            talent.consecutiveGoodEvents = 0; // reset streak (BR-08)
            await talent.save();
        }

        await NotificationService.create({
            userId: event.organizerId,
            title: 'Usher excused from event',
            message: `${talent.fullName} excused themselves from “${event.title}”.`,
            type: 'warning',
            link: `/provider/events/${event.id}`,
        });

        return res.status(200).json({
            success: true,
            message: isLateExcuse
                ? `Excused with late penalty. Late excuse count: ${lateExcuseCount}/5`
                : 'Excused successfully. No penalty applied.',
            data: { applicationStatus: application.status, isLateExcuse, lateExcuseCount },
        });
    }

    // US-109: Refer another talent to an event
    static async createReferralInvite(req, res, next) {
        const { eventId } = req.body;
        const referrer = req.authUser;
        const event = await Event.findByPk(eventId);
        if (!event || event.status !== 'open' || new Date() > new Date(event.applicationDeadline)) {
            return next(new AppError('Event is not available for referrals', 400));
        }
        if (!referrer.isVerified) return next(new AppError('Only verified ushers can create referral invites', 403));
        const accepted = await Application.findOne({
            where: { eventId, talentId: referrer.id, status: 'accepted' },
        });
        if (!accepted) return next(new AppError('You must be accepted for this event before inviting another usher', 403));
        const token = TokenService.generatePurposeToken({
            payload: { eventId, referrerTalentId: referrer.id },
            purpose: 'referral_invite',
            expiresIn: '7d',
        });
        return res.status(201).json({ success: true, data: { token, expiresIn: '7d' } });
    }

    static async uploadPortfolioImage(req, res, next) {
        if (!req.file) return next(new AppError('Image file is required', 400));

        const user = await User.findByPk(req.authUser.id);
        if (!user) return next(new AppError(messages.user.notfound, 404));
        const portfolio = Array.isArray(user.portfolio) ? [...user.portfolio] : [];
        if (portfolio.length >= 12) return next(new AppError('A portfolio can contain up to 12 images', 400));

        const uploaded = await CloudinaryService.uploadBuffer(req.file.buffer, UploadFolders.portfolio(user.id));
        portfolio.push(uploaded);
        user.portfolio = portfolio;
        await user.save();

        return res.status(201).json({ success: true, message: 'Portfolio image uploaded', data: portfolio });
    }

    static async deletePortfolioImage(req, res, next) {
        const index = Number.parseInt(req.params.index, 10);
        const user = await User.findByPk(req.authUser.id);
        if (!user) return next(new AppError(messages.user.notfound, 404));
        const portfolio = Array.isArray(user.portfolio) ? [...user.portfolio] : [];
        if (!Number.isInteger(index) || index < 0 || index >= portfolio.length) {
            return next(new AppError('Portfolio image not found', 404));
        }

        const [removed] = portfolio.splice(index, 1);
        user.portfolio = portfolio;
        await user.save();
        if (removed?.public_id) await CloudinaryService.deleteImage(removed.public_id).catch(() => undefined);

        return res.status(200).json({ success: true, message: 'Portfolio image removed', data: portfolio });
    }

    static async redeemReferralInvite(req, res, next) {
        let payload;
        try {
            payload = TokenService.verifyPurposeToken({ token: req.params.token, purpose: 'referral_invite' });
        } catch {
            return next(new AppError('Referral invite is invalid or expired', 404));
        }
        const referredTalentId = req.authUser.id;
        if (payload.referrerTalentId === referredTalentId) return next(new AppError('You cannot redeem your own invite', 400));
        const [event, referrer, accepted] = await Promise.all([
            Event.findByPk(payload.eventId),
            User.findOne({ where: { id: payload.referrerTalentId, role: 'usher', isBlocked: false, isVerified: true } }),
            Application.findOne({ where: { eventId: payload.eventId, talentId: payload.referrerTalentId, status: 'accepted' } }),
        ]);
        if (!event || !referrer || !accepted || event.status !== 'open' || new Date() > new Date(event.applicationDeadline)) {
            return next(new AppError('Referral invite is no longer available', 410));
        }
        const existingApplication = await Application.findOne({ where: { eventId: event.id, talentId: referredTalentId } });
        if (existingApplication && ['accepted', 'rejected'].includes(existingApplication.status)) {
            return next(new AppError('You already have a final application for this event', 409));
        }
        const [referral] = await Referral.findOrCreate({
            where: { eventId: event.id, referrerTalentId: referrer.id, referredTalentId },
            defaults: { status: 'pending' },
        });
        if (referral.status !== 'pending') return next(new AppError('This referral was already completed', 409));
        await NotificationService.create({
            userId: referredTalentId,
            title: 'Referral invite redeemed',
            message: `${referrer.fullName} invited you to “${event.title}”. Complete your profile, then accept or decline it from your dashboard.`,
            type: 'success',
            link: '/talent/dashboard',
        });
        return res.status(200).json({ success: true, data: referral });
    }

    static async referTalent(req, res, next) {
        const { eventId, referredTalentId } = req.body;
        const referrerTalentId = req.authUser.id;

        if (referrerTalentId === referredTalentId) return next(new AppError('You cannot refer yourself', 400));

        const event = await Event.findByPk(eventId);
        if (!event) return next(new AppError(messages.event.notfound, 404));
        if (event.status !== 'open') return next(new AppError('Event is not open for referrals', 400));
        if (new Date() > new Date(event.applicationDeadline)) {
            return next(new AppError('The application deadline has passed', 400));
        }

        const referredTalent = await User.findOne({ where: { id: referredTalentId, role: 'usher' } });
        if (!referredTalent) return next(new AppError('Referred talent not found', 404));

        if (!req.authUser.isVerified) {
            return next(new AppError('Only verified ushers can make referrals', 403));
        }

        const referrerApplication = await Application.findOne({
            where: { eventId, talentId: referrerTalentId, status: 'accepted' },
        });
        if (!referrerApplication) {
            return next(new AppError('You must be accepted for this event before referring another usher', 403));
        }

        // Cannot refer accepted/rejected (BR-13)
        const existingApp = await Application.findOne({ where: { eventId, talentId: referredTalentId } });
        if (existingApp && ['accepted', 'rejected'].includes(existingApp.status)) {
            return next(new AppError('Cannot refer a talent who is already accepted or rejected for this event', 400));
        }

        const existingReferral = await Referral.findOne({
            where: { eventId, referredTalentId, status: 'pending' },
        });
        if (existingReferral) return next(new AppError('This talent already has a pending referral for this event', 400));

        const mutualReferral = await Referral.findOne({
            where: {
                eventId,
                referrerTalentId: referredTalentId,
                referredTalentId: referrerTalentId,
                status: 'pending',
            },
        });
        if (mutualReferral) return next(new AppError('A mutual referral is already pending for this event', 400));

        const referral = await Referral.create({
            eventId, referrerTalentId, referredTalentId, status: 'pending',
        });

        if (existingApp) {
            existingApp.referredBy = referrerTalentId;
            await existingApp.save();
        }

        await NotificationService.create({
            userId: referredTalentId,
            title: 'New event referral',
            message: `${req.authUser.fullName} referred you to “${event.title}”.`,
            type: 'info',
            link: '/talent/dashboard',
        });

        return res.status(201).json({
            success: true,
            message: 'Talent referred successfully',
            data: referral,
        });
    }

    // ─── US-100-EXT: Usher Dashboard Stats ──────────────────────────────────────
    static async getDashboard(req, res, next) {
        const talentId = req.authUser.id;

        const [
            allApplications,
            acceptedApplications,
        ] = await Promise.all([
            Application.findAll({ where: { talentId } }),
            Application.findAll({ where: { talentId, status: 'accepted' } }),
        ]);

        const now = new Date();
        const acceptedEventIds = acceptedApplications.map(a => a.eventId);

        const [upcomingEvents, completedEvents, user] = await Promise.all([
            acceptedEventIds.length
                ? Event.findAll({
                    where: {
                        id: { [Op.in]: acceptedEventIds },
                        eventDate: { [Op.gte]: now },
                        status: { [Op.in]: ['open', 'confirmed'] },
                    },
                    order: [['eventDate', 'ASC']],
                    limit: 5,
                })
                : Promise.resolve([]),
            acceptedEventIds.length
                ? Event.findAll({
                    where: {
                        id: { [Op.in]: acceptedEventIds },
                        status: 'completed',
                    },
                })
                : Promise.resolve([]),
            User.findByPk(talentId, { attributes: SAFE_USER_ATTRS }),
        ]);

        return res.status(200).json({
            success: true,
            message: 'Dashboard retrieved successfully',
            data: {
                reliabilityScore: user?.reliabilityScore ?? 100,
                ratingAverage: user?.rate ?? 0,
                totalRatings: user?.totalRatings ?? 0,
                upcomingEventsCount: upcomingEvents.length,
                completedEventsCount: completedEvents.length,
                pendingApplications: allApplications.filter(a => a.status === 'pending').length,
                acceptedApplications: acceptedApplications.length,
                upcomingEvents: upcomingEvents.map(event => eventForTalent(event, true)),
            },
        });
    }

    // ─── US-109-EXT: Get pending referrals received by this usher ───────────────
    static async getMyPendingReferrals(req, res, next) {
        const talentId = req.authUser.id;

        const referrals = await Referral.findAll({
            where: { referredTalentId: talentId, status: 'pending' },
            order: [['createdAt', 'DESC']],
        });

        const enriched = await Promise.all(referrals.map(async (ref) => {
            const event = await Event.findByPk(ref.eventId);
            const referrer = await User.findByPk(ref.referrerTalentId, {
                attributes: ['id', 'fullName', 'portfolioPicture', 'city', 'rate'],
            });
            return { ...ref.toJSON(), event: eventForTalent(event), referrer };
        }));

        return res.status(200).json({
            success: true,
            message: 'Pending referrals retrieved successfully',
            data: enriched.filter(r => r.event && r.referrer),
            count: enriched.length,
        });
    }

    // ─── US-109-EXT: Accept a referral ─────────────────────────────────────────
    static async acceptReferral(req, res, next) {
        const { referralId } = req.params;
        const talentId = req.authUser.id;

        const referral = await Referral.findOne({ where: { id: referralId, referredTalentId: talentId } });
        if (!referral) return next(new AppError('Referral not found', 404));
        if (referral.status !== 'pending') return next(new AppError('Referral is no longer pending', 400));

        const event = await Event.findByPk(referral.eventId);
        if (!event) return next(new AppError(messages.event.notfound, 404));
        if (event.status !== 'open') return next(new AppError('Event is no longer open', 400));
        if (new Date() > new Date(event.applicationDeadline)) {
            return next(new AppError('The application deadline has passed', 400));
        }

        let application = await Application.findOne({ where: { eventId: referral.eventId, talentId } });
        if (application && application.status !== 'pending') {
            return next(new AppError('Your application for this event is no longer pending', 409));
        }

        // Mark referral accepted
        referral.status = 'accepted';
        await referral.save();

        // Decline all other pending referrals for same talent + event
        await Referral.update(
            { status: 'declined' },
            { where: { eventId: referral.eventId, referredTalentId: talentId, status: 'pending', id: { [Op.ne]: referralId } } }
        );

        // Ensure application exists with referredBy tagged
        if (application) {
            application.referredBy = referral.referrerTalentId;
            await application.save();
        } else {
            application = await Application.create({
                eventId: referral.eventId,
                talentId,
                status: 'pending',
                isDirect: false,
                referredBy: referral.referrerTalentId,
                appliedAt: new Date(),
            });
        }
        const {
            application: finalApplication,
            autoAccepted,
        } = await maybeAutoAcceptHighRatedApplication({
            application,
            event,
            talent: req.authUser,
        });

        await NotificationService.create({
            userId: event.organizerId,
            title: autoAccepted ? 'Referral auto-accepted' : 'Referral accepted',
            message: autoAccepted
                ? `${req.authUser.fullName} accepted a referral and was auto-accepted for “${event.title}”.`
                : `${req.authUser.fullName} accepted a referral and applied to “${event.title}”.`,
            type: autoAccepted ? 'success' : 'info',
            link: `/provider/events/${event.id}`,
        });

        return res.status(200).json({
            success: true,
            message: autoAccepted
                ? 'Referral accepted. Application accepted automatically.'
                : 'Referral accepted. Application submitted for organizer review.',
            data: finalApplication,
        });
    }

    // ─── US-109-EXT: Decline a referral ────────────────────────────────────────
    static async declineReferral(req, res, next) {
        const { referralId } = req.params;
        const talentId = req.authUser.id;

        const referral = await Referral.findOne({ where: { id: referralId, referredTalentId: talentId } });
        if (!referral) return next(new AppError('Referral not found', 404));
        if (referral.status !== 'pending') return next(new AppError('Referral is no longer pending', 400));

        referral.status = 'declined';
        await referral.save();

        await NotificationService.create({
            userId: referral.referrerTalentId,
            title: 'Referral declined',
            message: `${req.authUser.fullName} declined your event referral.`,
            type: 'warning',
            link: '/talent/events',
        });

        return res.status(200).json({
            success: true,
            message: 'Referral declined successfully',
        });
    }

    // ─── Payment Methods ────────────────────────────────────────────────────────
    static async addPaymentMethod(req, res, next) {
        const userId = req.authUser.id;
        const {
            provider,
            numberOrDetail,
            type,
            issuer,
            accountHolderName,
            bankCode,
            mobileNumber,
            iban,
            accountNumber,
        } = req.body;

        const user = await User.findByPk(userId);
        if (!user) return next(new AppError(messages.user.notfound, 404));

        const methods = Array.isArray(user.paymentMethods) ? [...user.paymentMethods] : [];
        const newMethod = {
            id: randomUUID(),
            provider,
            numberOrDetail: numberOrDetail || mobileNumber || iban || accountNumber || '',
            ...(type ? { type } : {}),
            ...(issuer ? { issuer } : {}),
            ...(accountHolderName ? { accountHolderName } : {}),
            ...(bankCode ? { bankCode } : {}),
            ...(mobileNumber ? { mobileNumber } : {}),
            ...(iban ? { iban } : {}),
            ...(accountNumber ? { accountNumber } : {}),
            isDefault: methods.length === 0,
        };
        newMethod._id = newMethod.id;

        methods.push(newMethod);
        user.paymentMethods = methods;
        await user.save();

        return res.status(201).json({
            success: true,
            message: messages.paymentMethod.createSuccessfully,
            data: methods,
        });
    }

    static async deletePaymentMethod(req, res, next) {
        const userId = req.authUser.id;
        const { methodId } = req.params;

        const user = await User.findByPk(userId);
        if (!user) return next(new AppError(messages.user.notfound, 404));

        const methods = Array.isArray(user.paymentMethods) ? [...user.paymentMethods] : [];
        const idx = methods.findIndex(m => (m.id || m._id) === methodId);
        if (idx === -1) return next(new AppError(messages.paymentMethod.notfound, 404));

        const wasDefault = methods[idx].isDefault;
        methods.splice(idx, 1);

        // Re-assign default if we deleted the default one
        if (wasDefault && methods.length > 0) {
            methods[0].isDefault = true;
        }

        user.paymentMethods = methods;
        await user.save();

        return res.status(200).json({
            success: true,
            message: messages.paymentMethod.deleteSuccessfully,
            data: methods,
        });
    }

    static async setDefaultPaymentMethod(req, res, next) {
        const userId = req.authUser.id;
        const { methodId } = req.params;

        const user = await User.findByPk(userId);
        if (!user) return next(new AppError(messages.user.notfound, 404));

        let methods = Array.isArray(user.paymentMethods) ? [...user.paymentMethods] : [];
        const target = methods.find(m => (m.id || m._id) === methodId);
        if (!target) return next(new AppError(messages.paymentMethod.notfound, 404));

        methods = methods.map(m => ({
            ...m,
            id: m.id || m._id,
            _id: m._id || m.id,
            isDefault: (m.id || m._id) === methodId,
        }));
        user.paymentMethods = methods;
        await user.save();

        return res.status(200).json({
            success: true,
            message: 'Default payment method updated',
            data: methods,
        });
    }

    static async getTalentReviews(req, res, next) {
        const { id } = req.params;
        const talent = await User.findOne({ where: { id, role: 'usher' }, attributes: ['id'] });
        if (!talent) return next(new AppError(messages.user.notfound, 404));

        const reviews = await Review.findAll({
            where: { reviewedUserId: id },
            order: [['createdAt', 'DESC']],
        });
        const data = await Promise.all(reviews.map(async (review) => ({
            ...review.toJSON(),
            event: eventForTalent(await Event.findByPk(review.eventId)),
        })));

        return res.status(200).json({ success: true, data, count: data.length });
    }
}

// Export helper for use by organizer controller after marking attendance/reviews
export { checkAndAutoVerify };
