import { DataTypes } from 'sequelize';
import { sequelize } from '../connection.js';

export const EventSettlement = sequelize.define(
  'EventSettlement',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    eventId: {
      type: DataTypes.UUID,
      allowNull: false,
      unique: true,
      references: { model: 'events', key: 'id' },
    },
    organizerId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    grossAmountCents: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: { min: 1 },
    },
    collectionAmountCents: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: { min: 1 },
    },
    platformFeeCents: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: { min: 0 },
    },
    usherAmountCents: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: { min: 0 },
    },
    cashDueAmountCents: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      validate: { min: 0 },
    },
    currency: {
      type: DataTypes.STRING(3),
      allowNull: false,
      defaultValue: 'EGP',
    },
    collectionStatus: {
      type: DataTypes.ENUM('not_started', 'pending', 'paid', 'failed', 'refunded'),
      allowNull: false,
      defaultValue: 'not_started',
    },
    payoutStatus: {
      type: DataTypes.ENUM('not_started', 'queued', 'processing', 'partially_paid', 'paid', 'failed'),
      allowNull: false,
      defaultValue: 'not_started',
    },
    specialReference: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    paymobIntentionId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    paymobOrderId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    paymobTransactionId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    paymobClientSecret: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    checkoutUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    selectedCardId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    collectedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    collectionFailureReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    isLive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    paymentMethod: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    lastCallbackAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    timestamps: true,
    tableName: 'event_settlements',
    indexes: [
      { fields: ['organizerId', 'collectionStatus'] },
      { fields: ['paymobOrderId'] },
      { fields: ['paymobTransactionId'] },
    ],
  },
);

EventSettlement.prototype.toJSON = function () {
  const values = { ...this.get() };
  delete values.paymobClientSecret;
  values._id = values.id;
  values.grossAmount = values.grossAmountCents / 100;
  values.collectionAmount = values.collectionAmountCents / 100;
  values.platformFee = values.platformFeeCents / 100;
  values.usherAmount = values.usherAmountCents / 100;
  values.cashDueAmount = values.cashDueAmountCents / 100;
  values.testMode = !values.isLive;
  return values;
};
