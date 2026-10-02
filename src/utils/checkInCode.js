import { createHmac, timingSafeEqual } from 'crypto';

// Rotating check-in codes. A staff phone shows a QR and a 6-digit code that change every
// CODE_STEP_SECONDS, so a photo of the screen stops working almost immediately. Codes from the
// previous ACCEPTED_PAST_STEPS steps are still accepted to cover the time to scan and submit.
export const CODE_STEP_SECONDS = 30;
export const ACCEPTED_PAST_STEPS = 2;
// The usher's phone must be this close to the staff phone (or to the venue pin).
export const CHECK_IN_RADIUS_METERS = 200;
// Locations less precise than this cannot prove anything.
export const MAX_LOCATION_ACCURACY_METERS = 500;
// A staff phone that stopped reporting its location this long ago no longer counts as present.
export const POINT_LOCATION_FRESH_MS = 3 * 60 * 1000;
// "I'm here" without a code accepts staff phones that reported recently, since the usher may not
// be able to reach the screen.
export const POINT_LOCATION_RECENT_MS = 15 * 60 * 1000;

export const codeStep = (now = Date.now()) => Math.floor(now / (CODE_STEP_SECONDS * 1000));

const signature = (secret, pointId, step) => createHmac('sha256', secret)
    .update(`${pointId}.${step}`)
    .digest();

export const qrTokenFor = (point, step = codeStep()) => {
    const sig = signature(point.secret, point.id, step).subarray(0, 16).toString('base64url');
    return `${point.id}.${step}.${sig}`;
};

export const numericCodeFor = (point, step = codeStep()) => {
    const value = signature(point.secret, point.id, step).readUInt32BE(0) % 1_000_000;
    return String(value).padStart(6, '0');
};

export const parseQrToken = (token = '') => {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const [pointId, stepValue, sig] = parts;
    const step = Number(stepValue);
    if (!pointId || !Number.isSafeInteger(step) || !sig) return null;
    return { pointId, step, sig };
};

const isAcceptedStep = (step, now) => {
    const current = codeStep(now);
    return step <= current && step >= current - ACCEPTED_PAST_STEPS;
};

const sameText = (left, right) => {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    return a.length === b.length && timingSafeEqual(a, b);
};

export const qrTokenMatchesPoint = (token, point, now = Date.now()) => {
    const parsed = parseQrToken(token);
    if (!parsed || parsed.pointId !== point.id || !isAcceptedStep(parsed.step, now)) return false;
    return sameText(qrTokenFor(point, parsed.step), token);
};

export const numericCodeMatchesPoint = (code, point, now = Date.now()) => {
    const current = codeStep(now);
    for (let step = current; step >= current - ACCEPTED_PAST_STEPS; step -= 1) {
        if (sameText(numericCodeFor(point, step), code)) return true;
    }
    return false;
};

export const codeExpiresAt = (now = Date.now()) => new Date((codeStep(now) + 1) * CODE_STEP_SECONDS * 1000);

// Great-circle distance in meters.
export const distanceMeters = (from, to) => {
    const radians = (degrees) => (degrees * Math.PI) / 180;
    const earthRadius = 6371000;
    const dLat = radians(to.latitude - from.latitude);
    const dLng = radians(to.longitude - from.longitude);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(dLng / 2) ** 2;
    return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(a)));
};

export const isValidCoordinate = (location) => Number.isFinite(location?.latitude)
    && Number.isFinite(location?.longitude)
    && Math.abs(location.latitude) <= 90
    && Math.abs(location.longitude) <= 180;

export const isWithinRadius = (from, to, radius = CHECK_IN_RADIUS_METERS) => (
    isValidCoordinate(from) && isValidCoordinate(to) && distanceMeters(from, to) <= radius
);

export const pointLocation = (point) => ({ latitude: point.latitude, longitude: point.longitude });

export const pointReportedSince = (point, maxAgeMs, now = Date.now()) => Boolean(
    point?.active
    && point.locationUpdatedAt
    && now - new Date(point.locationUpdatedAt).getTime() <= maxAgeMs
    && isValidCoordinate(pointLocation(point)),
);
