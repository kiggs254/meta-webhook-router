import express, { type Express } from 'express';
import { config } from './config/index.js';
import { sequelize } from './models/index.js';
import { handleMetaVerification, handleMetaEvent } from './routes/meta.js';
import registrationsRouter from './routes/registrations.js';
import logger from './utils/logger.js';

export async function createApp(): Promise<Express> {
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', env: config.server.env });
  });

  app.get('/health/db', async (_req, res) => {
    try {
      await sequelize.authenticate();
      res.json({ status: 'ok' });
    } catch (err) {
      logger.error('[health/db] failed', err);
      res.status(503).json({ status: 'unavailable' });
    }
  });

  // Meta webhooks
  //   GET: query params only; no body parsing needed.
  //   POST: raw body required for HMAC verification. Mount express.raw BEFORE
  //         any express.json so this is the first body parser to run on this path.
  app.get('/meta/webhooks', handleMetaVerification);
  app.post('/meta/webhooks', express.raw({ type: '*/*', limit: '1mb' }), handleMetaEvent);

  // Everything else parses JSON.
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/v1/registrations', registrationsRouter);

  // 404
  app.use((_req, res) => {
    res.status(404).json({ status: 'error', message: 'Not found' });
  });

  return app;
}
