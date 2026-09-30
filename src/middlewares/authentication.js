import { User } from '../../db/index.js';
import { AppError } from '../utils/appError.js';
import { TokenService } from '../utils/token.js';
import { getMissingProfileFields } from '../utils/profileCompletion.js';
import { getAccessToken, tokenHashesMatch } from '../utils/session.js';
import { findAvailableOrganization } from '../services/session.service.js';

export class AuthMiddleware {
  static isAuthenticated({ adminSession = false } = {}) {
    return async (req, res, next) => {
      try {
        const payload = TokenService.verifyPurposeToken({ token: getAccessToken(req), purpose: 'access' });
        if (!payload?.id) {
          return next(new AppError('Invalid payload', 401));
        }

        const user = await User.findByPk(payload.id);
        if (!user) {
          return next(new AppError('User Not Found', 401));
        }

        if (!payload.sessionHash || !user.refreshTokenHash
          || !(user.refreshTokenExpiresAt > new Date())
          || !tokenHashesMatch(payload.sessionHash, user.refreshTokenHash)) {
          return next(new AppError('Session expired. Please sign in again.', 401));
        }

        // BR-10: Blocked users cannot access the platform
        if (user.isBlocked) {
          return next(new AppError('Your account has been blocked', 403));
        }

        if (['organizer_member', 'organizer_supervisor'].includes(user.role)) {
          const owner = user.providerOwnerId ? await User.findByPk(user.providerOwnerId) : null;
          if (!owner || owner.role !== 'organizer') {
            return next(new AppError('Your staff account is not linked to an organizer', 403));
          }
          if (owner.isBlocked) {
            return next(new AppError('Your organization account has been blocked', 403));
          }
        }

        if (payload.actingAsId) {
          if (user.role !== 'admin') return next(new AppError('Invalid acting session', 401));
          req.adminActor = user;
          req.actingAsId = payload.actingAsId;
          if (!adminSession) {
            const organization = await findAvailableOrganization(payload.actingAsId);
            if (!organization) return next(new AppError('Organization unavailable. Refresh your session.', 401));
            req.authUser = organization;
            if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && typeof res.on === 'function') {
              res.on('finish', () => {
                // Keep the real actor visible in server logs without recording request bodies.
                // eslint-disable-next-line no-console
                console.info(JSON.stringify({ event: 'admin_organization_action', adminId: user.id,
                  organizationId: organization.id, method: req.method, path: req.path, status: res.statusCode }));
              });
            }
          } else {
            req.authUser = user;
          }
        } else {
          req.authUser = user;
        }
        next();
      } catch (error) {
        return next(new AppError('Authentication Failed', 401));
      }
    };
  }

  static isAuthorized(roles = []) {
    return async (req, res, next) => {
      const user = req.authUser;
      if (!roles.includes(user.role)) {
        return next(new AppError('Not authorized for this action', 403));
      }
      next();
    };
  }

  static requiresCompleteProfile() {
    return async (req, res, next) => {
      let profileOwner = req.authUser;
      if (['organizer_member', 'organizer_supervisor'].includes(req.authUser.role)) {
        profileOwner = await User.findByPk(req.authUser.providerOwnerId);
      }
      const missingFields = getMissingProfileFields(profileOwner);
      if (missingFields.length > 0) {
        return res.status(403).json({
          success: false,
          code: 'PROFILE_INCOMPLETE',
          message: 'Complete your profile before performing this action.',
          missingFields,
        });
      }
      next();
    };
  }
}
