import { DataTypes } from 'sequelize';
import { sequelize } from '../connection.js';
import { eventActionRequestStatus, eventActionRequestType } from '../../src/utils/constant/enums.js';

export const EventActionRequest = sequelize.define(
  'EventActionRequest',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    eventId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    organizerId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    requestType: {
      type: DataTypes.ENUM(...Object.values(eventActionRequestType)),
      allowNull: false,
    },
    reason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(eventActionRequestStatus)),
      allowNull: false,
      defaultValue: eventActionRequestStatus.PENDING,
    },
    resolvedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'users', key: 'id' },
    },
    resolvedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    timestamps: true,
    tableName: 'event_action_requests',
    indexes: [
      { fields: ['eventId', 'status'] },
      { fields: ['organizerId', 'status'] },
    ],
  },
);

EventActionRequest.prototype.toJSON = function () {
  const values = { ...this.get() };
  values._id = values.id;
  values.providerId = values.organizerId;
  return values;
};
