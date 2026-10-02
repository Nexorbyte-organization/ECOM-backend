import { DataTypes } from 'sequelize';
import { sequelize } from '../connection.js';

// Event funding returned to the card that paid it. Money comes back the way it came in: card
// payments are refunded through Paymob, and only funding paid from credit returns to credit. A
// refund Paymob rejects becomes organization credit so the money is never lost.
export const FundingRefund = sequelize.define(
  'FundingRefund',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    fundingId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'event_fundings', key: 'id' },
    },
    eventId: { type: DataTypes.UUID, allowNull: false },
    organizerId: { type: DataTypes.UUID, allowNull: false },
    amountCents: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: { min: 1 },
    },
    currency: {
      type: DataTypes.STRING(3),
      allowNull: false,
      defaultValue: 'EGP',
    },
    // no_show: wages of booked ushers who did not attend; surplus: unused funding;
    // cancellation: the refundable share of a cancelled event.
    reason: {
      type: DataTypes.ENUM('no_show', 'surplus', 'cancellation'),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('pending', 'processing', 'succeeded', 'failed'),
      allowNull: false,
      defaultValue: 'pending',
    },
    reference: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    paymobRefundTransactionId: { type: DataTypes.STRING, allowNull: true },
    failureReason: { type: DataTypes.TEXT, allowNull: true },
    processedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    timestamps: true,
    tableName: 'funding_refunds',
    indexes: [{ fields: ['fundingId'] }, { fields: ['eventId'] }, { fields: ['status'] }],
  },
);

FundingRefund.prototype.toJSON = function () {
  const values = { ...this.get() };
  values._id = values.id;
  values.amount = values.amountCents / 100;
  return values;
};
