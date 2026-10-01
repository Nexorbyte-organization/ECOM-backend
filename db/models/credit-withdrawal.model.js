import { DataTypes } from 'sequelize';
import { sequelize } from '../connection.js';

// An organization's request to receive part of its credit balance as money. The amount is
// reserved from the balance when requested; an admin pays it outside the platform and records it,
// or rejects it, which returns the reserved credit.
export const CreditWithdrawal = sequelize.define(
  'CreditWithdrawal',
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
      validate: { min: 1 },
    },
    currency: {
      type: DataTypes.STRING(3),
      allowNull: false,
      defaultValue: 'EGP',
    },
    status: {
      type: DataTypes.ENUM('pending', 'paid', 'rejected', 'cancelled'),
      allowNull: false,
      defaultValue: 'pending',
    },
    requestedBy: { type: DataTypes.UUID, allowNull: true },
    resolvedBy: { type: DataTypes.UUID, allowNull: true },
    resolvedAt: { type: DataTypes.DATE, allowNull: true },
    adminNote: { type: DataTypes.TEXT, allowNull: true },
    payoutReference: { type: DataTypes.STRING, allowNull: true },
  },
  {
    timestamps: true,
    tableName: 'credit_withdrawals',
    indexes: [{ fields: ['organizerId', 'status'] }, { fields: ['status', 'createdAt'] }],
  },
);

CreditWithdrawal.prototype.toJSON = function () {
  const values = { ...this.get() };
  values._id = values.id;
  values.amount = values.amountCents / 100;
  return values;
};
