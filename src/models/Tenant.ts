import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database.js';

export class Tenant extends Model {
  declare id: string;
  declare name: string;
  declare shared_secret: string;
  declare enabled: boolean;
  declare readonly created_at: Date;
}

Tenant.init(
  {
    id: {
      type: DataTypes.STRING(32),
      primaryKey: true,
      allowNull: false,
    },
    name: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    shared_secret: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  {
    sequelize,
    tableName: 'tenants',
    timestamps: true,
    updatedAt: false,
    underscored: true,
  }
);
