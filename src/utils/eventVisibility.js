export function eventForTalent(event, accepted = false, usherId = null) {
    if (!event) return event;
    const data = typeof event.toJSON === 'function' ? event.toJSON() : { ...event };
    delete data.attendanceQrCreatedAt;
    delete data.attendanceQrGenerated;
    data.hasMapAssignment = Boolean(usherId && data.hiredTalents?.includes(usherId) && data.mapPins?.some((pin) => pin.usherIds?.includes(usherId)));
    delete data.mapPins;
    delete data.mapImage;
    if (!accepted) {
        delete data.whatsappGroupLink;
        delete data.whatsappGroupId;
    }
    return data;
}
