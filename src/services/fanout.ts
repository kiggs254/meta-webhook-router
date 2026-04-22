import axios, { AxiosError } from 'axios';
import { Op } from 'sequelize';
import { config } from '../config/index.js';
import { DeliveryLog, Registration, sequelize } from '../models/index.js';
import { hmacSha256Hex } from '../utils/hmac.js';
import logger from '../utils/logger.js';

let dispatching = false;

export function startDispatcher(): NodeJS.Timeout {
  // Periodic sweep. setImmediate triggers from the webhook handler cover the
  // common fast path; this is a safety net for retries + missed triggers.
  const interval = setInterval(() => {
    triggerDispatch().catch((err) => logger.error('[dispatcher] tick error', err));
  }, Math.max(1000, config.fanout.tickMs));
  logger.info(`[dispatcher] started, tick=${config.fanout.tickMs}ms`);
  return interval;
}

export async function triggerDispatch(): Promise<void> {
  if (dispatching) return;
  dispatching = true;
  try {
    // Loop until there's nothing left to do right now, so a burst from Meta
    // doesn't sit idle waiting for the next tick.
    while (true) {
      const drained = await drainBatch();
      if (!drained) break;
    }
  } finally {
    dispatching = false;
  }
}

async function drainBatch(): Promise<boolean> {
  // Atomically claim up to 50 pending rows. FOR UPDATE SKIP LOCKED is the
  // standard Postgres pattern for a lightweight worker queue.
  const claimed: DeliveryLog[] = await sequelize.transaction(async (tx) => {
    const rows = await DeliveryLog.findAll({
      where: {
        status: 'pending',
        [Op.or]: [
          { next_retry_at: null as unknown as Date },
          { next_retry_at: { [Op.lte]: new Date() } },
        ],
      },
      order: [['id', 'ASC']],
      limit: 50,
      lock: tx.LOCK.UPDATE,
      skipLocked: true,
      transaction: tx,
    });
    // Mark as "in-flight" by bumping retry_count lease far into the future, so
    // a parallel worker on another replica won't re-pick them.
    for (const row of rows) {
      await row.update(
        { next_retry_at: new Date(Date.now() + 60_000) },
        { transaction: tx }
      );
    }
    return rows;
  });

  if (claimed.length === 0) return false;

  await Promise.all(claimed.map(dispatchOne));
  return true;
}

async function dispatchOne(row: DeliveryLog): Promise<void> {
  try {
    const reg = await Registration.findByPk(row.waba_id);
    if (!reg || !reg.enabled) {
      await row.update({
        status: 'failed',
        last_error: 'Registration missing or disabled',
      });
      return;
    }

    const body = JSON.stringify(row.payload);
    const signature = hmacSha256Hex(reg.forward_secret, body);

    try {
      const resp = await axios.post(reg.forward_url, body, {
        timeout: config.fanout.timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'x-shopflow-signature-256': signature,
          'x-shopflow-waba-id': reg.waba_id,
          'x-shopflow-delivery-id': String(row.id),
        },
        // Accept any status — we inspect it below.
        validateStatus: () => true,
      });

      if (resp.status >= 200 && resp.status < 300) {
        await row.update({
          status: 'delivered',
          last_http: resp.status,
          last_error: null,
          delivered_at: new Date(),
          next_retry_at: null,
        });
        return;
      }

      // 4xx (except 429) → permanent failure. 429/5xx → retry with backoff.
      const isRetryable = resp.status === 429 || resp.status >= 500;
      await handleFailure(row, resp.status, truncate(String(resp.data || '')), isRetryable);
    } catch (err) {
      const axiosErr = err as AxiosError;
      const status = axiosErr.response?.status ?? null;
      const message = axiosErr.message || 'Delivery failed';
      // Network / timeout → retryable.
      await handleFailure(row, status, message, true);
    }
  } catch (err) {
    logger.error(`[dispatcher] dispatchOne unexpected error for delivery ${row.id}`, err);
    await row.update({
      status: 'failed',
      last_error: (err as Error)?.message || 'Unexpected error',
    });
  }
}

async function handleFailure(
  row: DeliveryLog,
  httpStatus: number | null,
  message: string,
  retryable: boolean
): Promise<void> {
  const nextRetryCount = row.retry_count + 1;
  if (!retryable || nextRetryCount > config.fanout.maxRetries) {
    await row.update({
      status: 'failed',
      retry_count: nextRetryCount,
      last_http: httpStatus,
      last_error: message,
      next_retry_at: null,
    });
    return;
  }

  const backoffMs = Math.min(60 * 60_000, Math.pow(2, nextRetryCount) * 1000);
  await row.update({
    status: 'pending',
    retry_count: nextRetryCount,
    last_http: httpStatus,
    last_error: message,
    next_retry_at: new Date(Date.now() + backoffMs),
  });
}

function truncate(s: string, max = 2000): string {
  return s.length > max ? s.slice(0, max) : s;
}
