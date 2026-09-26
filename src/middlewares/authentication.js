import { User } from '../../db/index.js';
import { AppError } from '../utils/appError.js';
import { TokenService } from '../utils/token.js';
import { getMissingProfileFields } from '../utils/profileCompletion.js';
import { getAccessToken } from '../utils/session.js';

export class AuthMiddleware {
  static isAuthenticated() {
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

        req.authUser = user;
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
