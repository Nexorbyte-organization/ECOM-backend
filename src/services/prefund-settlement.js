import { EventSettlement, SettlementLine } from '../../db/index.js';
import { resolvePayoutMethod } from './payout-method.service.js';

// Settlement line values for a prefunded payment. Ushers without a supported payout account keep
// their pay held (awaiting_method) instead of being paid in cash by the organization.
export const prefundedLineValues = ({ talent, amounts, settlementId, eventId, lineType, attendanceStatus = null }) => {
  const payout = resolvePayoutMethod(talent?.paymentMethods || [], talent?.fullName || '');
  const digital = payout.type !== 'cash';
  return {
    settlementId,
    eventId,
    talentId: talent.id,
    lineType,
    attendanceStatus,
    grossAmountCents: amounts.grossAmountCents,
    collectionAmountCents: amounts.grossAmountCents,
    platformFeeCents: amounts.platformFeeCents,
    usherAmountCents: amounts.usherAmountCents,
    payoutMethodType: digital ? payout.type : 'cash',
    payoutProvider: digital ? payout.provider : null,
    payoutDestination: digital ? payout.destination : null,
    payoutMetadata: digital ? payout.metadata : null,
    payoutStatus: digital ? 'queued' : 'awaiting_method',
    failureReason: digital ? null : 'Waiting for the usher to add a supported payout account',
  };
};

export const settlementTotals = (lines) => lines.reduce((totals, line) => ({
  grossAmountCents: totals.grossAmountCents + line.grossAmountCents,
  collectionAmountCents: totals.collectionAmountCents + line.collectionAmountCents,
  platformFeeCents: totals.platformFeeCents + line.platformFeeCents,
  usherAmountCents: totals.usherAmountCents + line.usherAmountCents,
}), { grossAmountCents: 0, collectionAmountCents: 0, platformFeeCents: 0, usherAmountCents: 0 });

// A settlement paid from funds already held for the event, so no Paymob collection is needed.
export const createPrefundedSettlement = async ({ event, targetTalentId = null, specialReference, lineDrafts, transaction }) => {
  const settlement = await EventSettlement.create({
    eventId: event.id,
    organizerId: event.organizerId,
    targetTalentId,
    ...settlementTotals(lineDrafts.map(({ amounts }) => ({ ...amounts, collectionAmountCents: amounts.grossAmountCents }))),
    cashDueAmountCents: 0,
    collectionStatus: 'paid',
    payoutStatus: 'not_started',
    specialReference,
    fundingSource: 'prefund',
    collectedAt: new Date(),
    paymentMethod: 'Event funds held in advance',
    isLive: false,
  }, { transaction });
  await SettlementLine.bulkCreate(lineDrafts.map((draft) => prefundedLineValues({
    ...draft, settlementId: settlement.id, eventId: event.id,
  })), { transaction });
  return settlement;
};
