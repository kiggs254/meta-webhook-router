import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database.js';

export class Registration extends Model {
  declare waba_id: string;
  declare tenant_id: string;
  declare forward_url: string;
  declare forward_secret: string;
  declare enabled: boolean;
  declare readonly created_at: Date;
  declare readonly updated_at: Date;
}

Registration.init(
  {
    waba_id: {
      type: DataTypes.STRING(64),
      primaryKey: true,
      allowNull: false,
    },
    tenant_id: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    forward_url: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    forward_secret: {
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
    tableName: 'registrations',
    timestamps: true,
    underscored: true,
    indexes: [{ fields: ['tenant_id'] }],
  }
);
