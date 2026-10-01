import { DataTypes } from 'sequelize';
import { sequelize } from '../connection.js';

export const CREDIT_ENTRY_TYPES = [
  'event_surplus', // unused event funding returned after release
  'absence_release', // an absent usher's held pay returned after the dispute window
  'cancellation_refund', // the refundable part of a cancelled event's funding
  'late_funding_refund', // a checkout paid after the event no longer needed it
  'funding_applied', // credit moved onto an event's funding (negative)
  'withdrawal', // credit reserved for a withdrawal request (negative)
  'withdrawal_reversal', // a rejected or cancelled withdrawal returned
  'chargeback', // a Paymob refund of funding that had already been released (negative)
  'admin_adjustment',
];

// Append-only ledger: rows are never deleted, and a correction is a new entry. The balance is the
// sum of an organization's entries. `reference` is unique so every credit or debit is applied
// exactly once, even when a callback or request repeats.
export const OrganizerCreditEntry = sequelize.define(
  'OrganizerCreditEntry',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    organizerId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    amountCents: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: { notZero: (value) => { if (Number(value) === 0) throw new Error('Credit entries cannot be zero'); } },
    },
    currency: {
      type: DataTypes.STRING(3),
      allowNull: false,
      defaultValue: 'EGP',
    },
    type: {
      type: DataTypes.ENUM(...CREDIT_ENTRY_TYPES),
      allowNull: false,
    },
    reference: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    eventId: { type: DataTypes.UUID, allowNull: true },
    fundingId: { type: DataTypes.UUID, allowNull: true },
    withdrawalId: { type: DataTypes.UUID, allowNull: true },
    note: { type: DataTypes.TEXT, allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: true },
  },
  {
    timestamps: true,
    tableName: 'organizer_credit_entries',
    indexes: [{ fields: ['organizerId', 'createdAt'] }],
  },
);

OrganizerCreditEntry.prototype.toJSON = function () {
  const values = { ...this.get() };
  values._id = values.id;
  values.amount = values.amountCents / 100;
  return values;
};
