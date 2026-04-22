import { createApp } from './app.js';
import { config, assertConfig } from './config/index.js';
import { sequelize } from './models/index.js';
import { startDispatcher } from './services/fanout.js';
import logger from './utils/logger.js';

process.on('uncaughtException', (err) => {
  logger.error('[FATAL] uncaughtException', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.warn('[WARN] unhandledRejection', reason);
});

async function main() {
  assertConfig();

  await sequelize.authenticate();
  // Auto-create tables on boot. Matches the Shopflow main backend pattern —
  // no separate migration runner needed for a fresh repo this small.
  const sync = config.server.env === 'production' ? {} : { alter: true };
  await sequelize.sync(sync);
  logger.info('[db] synced');

  const app = await createApp();

  const dispatcher = startDispatcher();

  const server = app.listen(config.server.port, () => {
    logger.info(`[server] listening on :${config.server.port} (${config.server.env})`);
  });

  const shutdown = async (sig: string) => {
    logger.info(`[server] ${sig} received, shutting down`);
    clearInterval(dispatcher);
    server.close();
    try {
      await sequelize.close();
    } catch {
      // Non-fatal
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('[FATAL] startup failure', err);
  process.exit(1);
});
