import dotenv from 'dotenv';

dotenv.config();

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  server: {
    port: readInt('PORT', 3100),
    env: process.env.NODE_ENV || 'development',
  },
  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
  database: {
    url: process.env.DATABASE_URL || '',
    ssl: process.env.DB_SSL === 'true',
  },
  meta: {
    appSecret: process.env.META_APP_SECRET || '',
    verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || '',
  },
  fanout: {
    timeoutMs: readInt('FORWARD_TIMEOUT_MS', 4000),
    maxRetries: readInt('FORWARD_MAX_RETRIES', 6),
    tickMs: readInt('DISPATCH_TICK_MS', 15000),
  },
};

export function assertConfig(): void {
  const missing: string[] = [];
  if (!config.database.url) missing.push('DATABASE_URL');
  if (!config.meta.appSecret) missing.push('META_APP_SECRET');
  if (!config.meta.verifyToken) missing.push('META_WEBHOOK_VERIFY_TOKEN');
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}
