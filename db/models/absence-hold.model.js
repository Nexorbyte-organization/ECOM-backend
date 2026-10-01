import { DataTypes } from 'sequelize';
import { sequelize } from '../connection.js';

// When a prefunded event is released, the pay of each usher marked absent is held here instead of
// going straight back to the organization. The usher can dispute the mark until `releaseAfter`;
// an undisputed hold then returns to the organization's credit, and an admin decides disputes.
export const AbsenceHold = sequelize.define(
  'AbsenceHold',
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
    talentId: {
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
      type: DataTypes.ENUM('held', 'disputed', 'returned_to_organizer', 'paid_to_usher'),
      allowNull: false,
      defaultValue: 'held',
    },
    releaseAfter: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    disputeReason: { type: DataTypes.TEXT, allowNull: true },
    disputedAt: { type: DataTypes.DATE, allowNull: true },
    resolvedBy: { type: DataTypes.UUID, allowNull: true },
    resolvedAt: { type: DataTypes.DATE, allowNull: true },
    resolution: {
      type: DataTypes.ENUM('expired', 'organizer_corrected', 'admin_usher', 'admin_organizer'),
      allowNull: true,
    },
    resolutionNote: { type: DataTypes.TEXT, allowNull: true },
    settlementId: { type: DataTypes.UUID, allowNull: true },
  },
  {
    timestamps: true,
    tableName: 'absence_holds',
    indexes: [
      { unique: true, fields: ['eventId', 'talentId'] },
      { fields: ['organizerId', 'status'] },
      { fields: ['talentId', 'status'] },
      { fields: ['status', 'releaseAfter'] },
    ],
  },
);

AbsenceHold.prototype.toJSON = function () {
  const values = { ...this.get() };
  values._id = values.id;
  values.amount = values.amountCents / 100;
  return values;
};
