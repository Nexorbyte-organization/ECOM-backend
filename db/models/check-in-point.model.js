import { DataTypes } from 'sequelize';
import { sequelize } from '../connection.js';

// A staff member's phone showing the live check-in code for an event: at a gathering point, in a
// bus, or at the venue. The phone reports its location while the screen is open, and an usher
// must be near it to check in. `secret` signs the rotating QR and typed codes and never leaves
// the server.
export const CheckInPoint = sequelize.define(
  'CheckInPoint',
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
    staffUserId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    label: { type: DataTypes.STRING(80), allowNull: true },
    secret: { type: DataTypes.STRING(64), allowNull: false },
    latitude: { type: DataTypes.DOUBLE, allowNull: true },
    longitude: { type: DataTypes.DOUBLE, allowNull: true },
    accuracyMeters: { type: DataTypes.DOUBLE, allowNull: true },
    locationUpdatedAt: { type: DataTypes.DATE, allowNull: true },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    timestamps: true,
    tableName: 'check_in_points',
    indexes: [
      { unique: true, fields: ['eventId', 'staffUserId'] },
      { fields: ['eventId', 'active'] },
    ],
  },
);

CheckInPoint.prototype.toJSON = function () {
  const values = { ...this.get() };
  delete values.secret;
  values._id = values.id;
  return values;
};
