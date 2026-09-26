export function canViewTalentPaymentMethods(role) {
    return ['admin', 'organizer', 'organizer_member', 'organizer_supervisor'].includes(role);
}
