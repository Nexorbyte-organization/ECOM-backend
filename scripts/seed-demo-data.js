/* eslint-disable no-console */
import dotenv from 'dotenv';
import path from 'path';
import { pathToFileURL } from 'url';
import { Op } from 'sequelize';
import { sequelize } from '../db/connection.js';
import {
  Application,
  Attendance,
  Event,
  EventActionRequest,
  EventSettlement,
  Notification,
  OrganizerCard,
  Referral,
  Review,
  SettlementLine,
  User,
} from '../db/index.js';
import { HashService } from '../src/utils/hashAndcompare.js';
import { language, roles, status } from '../src/utils/constant/enums.js';

dotenv.config({ path: path.resolve('./.env') });

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD;

const adminData = {
  fullName: 'OO Admin',
  userName: 'oo_admin',
  email: ADMIN_EMAIL,
  role: roles.ADMIN,
  mobileNumber: '+201000000001',
  city: 'Cairo',
  experience: 0,
  rate: 0,
  languages: [language.ARABIC, language.ENGLISH],
  eventCategories: [],
};

const legacyDemoEmails = [
  'admin@usher.com',
  'ahmed@talent.com',
  'nour@talent.com',
  'omar@talent.com',
  'events@pyramidevents.com',
  'info@nilevenue.com',
];

const legacyDemoUserNames = [
  'oo_demo_admin',
  'demo_ahmed_hassan',
  'demo_nour_eldin',
  'demo_omar_farouk',
  'demo_pyramid_events',
  'demo_nile_venue',
];

const destroyWhere = (model, where, transaction) => model.destroy({ where, transaction });

const removeLegacyDemoData = async (transaction) => {
  const legacyUsers = await User.findAll({
    where: {
      [Op.or]: [
        { email: { [Op.in]: legacyDemoEmails } },
        { userName: { [Op.in]: legacyDemoUserNames } },
      ],
      email: { [Op.ne]: ADMIN_EMAIL },
    },
    attributes: ['id'],
    transaction,
  });
  const legacyUserIds = legacyUsers.map(({ id }) => id);

  if (!legacyUserIds.length) return { usersRemoved: 0, eventsRemoved: 0 };

  const demoEvents = await Event.findAll({
    where: { organizerId: { [Op.in]: legacyUserIds } },
    attributes: ['id'],
    transaction,
  });
  const demoEventIds = demoEvents.map(({ id }) => id);

  const userReference = { [Op.in]: legacyUserIds };
  const eventReference = { [Op.in]: demoEventIds };
  const eventOrUser = (userFields) => ({
    [Op.or]: [
      ...(demoEventIds.length ? [{ eventId: eventReference }] : []),
      ...userFields.map((field) => ({ [field]: userReference })),
    ],
  });

  const settlements = await EventSettlement.findAll({
    where: eventOrUser(['organizerId']),
    attributes: ['id'],
    transaction,
  });
  const settlementIds = settlements.map(({ id }) => id);

  await destroyWhere(SettlementLine, {
    [Op.or]: [
      ...(settlementIds.length ? [{ settlementId: { [Op.in]: settlementIds } }] : []),
      ...(demoEventIds.length ? [{ eventId: eventReference }] : []),
      { talentId: userReference },
    ],
  }, transaction);
  await destroyWhere(EventSettlement, eventOrUser(['organizerId']), transaction);
  await destroyWhere(Attendance, eventOrUser(['talentId']), transaction);
  await destroyWhere(Review, eventOrUser(['reviewerId', 'reviewedUserId']), transaction);
  await destroyWhere(Referral, eventOrUser(['referrerTalentId', 'referredTalentId']), transaction);
  await destroyWhere(Application, eventOrUser(['talentId', 'referredBy']), transaction);
  await destroyWhere(EventActionRequest, eventOrUser(['organizerId', 'resolvedBy']), transaction);
  await destroyWhere(Notification, { userId: userReference }, transaction);
  await destroyWhere(OrganizerCard, { organizerId: userReference }, transaction);

  const linkedEvents = await Event.findAll({
    where: {
      [Op.or]: [
        { hiredTalents: { [Op.overlap]: legacyUserIds } },
        { supervisorIds: { [Op.overlap]: legacyUserIds } },
        { supervisorId: userReference },
      ],
    },
    transaction,
  });
  for (const event of linkedEvents) {
    event.hiredTalents = (event.hiredTalents || []).filter((id) => !legacyUserIds.includes(id));
    event.supervisorIds = (event.supervisorIds || []).filter((id) => !legacyUserIds.includes(id));
    if (legacyUserIds.includes(event.supervisorId)) event.supervisorId = event.supervisorIds[0] || null;
    await event.save({ transaction });
  }

  if (demoEventIds.length) await destroyWhere(Event, { id: eventReference }, transaction);
  await destroyWhere(User, { id: userReference }, transaction);

  return { usersRemoved: legacyUserIds.length, eventsRemoved: demoEventIds.length };
};

export const seedDemoData = async ({ closeConnection = false } = {}) => {
  if (!ADMIN_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ADMIN_EMAIL)) {
    throw new Error('SEED_ADMIN_EMAIL must be a valid email address');
  }
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
    throw new Error('SEED_ADMIN_PASSWORD must be at least 8 characters');
  }

  await sequelize.authenticate();
  await sequelize.sync();

  const transaction = await sequelize.transaction();
  try {
    const removed = process.env.SEED_DEMO_CLEANUP === 'true'
      ? await removeLegacyDemoData(transaction)
      : { usersRemoved: 0, eventsRemoved: 0 };
    const password = HashService.hashPassword({ password: ADMIN_PASSWORD });
    const [admin] = await User.findOrCreate({
      where: { email: ADMIN_EMAIL },
      defaults: { ...adminData, password },
      transaction,
    });

    await admin.update({
      ...adminData,
      password,
      isEmailVerified: true,
      isVerified: true,
      isBlocked: false,
      status: status.VERIFIED,
      whatsappConsentGiven: false,
      whatsappConsentGivenAt: null,
    }, { transaction });

    await transaction.commit();
    return {
      users: [{ email: admin.email, role: admin.role, name: admin.fullName }],
      removed,
    };
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    if (closeConnection) await sequelize.close();
  }
};

const isCliRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCliRun) seedDemoData({ closeConnection: true }).then((result) => {
  console.log('Admin account seeded successfully.');
  console.log(`Removed ${result.removed.usersRemoved} legacy demo users and ${result.removed.eventsRemoved} demo events.`);
  console.table(result.users);
}).catch((error) => {
  console.error('Failed to seed admin account:', error);
  process.exitCode = 1;
});
