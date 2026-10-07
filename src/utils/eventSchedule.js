// Event dates are stored as calendar days (midnight UTC from a YYYY-MM-DD form value) and
// start/end times as local HH:mm strings. These helpers turn them into real instants in the
// platform's time zone so lifecycle rules do not depend on the server's time zone.
//
// An event runs on one or more days (`days`, each with its own hours). Events created before
// multi-day support have no `days` and run on `eventDate` from `startTime` to `endTime`.

export const DEFAULT_TIMEZONE = 'Africa/Cairo';
export const CHECK_IN_OPENS_BEFORE_START_MS = 2 * 60 * 60 * 1000;
export const CHECK_IN_CLOSES_AFTER_END_MS = 2 * 60 * 60 * 1000;
export const LATE_AFTER_START_MS = 15 * 60 * 1000;
// A multi-day event runs on at most this many days, all within this many calendar days.
export const MAX_EVENT_DAYS = 14;
export const MAX_EVENT_SPAN_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

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

// The YYYY-MM-DD calendar day of a stored date or form value, or null.
export const toDateKey = (value) => {
    if (typeof value === 'string' && DATE_KEY.test(value)) return value;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

const dateKeyToDate = (key) => new Date(`${key}T00:00:00.000Z`);

// The days an event runs, in date order: [{ date: 'YYYY-MM-DD', startTime, endTime }].
export const eventDays = (event) => {
    if (Array.isArray(event?.days) && event.days.length) {
        return event.days
            .map((day) => ({ date: toDateKey(day.date), startTime: day.startTime, endTime: day.endTime }))
            .filter((day) => day.date)
            .sort((a, b) => a.date.localeCompare(b.date));
    }
    const date = toDateKey(event?.eventDate);
    return date ? [{ date, startTime: event.startTime, endTime: event.endTime }] : [];
};

export const eventDayCount = (event) => Math.max(1, eventDays(event).length);

// Validates submitted days and returns them sorted, or an error message.
export const normalizeEventDays = (input) => {
    if (!Array.isArray(input) || !input.length) return { error: 'Add at least one event day' };
    if (input.length > MAX_EVENT_DAYS) return { error: `An event can run on at most ${MAX_EVENT_DAYS} days` };
    const days = input.map((day) => ({
        date: toDateKey(day?.date),
        startTime: String(day?.startTime ?? '').trim(),
        endTime: String(day?.endTime ?? '').trim(),
    })).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    for (const day of days) {
        if (!day.date) return { error: 'Each event day needs a valid date' };
        if (!TIME.test(day.startTime) || !TIME.test(day.endTime)) return { error: `Enter start and end times for ${day.date}` };
        if (day.startTime >= day.endTime) return { error: `End time must be after start time on ${day.date}` };
    }
    if (new Set(days.map((day) => day.date)).size !== days.length) return { error: 'Each event day must be a different date' };
    const span = (dateKeyToDate(days.at(-1).date) - dateKeyToDate(days[0].date)) / DAY_MS + 1;
    if (span > MAX_EVENT_SPAN_DAYS) return { error: `All event days must fall within ${MAX_EVENT_SPAN_DAYS} days` };
    return { days };
};

// Stored columns derived from the days. eventDate/startTime/endTime keep the first day so
// date-ordered queries and older clients keep working; endDate is the last day.
export const scheduleFromDays = (days) => ({
    days,
    eventDate: dateKeyToDate(days[0].date),
    startTime: days[0].startTime,
    endTime: days[0].endTime,
    endDate: dateKeyToDate(days.at(-1).date),
});

export const eventDayRange = (eventDate) => {
    const date = new Date(eventDate);
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    return { start, end: new Date(start.getTime() + DAY_MS) };
};

export const dayStartsAt = (day, timeZone = platformTimeZone()) => {
    if (!day?.date) return null;
    const [year, month, date] = day.date.split('-').map(Number);
    const time = parseTime(day.startTime) || { hours: 0, minutes: 0 };
    return zonedTimeToUtc(year, month - 1, date, time.hours, time.minutes, timeZone);
};

export const dayEndsAt = (day, timeZone = platformTimeZone()) => {
    if (!day?.date) return null;
    const [year, month, date] = day.date.split('-').map(Number);
    const start = dayStartsAt(day, timeZone);
    const time = parseTime(day.endTime) || { hours: 23, minutes: 59 };
    let end = zonedTimeToUtc(year, month - 1, date, time.hours, time.minutes, timeZone);
    if (end <= start) end = new Date(end.getTime() + DAY_MS); // overnight
    return end;
};

export const eventStartsAt = (event, timeZone = platformTimeZone()) => dayStartsAt(eventDays(event)[0], timeZone);
export const eventEndsAt = (event, timeZone = platformTimeZone()) => dayEndsAt(eventDays(event).at(-1), timeZone);

export const hasEventStarted = (event, now = new Date()) => now >= eventStartsAt(event);
export const hasEventEnded = (event, now = new Date()) => now >= eventEndsAt(event);

export const dayCheckInWindow = (day) => ({
    opensAt: new Date(dayStartsAt(day).getTime() - CHECK_IN_OPENS_BEFORE_START_MS),
    closesAt: new Date(dayEndsAt(day).getTime() + CHECK_IN_CLOSES_AFTER_END_MS),
});

// With a day index, that day's window; otherwise from the first day's opening to the last
// day's close.
export const checkInWindow = (event, dayIndex = null) => {
    const days = eventDays(event);
    if (dayIndex !== null) return dayCheckInWindow(days[dayIndex]);
    return { opensAt: dayCheckInWindow(days[0]).opensAt, closesAt: dayCheckInWindow(days.at(-1)).closesAt };
};

// The day a check-in at `now` belongs to and its status: 'early' (before that day's window),
// 'present', 'late', or 'closed' (after the last day's window). When two windows overlap, a day
// that has not ended yet wins over one that has.
export const checkInDayAt = (event, now = new Date()) => {
    const days = eventDays(event).map((day, dayIndex) => ({ day, dayIndex, ...dayCheckInWindow(day) }));
    const open = days.filter((entry) => now >= entry.opensAt && now <= entry.closesAt);
    const current = open.find((entry) => now < dayEndsAt(entry.day)) || open.at(-1);
    if (current) {
        const late = now > new Date(dayStartsAt(current.day).getTime() + LATE_AFTER_START_MS);
        return { ...current, status: late ? 'late' : 'present' };
    }
    const next = days.find((entry) => now < entry.opensAt);
    if (next) return { ...next, status: 'early' };
    return { ...days.at(-1), status: 'closed' };
};

// 'early', 'present', 'late', or 'closed' for a check-in at `now`.
export const checkInStatusAt = (event, now = new Date()) => checkInDayAt(event, now).status;

// Indexes of the days whose check-in window has closed.
export const closedCheckInDays = (event, now = new Date()) => eventDays(event)
    .map((day, dayIndex) => ({ dayIndex, closesAt: dayCheckInWindow(day).closesAt }))
    .filter(({ closesAt }) => now > closesAt)
    .map(({ dayIndex }) => dayIndex);
