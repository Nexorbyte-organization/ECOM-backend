import { createHash, timingSafeEqual } from 'crypto';

const ACCESS_COOKIE = 'oo_access';
const REFRESH_COOKIE = 'oo_refresh';
const isProduction = process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'prod';

export const parseCookies = (header = '') => Object.fromEntries(
  header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return [part, ''];
    return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
  }),
);

const cookie = (name, value, { maxAge = 0, httpOnly = true } = {}) => {
  const secure = isProduction ? '; Secure' : '';
  const age = maxAge > 0 ? `; Max-Age=${maxAge}` : '; Max-Age=0';
  const httpOnlyFlag = httpOnly ? '; HttpOnly' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax${secure}${httpOnlyFlag}${age}`;
};

export const setSessionCookies = (res, { accessToken, refreshToken }) => {
  res.setHeader('Set-Cookie', [
    cookie(ACCESS_COOKIE, accessToken, { maxAge: 15 * 60 }),
    cookie(REFRESH_COOKIE, refreshToken, { maxAge: 30 * 24 * 60 * 60 }),
  ]);
};

export const clearSessionCookies = (res) => {
  res.setHeader('Set-Cookie', [cookie(ACCESS_COOKIE, ''), cookie(REFRESH_COOKIE, '')]);
};

export const getAccessToken = (req) => {
  const authorization = req.headers.authorization;
  if (authorization) return authorization.startsWith('Bearer ') ? authorization.slice(7) : authorization;
  return req.headers.token || parseCookies(req.headers.cookie)[ACCESS_COOKIE] || '';
};

export const getRefreshToken = (req) => parseCookies(req.headers.cookie)[REFRESH_COOKIE] || '';
export const hashToken = (token) => createHash('sha256').update(token).digest('hex');
export const tokenHashesMatch = (left = '', right = '') => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};
