const ROOT = 'ECOM';

export const UploadFolders = {
  profilePicture: (userId) => `${ROOT}/ushers/${userId}/profile-picture`,
  portfolio: (userId) => `${ROOT}/ushers/${userId}/portfolio`,
  organizationLogo: (userId) => `${ROOT}/organization/${userId}/logo`,
  eventPhoto: (organizerId, eventId) => `${ROOT}/organization/${organizerId}/events/${eventId}/photos`,
  eventMap: (organizerId, eventId) => `${ROOT}/organization/${organizerId}/events/${eventId}/map`,
};
