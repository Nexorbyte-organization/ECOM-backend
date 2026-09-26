const DEFAULT_AVATAR_ID = 'default_avatar';

const hasText = (value) => typeof value === 'string' && value.trim().length > 0 && value.trim() !== 'N/A';
const hasUploadedImage = (image) => {
  if (!image) return false;
  if (typeof image === 'string') return hasText(image);
  return hasText(image.secure_url) && image.public_id !== DEFAULT_AVATAR_ID;
};

export const getMissingProfileFields = (user) => {
  if (!user) return ['profile'];

  if (user.role === 'usher') {
    return [
      !hasText(user.fullName) && 'fullName',
      !hasUploadedImage(user.portfolioPicture) && 'portfolioPicture',
      !hasText(user.city) && 'city',
      !hasText(user.mobileNumber) && 'mobileNumber',
      !hasText(user.education) && 'education',
      (!Array.isArray(user.workCities) || user.workCities.length === 0) && 'workCities',
      (!Array.isArray(user.languages) || user.languages.length === 0) && 'languages',
      (!Array.isArray(user.eventCategories) || user.eventCategories.length === 0) && 'eventCategories',
      (!Array.isArray(user.paymentMethods) || user.paymentMethods.length === 0) && 'paymentMethods',
    ].filter(Boolean);
  }

  if (user.role === 'organizer') {
    return [
      !hasText(user.fullName) && 'companyName',
      !hasUploadedImage(user.portfolioPicture) && 'logo',
      !hasText(user.organizationInfo?.description) && 'description',
      !hasText(user.city) && 'location',
      !hasText(user.mobileNumber) && 'phone',
    ].filter(Boolean);
  }

  return [];
};

export const isProfileComplete = (user) => getMissingProfileFields(user).length === 0;
