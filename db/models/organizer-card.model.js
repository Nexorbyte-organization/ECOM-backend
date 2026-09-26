import { DataTypes } from 'sequelize';
import { sequelize } from '../connection.js';

export const OrganizerCard = sequelize.define(
  'OrganizerCard',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    organizerId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    paymobCardTokenId: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    encryptedToken: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    tokenIv: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    tokenAuthTag: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    maskedPan: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    cardSubtype: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    cardholderName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    expiryMonth: {
      type: DataTypes.STRING(2),
      allowNull: true,
    },
    expiryYear: {
      type: DataTypes.STRING(4),
      allowNull: true,
    },
    isDefault: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    isLive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    timestamps: true,
    tableName: 'organizer_cards',
    indexes: [{ fields: ['organizerId', 'isActive'] }],
  },
);

OrganizerCard.prototype.toJSON = function () {
  const values = { ...this.get() };
  delete values.encryptedToken;
  delete values.tokenIv;
  delete values.tokenAuthTag;
  values._id = values.id;
  values.testMode = !values.isLive;
  return values;
};
