import { Op } from 'sequelize';
import { User, Event, Notification } from '../../db/index.js';
import { AppError } from '../utils/appError.js';
import { messages } from '../utils/constant/messages.js';
import { HashService } from '../utils/hashAndcompare.js';
import { normalizeRole } from '../utils/normalization.js';
import { NotificationService } from '../services/notification.service.js';

const SAFE_STAFF_ATTRS = { exclude: ['password', 'otp', 'otpExpiry', 'otpAttempts', 'lastOtpRequest', 'otpVerified'] };
const getOrganizerId = (user) => user.role === 'organizer' ? user.id : user.providerOwnerId;

const removeSupervisorAssignments = async (organizerId, supervisorId) => {
    const assignedEvents = await Event.findAll({
        where: {
            organizerId,
            [Op.or]: [
                { supervisorId },
                { supervisorIds: { [Op.contains]: [supervisorId] } },
            ],
        },
    });

    await Promise.all(assignedEvents.map(async (event) => {
        event.supervisorIds = (event.supervisorIds || []).filter((id) => id !== supervisorId);
        event.supervisorId = event.supervisorIds[0] || null;
        await event.save();
    }));
};

export class StaffController {

    // GET /organizer/staff — list all staff members of this organizer's company
    static async getStaffMembers(req, res, next) {
        const organizerId = getOrganizerId(req.authUser);

        const members = await User.findAll({
            where: {
                providerOwnerId: organizerId,
                role: { [Op.in]: ['organizer_member', 'organizer_supervisor'] },
            },
            attributes: SAFE_STAFF_ATTRS,
            order: [['createdAt', 'DESC']],
        });

        return res.status(200).json({
            success: true,
            message: messages.staff.getsuccessfully,
            data: members,
            count: members.length,
        });
    }

    // POST /organizer/staff — invite a new staff member
    static async inviteStaffMember(req, res, next) {
        const organizerId = req.authUser.id;
        const { fullName, email, password, role } = req.body;

        // Verify organizer exists
        const organizer = await User.findByPk(organizerId);
        if (!organizer) return next(new AppError(messages.user.notfound, 404));

        // Check email not already in use
        const existing = await User.findOne({ where: { email: email.toLowerCase() } });
        if (existing) return next(new AppError('A user with this email already exists', 400));

        const hashedPassword = HashService.hashPassword({ password: password || 'member123' });

        const member = await User.create({
            fullName,
            userName: `${fullName.replace(/\s+/g, '_').toLowerCase()}_${Date.now()}`,
            email: email.toLowerCase(),
            password: hashedPassword,
            mobileNumber: null,
            city: organizer.city || null,
            experience: 0,
            role: normalizeRole(role || 'organizer_member'),
            rate: 0,
            isEmailVerified: true,    // staff are pre-verified by organizer
            isVerified: false,
            providerOwnerId: organizerId,
        });

        await NotificationService.create({
            userId: member.id,
            title: 'Organization staff account created',
            message: `You were invited to join ${organizer.fullName} on OO-Ushers.`,
            type: 'success',
            link: '/provider/dashboard',
            sendEmail: false,
        });

        const safeData = member.toJSON();

        return res.status(201).json({
            success: true,
            message: messages.staff.createSuccessfully,
            data: safeData,
        });
    }

    // PUT /organizer/staff/:id — update staff member fields
    static async updateStaffMember(req, res, next) {
        const organizerId = req.authUser.id;
        const { id } = req.params;
        const { fullName, email, password, role } = req.body;

        const member = await User.findOne({
            where: { id, providerOwnerId: organizerId },
        });
        if (!member) return next(new AppError(messages.staff.notfound, 404));

        if (email !== undefined) {
            const emailInUse = await User.findOne({ where: { email: email.toLowerCase(), id: { [Op.ne]: id } } });
            if (emailInUse) return next(new AppError('Email already in use', 400));
            member.email = email.toLowerCase();
        }
        if (fullName !== undefined) member.fullName = fullName;
        if (password !== undefined) member.password = HashService.hashPassword({ password });
        if (role !== undefined) {
            const normalizedRole = normalizeRole(role);
            if (!['organizer_member', 'organizer_supervisor'].includes(normalizedRole)) {
                return next(new AppError('Invalid staff role', 400));
            }
            if (member.role === 'organizer_supervisor' && normalizedRole !== 'organizer_supervisor') {
                await removeSupervisorAssignments(organizerId, member.id);
            }
            member.role = normalizedRole;
        }

        await member.save();

        const safeData = member.toJSON();
        return res.status(200).json({
            success: true,
            message: messages.staff.updateSuccessfully,
            data: safeData,
        });
    }

    // PATCH /organizer/staff/:id/block — block a staff member
    static async blockStaffMember(req, res, next) {
        const organizerId = req.authUser.id;
        const { id } = req.params;

        const member = await User.findOne({ where: { id, providerOwnerId: organizerId } });
        if (!member) return next(new AppError(messages.staff.notfound, 404));

        member.isBlocked = true;
        await member.save();
        await removeSupervisorAssignments(organizerId, member.id);

        return res.status(200).json({
            success: true,
            message: 'Staff member blocked successfully',
        });
    }

    // PATCH /organizer/staff/:id/unblock — unblock a staff member
    static async unblockStaffMember(req, res, next) {
        const organizerId = req.authUser.id;
        const { id } = req.params;

        const member = await User.findOne({ where: { id, providerOwnerId: organizerId } });
        if (!member) return next(new AppError(messages.staff.notfound, 404));

        member.isBlocked = false;
        await member.save();

        return res.status(200).json({
            success: true,
            message: 'Staff member unblocked successfully',
        });
    }

    // DELETE /organizer/staff/:id — remove staff member
    static async removeStaffMember(req, res, next) {
        const organizerId = req.authUser.id;
        const { id } = req.params;

        const member = await User.findOne({ where: { id, providerOwnerId: organizerId } });
        if (!member) return next(new AppError(messages.staff.notfound, 404));

        await removeSupervisorAssignments(organizerId, member.id);
        await Notification.destroy({ where: { userId: member.id } });
        await member.destroy();

        return res.status(200).json({
            success: true,
            message: messages.staff.deleteSuccessfully,
        });
    }
}
