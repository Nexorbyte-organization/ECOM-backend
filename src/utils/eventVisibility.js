export function eventForTalent(event, accepted = false, usherId = null) {
    if (!event) return event;
    const data = typeof event.toJSON === 'function' ? event.toJSON() : { ...event };
    // Platform fee bookkeeping is between the organization and the platform.
    delete data.noShowFeeCents;
    data.hasMapAssignment = Boolean(usherId && data.hiredTalents?.includes(usherId) && data.mapPins?.some((pin) => pin.usherIds?.includes(usherId)));
    delete data.mapPins;
    delete data.mapImage;
    if (!accepted) {
        delete data.whatsappGroupLink;
        delete data.whatsappGroupId;
    }
    return data;
}
