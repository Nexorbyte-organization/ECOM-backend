import { Op } from 'sequelize';
import { User } from '../../db/index.js';
import { TokenService } from '../utils/token.js';
import { hashToken, setSessionCookies } from '../utils/session.js';

export const issueSession = async (user, res, previousHash, actingAsId) => {
  const refreshToken = TokenService.generateRefreshToken(user, actingAsId);
  const session = {
    refreshTokenHash: hashToken(refreshToken),
    refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  };
  const accessToken = TokenService.generateAccessToken(user, session.refreshTokenHash, actingAsId);
  if (previousHash) {
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

export const findAvailableOrganization = (id) => id
  ? User.findOne({ where: { id, role: 'organizer', isBlocked: false } })
  : null;
