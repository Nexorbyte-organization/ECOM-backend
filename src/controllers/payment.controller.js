import { Op } from 'sequelize';
import { sequelize } from '../../db/connection.js';
import {
  Attendance,
  Event,
  EventSettlement,
  OrganizerCard,
  OrganizerCardEnrollment,
  SettlementLine,
  User,
} from '../../db/index.js';
import { AppError } from '../utils/appError.js';
import { NotificationService } from '../services/notification.service.js';
import {
  createPaymobIntention,
  createCardEnrollmentIntention,
  getCardEnrollmentIntegrationId,
  getPaymobTestConfig,
  verifyCardTokenHmac,
  verifyTransactionHmac,
} from '../services/paymob.service.js';
import {
  assertCardTokenEncryptionConfigured,
  decryptCardToken,
  encryptCardToken,
} from '../services/card-token.service.js';
import { resolveSettlementPayoutMethod } from '../services/payout-method.service.js';
import { classifyPayoutStatus, isPayoutSandboxConfigured, sendSandboxPayout } from '../services/paymob-payout.service.js';

const PLATFORM_FEE_PERCENT = 5;

const getOrganizerId = (user) => user.role === 'organizer' ? user.id : user.providerOwnerId;

const maskDestination = (value) => {
  const normalized = String(value || '').replace(/\s+/g, '');
  if (!normalized) return null;
  return `${'*'.repeat(Math.max(4, normalized.length - 4))}${normalized.slice(-4)}`;
};

export const calculateSettlementLineAmounts = (budget) => {
  const grossAmountCents = Math.round(Number(budget) * 100);
  if (!Number.isFinite(grossAmountCents) || grossAmountCents <= 0) {
    throw new AppError('Event budget must be a positive amount', 400);
  }
  const platformFeeCents = Math.round(grossAmountCents * (PLATFORM_FEE_PERCENT / 100));
  return {
    grossAmountCents,
    platformFeeCents,
    usherAmountCents: grossAmountCents - platformFeeCents,
  };
};

const loadEligibleUshers = async (event) => {
  const attendance = await Attendance.findAll({
    where: {
      eventId: event.id,
      talentId: { [Op.in]: event.hiredTalents || [] },
      status: { [Op.in]: ['present', 'late'] },
    },
  });
  if (attendance.length === 0) {
    throw new AppError('Mark at least one hired usher as present or late before paying', 409);
  }

  const talentIds = attendance.map((record) => record.talentId);
  const talents = await User.findAll({ where: { id: { [Op.in]: talentIds }, role: 'usher' } });
  const talentsById = new Map(talents.map((talent) => [talent.id, talent]));
  return attendance
    .map((record) => ({ attendance: record, talent: talentsById.get(record.talentId) }))
    .filter((entry) => entry.talent);
};

const buildLineDrafts = (eligibleUshers, budget, excludedTalentIds = new Set()) => {
  const amounts = calculateSettlementLineAmounts(budget);
  return eligibleUshers.map(({ attendance, talent }) => {
    const payout = resolveSettlementPayoutMethod(
      talent.paymentMethods || [], talent.fullName, excludedTalentIds.has(talent.id),
    );
    return {
      talentId: talent.id,
      talentName: talent.fullName,
      talentPhoto: talent.portfolioPicture?.secure_url || '',
      attendanceStatus: attendance.status,
      ...amounts,
      collectionAmountCents: payout.type === 'cash' ? amounts.platformFeeCents : amounts.grossAmountCents,
      payoutMethodType: payout.type,
      payoutProvider: payout.provider,
      payoutDestination: payout.destination,
      payoutDestinationMasked: maskDestination(payout.destination),
      payoutMetadata: payout.metadata,
      payoutStatus: payout.status,
    };
  });
};

const summarizeDrafts = (drafts) => drafts.reduce((summary, line) => ({
  grossAmountCents: summary.grossAmountCents + line.grossAmountCents,
  collectionAmountCents: summary.collectionAmountCents + line.collectionAmountCents,
  platformFeeCents: summary.platformFeeCents + line.platformFeeCents,
  usherAmountCents: summary.usherAmountCents + line.usherAmountCents,
  cashDueAmountCents: summary.cashDueAmountCents
    + (line.payoutMethodType === 'cash' ? line.usherAmountCents : 0),
}), {
  grossAmountCents: 0,
  collectionAmountCents: 0,
  platformFeeCents: 0,
  usherAmountCents: 0,
  cashDueAmountCents: 0,
});

const lineValues = (line, settlement, event) => ({
  settlementId: settlement.id,
  eventId: event.id,
  talentId: line.talentId,
  attendanceStatus: line.attendanceStatus,
  grossAmountCents: line.grossAmountCents,
  collectionAmountCents: line.collectionAmountCents,
  platformFeeCents: line.platformFeeCents,
  usherAmountCents: line.usherAmountCents,
  payoutMethodType: line.payoutMethodType,
  payoutProvider: line.payoutProvider,
  payoutDestination: line.payoutDestination,
  payoutMetadata: line.payoutMetadata,
  payoutStatus: line.payoutStatus,
});

const publicLine = (line, talent = null) => {
  const values = line.toJSON ? line.toJSON() : { ...line };
  delete values.payoutDestination;
  delete values.payoutMetadata;
  return {
    ...values,
    payoutDestinationMasked: maskDestination(line.payoutDestination),
    talent: talent ? {
      _id: talent.id,
      userId: talent.id,
      fullName: talent.fullName,
      photo: talent.portfolioPicture?.secure_url || '',
    } : undefined,
  };
};

const serializeSettlement = async (settlement) => {
  const lines = await SettlementLine.findAll({
    where: { settlementId: settlement.id },
    order: [['createdAt', 'ASC']],
  });
  const talentIds = lines.map((line) => line.talentId);
  const talents = talentIds.length
    ? await User.findAll({ where: { id: { [Op.in]: talentIds } } })
    : [];
  const talentsById = new Map(talents.map((talent) => [talent.id, talent]));
  return {
    ...settlement.toJSON(),
    payoutSandboxConfigured: isPayoutSandboxConfigured(),
    lines: lines.map((line) => publicLine(line, talentsById.get(line.talentId))),
  };
};

const updateAggregatePayoutStatus = async (settlement) => {
  const lines = await SettlementLine.findAll({ where: { settlementId: settlement.id } });
  const statuses = lines.map((line) => line.payoutStatus);
  if (statuses.length > 0 && statuses.every((status) => status === 'paid')) {
    settlement.payoutStatus = 'paid';
  } else if (statuses.some((status) => status === 'paid')) {
    settlement.payoutStatus = 'partially_paid';
  } else if (statuses.some((status) => ['queued', 'processing', 'cash_due'].includes(status))) {
    settlement.payoutStatus = 'processing';
  } else if (statuses.some((status) => status === 'failed')) {
    settlement.payoutStatus = 'failed';
  } else {
    settlement.payoutStatus = 'not_started';
  }
  await settlement.save();
};

const processAutomaticPayouts = async (settlement, lineId = null) => {
  const lines = await SettlementLine.findAll({
    where: { settlementId: settlement.id, payoutStatus: 'queued', ...(lineId ? { id: lineId } : {}) },
  });
  if (!lines.length || !isPayoutSandboxConfigured()) {
    await updateAggregatePayoutStatus(settlement);
    return;
  }

  settlement.payoutStatus = 'processing';
  await settlement.save();
  for (const line of lines) {
    const [claimed] = await SettlementLine.update(
      { payoutStatus: 'processing' },
      { where: { id: line.id, payoutStatus: 'queued' } },
    );
    if (!claimed) continue;
    line.payoutStatus = 'processing';
    const talent = await User.findByPk(line.talentId, { paranoid: false });
    if (!talent) {
      line.payoutStatus = 'failed';
      line.failureReason = 'Usher account not found';
      line.payoutRetrySafe = false;
      await line.save();
      continue;
    }

    try {
      const payout = await sendSandboxPayout(line, talent);
      line.paymobPayoutTransactionId = payout.transactionId;
      line.failureReason = payout.description;
      const outcome = classifyPayoutStatus(payout.status);
      line.payoutStatus = outcome.status;
      line.payoutRetrySafe = outcome.retrySafe;
      if (outcome.status === 'paid') {
        line.paidAt = new Date();
      } else if (outcome.status === 'processing' && !payout.description) {
        line.failureReason = payout.description || `Paymob payout status is ${payout.status || 'unknown'}; verify before retrying`;
      }
    } catch (error) {
      line.payoutStatus = 'failed';
      line.payoutRetrySafe = false;
      line.failureReason = error.message;
    }
    await line.save();
    if (line.payoutStatus === 'paid' && !talent.deletedAt) {
      try {
        await NotificationService.create({
          userId: talent.id,
          title: 'Event payment sent',
          message: `Your ${line.usherAmountCents / 100} EGP payment was sent through Paymob Test Mode.`,
          type: 'success',
          link: '/talent/events',
        });
      } catch {
        // A notification failure must not change a completed transfer into a failed payout.
      }
    }
  }
  await updateAggregatePayoutStatus(settlement);
};

const requireOwnedCompletedEvent = async (eventId, authUser) => {
  const organizerId = getOrganizerId(authUser);
  const event = await Event.findOne({ where: { id: eventId, organizerId } });
  if (!event) throw new AppError('Event not found', 404);
  if (event.status !== 'completed') {
    throw new AppError('The organization can pay ushers only after the event is completed', 409);
  }
  return event;
};

const getCheckoutCard = async (cardId, organizerId) => {
  if (!cardId) return null;
  if (typeof cardId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cardId)) {
    throw new AppError('Invalid saved card ID', 400);
  }
  const card = await OrganizerCard.findOne({
    where: { id: cardId, organizerId, isActive: true, isLive: false },
  });
  if (!card) throw new AppError('Saved card not found for this organization', 404);
  return card;
};

const startCheckout = async ({ settlement, event, organizer, drafts, card }) => {
  try {
    const intention = await createPaymobIntention({
      settlement, event, organizer, lines: drafts,
      cardToken: card ? decryptCardToken(card) : undefined,
    });
    await settlement.update({
      collectionStatus: 'pending',
      paymobIntentionId: intention.intentionId,
      paymobOrderId: intention.orderId,
      paymobClientSecret: intention.clientSecret,
      checkoutUrl: intention.checkoutUrl,
      selectedCardId: card?.id || null,
      expiresAt: intention.expiresAt,
    });
  } catch (error) {
    await settlement.update({ collectionStatus: 'failed', collectionFailureReason: error.message });
    throw error;
  }
};

export class PaymentController {
  static async previewEventSettlement(req, res) {
    const event = await requireOwnedCompletedEvent(req.params.id, req.authUser);
    const drafts = buildLineDrafts(await loadEligibleUshers(event), event.budget);
    const totals = summarizeDrafts(drafts);
    const savedCards = await OrganizerCard.findAll({
      where: { organizerId: getOrganizerId(req.authUser), isActive: true, isLive: false },
      order: [['isDefault', 'DESC'], ['createdAt', 'DESC']],
    });
    return res.status(200).json({
      success: true,
      data: {
        testMode: true,
        eventId: event.id,
        feePercent: PLATFORM_FEE_PERCENT,
        ...totals,
        grossAmount: totals.grossAmountCents / 100,
        collectionAmount: totals.collectionAmountCents / 100,
        platformFee: totals.platformFeeCents / 100,
        usherAmount: totals.usherAmountCents / 100,
        cashDueAmount: totals.cashDueAmountCents / 100,
        payoutSandboxConfigured: isPayoutSandboxConfigured(),
        savedCards,
        lines: drafts.map((line) => ({
          ...line,
          payoutDestination: undefined,
          payoutMetadata: undefined,
        })),
      },
    });
  }

  static async createEventSettlement(req, res, next) {
    const event = await requireOwnedCompletedEvent(req.params.id, req.authUser);
    const organizerId = getOrganizerId(req.authUser);
    const organizer = await User.findByPk(organizerId);
    const eligibleUshers = await loadEligibleUshers(event);
    const excludedTalentIds = req.body?.excludedTalentIds ?? [];
    if (!Array.isArray(excludedTalentIds)
      || excludedTalentIds.some((id) => typeof id !== 'string')
      || new Set(excludedTalentIds).size !== excludedTalentIds.length
      || excludedTalentIds.some((id) => !eligibleUshers.some(({ talent }) => talent.id === id))) {
      return next(new AppError('Excluded ushers must be unique eligible ushers for this event', 400));
    }
    const drafts = buildLineDrafts(eligibleUshers, event.budget, new Set(excludedTalentIds));
    if (drafts.some((line) => line.payoutStatus === 'queued') && !isPayoutSandboxConfigured()) {
      return next(new AppError('Automatic Paymob payouts are not configured. Connect the Payouts sandbox before collecting payment for ushers with payout accounts.', 503));
    }
    const totals = summarizeDrafts(drafts);
    const cardId = req.body?.cardId || null;
    const card = await getCheckoutCard(cardId, organizerId);
    const prepared = await sequelize.transaction(async (transaction) => {
      await Event.findByPk(event.id, { transaction, lock: transaction.LOCK.UPDATE });
      const individual = await EventSettlement.findOne({
        where: { eventId: event.id, targetTalentId: { [Op.ne]: null } }, transaction,
      });
      if (individual) throw new AppError('Individual checkout has started for this event. Pay the remaining ushers individually.', 409);

      let settlement = await EventSettlement.findOne({
        where: { eventId: event.id, targetTalentId: null }, transaction,
      });
      if (['paid', 'refunded'].includes(settlement?.collectionStatus)) {
        throw new AppError('This event settlement has already been collected', 409);
      }
      if (settlement?.collectionStatus === 'not_started') {
        throw new AppError('This event checkout is being prepared. Try again shortly.', 409);
      }
      if (settlement?.collectionStatus === 'pending') {
        if (settlement.checkoutUrl && settlement.expiresAt && new Date(settlement.expiresAt) > new Date()) {
          const existingLines = await SettlementLine.findAll({ where: { settlementId: settlement.id }, transaction });
          if (cardId !== (settlement.selectedCardId || null)
            || existingLines.length !== drafts.length
            || existingLines.some((line) => {
              const draft = drafts.find((entry) => entry.talentId === line.talentId);
              return !draft || draft.payoutMethodType !== line.payoutMethodType
                || draft.collectionAmountCents !== line.collectionAmountCents;
            })) {
            throw new AppError('An existing checkout is still active. Continue it or retry after it expires.', 409);
          }
          return { settlement, reused: true };
        }
        throw new AppError('Wait for Paymob to confirm the existing checkout before starting another payment.', 409);
      }

      if (!settlement) {
        settlement = await EventSettlement.create({
          eventId: event.id, organizerId, targetTalentId: null, ...totals,
          specialReference: `OO-SET-${event.id}-${Date.now()}`, isLive: false,
        }, { transaction });
      } else {
        await settlement.update({
          ...totals,
          collectionStatus: 'not_started', payoutStatus: 'not_started',
          specialReference: `OO-SET-${event.id}-${Date.now()}`,
          paymobIntentionId: null, paymobOrderId: null, paymobTransactionId: null,
          paymobClientSecret: null, checkoutUrl: null, selectedCardId: null,
          expiresAt: null, collectionFailureReason: null, isLive: false,
        }, { transaction });
        await SettlementLine.destroy({ where: { settlementId: settlement.id }, transaction });
      }
      await SettlementLine.bulkCreate(drafts.map((line) => lineValues(line, settlement, event)), { transaction });
      return { settlement, reused: false };
    });
    if (!prepared.reused) await startCheckout({ settlement: prepared.settlement, event, organizer, drafts, card });
    return res.status(prepared.reused ? 200 : 201).json({
      success: true, data: await serializeSettlement(prepared.settlement),
    });
  }

  static async getEventSettlement(req, res) {
    const event = await requireOwnedCompletedEvent(req.params.id, req.authUser);
    const settlement = await EventSettlement.findOne({ where: { eventId: event.id, targetTalentId: null } });
    return res.status(200).json({
      success: true,
      data: settlement ? await serializeSettlement(settlement) : null,
    });
  }

  static async listIndividualSettlements(req, res) {
    const event = await requireOwnedCompletedEvent(req.params.id, req.authUser);
    const settlements = await EventSettlement.findAll({
      where: { eventId: event.id, targetTalentId: { [Op.ne]: null } },
      order: [['createdAt', 'ASC']],
    });
    return res.status(200).json({
      success: true,
      data: await Promise.all(settlements.map(serializeSettlement)),
    });
  }

  static async createIndividualSettlement(req, res) {
    const event = await requireOwnedCompletedEvent(req.params.id, req.authUser);
    const organizerId = getOrganizerId(req.authUser);
    const organizer = await User.findByPk(organizerId);
    const eligible = (await loadEligibleUshers(event))
      .find(({ talent }) => talent.id === req.params.talentId);
    if (!eligible) throw new AppError('Usher is not eligible for payment on this event', 404);
    const payInCash = req.body?.payInCash ?? false;
    if (typeof payInCash !== 'boolean') throw new AppError('payInCash must be a boolean', 400);
    const drafts = buildLineDrafts([eligible], event.budget,
      payInCash ? new Set([eligible.talent.id]) : new Set());
    if (drafts[0].payoutStatus === 'queued' && !isPayoutSandboxConfigured()) {
      throw new AppError('Automatic Paymob payouts are not configured for this usher', 503);
    }
    const totals = summarizeDrafts(drafts);
    const cardId = req.body?.cardId || null;
    const card = await getCheckoutCard(cardId, organizerId);

    const prepared = await sequelize.transaction(async (transaction) => {
      await Event.findByPk(event.id, { transaction, lock: transaction.LOCK.UPDATE });
      const bulk = await EventSettlement.findOne({
        where: { eventId: event.id, targetTalentId: null }, transaction,
      });
      if (bulk && bulk.collectionStatus !== 'failed') {
        throw new AppError('The event checkout may still collect this usher. Wait for a confirmed failure before paying individually.', 409);
      }

      let settlement = await EventSettlement.findOne({
        where: { eventId: event.id, targetTalentId: eligible.talent.id }, transaction,
      });
      if (['paid', 'refunded'].includes(settlement?.collectionStatus)) {
        throw new AppError('This usher has already been charged for this event', 409);
      }
      if (settlement?.collectionStatus === 'not_started') {
        throw new AppError('This usher checkout is being prepared. Try again shortly.', 409);
      }
      if (settlement?.collectionStatus === 'pending') {
        if (settlement.checkoutUrl && settlement.expiresAt && new Date(settlement.expiresAt) > new Date()) {
          const existingLine = await SettlementLine.findOne({ where: { settlementId: settlement.id }, transaction });
          if (cardId !== (settlement.selectedCardId || null)
            || existingLine?.payoutMethodType !== drafts[0].payoutMethodType
            || existingLine?.collectionAmountCents !== drafts[0].collectionAmountCents) {
            throw new AppError('An existing usher checkout is active. Continue it with the same choices.', 409);
          }
          return { settlement, reused: true };
        }
        throw new AppError('Wait for Paymob to confirm the existing usher checkout before starting another payment.', 409);
      }

      if (!settlement) {
        settlement = await EventSettlement.create({
          eventId: event.id, organizerId, targetTalentId: eligible.talent.id,
          ...totals, specialReference: `OO-USHER-${event.id}-${eligible.talent.id}-${Date.now()}`,
          isLive: false,
        }, { transaction });
      } else {
        await settlement.update({
          ...totals,
          collectionStatus: 'not_started', payoutStatus: 'not_started',
          specialReference: `OO-USHER-${event.id}-${eligible.talent.id}-${Date.now()}`,
          paymobIntentionId: null, paymobOrderId: null, paymobTransactionId: null,
          paymobClientSecret: null, checkoutUrl: null, selectedCardId: null,
          expiresAt: null, collectionFailureReason: null, isLive: false,
        }, { transaction });
        await SettlementLine.destroy({ where: { settlementId: settlement.id }, transaction });
      }
      await SettlementLine.create(lineValues(drafts[0], settlement, event), { transaction });
      return { settlement, reused: false };
    });
    if (!prepared.reused) await startCheckout({ settlement: prepared.settlement, event, organizer, drafts, card });
    return res.status(prepared.reused ? 200 : 201).json({
      success: true, data: await serializeSettlement(prepared.settlement),
    });
  }

  static async getSettlement(req, res, next) {
    const settlement = await EventSettlement.findByPk(req.params.settlementId);
    if (!settlement) return next(new AppError('Settlement not found', 404));
    const organizerId = getOrganizerId(req.authUser);
    const allowed = req.authUser.role === 'admin'
      || settlement.organizerId === organizerId
      || settlement.organizerId === req.authUser.id;
    if (!allowed) return next(new AppError('Not authorized to view this settlement', 403));
    return res.status(200).json({ success: true, data: await serializeSettlement(settlement) });
  }

  static async listOrganizerCards(req, res) {
    const cards = await OrganizerCard.findAll({
      where: { organizerId: getOrganizerId(req.authUser), isActive: true, isLive: false },
      order: [['isDefault', 'DESC'], ['createdAt', 'DESC']],
    });
    return res.status(200).json({ success: true, data: cards });
  }

  static async startCardEnrollment(req, res, next) {
    assertCardTokenEncryptionConfigured();
    const organizerId = getOrganizerId(req.authUser);
    const organizer = await User.findByPk(organizerId);
    const enrollment = await OrganizerCardEnrollment.create({ organizerId });
    try {
      const intention = await createCardEnrollmentIntention({ enrollment, organizer });
      await enrollment.update({
        paymobOrderId: intention.orderId,
        paymobIntentionId: intention.intentionId,
        checkoutUrl: intention.checkoutUrl,
        expiresAt: intention.expiresAt,
      });
      return res.status(201).json({ success: true, data: { id: enrollment.id, checkoutUrl: intention.checkoutUrl } });
    } catch (error) {
      await enrollment.update({ status: 'failed' });
      return next(error);
    }
  }

  static async getCardEnrollment(req, res, next) {
    const enrollment = await OrganizerCardEnrollment.findOne({
      where: { id: req.params.enrollmentId, organizerId: getOrganizerId(req.authUser) },
    });
    if (!enrollment) return next(new AppError('Card setup not found', 404));
    if (enrollment.status === 'pending' && enrollment.expiresAt && enrollment.expiresAt < new Date()) {
      await enrollment.update({ status: 'failed' });
    }
    return res.status(200).json({ success: true, data: { status: enrollment.status } });
  }

  static async setDefaultOrganizerCard(req, res, next) {
    const organizerId = getOrganizerId(req.authUser);
    const card = await OrganizerCard.findOne({
      where: { id: req.params.cardId, organizerId, isActive: true, isLive: false },
    });
    if (!card) return next(new AppError('Saved card not found', 404));
    await OrganizerCard.update({ isDefault: false }, { where: { organizerId, isLive: false } });
    await card.update({ isDefault: true });
    return res.status(200).json({ success: true, data: card });
  }

  static async removeOrganizerCard(req, res, next) {
    const card = await OrganizerCard.findOne({
      where: {
        id: req.params.cardId,
        organizerId: getOrganizerId(req.authUser),
        isLive: false,
      },
    });
    if (!card) return next(new AppError('Saved card not found', 404));
    const wasDefault = card.isDefault;
    card.isActive = false;
    card.isDefault = false;
    await card.save();
    await card.destroy();
    if (wasDefault) {
      const replacement = await OrganizerCard.findOne({
        where: { organizerId: card.organizerId, isActive: true, isLive: false },
        order: [['createdAt', 'DESC']],
      });
      if (replacement) await replacement.update({ isDefault: true });
    }
    return res.status(200).json({ success: true, message: 'Saved test card removed' });
  }

  static async markCashPaid(req, res, next) {
    const settlement = await EventSettlement.findByPk(req.params.settlementId);
    if (!settlement) return next(new AppError('Settlement not found', 404));
    if (settlement.organizerId !== getOrganizerId(req.authUser)) {
      return next(new AppError('Not authorized to update this settlement', 403));
    }
    if (settlement.collectionStatus !== 'paid') {
      return next(new AppError('Complete the Paymob collection before recording cash payouts', 409));
    }
    const line = await SettlementLine.findOne({
      where: { id: req.params.lineId, settlementId: settlement.id },
    });
    if (!line) return next(new AppError('Settlement line not found', 404));
    if (line.payoutMethodType !== 'cash') return next(new AppError('This usher is configured for automatic payout', 409));
    if (line.payoutStatus === 'paid') {
      return res.status(200).json({ success: true, data: await serializeSettlement(settlement) });
    }
    line.payoutStatus = 'paid';
    line.paidAt = new Date();
    line.failureReason = null;
    await line.save();
    await updateAggregatePayoutStatus(settlement);
    try {
      await NotificationService.create({
        userId: line.talentId,
        title: 'Cash payment recorded',
        message: `The organization recorded your ${line.usherAmountCents / 100} EGP event payment as paid in cash.`,
        type: 'success',
        link: '/talent/events',
      });
    } catch {
      // The recorded cash payment is authoritative even if notification persistence fails.
    }
    return res.status(200).json({ success: true, data: await serializeSettlement(settlement) });
  }

  static async retryIndividualPayout(req, res) {
    const settlement = await EventSettlement.findByPk(req.params.settlementId);
    if (!settlement) throw new AppError('Settlement not found', 404);
    if (settlement.organizerId !== getOrganizerId(req.authUser)) {
      throw new AppError('Not authorized to pay this usher', 403);
    }
    if (settlement.collectionStatus !== 'paid') {
      throw new AppError('Complete the Paymob collection before paying this usher', 409);
    }
    if (!isPayoutSandboxConfigured()) {
      throw new AppError('Automatic Paymob payouts are not configured', 503);
    }
    const line = await SettlementLine.findOne({
      where: { id: req.params.lineId, settlementId: settlement.id },
    });
    if (!line) throw new AppError('Settlement line not found', 404);
    if (line.payoutMethodType === 'cash') {
      throw new AppError('This usher is configured for cash payment', 409);
    }
    const [claimed] = await SettlementLine.update(
      {
        payoutStatus: 'queued', payoutRetrySafe: false, failureReason: null,
        payoutAttempt: sequelize.literal('"payoutAttempt" + 1'),
      },
      { where: { id: line.id, settlementId: settlement.id, payoutStatus: 'failed', payoutRetrySafe: true } },
    );
    if (!claimed) {
      throw new AppError('This payout cannot be retried until its previous result is confirmed failed', 409);
    }
    await processAutomaticPayouts(settlement, line.id);
    return res.status(200).json({ success: true, data: await serializeSettlement(settlement) });
  }

  static async paymobWebhook(req, res, next) {
    const config = getPaymobTestConfig();
    const callbackType = String(req.body?.type || '').toUpperCase();
    const obj = req.body?.obj;
    const receivedHmac = req.query.hmac;
    if (!obj || !callbackType) return next(new AppError('Invalid Paymob callback body', 400));

    if (callbackType === 'TOKEN') {
      if (!verifyCardTokenHmac(obj, receivedHmac, config.hmacSecret)) {
        return next(new AppError('Invalid Paymob card-token HMAC', 401));
      }
      const settlement = await EventSettlement.findOne({
        where: { paymobOrderId: String(obj.order_id), isLive: false }, paranoid: false,
      });
      const enrollment = settlement ? null : await OrganizerCardEnrollment.findOne({
        where: { paymobOrderId: String(obj.order_id) }, paranoid: false,
      });
      if (!settlement && !enrollment) return next(new AppError('No test checkout matches this card token', 404));
      const organizerId = settlement?.organizerId || enrollment.organizerId;
      const organizer = await User.findByPk(organizerId);
      if (!organizer || settlement?.deletedAt || enrollment?.deletedAt) {
        return res.status(200).json({ success: true, received: true, ignored: true });
      }
      const existingCard = await OrganizerCard.findOne({ where: { paymobCardTokenId: String(obj.id) }, paranoid: false });
      if (existingCard && existingCard.organizerId !== organizerId) {
        return next(new AppError('Card token is already assigned to another organization', 409));
      }
      if (existingCard?.deletedAt) {
        return res.status(200).json({ success: true, received: true, ignored: true });
      }
      const encrypted = encryptCardToken(obj.token);
      await OrganizerCard.update(
        { isDefault: false },
        { where: { organizerId, isLive: false } },
      );
      const [card, created] = await OrganizerCard.findOrCreate({
        where: { paymobCardTokenId: String(obj.id) },
        defaults: {
          organizerId,
          ...encrypted,
          maskedPan: obj.masked_pan,
          cardSubtype: obj.card_subtype,
          cardholderName: obj.cardholder_name || null,
          expiryMonth: obj.expiry_month || null,
          expiryYear: obj.expiry_year || null,
          isDefault: true,
          isActive: true,
          isLive: false,
        },
      });
      if (!created) {
        await card.update({
          ...encrypted,
          maskedPan: obj.masked_pan,
          cardSubtype: obj.card_subtype,
          cardholderName: obj.cardholder_name || null,
          expiryMonth: obj.expiry_month || null,
          expiryYear: obj.expiry_year || null,
          isDefault: true,
          isActive: true,
          isLive: false,
        });
      }
      if (enrollment) await enrollment.update({ status: 'completed' });
      return res.status(200).json({ success: true, received: true });
    }

    if (callbackType !== 'TRANSACTION') {
      return res.status(200).json({ success: true, received: true, ignored: true });
    }
    if (!verifyTransactionHmac(obj, receivedHmac, config.hmacSecret)) {
      return next(new AppError('Invalid Paymob transaction HMAC', 401));
    }
    if (obj.is_live === true) return next(new AppError('Live Paymob callbacks are disabled', 409));
    const allowedIntegrations = config.paymentMethods.map(String);
    const cardIntegrationId = process.env.PAYMOB_CARD_INTEGRATION_ID?.trim();
    if (cardIntegrationId) allowedIntegrations.push(cardIntegrationId);
    if (!allowedIntegrations.includes(String(obj.integration_id))) {
      return next(new AppError('Unexpected Paymob Test Integration ID', 409));
    }

    const extraSettlementId = obj.payment_key_claims?.extra?.settlement_id
      || obj.payment_key_claims?.extras?.settlement_id;
    const orderId = obj.order?.id !== null && obj.order?.id !== undefined
      ? String(obj.order.id)
      : null;
    const specialReference = obj.order?.merchant_order_id || null;
    const whereOptions = [
      orderId && { paymobOrderId: orderId },
      specialReference && { specialReference: String(specialReference) },
      extraSettlementId && { id: String(extraSettlementId) },
    ].filter(Boolean);
    const settlement = whereOptions.length
      ? await EventSettlement.findOne({ where: { [Op.or]: whereOptions, isLive: false }, paranoid: false })
      : null;
    if (!settlement) {
      const enrollment = orderId ? await OrganizerCardEnrollment.findOne({ where: { paymobOrderId: orderId }, paranoid: false }) : null;
      if (!enrollment) return next(new AppError('No test checkout matches this transaction', 404));
      if (String(obj.integration_id) !== String(getCardEnrollmentIntegrationId(config))) {
        return next(new AppError('Unexpected card setup Integration ID', 409));
      }
      if (Number(obj.amount_cents) !== 1000 || obj.currency !== 'EGP') {
        return next(new AppError('Card setup amount or currency does not match', 409));
      }
      if (obj.success !== true && obj.pending !== true && enrollment.status !== 'completed') {
        await enrollment.update({ status: 'failed' });
      }
      return res.status(200).json({ success: true, received: true });
    }
    if (Number(obj.amount_cents) !== settlement.collectionAmountCents || obj.currency !== settlement.currency) {
      return next(new AppError('Paymob callback amount or currency does not match the settlement', 409));
    }

    const wasPaid = settlement.collectionStatus === 'paid';
    const isPaid = obj.success === true && obj.pending === false && obj.error_occured === false;
    const isRefunded = obj.is_refunded === true;
    if (wasPaid && !isPaid && !isRefunded) {
      return res.status(200).json({ success: true, received: true, ignored: true });
    }
    settlement.collectionStatus = isRefunded ? 'refunded' : isPaid ? 'paid' : obj.pending ? 'pending' : 'failed';
    settlement.paymobTransactionId = String(obj.id);
    settlement.paymentMethod = [obj.source_data?.type, obj.source_data?.sub_type].filter(Boolean).join(' — ') || null;
    settlement.lastCallbackAt = new Date();
    settlement.collectionFailureReason = settlement.collectionStatus === 'failed'
      ? obj.data?.message || 'Paymob reported an unsuccessful payment'
      : null;
    if (settlement.collectionStatus === 'paid' && !settlement.collectedAt) settlement.collectedAt = new Date();
    await settlement.save();

    if (settlement.collectionStatus === 'paid') {
      await processAutomaticPayouts(settlement);
      if (!wasPaid && !settlement.deletedAt) {
        try {
          await NotificationService.create({
            userId: settlement.organizerId,
            title: 'Event payment received',
            message: `Paymob confirmed the ${settlement.collectionAmountCents / 100} EGP test payment. Usher payouts are being processed.`,
            type: 'success',
            link: `/provider/events/${settlement.eventId}`,
          });
        } catch {
          // Collection and payout state remain authoritative if notification delivery fails.
        }
      }
    }

    return res.status(200).json({ success: true, received: true });
  }

  // Used only by future saved-card charging after Paymob enables the required CIT/MOTO integration.
  static async verifyStoredCardToken(req, res, next) {
    const card = await OrganizerCard.findOne({
      where: { id: req.params.cardId, organizerId: getOrganizerId(req.authUser), isActive: true, isLive: false },
    });
    if (!card) return next(new AppError('Saved card not found', 404));
    decryptCardToken(card);
    return res.status(200).json({ success: true, data: { valid: true } });
  }
}
