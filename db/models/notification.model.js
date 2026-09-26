import { DataTypes } from 'sequelize';
import { sequelize } from '../connection.js';

export const Notification = sequelize.define(
  'Notification',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    type: {
      type: DataTypes.ENUM('info', 'success', 'warning', 'danger'),
      allowNull: false,
      defaultValue: 'info',
    },
    link: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    isRead: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    timestamps: true,
    tableName: 'notifications',
    indexes: [{ fields: ['userId', 'isRead', 'createdAt'] }],
  },
);

Notification.prototype.toJSON = function () {
  const values = { ...this.get() };
  values._id = values.id;
  return values;
};
