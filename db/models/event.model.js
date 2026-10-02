import { DataTypes } from 'sequelize';
import { sequelize } from '../connection.js';
import { eventStatus, genderPreference, eventCategories } from '../../src/utils/constant/enums.js';

export const Event = sequelize.define(
  'Event',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    organizerId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    category: {
      type: DataTypes.ENUM(...Object.values(eventCategories)),
      allowNull: false,
    },
    eventDate: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    applicationDeadline: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    startTime: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    endTime: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    location: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    gatheringLocation: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    photo: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    mapImage: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    mapPins: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    requiredCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    genderPreference: {
      type: DataTypes.ENUM(...Object.values(genderPreference)),
      defaultValue: 'any',
    },
    specifyGenders: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    malesCount: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    femalesCount: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    budget: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    dressCode: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(eventStatus)),
      defaultValue: 'open',
    },
    hiredTalents: {
      type: DataTypes.ARRAY(DataTypes.UUID),
      defaultValue: [],
    },
    // Optional supervisor assigned to this event (must be organizer-staff role)
    supervisorId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'users', key: 'id' },
    },
    supervisorIds: {
      type: DataTypes.ARRAY(DataTypes.UUID),
      allowNull: false,
      defaultValue: [],
    },
    whatsappGroupId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    whatsappGroupLink: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // Optional venue pin. An usher within range of it can check in without a staff QR code.
    venueLatitude: {
      type: DataTypes.DOUBLE,
      allowNull: true,
      validate: { min: -90, max: 90 },
    },
    venueLongitude: {
      type: DataTypes.DOUBLE,
      allowNull: true,
      validate: { min: -180, max: 180 },
    },
    // prefund: the organization funds usher pay in advance and it is released after the event.
    // pay_after: a trusted organization pays through a post-event settlement checkout.
    fundingMode: {
      type: DataTypes.ENUM('prefund', 'pay_after'),
      allowNull: false,
      defaultValue: 'prefund',
    },
    fundsReleasedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    // Platform fee kept for booked ushers who did not attend, recorded when payments are released.
    noShowFeeCents: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    timestamps: true,
    tableName: 'events',
  },
);

Event.prototype.toJSON = function () {
  const values = { ...this.get() };
  values._id = values.id;
  values.providerId = values.organizerId;
  if (values.photo && typeof values.photo === 'object') {
    values.photo = values.photo.secure_url || values.photo.url || values.photo;
  }
  return values;
};
