import { DataTypes } from 'sequelize';
import { sequelize } from '../connection.js';
import { attendanceStatus } from '../../src/utils/constant/enums.js';

// manual and admin remain for records created before self check-in.
export const CHECK_IN_METHODS = ['qr', 'code', 'location', 'staff', 'auto', 'manual', 'admin'];
// Attendance the usher proved themselves.
export const SELF_CHECK_IN_METHODS = ['qr', 'code', 'location'];

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
    // Which event day (0-based, in date order) this record is for; ushers check in every day.
    dayIndex: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
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
    // How attendance was proven. The usher's own proofs (qr, code, location) cannot be changed by
    // the organization; staff can only check someone in, and `auto` marks a missed check-in absent.
    checkInMethod: {
      type: DataTypes.ENUM(...CHECK_IN_METHODS),
      allowNull: false,
      defaultValue: 'manual',
    },
    checkInLatitude: { type: DataTypes.DOUBLE, allowNull: true },
    checkInLongitude: { type: DataTypes.DOUBLE, allowNull: true },
    checkInPointId: { type: DataTypes.UUID, allowNull: true },
    recordedBy: { type: DataTypes.UUID, allowNull: true },
  },
  {
    timestamps: true,
    tableName: 'attendances',
    indexes: [{ unique: true, fields: ['eventId', 'talentId', 'dayIndex'], name: 'attendances_event_talent_day_unique' }],
  },
);

Attendance.prototype.toJSON = function () {
  const values = { ...this.get() };
  values._id = values.id;
  return values;
};
