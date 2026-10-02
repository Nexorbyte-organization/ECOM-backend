import { DataTypes } from 'sequelize';
import { sequelize } from '../connection.js';

// Delivery history is independent of user-clearable notifications.
export const EventReminder = sequelize.define('EventReminder', {
  eventId: {
    type: DataTypes.UUID, primaryKey: true, references: { model: 'events', key: 'id' },
  },
  userId: {
    type: DataTypes.UUID, primaryKey: true, references: { model: 'users', key: 'id' },
  },
  startsAt: { type: DataTypes.DATE, primaryKey: true },
  sentAt: { type: DataTypes.DATE, allowNull: false },
}, { tableName: 'event_reminders', timestamps: true });
