import { Op } from 'sequelize';
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
import { resolvePayoutMethod } from '../services/payout-method.service.js';
import { isPayoutSandboxConfigured, sendSandboxPayout } from '../services/paymob-payout.service.js';

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

const buildLineDrafts = (eligibleUshers, budget) => {
  const amounts = calculateSettlementLineAmounts(budget);
  return eligibleUshers.map(({ attendance, talent }) => {
    const payout = resolvePayoutMethod(talent.paymentMethods || [], talent.fullName);
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

const processAutomaticPayouts = async (settlement) => {
  const lines = await SettlementLine.findAll({
    where: { settlementId: settlement.id, payoutStatus: 'queued' },
  });
  if (!lines.length || !isPayoutSandboxConfigured()) {
    await updateAggregatePayoutStatus(settlement);
    return;
  }

  settlement.payoutStatus = 'processing';
  await settlement.save();
  for (const line of lines) {
    const talent = await User.findByPk(line.talentId);
    if (!talent) {
      line.payoutStatus = 'failed';
      line.failureReason = 'Usher account not found';
      await line.save();
      continue;
    }

    line.payoutStatus = 'processing';
    await line.save();
    try {
      const payout = await sendSandboxPayout(line, talent);
      line.paymobPayoutTransactionId = payout.transactionId;
      line.failureReason = payout.description;
      if (['success', 'successful', 'paid', 'completed'].includes(payout.status)) {
        line.payoutStatus = 'paid';
        line.paidAt = new Date();
        await NotificationService.create({
          userId: talent.id,
          title: 'Event payment sent',
          message: `Your ${line.usherAmountCents / 100} EGP payment was sent through Paymob Test Mode.`,
          type: 'success',
          link: '/talent/events',
        });
      } else if (['pending', 'processing', 'queued'].includes(payout.status)) {
        line.payoutStatus = 'processing';
      } else {
        line.payoutStatus = 'failed';
      }
    } catch (error) {
      line.payoutStatus = 'failed';
      line.failureReason = error.message;
    }
    await line.save();
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
    const drafts = buildLineDrafts(await loadEligibleUshers(event), event.budget);
    const totals = summarizeDrafts(drafts);
    const cardId = req.body?.cardId || null;
    if (cardId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cardId)) {
      return next(new AppError('Invalid saved card ID', 400));
    }
    const card = cardId ? await OrganizerCard.findOne({
      where: { id: cardId, organizerId, isActive: true, isLive: false },
    }) : null;
    if (cardId && !card) return next(new AppError('Saved card not found for this organization', 404));

    let settlement = await EventSettlement.findOne({ where: { eventId: event.id } });
    if (settlement?.collectionStatus === 'paid') {
      return next(new AppError('This event settlement has already been collected', 409));
    }
    if (
      settlement?.collectionStatus === 'pending'
      && settlement.checkoutUrl
      && settlement.expiresAt
      && new Date(settlement.expiresAt) > new Date()
    ) {
      if (cardId !== (settlement.selectedCardId || null)) {
        return next(new AppError('An existing checkout is still active. Continue it or retry after it expires.', 409));
      }
      return res.status(200).json({ success: true, data: await serializeSettlement(settlement) });
    }

    if (!settlement) {
      settlement = await EventSettlement.create({
        eventId: event.id,
        organizerId,
        ...totals,
        specialReference: `OO-SET-${event.id}-${Date.now()}`,
        isLive: false,
      });
    } else {
      await settlement.update({
        ...totals,
        collectionStatus: 'not_started',
        payoutStatus: 'not_started',
        specialReference: `OO-SET-${event.id}-${Date.now()}`,
        paymobIntentionId: null,
        paymobOrderId: null,
        paymobTransactionId: null,
        paymobClientSecret: null,
        checkoutUrl: null,
        selectedCardId: null,
        expiresAt: null,
        collectionFailureReason: null,
        isLive: false,
      });
      await SettlementLine.destroy({ where: { settlementId: settlement.id } });
    }

    await SettlementLine.bulkCreate(drafts.map((line) => ({
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
    })));

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

    return res.status(201).json({ success: true, data: await serializeSettlement(settlement) });
  }

  static async getEventSettlement(req, res) {
    const event = await requireOwnedCompletedEvent(req.params.id, req.authUser);
    const settlement = await EventSettlement.findOne({ where: { eventId: event.id } });
    return res.status(200).json({
      success: true,
      data: settlement ? await serializeSettlement(settlement) : null,
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
    line.payoutStatus = 'paid';
    line.paidAt = new Date();
    line.failureReason = null;
    await line.save();
    await updateAggregatePayoutStatus(settlement);
    await NotificationService.create({
      userId: line.talentId,
      title: 'Cash payment recorded',
      message: `The organization recorded your ${line.usherAmountCents / 100} EGP event payment as paid in cash.`,
      type: 'success',
      link: '/talent/events',
    });
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
        where: { paymobOrderId: String(obj.order_id), isLive: false },
      });
      const enrollment = settlement ? null : await OrganizerCardEnrollment.findOne({
        where: { paymobOrderId: String(obj.order_id) },
      });
      if (!settlement && !enrollment) return next(new AppError('No test checkout matches this card token', 404));
      const organizerId = settlement?.organizerId || enrollment.organizerId;
      const existingCard = await OrganizerCard.findOne({ where: { paymobCardTokenId: String(obj.id) } });
      if (existingCard && existingCard.organizerId !== organizerId) {
        return next(new AppError('Card token is already assigned to another organization', 409));
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
      ? await EventSettlement.findOne({ where: { [Op.or]: whereOptions, isLive: false } })
      : null;
    if (!settlement) {
      const enrollment = orderId ? await OrganizerCardEnrollment.findOne({ where: { paymobOrderId: orderId } }) : null;
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
    settlement.collectionStatus = isRefunded ? 'refunded' : isPaid ? 'paid' : obj.pending ? 'pending' : 'failed';
    settlement.paymobTransactionId = String(obj.id);
    settlement.paymentMethod = [obj.source_data?.type, obj.source_data?.sub_type].filter(Boolean).join(' — ') || null;
    settlement.lastCallbackAt = new Date();
    settlement.collectionFailureReason = settlement.collectionStatus === 'failed'
      ? obj.data?.message || 'Paymob reported an unsuccessful payment'
      : null;
    if (isPaid && !settlement.collectedAt) settlement.collectedAt = new Date();
    await settlement.save();

    if (isPaid && !wasPaid) {
      await NotificationService.create({
        userId: settlement.organizerId,
        title: 'Event payment received',
        message: `Paymob confirmed the ${settlement.collectionAmountCents / 100} EGP test payment. Usher payouts are being processed.`,
        type: 'success',
        link: `/provider/events/${settlement.eventId}`,
      });
      await processAutomaticPayouts(settlement);
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
