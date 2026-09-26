import { eventCategories, language, roles } from './constant/enums.js';

const normalizeKey = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[()]/g, '')
  .replace(/&/g, 'and')
  .replace(/[\s-]+/g, '_');

const roleAliases = {
  talent: roles.USHER,
  provider: roles.ORGANIZER,
  provider_member: roles.ORGANIZER_MEMBER,
  provider_supervisor: roles.ORGANIZER_SUPERVISOR,
};

const categoryAliases = {
  sports_event: eventCategories.SPORT_EVENT,
  sport_event: eventCategories.SPORT_EVENT,
};

const languageAliases = {
  chinese_mandarin: language.CHINESE_MANDARIN,
};

export const normalizeRole = (value) => {
  const key = normalizeKey(value);
  return roleAliases[key] || (Object.values(roles).includes(key) ? key : null);
};

export const normalizeEventCategory = (value) => {
  const key = normalizeKey(value);
  const normalized = categoryAliases[key] || key;
  return Object.values(eventCategories).includes(normalized) ? normalized : null;
};

export const normalizeEventCategories = (values = []) => [...new Set(values
  .map(normalizeEventCategory)
  .filter(Boolean))];

export const normalizeLanguage = (value) => {
  const key = normalizeKey(value);
  const normalized = languageAliases[key] || key;
  return Object.values(language).includes(normalized) ? normalized : null;
};

export const normalizeLanguages = (values = []) => [...new Set(values
  .map(normalizeLanguage)
  .filter(Boolean))];
