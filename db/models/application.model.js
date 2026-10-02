import { DataTypes } from 'sequelize';
import { sequelize } from '../connection.js';
import { applicationStatus } from '../../src/utils/constant/enums.js';

export const Application = sequelize.define(
  'Application',
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
    talentId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    status: {
      type: DataTypes.ENUM(...Object.values(applicationStatus)),
      defaultValue: 'pending',
    },
    isDirect: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    // The usher agreed to be on standby if the event is full. A standby invitation counts as
    // agreement once accepted.
    standbyOk: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    // A direct invitation to join the standby list rather than a hired spot.
    standbyInvite: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    // Position in the standby queue: earliest is moved in first.
    standbySince: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    // When the usher was moved in from standby; an excuse shortly after it is not late.
    promotedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    referredBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'users', key: 'id' },
    },
    appliedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    timestamps: true,
    tableName: 'applications',
    indexes: [{ unique: true, fields: ['eventId', 'talentId'] }],
  },
);

Application.prototype.toJSON = function () {
  const values = { ...this.get() };
  values._id = values.id;
  return values;
};
