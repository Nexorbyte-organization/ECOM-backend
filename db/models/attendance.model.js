import { DataTypes } from 'sequelize';
import { sequelize } from '../connection.js';
import { attendanceStatus } from '../../src/utils/constant/enums.js';

export const Attendance = sequelize.define(
  'Attendance',
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
      type: DataTypes.ENUM(...Object.values(attendanceStatus)),
      allowNull: false,
    },
    checkInTime: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    checkOutTime: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    // qr: the usher scanned the event QR; the organization cannot override it with an absent mark.
    checkInMethod: {
      type: DataTypes.ENUM('qr', 'manual', 'admin'),
      allowNull: false,
      defaultValue: 'manual',
    },
  },
  {
    timestamps: true,
    tableName: 'attendances',
    indexes: [{ unique: true, fields: ['eventId', 'talentId'] }],
  },
);

Attendance.prototype.toJSON = function () {
  const values = { ...this.get() };
  values._id = values.id;
  return values;
};
