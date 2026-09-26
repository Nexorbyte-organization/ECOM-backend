import { DataTypes } from 'sequelize';
import { sequelize } from '../connection.js';

export const OrganizerCardEnrollment = sequelize.define('OrganizerCardEnrollment', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  organizerId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  paymobOrderId: { type: DataTypes.STRING, allowNull: true, unique: true },
  paymobIntentionId: { type: DataTypes.STRING, allowNull: true },
  checkoutUrl: { type: DataTypes.TEXT, allowNull: true },
  status: {
    type: DataTypes.ENUM('pending', 'completed', 'failed'),
    allowNull: false,
    defaultValue: 'pending',
  },
  expiresAt: { type: DataTypes.DATE, allowNull: true },
}, {
  timestamps: true,
  tableName: 'organizer_card_enrollments',
  indexes: [{ fields: ['organizerId', 'status'] }],
});

OrganizerCardEnrollment.prototype.toJSON = function () {
  const values = { ...this.get() };
  delete values.checkoutUrl;
  return values;
};
