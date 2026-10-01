import { Op } from 'sequelize';
import { Application, Event, OrganizationFavorite, User } from '../../db/index.js';
import { sequelize } from '../../db/connection.js';
import { AppError } from '../utils/appError.js';
import { isProfileComplete } from '../utils/profileCompletion.js';
import { publicTalent } from '../utils/publicTalent.js';
import { NotificationService } from '../services/notification.service.js';
import { LATE_EXCUSE_LIMIT } from '../services/application-decision.service.js';

const organizerIdFor = (user) => user.role === 'organizer' ? user.id : user.providerOwnerId;
const bookable = (talent) => talent?.role === 'usher' && !talent.isBlocked && isProfileComplete(talent);
const canRebook = (talent) => bookable(talent) && (talent.lateExcuseCount || 0) < LATE_EXCUSE_LIMIT;

async function lastTeamFor(event, transaction) {
  const before = new Date(Math.min(Date.now(), new Date(event.eventDate).getTime()));
  return Event.findOne({
    where: {
      organizerId: event.organizerId,
      id: { [Op.ne]: event.id },
      status: { [Op.ne]: 'cancelled' },
      eventDate: { [Op.lt]: before },
      [Op.and]: sequelize.where(sequelize.fn('cardinality', sequelize.col('hiredTalents')), { [Op.gt]: 0 }),
    },
    order: [['eventDate', 'DESC'], ['createdAt', 'DESC']],
    transaction,
  });
}

export class OrganizationTalentController {
  static async listFavorites(req, res) {
    const organizerId = organizerIdFor(req.authUser);
    const favorites = await OrganizationFavorite.findAll({
      where: { organizerId }, order: [['createdAt', 'DESC']],
    });
    const ids = favorites.map((favorite) => favorite.talentId);
    const talents = ids.length ? await User.findAll({
      where: { id: { [Op.in]: ids }, role: 'usher', isBlocked: false },
    }) : [];
    const byId = new Map(talents.filter(bookable).map((talent) => [talent.id, talent]));
    const data = ids.flatMap((id) => byId.has(id) ? [publicTalent(byId.get(id))] : []);
    return res.status(200).json({ success: true, data, count: data.length });
  }

  static async addFavorite(req, res, next) {
    const organizerId = organizerIdFor(req.authUser);
    const { talentId } = req.params;
    const talent = await User.findByPk(talentId);
    if (!bookable(talent)) return next(new AppError('Usher is unavailable', 404));
    const [favorite, created] = await OrganizationFavorite.findOrCreate({
      where: { organizerId, talentId }, defaults: { organizerId, talentId },
    });
    return res.status(created ? 201 : 200).json({
      success: true, data: publicTalent(talent), favoriteId: favorite.id,
    });
  }

  static async removeFavorite(req, res) {
    const organizerId = organizerIdFor(req.authUser);
    await OrganizationFavorite.destroy({ where: { organizerId, talentId: req.params.talentId } });
    return res.status(200).json({ success: true });
  }

  static async getLastTeam(req, res, next) {
    const organizerId = organizerIdFor(req.authUser);
    const event = await Event.findOne({ where: { id: req.params.id, organizerId } });
    if (!event) return next(new AppError('Event not found', 404));
    const source = await lastTeamFor(event);
    if (!source) return res.status(200).json({ success: true, data: null });
    const talents = await User.findAll({ where: { id: { [Op.in]: source.hiredTalents } } });
    const byId = new Map(talents.filter(canRebook).map((talent) => [talent.id, talent]));
    return res.status(200).json({
      success: true,
      data: {
        eventId: source.id,
        eventTitle: source.title,
        eventDate: source.eventDate,
        talents: source.hiredTalents.flatMap((id) => byId.has(id) ? [publicTalent(byId.get(id))] : []),
        unavailableCount: source.hiredTalents.filter((id) => !byId.has(id)).length,
      },
    });
  }

  static async rebookLastTeam(req, res, next) {
    const organizerId = organizerIdFor(req.authUser);
    const outcome = await sequelize.transaction(async (transaction) => {
      const event = await Event.findOne({
        where: { id: req.params.id, organizerId }, transaction, lock: transaction.LOCK.UPDATE,
      });
      if (!event) throw new AppError('Event not found', 404);
      if (event.status !== 'open') throw new AppError('Event is not open for bookings', 409);
      const source = await lastTeamFor(event, transaction);
      if (!source) throw new AppError('No previous team is available', 404);

      const pendingDirect = await Application.count({
        where: { eventId: event.id, isDirect: true, status: 'pending' }, transaction,
      });
      let slots = Math.max(0, event.requiredCount - (event.hiredTalents || []).length - pendingDirect);
      const invited = [];
      const skipped = [];
      for (const talentId of source.hiredTalents) {
        const existing = await Application.findOne({ where: { eventId: event.id, talentId }, transaction });
        if (existing) {
          skipped.push({ talentId, reason: 'already_applied' });
          continue;
        }
        if (!slots) {
          skipped.push({ talentId, reason: 'no_open_slot' });
          continue;
        }
        const talent = await User.findByPk(talentId, { transaction });
        if (!canRebook(talent)) {
          skipped.push({ talentId, reason: 'unavailable' });
          continue;
        }
        const [application, created] = await Application.findOrCreate({
          where: { eventId: event.id, talentId },
          defaults: { eventId: event.id, talentId, status: 'pending', isDirect: true, appliedAt: new Date() },
          transaction,
        });
        if (created) {
          invited.push(application);
          slots -= 1;
        } else {
          skipped.push({ talentId, reason: 'already_applied' });
        }
      }
      return { event, source, invited, skipped };
    });

    await Promise.all(outcome.invited.map((application) => NotificationService.create({
      userId: application.talentId,
      title: 'New booking invitation',
      message: `${req.authUser.fullName} invited you to work at “${outcome.event.title}”.`,
      type: 'success',
      link: `/talent/jobs/${outcome.event.id}`,
    })));
    return res.status(200).json({
      success: true,
      data: {
        sourceEventId: outcome.source.id,
        invited: outcome.invited.map((application) => application.talentId),
        skipped: outcome.skipped,
      },
    });
  }
}
