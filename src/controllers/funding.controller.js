import { Op } from 'sequelize';
import { randomUUID } from 'crypto';
import { Event, EventFunding, EventSettlement, OrganizerCard, User } from '../../db/index.js';
import { AppError } from '../utils/appError.js';
import { FundingService } from '../services/funding.service.js';
import { FundingRefundService } from '../services/funding-refund.service.js';
import { OrganizerCreditService } from '../services/organizer-credit.service.js';
import { AttendanceService } from '../services/attendance.service.js';
import { EventAutomationService } from '../services/event-automation.service.js';
import { isUuid, notifySafely, processAutomaticPayouts, serializeSettlement } from '../services/settlement.service.js';

const getOrganizerId = (user) => user.role === 'organizer' ? user.id : user.providerOwnerId;

const toCents = (amount) => {
  const value = Number(amount);
  if (typeof amount === 'boolean' || amount === null || amount === '' || !Number.isFinite(value)) return NaN;
  const cents = Math.round(value * 100);
  return Math.abs(value * 100 - cents) < 1e-6 ? cents : NaN;
};

const requireUuidParam = (value, label) => {
  if (!isUuid(value)) throw new AppError(`Invalid ${label}`, 400);
  return value;
};

const ownedEvent = async (eventId, authUser) => {
  requireUuidParam(eventId, 'event ID');
  const event = await Event.findOne({ where: { id: eventId, organizerId: getOrganizerId(authUser) } });
  if (!event) throw new AppError('Event not found', 404);
  return event;
};

// Credit is only spent on future events; returned card payments go back to the card.
const creditOverview = async (organizerId) => {
  const [balanceCents, entries, tier, refunds] = await Promise.all([
    OrganizerCreditService.balance(organizerId),
    OrganizerCreditService.listEntries(organizerId),
    OrganizerCreditService.evaluateOrganizerTier(organizerId),
    FundingRefundService.listForOrganizer(organizerId),
  ]);
  const eventIds = [...new Set([...entries, ...refunds].map((item) => item.eventId).filter(Boolean))];
  const events = eventIds.length
    ? await Event.findAll({ where: { id: { [Op.in]: eventIds } }, paranoid: false, attributes: ['id', 'title'] })
    : [];
  const titles = new Map(events.map((event) => [event.id, event.title]));
  return {
    balance: balanceCents / 100,
    balanceCents,
    tier,
    entries: entries.map((entry) => ({ ...entry.toJSON(), eventTitle: titles.get(entry.eventId) || null })),
    refunds: refunds.map((refund) => ({ ...refund.toJSON(), eventTitle: titles.get(refund.eventId) || null })),
  };
};

export class FundingController {
  // ── Organization ─────────────────────────────────────────────────────────────
  static async getEventFunding(req, res) {
    const event = await ownedEvent(req.params.id, req.authUser);
    await EventAutomationService.sweepQuietly({ eventIds: [event.id] });
    await event.reload();
    const data = await FundingService.publicSummary(event);
    if (req.authUser.role === 'organizer') {
      data.savedCards = await OrganizerCard.findAll({
        where: { organizerId: event.organizerId, isActive: true, isLive: false },
        order: [['isDefault', 'DESC'], ['createdAt', 'DESC']],
      });
    }
    return res.status(200).json({ success: true, data });
  }

  static async startEventFunding(req, res) {
    const event = await ownedEvent(req.params.id, req.authUser);
    const prepared = await FundingService.startFunding({
      eventId: event.id,
      organizerId: event.organizerId,
      cardId: req.body?.cardId || null,
      useCredit: req.body?.useCredit ?? true,
      extraSeats: req.body?.extraSeats === undefined ? 0 : Number(req.body.extraSeats),
      actorId: req.authUser.id,
    });
    const refreshed = await Event.findByPk(event.id);
    return res.status(prepared.reused ? 200 : 201).json({
      success: true,
      data: {
        checkout: prepared.checkout ? prepared.checkout.toJSON() : null,
        checkoutUrl: prepared.checkout?.checkoutUrl || null,
        fullyFunded: prepared.fullyFundedNow,
        funding: await FundingService.publicSummary(refreshed, { includeRelease: false }),
      },
    });
  }

  static async setFundingMode(req, res) {
    const event = await ownedEvent(req.params.id, req.authUser);
    const updated = await FundingService.changeFundingMode({
      eventId: event.id, organizerId: event.organizerId, mode: req.body?.mode,
    });
    return res.status(200).json({ success: true, data: updated });
  }

  // Releases before the automatic time, once check-in has closed.
  static async releaseEventFunds(req, res) {
    const event = await ownedEvent(req.params.id, req.authUser);
    await AttendanceService.finalizeAttendance(event);
    await FundingService.releaseEventFunds({ eventId: event.id, organizerId: event.organizerId, actorId: req.authUser.id });
    const refreshed = await Event.findByPk(event.id);
    return res.status(200).json({ success: true, data: await FundingService.publicSummary(refreshed) });
  }

  // Polled by the checkout result page; the callback, not the redirect, decides the outcome.
  static async getFunding(req, res) {
    const funding = await EventFunding.findByPk(requireUuidParam(req.params.fundingId, 'funding ID'));
    if (!funding) throw new AppError('Funding not found', 404);
    if (req.authUser.role !== 'admin' && funding.organizerId !== getOrganizerId(req.authUser)) {
      throw new AppError('Not authorized to view this funding', 403);
    }
    if (['not_started', 'pending'].includes(funding.collectionStatus)) {
      await FundingService.reconcileStaleFundings(funding.eventId);
      await funding.reload();
    }
    const event = await Event.findByPk(funding.eventId, { paranoid: false });
    return res.status(200).json({
      success: true,
      data: {
        ...funding.toJSON(),
        event: event ? { _id: event.id, title: event.title } : null,
        eventFunding: event && !event.deletedAt ? await FundingService.publicSummary(event, { includeRelease: false }) : null,
      },
    });
  }

  static async getCredit(req, res) {
    return res.status(200).json({ success: true, data: await creditOverview(getOrganizerId(req.authUser)) });
  }

  // ── Admin ────────────────────────────────────────────────────────────────────
  static async adminOverview(req, res) {
    const [underfunded, failedRefunds] = await Promise.all([
      FundingService.underfundedEvents(),
      FundingRefundService.listFailed(),
    ]);
    return res.status(200).json({ success: true, data: { underfunded, failedRefunds } });
  }

  static async getOrganizerPaymentProfile(req, res) {
    const organizerId = requireUuidParam(req.params.id, 'organization ID');
    const organizer = await User.findOne({ where: { id: organizerId, role: 'organizer' }, attributes: ['id', 'fullName'] });
    if (!organizer) throw new AppError('Organization not found', 404);
    return res.status(200).json({
      success: true,
      data: { organization: { _id: organizer.id, fullName: organizer.fullName }, ...await creditOverview(organizerId) },
    });
  }

  static async setOrganizerTier(req, res) {
    const organizerId = requireUuidParam(req.params.id, 'organization ID');
    const override = req.body?.override ?? null;
    if (override !== null && !['standard', 'trusted'].includes(override)) {
      throw new AppError('Override must be standard, trusted, or null for automatic', 400);
    }
    const organizer = await User.findOne({ where: { id: organizerId, role: 'organizer' } });
    if (!organizer) throw new AppError('Organization not found', 404);
    await organizer.update({ paymentTierOverride: override });
    const tier = await OrganizerCreditService.evaluateOrganizerTier(organizerId);
    await notifySafely({
      userId: organizerId,
      title: tier.tier === 'trusted' ? 'Pay-after-event enabled' : 'Advance funding required',
      message: tier.tier === 'trusted'
        ? 'Your organization can now choose to pay ushers after events.'
        : 'Your organization now funds usher pay in advance for new events.',
      type: 'info',
      link: '/provider/payments',
    });
    return res.status(200).json({ success: true, data: tier });
  }

  static async adjustCredit(req, res) {
    const organizerId = requireUuidParam(req.params.id, 'organization ID');
    const amountCents = toCents(req.body?.amount);
    if (!Number.isSafeInteger(amountCents) || amountCents === 0) throw new AppError('Enter a non-zero amount in EGP', 400);
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!note) throw new AppError('Explain the adjustment in a note', 400);
    const organizer = await User.findOne({ where: { id: organizerId, role: 'organizer' } });
    if (!organizer) throw new AppError('Organization not found', 404);
    await OrganizerCreditService.addEntry({
      organizerId, amountCents, type: 'admin_adjustment', reference: `admin:${randomUUID()}`,
      note: note.slice(0, 1000), createdBy: req.authUser.id,
    });
    return res.status(201).json({ success: true, data: await creditOverview(organizerId) });
  }

  // Sends queued payouts left waiting, for example while the Payouts sandbox was not configured.
  static async processQueuedPayouts(req, res) {
    const settlement = await EventSettlement.findByPk(requireUuidParam(req.params.settlementId, 'settlement ID'), { paranoid: false });
    if (!settlement) throw new AppError('Settlement not found', 404);
    if (settlement.collectionStatus !== 'paid') throw new AppError('Only collected settlements can pay out', 409);
    await processAutomaticPayouts(settlement);
    return res.status(200).json({ success: true, data: await serializeSettlement(settlement) });
  }

  static async getEventFundingForAdmin(req, res) {
    const event = await Event.findByPk(requireUuidParam(req.params.id, 'event ID'));
    if (!event) throw new AppError('Event not found', 404);
    return res.status(200).json({ success: true, data: await FundingService.publicSummary(event) });
  }
}

