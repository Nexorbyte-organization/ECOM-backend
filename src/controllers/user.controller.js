import { sequelize } from "../../db/connection.js";
import { Event, User } from "../../db/index.js";
import { Op } from 'sequelize';
import { AppError } from "../utils/appError.js";
import { messages } from "../utils/constant/messages.js";
import { EmailService } from "../utils/email.js";
import { HashService } from "../utils/hashAndcompare.js";
import { HtmlTemplateService } from "../utils/htmlTemplate.js";
import { OtpService } from "../utils/otp.js";
import { TokenService } from "../utils/token.js";
import { ApiFeature } from "../utils/apiFeature.js";
import { getMissingProfileFields, isProfileComplete } from '../utils/profileCompletion.js';
import { normalizeEventCategories, normalizeLanguages, normalizeRole } from '../utils/normalization.js';
import {
    clearSessionCookies,
    getRefreshToken,
    hashToken,
    setSessionCookies,
    tokenHashesMatch,
} from '../utils/session.js';

const SAFE_USER_ATTRS = { exclude: [
    'password', 'otp', 'otpExpiry', 'otpAttempts', 'lastOtpRequest', 'otpVerified',
    'refreshTokenHash', 'refreshTokenExpiresAt',
] };

const issueSession = async (user, res, previousHash) => {
    const refreshToken = TokenService.generateRefreshToken(user);
    const session = {
        refreshTokenHash: hashToken(refreshToken),
        refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    };
    const accessToken = TokenService.generateAccessToken(user, session.refreshTokenHash);
    if (previousHash) {
        // Compare-and-swap prevents a stale refresh from replacing a newer login.
        const [updated] = await User.update(session, {
            where: {
                id: user.id,
                refreshTokenHash: previousHash,
                refreshTokenExpiresAt: { [Op.gt]: new Date() },
                isBlocked: false,
            },
        });
        if (!updated) return null;
    } else {
        await user.update(session);
    }
    setSessionCookies(res, { accessToken, refreshToken });
    return accessToken;
};

const withProfileStatus = (user) => {
    const data = typeof user?.toJSON === 'function' ? user.toJSON() : user;
    return {
        ...data,
        profileCompleted: isProfileComplete(user),
        missingProfileFields: getMissingProfileFields(user),
    };
};

export class UserController {
    // signup
    static async signup(req, res, next) {
        const { password, rate, languages, eventCategories, portfolio } = req.body;
        let { fullName, userName, email, mobileNumber, city, experience, portfolioPicture, role } = req.body;

        email = email.toLowerCase();

        const defaultName = email.split('@')[0];
        if (!fullName) fullName = '';
        if (!userName) userName = `${defaultName}_${Date.now()}`;
        if (!mobileNumber) mobileNumber = null;
        if (!city) city = null;
        if (experience === undefined || experience === null) experience = 0;

        role = normalizeRole(role);

        const normalizedLanguages = normalizeLanguages(languages || []);
        const normalizedCategories = normalizeEventCategories(eventCategories || []);
        if ((languages || []).length !== normalizedLanguages.length) {
            return next(new AppError('One or more languages are not supported', 400));
        }
        if ((eventCategories || []).length !== normalizedCategories.length) {
            return next(new AppError('One or more event categories are not supported', 400));
        }

        if (!portfolioPicture) {
            portfolioPicture = {
                secure_url: "https://res.cloudinary.com/dvz0zvpof/image/upload/v1727788484/Default_pfp.svg_v7dmtb.png",
                public_id: "default_avatar"
            };
        }

        const transaction = await sequelize.transaction();

        const duplicateChecks = [{ email }, { userName }];
        if (mobileNumber) duplicateChecks.push({ mobileNumber });
        const userExist = await User.findOne({
            where: { [Op.or]: duplicateChecks },
            attributes: ['email', 'userName', 'mobileNumber'],
            transaction
        });

        if (userExist) {
            await transaction.rollback();
            const duplicateField = userExist.email === email
                ? 'email'
                : userExist.userName === userName ? 'username' : 'mobile number';
            return next(new AppError(`A user with this ${duplicateField} already exists`, 409));
        }

        const hashedpassword = HashService.hashPassword({ password });

        const newUser = await User.create({
            fullName,
            userName,
            email,
            password: hashedpassword,
            mobileNumber,
            city,
            experience,
            portfolioPicture,
            role,
            rate: rate || 0,
            languages: normalizedLanguages,
            eventCategories: normalizedCategories,
            portfolio: portfolio || []
        }, { transaction });

        // Create token and send verification email — rollback if email fails
        const token = TokenService.generatePurposeToken({
            payload: { id: newUser.id, email },
            purpose: 'email_verification',
            expiresIn: '24h',
        });
        try {
            await EmailService.sendEmail({
                to: email,
                subject: 'Email Confirmation',
                html: HtmlTemplateService.emailConfirmation(token)
            });
        } catch {
            await transaction.rollback();
            return next(new AppError('Failed to send verification email. Please try again.', 500));
        }

        await transaction.commit();

        return res.status(201).json({
            success: true,
            message: messages.user.createSuccessfully,
            data: withProfileStatus(newUser),
        });
    }

    // login
    static async login(req, res, next) {
        const { password } = req.body;
        const email = req.body.email.toLowerCase();

        const user = await User.findOne({ where: { email } });

        if (!user) return next(new AppError(messages.user.invalidCreadintials, 401));

        const isValid = HashService.comparePassword({ password, hashPassword: user.password });

        if (!isValid) {
            return next(new AppError(messages.user.invalidCreadintials, 401));
        }

        if (!user.isEmailVerified) {
            return next(new AppError(messages.user.notverified, 401));
        }

        if (user.isBlocked) {
            return next(new AppError('Your account has been blocked. Contact an administrator for support.', 403));
        }

        const token = await issueSession(user, res);

        const safeUser = withProfileStatus(user);

        return res.status(200).json({
            success: true,
            message: messages.user.loginSuccessfully,
            role: user.role,
            frontendRole: safeUser.frontendRole,
            token,
            user: safeUser,
            data: { token, user: safeUser }
        });
    }

    // forgetPassword — OTP is hashed before storing
    static async forgetPassword(req, res, next) {
        const { email } = req.body;

        const userExist = await User.findOne({ where: { email } });

        if (!userExist) {
            return res.status(200).json({
                message: 'If an account exists for that email, a reset code has been sent.',
                success: true,
            });
        }

        const currentTime = Date.now();

        if (userExist.lastOtpRequest) {
            const lastRequestTime = new Date(userExist.lastOtpRequest).getTime();
            const timeSinceLastRequest = currentTime - lastRequestTime;

            if (timeSinceLastRequest < 30 * 1000) {
                const remainingTime = Math.ceil((30 * 1000 - timeSinceLastRequest) / 1000);
                return next(new AppError(`Please wait ${remainingTime} seconds before requesting a new OTP`, 429));
            }
        }

        const otp = OtpService.generateOTP();
        // Hash the OTP before storing — plain text OTP is only sent via email, never stored
        const hashedOtp = HashService.hashPassword({ password: otp.toString() });

        try {
            await userExist.update({
                otp: hashedOtp,
                otpExpiry: new Date(currentTime + 15 * 60 * 1000),
                otpAttempts: 0,
                lastOtpRequest: new Date(currentTime)
            });

            await EmailService.sendEmail({
                to: email,
                subject: 'Forget Password OTP',
                html: HtmlTemplateService.otpEmail(otp), // raw OTP in email
            });

            return res.status(200).json({
                message: 'If an account exists for that email, a reset code has been sent.',
                success: true
            });

        } catch {
            await userExist.update({
                otp: null,
                otpExpiry: null,
                otpAttempts: 0,
                lastOtpRequest: null
            });
            return next(new AppError('Failed to send email', 500));
        }
    }

    // verifyOtp — compares against hashed OTP; returns error if expired (no auto-resend)
    static async verifyOtp(req, res, next) {
        const { otp, email } = req.body;

        const user = await User.findOne({ where: { email } });
        if (!user) {
            return next(new AppError(messages.user.notfound, 404));
        }

        const currentTime = Date.now();
        const otpExpiryTime = user.otpExpiry ? new Date(user.otpExpiry).getTime() : 0;

        // If OTP doesn't exist or has expired — tell user to request a new one
        if (!user.otp || otpExpiryTime <= currentTime) {
            return next(new AppError('OTP has expired. Please request a new one via /forget-password.', 400));
        }

        // Compare raw OTP against stored bcrypt hash
        const isValidOtp = HashService.comparePassword({ password: otp.toString(), hashPassword: user.otp });

        if (!isValidOtp) {
            await user.increment('otpAttempts', { by: 1 });
            await user.reload();

            if (user.otpAttempts >= 3) {
                await user.update({
                    otp: null,
                    otpExpiry: null,
                    otpAttempts: 0
                });
                return next(new AppError('Maximum OTP attempts exceeded. Please request a new OTP.', 403));
            }

            return next(new AppError(`Invalid OTP. You have ${3 - user.otpAttempts} attempts left`, 401));
        }

        await user.update({
            otpAttempts: 0,
            otp: null,
            otpExpiry: null,
            otpVerified: false
        });

        const resetToken = TokenService.generatePurposeToken({
            payload: { id: user.id, email: user.email, passwordVersion: hashToken(user.password) },
            purpose: 'password_reset',
            expiresIn: '10m',
        });

        return res.status(200).json({
            message: 'OTP verified successfully',
            success: true,
            resetToken,
        });
    }

    // resetPassword
    static async resetPassword(req, res, next) {
        const { newPassword, resetToken } = req.body;
        let payload;
        try {
            payload = TokenService.verifyPurposeToken({ token: resetToken, purpose: 'password_reset' });
        } catch {
            return next(new AppError('Password reset authorization is invalid or expired.', 401));
        }

        const user = await User.findOne({ where: { id: payload.id, email: payload.email } });
        if (!user) return next(new AppError('Password reset authorization is invalid or expired.', 401));
        if (!tokenHashesMatch(payload.passwordVersion, hashToken(user.password))) {
            return next(new AppError('Password reset authorization is invalid or expired.', 401));
        }

        const hashedPassword = HashService.hashPassword({ password: newPassword });

        await user.update({
            password: hashedPassword,
            otpVerified: false,
            lastOtpRequest: null,
            refreshTokenHash: null,
            refreshTokenExpiresAt: null,
        });

        return res.status(200).json({ message: 'Password updated successfully', success: true });
    }

    static async refreshSession(req, res, next) {
        const refreshToken = getRefreshToken(req);
        let payload;
        try {
            payload = TokenService.verifyPurposeToken({ token: refreshToken, purpose: 'refresh' });
        } catch {
            clearSessionCookies(res);
            return next(new AppError('Session expired', 401));
        }

        const user = await User.findByPk(payload.id);
        const valid = user?.refreshTokenHash
            && user.refreshTokenExpiresAt > new Date()
            && tokenHashesMatch(user.refreshTokenHash, hashToken(refreshToken));
        if (!valid || user.isBlocked) {
            clearSessionCookies(res);
            return next(new AppError('Session expired', 401));
        }

        const token = await issueSession(user, res, hashToken(refreshToken));
        if (!token) {
            clearSessionCookies(res);
            return next(new AppError('Session expired', 401));
        }
        return res.status(200).json({ success: true, token, data: { token, user: withProfileStatus(user) } });
    }

    static async logout(req, res) {
        const refreshToken = getRefreshToken(req);
        try {
            const payload = TokenService.verifyPurposeToken({ token: refreshToken, purpose: 'refresh' });
            await User.update(
                { refreshTokenHash: null, refreshTokenExpiresAt: null },
                { where: { id: payload.id, refreshTokenHash: hashToken(refreshToken) } },
            );
        } catch {
            // Clearing cookies is idempotent even when the session has already expired.
        }
        clearSessionCookies(res);
        return res.status(200).json({ success: true, message: 'Signed out successfully' });
    }

    static async getReferralInvite(req, res, next) {
        let payload;
        try {
            payload = TokenService.verifyPurposeToken({ token: req.params.token, purpose: 'referral_invite' });
        } catch {
            return next(new AppError('Referral invite is invalid or expired', 404));
        }
        const [event, referrer] = await Promise.all([
            Event.findByPk(payload.eventId),
            User.findOne({ where: { id: payload.referrerTalentId, role: 'usher', isBlocked: false } }),
        ]);
        if (!event || !referrer || event.status !== 'open' || new Date() > new Date(event.applicationDeadline)) {
            return next(new AppError('Referral invite is no longer available', 410));
        }
        return res.status(200).json({
            success: true,
            data: {
                event: {
                    _id: event.id,
                    title: event.title,
                    category: event.category,
                    eventDate: event.eventDate,
                    applicationDeadline: event.applicationDeadline,
                    location: event.location,
                },
                referrer: {
                    _id: referrer.id,
                    fullName: referrer.fullName,
                    photo: referrer.portfolioPicture?.secure_url || '',
                    city: referrer.city || '',
                },
            },
        });
    }

    // getAllUsers — with pagination via ApiFeature
    static async getAllUsers(req, res, next) {
        const feature = new ApiFeature(req.query).pagination().sort().build();
        const page = parseInt(req.query.page) || 1;

        const { count, rows: users } = await User.findAndCountAll({
            attributes: SAFE_USER_ATTRS,
            order: feature.order.length ? feature.order : [['createdAt', 'DESC']],
            limit: feature.limit,
            offset: feature.offset,
        });

        return res.status(200).json({
            success: true,
            message: 'Users fetched successfully',
            ...ApiFeature.paginateResponse(users, page, feature.limit, count),
        });
    }

    // getMyProfile — returns the authenticated user's own profile (any role)
    static async getMyProfile(req, res, next) {
        const userId = req.authUser.id;
        const user = await User.findByPk(userId, {
            attributes: SAFE_USER_ATTRS,
        });
        if (!user) {
            return next(new AppError(messages.user.notfound, 404));
        }
        return res.status(200).json({
            success: true,
            message: 'Profile fetched successfully',
            data: withProfileStatus(user),
        });
    }
}
