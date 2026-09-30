import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

export class TokenService {
  static generateToken({
    payload = {},
    secretKey = process.env.JWT_SECRET_KEY,
    expiresIn = '15m',
  }) {
    return jwt.sign(payload, secretKey, { expiresIn });
  }

  static verifyToken({ token = '', secretKey = process.env.JWT_SECRET_KEY }) {
    return jwt.verify(token, secretKey);
  }

  static generateAccessToken(user, sessionHash, actingAsId) {
    return this.generateToken({
      payload: { id: user.id, email: user.email, role: user.role, purpose: 'access', sessionHash,
        ...(actingAsId ? { actingAsId } : {}) },
      expiresIn: '15m',
    });
  }

  static generateRefreshToken(user, actingAsId) {
    return this.generateToken({
      payload: { id: user.id, purpose: 'refresh', sessionId: randomUUID(),
        ...(actingAsId ? { actingAsId } : {}) },
      expiresIn: '30d',
    });
  }

  static generatePurposeToken({ payload = {}, purpose, expiresIn }) {
    return this.generateToken({ payload: { ...payload, purpose }, expiresIn });
  }

  static verifyPurposeToken({ token = '', purpose }) {
    const payload = this.verifyToken({ token });
    if (payload?.purpose !== purpose) throw new Error('Invalid token purpose');
    return payload;
  }
}
