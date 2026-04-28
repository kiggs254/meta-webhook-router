import express, { type Express } from 'express';
import { config } from './config/index.js';
import { sequelize } from './models/index.js';
import { handleMetaVerification, handleMetaEvent, handleWebhookHitsList } from './routes/meta.js';
import registrationsRouter from './routes/registrations.js';
import embeddedSignupRouter from './routes/embeddedSignup.js';
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

  // Trace every incoming request at info level so operators can see in Coolify
  // logs whether Meta is hitting the router at all.
  app.use((req, _res, next) => {
    if (req.path.startsWith('/meta/')) {
      logger.info(`[http] ${req.method} ${req.originalUrl}`);
    }
    next();
  });

  // Meta webhooks
  //   GET: query params only; no body parsing needed.
  //   POST: raw body required for HMAC verification. Mount express.raw BEFORE
  //         any express.json so this is the first body parser to run on this path.
  app.get('/meta/webhooks', handleMetaVerification);
  app.post('/meta/webhooks', express.raw({ type: '*/*', limit: '1mb' }), handleMetaEvent);

  // Everything else parses JSON.
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/v1/webhook-hits', handleWebhookHitsList);
  app.use('/api/v1/registrations', registrationsRouter);

  // Embedded-signup proxy: serves an HTML page that runs FB.login on this
  // domain (the single domain whitelisted in Meta's JS SDK host list) and
  // relays results back to the originating Shopflow install via postMessage.
  app.use('/embedded-signup', embeddedSignupRouter);

  // 404
  app.use((_req, res) => {
    res.status(404).json({ status: 'error', message: 'Not found' });
  });

  return app;
}
