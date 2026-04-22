import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database.js';

/**
 * One row per request that touches /meta/webhooks — GET verification attempts
 * and POST events alike. Capped by the writer path so the table doesn't grow
 * unbounded; used by /api/v1/webhook-hits for ops debugging and by stdout
 * logs for live tailing.
 */
export class WebhookHit extends Model {
  declare id: number;
  declare received_at: Date;
  declare method: string;
  declare outcome: string; // verified|verify_failed|accepted|signature_invalid|no_signature|parse_error|handler_error
  declare http_status: number;
  declare waba_ids: string[] | null;
  declare entry_count: number;
  declare dispatched_count: number;
  declare reason: string | null;
  declare signature_present: boolean;
  declare verify_mode: string | null;
  declare body_size: number;
}

WebhookHit.init(
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    received_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    method: {
      type: DataTypes.STRING(8),
      allowNull: false,
    },
    outcome: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    http_status: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    waba_ids: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    entry_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    dispatched_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    reason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    signature_present: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    verify_mode: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    body_size: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    sequelize,
    tableName: 'webhook_hits',
    timestamps: false,
    underscored: true,
    indexes: [{ fields: ['received_at'] }],
  }
);
