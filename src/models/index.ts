import sequelize from '../config/database.js';
import { Tenant } from './Tenant.js';
import { Registration } from './Registration.js';
import { DeliveryLog } from './DeliveryLog.js';
import { WebhookHit } from './WebhookHit.js';

Registration.belongsTo(Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
Tenant.hasMany(Registration, { foreignKey: 'tenant_id', as: 'registrations' });

export { sequelize, Tenant, Registration, DeliveryLog, WebhookHit };
