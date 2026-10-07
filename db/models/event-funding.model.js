import { DataTypes, Op } from 'sequelize';
import { sequelize } from '../connection.js';

// Money an organization puts in advance toward an event's usher pay. A Paymob row is one checkout;
// a credit row moves part of the organization's credit balance onto the event. Funds stay held
// until the event's payments are released or the event is cancelled.
export const EventFunding = sequelize.define(
  'EventFunding',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    eventId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'events', key: 'id' },
    },
    organizerId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    source: {
      type: DataTypes.ENUM('paymob', 'credit'),
      allowNull: false,
    },
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
    collectionStatus: {
      type: DataTypes.ENUM('not_started', 'pending', 'paid', 'failed', 'refunded'),
      allowNull: false,
      defaultValue: 'not_started',
    },
    specialReference: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    paymobIntentionId: { type: DataTypes.STRING, allowNull: true },
    paymobOrderId: { type: DataTypes.STRING, allowNull: true },
    paymobTransactionId: { type: DataTypes.STRING, allowNull: true },
    paymobClientSecret: { type: DataTypes.TEXT, allowNull: true },
    checkoutUrl: { type: DataTypes.TEXT, allowNull: true },
    selectedCardId: { type: DataTypes.UUID, allowNull: true },
    expiresAt: { type: DataTypes.DATE, allowNull: true },
    collectedAt: { type: DataTypes.DATE, allowNull: true },
    collectionFailureReason: { type: DataTypes.TEXT, allowNull: true },
    paymentMethod: { type: DataTypes.STRING, allowNull: true },
    lastCallbackAt: { type: DataTypes.DATE, allowNull: true },
    isLive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    timestamps: true,
    tableName: 'event_fundings',
    indexes: [
      { fields: ['eventId', 'collectionStatus'] },
      { fields: ['organizerId'] },
      { fields: ['paymobOrderId'] },
      // At most one Paymob checkout per event may be in progress, so two clicks cannot charge twice.
      {
        name: 'event_fundings_active_checkout_unique',
        unique: true,
        fields: ['eventId'],
        where: { source: 'paymob', collectionStatus: { [Op.in]: ['not_started', 'pending'] }, deletedAt: null },
      },
    ],
  },
);

EventFunding.prototype.toJSON = function () {
  const values = { ...this.get() };
  delete values.paymobClientSecret;
  values._id = values.id;
  values.amount = values.amountCents / 100;
  values.testMode = !values.isLive;
  return values;
};
