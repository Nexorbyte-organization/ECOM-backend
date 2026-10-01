import { Op } from 'sequelize';
import { OrganizerCard, SettlementLine, User } from '../../db/index.js';
import { AppError } from '../utils/appError.js';
import { NotificationService } from './notification.service.js';
import { classifyPayoutStatus, isPayoutSandboxConfigured, sendSandboxPayout } from './paymob-payout.service.js';

export const PLATFORM_FEE_PERCENT = 5;

export const maskDestination = (value) => {
  const normalized = String(value || '').replace(/\s+/g, '');
  if (!normalized) return null;
  return `${'*'.repeat(Math.max(4, normalized.length - 4))}${normalized.slice(-4)}`;
};

export const splitPlatformFee = (grossAmountCents) => {
  const platformFeeCents = Math.round(grossAmountCents * (PLATFORM_FEE_PERCENT / 100));
  return { grossAmountCents, platformFeeCents, usherAmountCents: grossAmountCents - platformFeeCents };
};

export const calculateSettlementLineAmounts = (budget) => {
  const grossAmountCents = Math.round(Number(budget) * 100);
  if (!Number.isFinite(grossAmountCents) || grossAmountCents <= 0) {
    throw new AppError('Event budget must be a positive amount', 400);
  }
  return splitPlatformFee(grossAmountCents);
};

export const publicLine = (line, talent = null) => {
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

export const serializeSettlement = async (settlement) => {
  const lines = await SettlementLine.findAll({
    where: { settlementId: settlement.id },
    order: [['createdAt', 'ASC']],
  });
  const talentIds = lines.map((line) => line.talentId);
  const talents = talentIds.length
    ? await User.findAll({ where: { id: { [Op.in]: talentIds } }, paranoid: false })
    : [];
  const talentsById = new Map(talents.map((talent) => [talent.id, talent]));
  return {
    ...settlement.toJSON(),
    payoutSandboxConfigured: isPayoutSandboxConfigured(),
    lines: lines.map((line) => publicLine(line, talentsById.get(line.talentId))),
  };
};

export const updateAggregatePayoutStatus = async (settlement) => {
  const lines = await SettlementLine.findAll({ where: { settlementId: settlement.id } });
  const statuses = lines.map((line) => line.payoutStatus);
  if (statuses.length > 0 && statuses.every((status) => status === 'paid')) {
    settlement.payoutStatus = 'paid';
  } else if (statuses.some((status) => status === 'paid')) {
    settlement.payoutStatus = 'partially_paid';
  } else if (statuses.some((status) => ['queued', 'processing', 'cash_due', 'awaiting_method'].includes(status))) {
    settlement.payoutStatus = 'processing';
  } else if (statuses.some((status) => status === 'failed')) {
    settlement.payoutStatus = 'failed';
  } else {
    settlement.payoutStatus = 'not_started';
  }
  await settlement.save();
};

export const processAutomaticPayouts = async (settlement, lineId = null) => {
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

// Paymob does not send a callback for a checkout that was abandoned, so an expired checkout
// would otherwise block the event forever. Once the checkout can no longer be paid, ask Paymob
// what happened to the order; without inquiry credentials, wait long enough for any delayed
// callback before treating the checkout as failed.
export const STALE_PREPARATION_MS = 10 * 60 * 1000;
export const EXPIRED_CHECKOUT_GRACE_MS = 15 * 60 * 1000;
export const UNVERIFIED_EXPIRY_GRACE_MS = 24 * 60 * 60 * 1000;

export const staleCheckoutAction = (checkout, now = new Date(), inquiryConfigured = false) => {
  if (checkout?.collectionStatus === 'not_started') {
    return now - new Date(checkout.updatedAt) > STALE_PREPARATION_MS ? 'fail_preparation' : null;
  }
  if (checkout?.collectionStatus !== 'pending' || !checkout.expiresAt) return null;
  const expiredFor = now - new Date(checkout.expiresAt);
  if (inquiryConfigured && checkout.paymobOrderId && expiredFor > EXPIRED_CHECKOUT_GRACE_MS) return 'inquire';
  if (expiredFor > UNVERIFIED_EXPIRY_GRACE_MS) return 'fail_expired';
  return null;
};

export const isPaidTransaction = (obj) => obj.success === true && obj.pending === false && obj.error_occured === false;

// Settles an abandoned or interrupted checkout (a settlement or an event funding) through the
// same path as its callback. `applyTransaction` records a transaction Paymob reports for it.
export const reconcileStaleCheckout = async (checkout, applyTransaction, inquireOrderTransaction) => {
  const action = staleCheckoutAction(checkout, new Date(), Boolean(process.env.PAYMOB_API_KEY?.trim()));
  if (!action) return checkout;
  if (action === 'fail_preparation') {
    await checkout.update({
      collectionStatus: 'failed',
      collectionFailureReason: 'Checkout preparation was interrupted. Start a new payment.',
    });
    return checkout;
  }
  if (action === 'inquire') {
    let transaction;
    try {
      transaction = await inquireOrderTransaction(checkout.paymobOrderId);
    } catch {
      return checkout; // Keep the checkout blocked until Paymob can be reached.
    }
    if (transaction) {
      try {
        await applyTransaction(checkout, transaction);
      } catch {
        // A mismatched inquiry result is left for manual reconciliation.
      }
      return checkout;
    }
    if (transaction === undefined) return checkout;
  }
  await checkout.update({
    collectionStatus: 'failed',
    collectionFailureReason: 'The checkout expired without a payment. Start a new payment.',
  });
  return checkout;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value) => typeof value === 'string' && UUID_PATTERN.test(value);

export const getCheckoutCard = async (cardId, organizerId) => {
  if (!cardId) return null;
  if (!isUuid(cardId)) throw new AppError('Invalid saved card ID', 400);
  const card = await OrganizerCard.findOne({
    where: { id: cardId, organizerId, isActive: true, isLive: false },
  });
  if (!card) throw new AppError('Saved card not found for this organization', 404);
  return card;
};

export const notifySafely = async (notification) => {
  try {
    await NotificationService.create(notification);
  } catch {
    // Payment state is authoritative even when a notification cannot be stored.
  }
};
