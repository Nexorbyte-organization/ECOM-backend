import { DataTypes } from 'sequelize';
import { sequelize } from '../connection.js';
import { eventCategories, language, roles, status } from '../../src/utils/constant/enums.js';

export const User = sequelize.define(
  'User',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    fullName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    userName: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    role: {
      type: DataTypes.ENUM(...Object.values(roles)),
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      set(value) {
        this.setDataValue('email', value.toLowerCase().trim());
      },
    },
    password: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    mobileNumber: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
    },
    city: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    organizationId: {
      type: DataTypes.ARRAY(DataTypes.UUID),
      allowNull: true,
      // references: {
      //   model: 'organizations',
      //   key: 'id',
      // },
    },
    experience: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    languages: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: true,
      validate: {
        isValidLanguage(value) {
          if (value) {
            const allowed = Object.values(language);
            value.forEach((v) => {
              if (!allowed.includes(v)) throw new Error(`Invalid language: ${v}`);
            });
          }
        },
      },
    },
    eventCategories: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: true,
      validate: {
        isValidCategory(value) {
          if (value) {
            const allowed = Object.values(eventCategories);
            value.forEach((v) => {
              if (!allowed.includes(v)) throw new Error(`Invalid category: ${v}`);
            });
          }
        },
      },
    },
    portfolio: {
      type: DataTypes.ARRAY(DataTypes.JSON),
      allowNull: true,
    },
    // Organizer-specific info (description, website) — stored separately to avoid polluting portfolio
    organizationInfo: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: null,
    },
    // portfolio picture avatar default picture
    portfolioPicture: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: {
        secure_url: "https://res.cloudinary.com/dvz0zvpof/image/upload/v1727788484/Default_pfp.svg_v7dmtb.png",
        public_id: "default_avatar"
      }
    },
    isEmailVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    // admin verification
    isVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    otp: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    otpExpiry: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    otpAttempts: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    lastOtpRequest: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    otpVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    refreshTokenHash: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    refreshTokenExpiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    rate: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(status)),
      defaultValue: 'pending',
    },
    isBlocked: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    lateExcuseCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    consecutiveGoodEvents: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    // Set automatically after repeated no-shows; the usher cannot take new work until it passes.
    suspendedUntil: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    // Talent stats
    totalRatings: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    completedEventsCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    reliabilityScore: {
      type: DataTypes.FLOAT,
      defaultValue: 100,
    },
    // Talent preferences
    refusedCategories: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: true,
      defaultValue: [],
    },
    availabilityDates: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: true,
      defaultValue: [],
    },
    workCities: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: true,
      defaultValue: [],
    },
    education: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    whatsappNumber: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    whatsappConsentGiven: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    whatsappConsentGivenAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    // Payment methods (usher-specific)
    paymentMethods: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: [],
    },
    // Staff link: points to the organizer (provider) User.id this staff belongs to
    providerOwnerId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'users', key: 'id' },
    },
    // Admin decision that replaces the automatic organization payment tier; null means automatic.
    paymentTierOverride: {
      type: DataTypes.ENUM('standard', 'trusted'),
      allowNull: true,
    },
  },
  {
    timestamps: true,
    tableName: 'users',
  },
);

// ✅ Hide password from JSON responses
User.prototype.toJSON = function () {
  const values = { ...this.get() };
  delete values.password;
  delete values.refreshTokenHash;
  delete values.refreshTokenExpiresAt;
  values._id = values.id;
  values.userId = values.id;
  values.frontendRole = {
    usher: 'talent',
    organizer: 'provider',
    organizer_member: 'provider_member',
    organizer_supervisor: 'provider_supervisor',
  }[values.role] || values.role;

  if (values.role === 'usher') {
    values.photo = values.portfolioPicture?.secure_url || '';
    values.experienceYears = values.experience;
    values.categories = values.eventCategories || [];
    values.portfolioImages = (values.portfolio || []).map((item) => item?.secure_url || item);
    values.phoneNumber = values.mobileNumber;
    values.ratingAverage = values.rate;
    values.paymentMethods = (values.paymentMethods || []).map((method) => ({
      ...method,
      id: method.id || method._id,
      _id: method._id || method.id,
    }));
  } else if (values.role === 'organizer') {
    values.companyName = values.fullName;
    values.logo = values.portfolioPicture?.secure_url || '';
    values.description = values.organizationInfo?.description || '';
    values.location = values.city || '';
    values.phone = values.mobileNumber || '';
    values.website = values.organizationInfo?.website || '';
    values.autoAcceptHighRatedTalents = values.organizationInfo?.autoAcceptHighRatedTalents === true
      || values.organizationInfo?.autoAcceptHighRatedTalents === 'true';
  } else if (['organizer_member', 'organizer_supervisor'].includes(values.role)) {
    values.providerProfileId = values.providerOwnerId;
  }
  return values;
};
