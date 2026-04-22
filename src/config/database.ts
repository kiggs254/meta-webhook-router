import { Sequelize } from 'sequelize';
import { config } from './index.js';

const sequelize = new Sequelize(config.database.url, {
  dialect: 'postgres',
  logging: false,
  dialectOptions: config.database.ssl
    ? { ssl: { require: true, rejectUnauthorized: false } }
    : {},
  pool: { max: 10, min: 0, idle: 10000, acquire: 30000 },
});

export default sequelize;
