export function eventForTalent(event, accepted = false) {
    if (!event) return event;
    const data = typeof event.toJSON === 'function' ? event.toJSON() : { ...event };
    delete data.attendanceQrCreatedAt;
    delete data.attendanceQrGenerated;
    if (!accepted) {
        delete data.whatsappGroupLink;
        delete data.whatsappGroupId;
    }
    return data;
}
