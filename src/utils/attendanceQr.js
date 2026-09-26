import { createHmac, timingSafeEqual } from 'crypto';

const signatureFor = (payload) => createHmac('sha256', process.env.JWT_SECRET_KEY)
    .update(payload)
    .digest('base64url');

export const createAttendanceQrToken = (event) => {
    const generatedAt = new Date(event.attendanceQrCreatedAt).getTime();
    if (!event?.id || !Number.isFinite(generatedAt)) {
        throw new Error('Event attendance QR has not been generated');
    }

    const payload = `${event.id}.${generatedAt}`;
    return `${payload}.${signatureFor(payload)}`;
};

export const parseAttendanceQrToken = (token = '') => {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [eventId, generatedAtValue, providedSignature] = parts;
    const generatedAt = Number(generatedAtValue);
    if (!eventId || !Number.isFinite(generatedAt) || !providedSignature) return null;

    const payload = `${eventId}.${generatedAtValue}`;
    const expectedSignature = signatureFor(payload);
    const providedBuffer = Buffer.from(providedSignature);
    const expectedBuffer = Buffer.from(expectedSignature);
    if (providedBuffer.length !== expectedBuffer.length
        || !timingSafeEqual(providedBuffer, expectedBuffer)) return null;

    return { eventId, generatedAt };
};

export const attendanceQrMatchesEvent = (token, event) => {
    const parsed = parseAttendanceQrToken(token);
    if (!parsed || parsed.eventId !== event?.id || !event.attendanceQrCreatedAt) return false;
    return parsed.generatedAt === new Date(event.attendanceQrCreatedAt).getTime();
};

export const attendanceQrResponse = (event) => {
    const token = createAttendanceQrToken(event);
    const configuredFrontend = (process.env.FRONTEND_URL || '').split(',')[0].trim();
    const frontendUrl = configuredFrontend || 'http://localhost:3001';
    const checkInUrl = new URL(`/talent/check-in/${encodeURIComponent(token)}`, frontendUrl).toString();
    return {
        checkInUrl,
        generatedAt: event.attendanceQrCreatedAt,
    };
};
