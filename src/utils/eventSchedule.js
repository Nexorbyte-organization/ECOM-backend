// Event dates are stored as calendar days (midnight UTC from a YYYY-MM-DD form value) and
// start/end times as local HH:mm strings. These helpers turn them into real instants in the
// platform's time zone so lifecycle rules do not depend on the server's time zone.

export const DEFAULT_TIMEZONE = 'Africa/Cairo';
export const CHECK_IN_OPENS_BEFORE_START_MS = 2 * 60 * 60 * 1000;
export const CHECK_IN_CLOSES_AFTER_END_MS = 2 * 60 * 60 * 1000;
export const LATE_AFTER_START_MS = 15 * 60 * 1000;

export const platformTimeZone = () => process.env.APP_TIMEZONE?.trim() || DEFAULT_TIMEZONE;

const parseTime = (value) => {
    const match = /^(\d{1,2}):(\d{2})/.exec(String(value || '').trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return { hours, minutes };
};

// Milliseconds the zone is ahead of UTC at the given instant.
const zoneOffsetMs = (instant, timeZone) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(instant).map(({ type, value }) => [type, value]));
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return asUtc - (instant.getTime() - instant.getUTCMilliseconds());
};

export const zonedTimeToUtc = (year, monthIndex, day, hours, minutes, timeZone = platformTimeZone()) => {
    const wallClock = Date.UTC(year, monthIndex, day, hours, minutes);
    let instant = new Date(wallClock - zoneOffsetMs(new Date(wallClock), timeZone));
    // A second pass settles instants near a daylight-saving change.
    instant = new Date(wallClock - zoneOffsetMs(instant, timeZone));
    return instant;
};

const eventDay = (event) => {
    const date = new Date(event.eventDate);
    if (Number.isNaN(date.getTime())) return null;
    return { year: date.getUTCFullYear(), monthIndex: date.getUTCMonth(), day: date.getUTCDate() };
};

export const eventDayRange = (eventDate) => {
    const date = new Date(eventDate);
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
};

export const eventStartsAt = (event, timeZone = platformTimeZone()) => {
    const day = eventDay(event);
    if (!day) return null;
    const time = parseTime(event.startTime) || { hours: 0, minutes: 0 };
    return zonedTimeToUtc(day.year, day.monthIndex, day.day, time.hours, time.minutes, timeZone);
};

export const eventEndsAt = (event, timeZone = platformTimeZone()) => {
    const day = eventDay(event);
    if (!day) return null;
    const start = eventStartsAt(event, timeZone);
    const time = parseTime(event.endTime) || { hours: 23, minutes: 59 };
    let end = zonedTimeToUtc(day.year, day.monthIndex, day.day, time.hours, time.minutes, timeZone);
    if (end <= start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000); // overnight event
    return end;
};

export const hasEventStarted = (event, now = new Date()) => now >= eventStartsAt(event);
export const hasEventEnded = (event, now = new Date()) => now >= eventEndsAt(event);

export const checkInWindow = (event) => ({
    opensAt: new Date(eventStartsAt(event).getTime() - CHECK_IN_OPENS_BEFORE_START_MS),
    closesAt: new Date(eventEndsAt(event).getTime() + CHECK_IN_CLOSES_AFTER_END_MS),
});

// 'early', 'present', 'late', or 'closed' for a check-in at `now`.
export const checkInStatusAt = (event, now = new Date()) => {
    const { opensAt, closesAt } = checkInWindow(event);
    if (now < opensAt) return 'early';
    if (now > closesAt) return 'closed';
    return now > new Date(eventStartsAt(event).getTime() + LATE_AFTER_START_MS) ? 'late' : 'present';
};
