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
