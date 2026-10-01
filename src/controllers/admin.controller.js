import { Op } from 'sequelize';
import { sequelize } from '../../db/connection.js';
import { User, Event, Application, Attendance, Review, Referral, EventActionRequest, Notification, EventSettlement, OrganizerCard, OrganizerCardEnrollment, AbsenceHold, CreditWithdrawal, SettlementLine } from '../../db/index.js';
import { OrganizerCreditService } from '../services/organizer-credit.service.js';
import { AppError } from '../utils/appError.js';
import { messages } from '../utils/constant/messages.js';
import { ApiFeature } from '../utils/apiFeature.js';
import { HashService } from '../utils/hashAndcompare.js';
import { EventService } from '../services/event.service.js';
import { NotificationService } from '../services/notification.service.js';
import { normalizeRole } from '../utils/normalization.js';
import { eventStatus } from '../utils/constant/enums.js';
import { findAvailableOrganization, issueSession } from '../services/session.service.js';

const SAFE_USER_ATTRS = { exclude: ['password', 'otp', 'otpExpiry', 'otpAttempts', 'lastOtpRequest', 'otpVerified', 'refreshTokenHash', 'refreshTokenExpiresAt'] };

export class AdminController {

    static async switchToOrganization(req, res, next) {
        const { id } = req.params;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
            return next(new AppError('Invalid organization id', 400));
        }
        const organization = await findAvailableOrganization(id);
        if (!organization) return next(new AppError('Organization not found or blocked', 404));
        const token = await issueSession(req.authUser, res, req.authUser.refreshTokenHash, organization.id);
        if (!token) return next(new AppError('Session expired. Please sign in again.', 401));
        // eslint-disable-next-line no-console
        console.info(JSON.stringify({ event: 'admin_organization_switch', adminId: req.authUser.id,
            organizationId: organization.id }));
        return res.status(200).json({ success: true, data: {
            organizationId: organization.id, organizationName: organization.fullName,
        } });
    }

    static async stopActingAsOrganization(req, res, next) {
        const admin = req.authUser;
        const token = await issueSession(admin, res, admin.refreshTokenHash);
        if (!token) return next(new AppError('Session expired. Please sign in again.', 401));
        // eslint-disable-next-line no-console
        console.info(JSON.stringify({ event: 'admin_organization_stop', adminId: admin.id,
            organizationId: req.actingAsId || null }));
        return res.status(200).json({ success: true });
    }

    // US-301: Get all users — with search & role filter + ApiFeature pagination
    static async getAllUsers(req, res, next) {
        const { search, role } = req.query;
        const where = {};

        if (role && role !== 'all') {
            if (role === 'blocked') {
                where.isBlocked = true;
            } else {
                const normalizedRole = normalizeRole(role);
                if (!normalizedRole) return next(new AppError('Invalid user role filter', 400));
                where.role = normalizedRole;
            }
        }

        if (search) {
            where[Op.or] = [
                { fullName: { [Op.iLike]: `%${search}%` } },
                { email: { [Op.iLike]: `%${search}%` } },
            ];
        }

        const feature = new ApiFeature(req.query).pagination().sort().build();
        const page = parseInt(req.query.page) || 1;

        const { count, rows: users } = await User.findAndCountAll({
            where,
            attributes: SAFE_USER_ATTRS,
            order: feature.order.length ? feature.order : [['createdAt', 'DESC']],
            limit: feature.limit,
            offset: feature.offset,
        });

        return res.status(200).json({
            success: true,
            message: messages.user.getsuccessfully,
            ...ApiFeature.paginateResponse(users, page, feature.limit, count),
        });
    }

    // Get all ushers (talent) — with ApiFeature pagination
    static async getUshers(req, res, next) {
        const feature = new ApiFeature(req.query).pagination().sort().build();
        const page = parseInt(req.query.page) || 1;

        const { count, rows: users } = await User.findAndCountAll({
            where: { role: 'usher' },
            attributes: SAFE_USER_ATTRS,
            order: feature.order.length ? feature.order : [['createdAt', 'DESC']],
            limit: feature.limit,
            offset: feature.offset,
        });

        return res.status(200).json({
            success: true,
            message: messages.user.getsuccessfully,
            ...ApiFeature.paginateResponse(users, page, feature.limit, count),
        });
    }

    // Get all organizers (providers) — with ApiFeature pagination
    static async getOrganizers(req, res, next) {
        const feature = new ApiFeature(req.query).pagination().sort().build();
        const page = parseInt(req.query.page) || 1;

        const { count, rows: users } = await User.findAndCountAll({
            where: { role: 'organizer' },
            attributes: SAFE_USER_ATTRS,
            order: feature.order.length ? feature.order : [['createdAt', 'DESC']],
            limit: feature.limit,
            offset: feature.offset,
        });

        return res.status(200).json({
            success: true,
            message: messages.user.getsuccessfully,
            ...ApiFeature.paginateResponse(users, page, feature.limit, count),
        });
    }

    // US-306: Get all events — with search & status filter + ApiFeature pagination
    static async getEvents(req, res, next) {
        const { search, status } = req.query;
        const where = {};

        if (status && status !== 'all') {
            if (!Object.values(eventStatus).includes(status)) return next(new AppError('Invalid event status filter', 400));
            where.status = status;
        }

        if (search) {
            where[Op.or] = [
                { title: { [Op.iLike]: `%${search}%` } },
                { location: { [Op.iLike]: `%${search}%` } },
            ];
        }

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

    // US-302: Block a user (cannot block admins — BR-09)
    static async blockUser(req, res, next) {
        const { id } = req.params;
        const adminId = req.authUser.id;

        if (id === adminId) return next(new AppError('You cannot block yourself', 400));

        const user = await User.findByPk(id);
        if (!user) return next(new AppError(messages.user.notfound, 404));
        if (user.role === 'admin') return next(new AppError('Admin accounts cannot be blocked', 403));

        user.isBlocked = true;
        user.status = 'blocked';
        await user.save();

        return res.status(200).json({
            success: true,
            message: 'User blocked successfully',
        });
    }

    // US-303: Unblock a user
    static async unblockUser(req, res, next) {
        const { id } = req.params;

        const user = await User.findByPk(id);
        if (!user) return next(new AppError(messages.user.notfound, 404));

        user.isBlocked = false;
        user.status = 'verified';
        await user.save();

        return res.status(200).json({
            success: true,
            message: 'User unblocked successfully',
        });
    }

    // US-304: Verify a user
    static async verifyUser(req, res, next) {
        const { id } = req.params;

        const user = await User.findByPk(id);
        if (!user) return next(new AppError(messages.user.notfound, 404));

        user.isVerified = true;
        await user.save();

        return res.status(200).json({
            success: true,
            message: messages.user.verified,
        });
    }

    // US-304: Unverify a user
    static async unverifyUser(req, res, next) {
        const { id } = req.params;

        const user = await User.findByPk(id);
        if (!user) return next(new AppError(messages.user.notfound, 404));

        user.isVerified = false;
        await user.save();

        return res.status(200).json({
            success: true,
            message: 'User unverified successfully',
        });
    }

    // Legacy: update user status field
    static async updateUserStatus(req, res, next) {
        const { id } = req.params;
        const { status } = req.body;

        const user = await User.findByPk(id);
        if (!user) return next(new AppError(messages.user.notfound, 404));
        if (user.role === 'admin') return next(new AppError('Cannot modify admin accounts', 403));

        user.status = status;
        user.isBlocked = status === 'blocked';
        await user.save();

        return res.status(200).json({
            success: true,
            message: messages.user.updateSuccessfully,
        });
    }

    // US-307: Change event status
    static async updateEventStatus(req, res, next) {
        const { id } = req.params;
        const { status } = req.body;

        const { event, notifyUserIds, fundingResult } = await EventService.changeStatus(id, status);
        await EventService.notifyCancellation(event, notifyUserIds, fundingResult);

        return res.status(200).json({
            success: true,
            message: messages.event.updateSuccessfully,
            data: event,
        });
    }

    // US-308: Delete event and all its applications (BR-11)
    static async deleteEvent(req, res, next) {
        const { id } = req.params;

        const event = await Event.findByPk(id);
        if (!event) return next(new AppError(messages.event.notfound, 404));

        await EventService.deleteWithRelations(id);

        return res.status(200).json({
            success: true,
            message: messages.event.deleteSuccessfully,
        });
    }

    // US-305: Reset talent late excuses
    static async resetExcuses(req, res, next) {
        const { id } = req.params;

        const user = await User.findByPk(id);
        if (!user) return next(new AppError(messages.user.notfound, 404));
        if (user.role !== 'usher') return next(new AppError('Only usher accounts have excuse counters', 400));

        user.lateExcuseCount = 0;
        user.consecutiveGoodEvents = 0;
        await user.save();

        return res.status(200).json({
            success: true,
            message: 'Late excuse counter reset successfully',
            data: { id: user.id, lateExcuseCount: 0, consecutiveGoodEvents: 0 },
        });
    }

    // US-309: Admin invite (create) a user with a specific role
    static async inviteUser(req, res, next) {
        const { fullName, companyName, email, password, city, mobileNumber } = req.body;
        const role = normalizeRole(req.body.role);
        const providerOwnerId = req.body.providerOwnerId || req.body.providerProfileId || null;

        const existing = await User.findOne({ where: { email: email.toLowerCase() }, paranoid: false });
        if (existing) return next(new AppError('A user with this email already exists', 400));

        const hashedPassword = HashService.hashPassword({ password: password || 'Password@123' });

        if (['organizer_member', 'organizer_supervisor'].includes(role)) {
            const owner = providerOwnerId ? await User.findOne({ where: { id: providerOwnerId, role: 'organizer' } }) : null;
            if (!owner) return next(new AppError('A valid organizer is required for a staff account', 400));
        }

        const newUser = await User.create({
            fullName: fullName || companyName || '',
            userName: `user_${Date.now()}`,
            email: email.toLowerCase(),
            password: hashedPassword,
            mobileNumber: mobileNumber || null,
            city: city || null,
            experience: 0,
            role,
            rate: 0,
            isEmailVerified: true,
            isVerified: false,
            providerOwnerId: ['organizer_member', 'organizer_supervisor'].includes(role) ? providerOwnerId : null,
        });

        const safeData = newUser.toJSON();
        return res.status(201).json({
            success: true,
            message: messages.user.createSuccessfully,
            data: safeData,
        });
    }

    // US-310: Admin delete a user
    static async deleteUser(req, res, next) {
        const { id } = req.params;
        const adminId = req.authUser.id;

        if (id === adminId) return next(new AppError('You cannot delete your own account', 400));

        const user = await User.findByPk(id);
        if (!user) return next(new AppError(messages.user.notfound, 404));
        if (user.role === 'admin') return next(new AppError('Admin accounts cannot be deleted', 403));
        const moneyBlocker = await AdminController.unsettledMoneyFor(user);
        if (moneyBlocker) return next(new AppError(moneyBlocker, 409));

        await sequelize.transaction(async (transaction) => {
            if (user.role === 'organizer') {
                const ownedEvents = await Event.findAll({ where: { organizerId: id }, attributes: ['id'], transaction });
                for (const event of ownedEvents) await EventService.deleteWithRelations(event.id, { transaction });
                const staff = await User.findAll({ where: { providerOwnerId: id }, attributes: ['id'], transaction });
                const staffIds = staff.map((member) => member.id);
                if (staffIds.length) {
                    await Notification.destroy({ where: { userId: { [Op.in]: staffIds } }, transaction });
                }
                await User.destroy({ where: { providerOwnerId: id }, transaction });
            }

            if (user.role === 'organizer_supervisor') {
                const assignedEvents = await Event.findAll({
                    where: {
                        [Op.or]: [
                            { supervisorId: id },
                            { supervisorIds: { [Op.contains]: [id] } },
                        ],
                    },
                    transaction,
                });
                await Promise.all(assignedEvents.map(async (event) => {
                    event.supervisorIds = (event.supervisorIds || []).filter((userId) => userId !== id);
                    event.supervisorId = event.supervisorIds[0] || null;
                    await event.save({ transaction });
                }));
            }

            if (user.role === 'usher') {
                const hiredEvents = await Event.findAll({
                    where: { hiredTalents: { [Op.contains]: [id] } },
                    transaction,
                });
                await Promise.all(hiredEvents.map(async (event) => {
                    event.hiredTalents = (event.hiredTalents || []).filter((userId) => userId !== id);
                    event.mapPins = (event.mapPins || []).map((pin) => ({
                        ...pin, usherIds: (pin.usherIds || []).filter((userId) => userId !== id),
                    }));
                    await event.save({ transaction });
                }));
            }

            await Promise.all([
                Application.destroy({ where: { talentId: id }, transaction }),
                Attendance.destroy({ where: { talentId: id }, transaction }),
                Review.destroy({ where: { [Op.or]: [{ reviewerId: id }, { reviewedUserId: id }] }, transaction }),
                Referral.destroy({ where: { [Op.or]: [{ referrerTalentId: id }, { referredTalentId: id }] }, transaction }),
                EventActionRequest.destroy({ where: { organizerId: id }, transaction }),
                Notification.destroy({ where: { userId: id }, transaction }),
            ]);

            await Promise.all([
                EventSettlement.destroy({ where: { organizerId: id }, transaction }),
                OrganizerCard.destroy({ where: { organizerId: id }, transaction }),
                OrganizerCardEnrollment.destroy({ where: { organizerId: id }, transaction }),
            ]);
            await user.destroy({ transaction });
        });

        return res.status(200).json({
            success: true,
            message: messages.user.deleteSuccessfully,
        });
    }

    // Deleting an account must not strand money the platform holds for it or owes it.
    static async unsettledMoneyFor(user) {
        if (user.role === 'organizer') {
            const [balance, pendingWithdrawals, activeHolds] = await Promise.all([
                OrganizerCreditService.balance(user.id),
                CreditWithdrawal.count({ where: { organizerId: user.id, status: 'pending' } }),
                AbsenceHold.count({ where: { organizerId: user.id, status: { [Op.in]: ['held', 'disputed'] } } }),
            ]);
            if (balance !== 0) return `This organization has ${balance / 100} EGP of credit. Settle it before deleting the account.`;
            if (pendingWithdrawals) return 'This organization has a credit withdrawal waiting for review.';
            if (activeHolds) return 'This organization has usher pay held for an attendance dispute window.';
        }
        if (user.role === 'usher') {
            const [waiting, activeHolds] = await Promise.all([
                SettlementLine.count({ where: { talentId: user.id, payoutStatus: { [Op.in]: ['awaiting_method', 'queued', 'processing'] } } }),
                AbsenceHold.count({ where: { talentId: user.id, status: { [Op.in]: ['held', 'disputed'] } } }),
            ]);
            if (waiting) return 'This usher still has event pay waiting to be sent.';
            if (activeHolds) return 'This usher has held pay in an attendance dispute window.';
        }
        return null;
    }

    // US-300: Admin dashboard stats
    static async getDashboard(req, res, next) {
        const [
            totalUsers,
            totalTalents,
            totalOrganizers,
            totalEvents,
            openEvents,
            completedEvents,
            cancelledEvents,
            flaggedTalents,
            recentEvents,
            topRatedTalents,
        ] = await Promise.all([
            User.count(),
            User.count({ where: { role: 'usher' } }),
            User.count({ where: { role: 'organizer' } }),
            Event.count(),
            Event.count({ where: { status: 'open' } }),
            Event.count({ where: { status: 'completed' } }),
            Event.count({ where: { status: 'cancelled' } }),
            User.findAll({
                where: { role: 'usher', lateExcuseCount: { [Op.gte]: 5 } },
                attributes: SAFE_USER_ATTRS,
                order: [['lateExcuseCount', 'DESC']],
            }),
            Event.findAll({ order: [['createdAt', 'DESC']], limit: 10 }),
            User.findAll({
                where: { role: 'usher' },
                attributes: SAFE_USER_ATTRS,
                order: [['rate', 'DESC']],
                limit: 10,
            }),
        ]);

        return res.status(200).json({
            success: true,
            message: 'Dashboard data retrieved successfully',
            data: {
                stats: { totalUsers, totalTalents, totalOrganizers, totalEvents, openEvents, completedEvents, cancelledEvents },
                flaggedTalents,
                recentEvents,
                topRatedTalents,
            },
        });
    }

    static async getEventActionRequests(req, res) {
        const status = req.query.status || 'pending';
        const requests = await EventActionRequest.findAll({
            where: status === 'all' ? {} : { status },
            order: [['createdAt', 'DESC']],
        });

        const data = await Promise.all(requests.map(async (request) => ({
            ...request.toJSON(),
            event: await Event.findByPk(request.eventId),
            organizer: await User.findByPk(request.organizerId, { attributes: SAFE_USER_ATTRS }),
        })));

        return res.status(200).json({ success: true, data, count: data.length });
    }

    static async resolveEventActionRequest(req, res, next) {
        const request = await EventActionRequest.findByPk(req.params.id);
        if (!request) return next(new AppError('Event action request not found', 404));
        if (request.status !== 'pending') return next(new AppError('This request has already been resolved', 409));

        const event = await Event.findByPk(request.eventId);
        const eventTitle = event?.title || 'Event';
        if (req.body.decision === 'approved' && event) {
            if (request.requestType === 'cancel') {
                const { event: cancelled, notifyUserIds, fundingResult } = await EventService.changeStatus(event.id, 'cancelled');
                await EventService.notifyCancellation(cancelled, notifyUserIds, fundingResult);
            } else {
                await EventService.deleteWithRelations(event.id, { preserveActionRequests: true });
            }
        }

        request.status = req.body.decision;
        request.resolvedBy = req.authUser.id;
        request.resolvedAt = new Date();
        await request.save();

        await NotificationService.create({
            userId: request.organizerId,
            title: `Event request ${request.status}`,
            message: `Your request to ${request.requestType} “${eventTitle}” was ${request.status}.`,
            type: request.status === 'approved' ? 'success' : 'danger',
            link: request.requestType === 'delete' && request.status === 'approved' ? null : `/provider/events/${request.eventId}`,
        });

        return res.status(200).json({ success: true, data: request });
    }
}
