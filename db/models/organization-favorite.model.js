import { DataTypes } from 'sequelize';
import { sequelize } from '../connection.js';

export const OrganizationFavorite = sequelize.define('OrganizationFavorite', {
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
  talentId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
}, {
  tableName: 'organization_favorites',
  timestamps: true,
  indexes: [{ unique: true, fields: ['organizerId', 'talentId'], where: { deletedAt: null } }],
});
