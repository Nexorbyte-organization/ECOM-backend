import { Op } from 'sequelize';
import { EventFunding, FundingRefund } from '../../db/index.js';
import { OrganizerCreditService } from './organizer-credit.service.js';
import { refundTransaction } from './paymob.service.js';
import { isPaidTransaction, notifySafely } from './settlement.service.js';

const egp = (cents) => cents / 100;
const COUNTED_REFUND_STATUSES = ['pending', 'processing', 'succeeded'];

// Splits money returned to an organization between the cards that paid the event (latest payment
// first) and credit, for the part that was paid from credit.
export const allocateReturn = ({ amountCents, fundings, refundedByFunding = new Map() }) => {
  let remaining = Math.max(0, amountCents);
  const refunds = [];
  const cardFundings = fundings
    .filter((funding) => funding.source === 'paymob' && funding.collectionStatus === 'paid')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  for (const funding of cardFundings) {
    if (remaining <= 0) break;
    const refundable = funding.amountCents - (refundedByFunding.get(funding.id) || 0);
    const amount = Math.min(refundable, remaining);
    if (amount > 0) {
      refunds.push({ funding, amountCents: amount });
      remaining -= amount;
    }
  }
  return { refunds, creditCents: remaining };
};

const CREDIT_TYPES = { no_show: 'no_show_refund', surplus: 'event_surplus', cancellation: 'cancellation_refund' };

export class FundingRefundService {
  static async refundedByFunding(fundingIds, { transaction } = {}) {
    if (!fundingIds.length) return new Map();
    const refunds = await FundingRefund.findAll({
      where: { fundingId: { [Op.in]: fundingIds }, status: { [Op.in]: COUNTED_REFUND_STATUSES } },
      transaction,
    });
    const totals = new Map();
    refunds.forEach((refund) => totals.set(refund.fundingId, (totals.get(refund.fundingId) || 0) + refund.amountCents));
    return totals;
  }

  // Records where returned money goes, inside the caller's transaction. Card refunds are sent by
  // processPending once the transaction commits.
  static async returnFunds({ event, amountCents, reason, transaction }) {
    if (amountCents <= 0) return { refunds: [], creditCents: 0 };
    const fundings = await EventFunding.findAll({ where: { eventId: event.id, collectionStatus: 'paid' }, transaction });
    const refundedByFunding = await this.refundedByFunding(fundings.map((funding) => funding.id), { transaction });
    const plan = allocateReturn({ amountCents, fundings, refundedByFunding });
    const refunds = [];
    for (const { funding, amountCents: amount } of plan.refunds) {
      const [refund] = await FundingRefund.findOrCreate({
        where: { reference: `${reason}:${funding.id}` },
        defaults: { fundingId: funding.id, eventId: event.id, organizerId: event.organizerId, amountCents: amount, reason },
        transaction,
      });
      refunds.push(refund);
    }
    if (plan.creditCents > 0) {
      await OrganizerCreditService.addEntry({
        organizerId: event.organizerId, amountCents: plan.creditCents, type: CREDIT_TYPES[reason],
        reference: `${reason}:${event.id}`, eventId: event.id,
      }, { transaction });
    }
    return { refunds, creditCents: plan.creditCents };
  }

  // Sends pending card refunds. Each refund is claimed before the request so it is sent once; a
  // refund Paymob rejects becomes credit so the organization never loses the money.
  static async processPending({ eventId } = {}) {
    const pending = await FundingRefund.findAll({ where: { status: 'pending', ...(eventId ? { eventId } : {}) }, limit: 100 });
    for (const refund of pending) {
      const [claimed] = await FundingRefund.update({ status: 'processing' }, { where: { id: refund.id, status: 'pending' } });
      if (!claimed) continue;
      const funding = await EventFunding.findByPk(refund.fundingId, { paranoid: false });
      try {
        const result = await refundTransaction({ transactionId: funding?.paymobTransactionId, amountCents: refund.amountCents });
        if (!isPaidTransaction(result) && result?.pending !== true) {
          throw new Error(result?.data?.message || 'Paymob did not accept the refund');
        }
        await refund.update({ status: 'succeeded', paymobRefundTransactionId: result?.id ? String(result.id) : null, processedAt: new Date() });
        await notifySafely({
          userId: refund.organizerId,
          title: 'Refund sent to your card',
          message: `${egp(refund.amountCents)} EGP was refunded to the card that paid for the event.`,
          type: 'success',
          link: '/provider/payments',
        });
      } catch (error) {
        await refund.update({ status: 'failed', failureReason: String(error?.message || error).slice(0, 500), processedAt: new Date() });
        await OrganizerCreditService.addEntry({
          organizerId: refund.organizerId, amountCents: refund.amountCents, type: 'card_refund_failed',
          reference: `refund-failed:${refund.id}`, eventId: refund.eventId, fundingId: refund.fundingId,
          note: 'The card refund could not be completed, so the amount was added to your credit',
        });
        await notifySafely({
          userId: refund.organizerId,
          title: 'Refund added to your credit',
          message: `The card refund of ${egp(refund.amountCents)} EGP could not be completed, so it was added to your credit for your next event.`,
          type: 'warning',
          link: '/provider/payments',
        });
      }
    }
    return pending.length;
  }

  static async listForEvent(eventId) {
    return FundingRefund.findAll({ where: { eventId }, order: [['createdAt', 'ASC']] });
  }

  // Card refunds Paymob rejected; each one was added to the organization's credit.
  static async listFailed({ limit = 50 } = {}) {
    return FundingRefund.findAll({ where: { status: 'failed' }, order: [['createdAt', 'DESC']], limit });
  }

  static async listForOrganizer(organizerId, { limit = 50 } = {}) {
    return FundingRefund.findAll({ where: { organizerId }, order: [['createdAt', 'DESC']], limit });
  }

  // Paymob reports refunds we sent as transaction callbacks on the original order. They are already
  // recorded, so they must not change the funding.
  static async isOwnRefundCallback(funding, obj) {
    if (obj.is_refund === true || obj.is_void === true) return true;
    if (obj.is_refunded !== true) return false;
    const ours = (await this.refundedByFunding([funding.id])).get(funding.id) || 0;
    const reported = Number(obj.refunded_amount_cents || 0);
    return ours > 0 && reported <= ours;
  }
}
