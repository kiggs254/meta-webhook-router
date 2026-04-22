import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database.js';

export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

export class DeliveryLog extends Model {
  declare id: number;
  declare waba_id: string;
  declare field: string | null;
  declare payload: Record<string, unknown>;
  declare status: DeliveryStatus;
  declare last_http: number | null;
  declare last_error: string | null;
  declare retry_count: number;
  declare next_retry_at: Date | null;
  declare readonly created_at: Date;
  declare delivered_at: Date | null;
}

DeliveryLog.init(
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    waba_id: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    field: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    payload: {
      type: DataTypes.JSONB,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'pending',
    },
    last_http: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    last_error: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    retry_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    next_retry_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    delivered_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'delivery_log',
    timestamps: true,
    updatedAt: false,
    underscored: true,
    indexes: [{ fields: ['status', 'next_retry_at'] }, { fields: ['waba_id'] }],
  }
);
