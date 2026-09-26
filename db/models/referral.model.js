import { DataTypes } from 'sequelize';
import { sequelize } from '../connection.js';
import { referralStatus } from '../../src/utils/constant/enums.js';

export const Referral = sequelize.define(
  'Referral',
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
    referrerTalentId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    referredTalentId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    status: {
      type: DataTypes.ENUM(...Object.values(referralStatus)),
      defaultValue: 'pending',
    },
  },
  {
    timestamps: true,
    tableName: 'referrals',
    indexes: [{ fields: ['eventId', 'referredTalentId', 'status'] }],
  },
);

Referral.prototype.toJSON = function () {
  const values = { ...this.get() };
  values._id = values.id;
  return values;
};
