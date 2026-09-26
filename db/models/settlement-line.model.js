import { DataTypes } from 'sequelize';
import { sequelize } from '../connection.js';

export const SettlementLine = sequelize.define(
  'SettlementLine',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    settlementId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'event_settlements', key: 'id' },
    },
    eventId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'events', key: 'id' },
    },
    talentId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    attendanceStatus: {
      type: DataTypes.ENUM('present', 'late'),
      allowNull: false,
    },
    grossAmountCents: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    collectionAmountCents: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    platformFeeCents: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    usherAmountCents: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    payoutMethodType: {
      type: DataTypes.ENUM('wallet', 'bank', 'cash'),
      allowNull: false,
      defaultValue: 'cash',
    },
    payoutProvider: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    payoutDestination: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    payoutMetadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    payoutStatus: {
      type: DataTypes.ENUM('cash_due', 'queued', 'processing', 'paid', 'failed'),
      allowNull: false,
    },
    paymobPayoutTransactionId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    failureReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    paidAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    timestamps: true,
    tableName: 'settlement_lines',
    indexes: [
      { unique: true, fields: ['settlementId', 'talentId'] },
      { fields: ['talentId', 'payoutStatus'] },
    ],
  },
);

SettlementLine.prototype.toJSON = function () {
  const values = { ...this.get() };
  values._id = values.id;
  values.grossAmount = values.grossAmountCents / 100;
  values.collectionAmount = values.collectionAmountCents / 100;
  values.platformFee = values.platformFeeCents / 100;
  values.usherAmount = values.usherAmountCents / 100;
  return values;
};
