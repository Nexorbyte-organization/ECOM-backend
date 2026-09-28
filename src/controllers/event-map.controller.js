import { randomUUID } from 'crypto';
import { Op } from 'sequelize';
import { Event, User } from '../../db/index.js';
import { sequelize } from '../../db/connection.js';
import { AppError } from '../utils/appError.js';
import { CloudinaryService } from '../utils/cloudinary.js';
import { UploadFolders } from '../utils/uploadFolders.js';
import { NotificationService } from '../services/notification.service.js';

const ownerId = (user) => user.role === 'organizer' ? user.id : user.providerOwnerId;
const imageUrl = (image) => image?.secure_url || null;
const pinsOf = (event) => Array.isArray(event.mapPins) ? event.mapPins : [];
const validCoordinate = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

async function ownedEvent(req) {
  const event = await Event.findOne({ where: { id: req.params.id, organizerId: ownerId(req.authUser) } });
  if (!event) throw new AppError('Event not found', 404);
  return event;
}

async function mapResponse(event) {
  const hiredIds = event.hiredTalents || [];
  const users = hiredIds.length ? await User.findAll({
    where: { id: { [Op.in]: hiredIds }, role: 'usher' },
    attributes: ['id', 'fullName'],
  }) : [];
  return {
    imageUrl: imageUrl(event.mapImage),
    pins: pinsOf(event),
    ushers: users.map((user) => ({ id: user.id, name: user.fullName })),
  };
}

export class EventMapController {
  static async getOrganizationMap(req, res) {
    const event = await ownedEvent(req);
    res.json({ success: true, data: await mapResponse(event) });
  }

  static async getUsherMap(req, res) {
    const event = await Event.findByPk(req.params.id);
    if (!event || !(event.hiredTalents || []).includes(req.authUser.id)) throw new AppError('Event map not found', 404);
    const pins = pinsOf(event).filter((pin) => pin.usherIds?.includes(req.authUser.id));
    if (!pins.length) throw new AppError('Map location not assigned', 404);
    res.json({ success: true, data: { imageUrl: imageUrl(event.mapImage), pins: pins.map(({ id, name, x, y }) => ({ id, name, x, y })) } });
  }

  static async uploadImage(req, res) {
    if (!req.file) throw new AppError('Map image is required', 400);
    const event = await ownedEvent(req);
    const uploaded = await CloudinaryService.uploadBuffer(req.file.buffer, UploadFolders.eventMap(event.organizerId, event.id));
    const previous = event.mapImage?.public_id;
    event.mapImage = uploaded;
    try { await event.save(); } catch (error) {
      await CloudinaryService.deleteImage(uploaded.public_id).catch(() => undefined);
      throw error;
    }
    if (previous) await CloudinaryService.deleteImage(previous).catch(() => undefined);
    res.json({ success: true, data: await mapResponse(event) });
  }

  static async createPin(req, res) {
    const { name, x, y } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || !validCoordinate(x) || !validCoordinate(y)) {
      throw new AppError('Pin requires a name of at most 80 characters and coordinates from 0 to 100', 400);
    }
    const event = await sequelize.transaction(async (transaction) => {
      const locked = await Event.findOne({ where: { id: req.params.id, organizerId: ownerId(req.authUser) }, transaction, lock: transaction.LOCK.UPDATE });
      if (!locked) throw new AppError('Event not found', 404);
      if (!locked.mapImage) throw new AppError('Upload a map image first', 409);
      locked.mapPins = [...pinsOf(locked), { id: randomUUID(), name: name.trim(), x, y, usherIds: [] }];
      await locked.save({ transaction });
      return locked;
    });
    res.status(201).json({ success: true, data: await mapResponse(event) });
  }

  static async updatePin(req, res) {
    const { name, x, y, usherIds } = req.body || {};
    if (name === undefined && x === undefined && y === undefined && usherIds === undefined) throw new AppError('Provide a pin change', 400);
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 80)) throw new AppError('Pin name must contain 1 to 80 characters', 400);
    if ((x !== undefined && !validCoordinate(x)) || (y !== undefined && !validCoordinate(y))) throw new AppError('Coordinates must be from 0 to 100', 400);
    if (usherIds !== undefined && (!Array.isArray(usherIds) || usherIds.some((id) => typeof id !== 'string') || new Set(usherIds).size !== usherIds.length)) throw new AppError('usherIds must be a list of unique user IDs', 400);
    let newlyAssigned = [];
    let pinName = '';
    const event = await sequelize.transaction(async (transaction) => {
      const locked = await Event.findOne({ where: { id: req.params.id, organizerId: ownerId(req.authUser) }, transaction, lock: transaction.LOCK.UPDATE });
      if (!locked) throw new AppError('Event not found', 404);
      const pins = pinsOf(locked).map((pin) => ({ ...pin }));
      const pin = pins.find((item) => item.id === req.params.pinId);
      if (!pin) throw new AppError('Pin not found', 404);
      if (usherIds !== undefined) {
        const hired = new Set(locked.hiredTalents || []);
        if (usherIds.some((id) => !hired.has(id))) throw new AppError('Only hired ushers can be assigned', 400);
        if (pins.some((other) => other.id !== pin.id && other.usherIds?.some((id) => usherIds.includes(id)))) throw new AppError('An usher can have only one map pin per event', 409);
        newlyAssigned = usherIds.filter((id) => !(pin.usherIds || []).includes(id));
        pin.usherIds = usherIds;
      }
      if (name !== undefined) pin.name = name.trim();
      if (x !== undefined) pin.x = x;
      if (y !== undefined) pin.y = y;
      pinName = pin.name;
      locked.mapPins = pins;
      await locked.save({ transaction });
      return locked;
    });
    await Promise.all(newlyAssigned.map((userId) => NotificationService.create({
      userId, title: 'Assigned to an event map location',
      message: `You have been assigned to “${pinName}” on the map for “${event.title}”.`,
      type: 'info', link: `/talent/events/${event.id}/map`,
    })));
    res.json({ success: true, data: await mapResponse(event) });
  }

  static async deletePin(req, res) {
    const event = await sequelize.transaction(async (transaction) => {
      const locked = await Event.findOne({ where: { id: req.params.id, organizerId: ownerId(req.authUser) }, transaction, lock: transaction.LOCK.UPDATE });
      if (!locked) throw new AppError('Event not found', 404);
      const pins = pinsOf(locked);
      if (!pins.some((pin) => pin.id === req.params.pinId)) throw new AppError('Pin not found', 404);
      locked.mapPins = pins.filter((pin) => pin.id !== req.params.pinId);
      await locked.save({ transaction });
      return locked;
    });
    res.json({ success: true, data: await mapResponse(event) });
  }
}
