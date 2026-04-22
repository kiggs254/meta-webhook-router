import type { Request, Response } from 'express';
import crypto from 'crypto';
import { config } from '../config/index.js';
import { Registration, DeliveryLog } from '../models/index.js';
import logger from '../utils/logger.js';
import { triggerDispatch } from '../services/fanout.js';

/**
 * GET /meta/webhooks — Meta subscription verification.
 */
export async function handleMetaVerification(req: Request, res: Response): Promise<void> {
  const mode = String(req.query['hub.mode'] || '');
  const verifyToken = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');

  if (mode === 'subscribe' && verifyToken === config.meta.verifyToken) {
    res.status(200).type('text/plain').send(challenge);
    return;
  }
  res.status(403).send('Forbidden');
}

/**
 * POST /meta/webhooks — receive Meta event, verify HMAC, stage delivery rows
 * per WABA, ACK fast. Actual HTTP fanout happens in the dispatcher.
 */
export async function handleMetaEvent(req: Request, res: Response): Promise<void> {
  try {
    const rawBody: Buffer = (req.body as Buffer) ?? Buffer.alloc(0);
    const signature = String(req.header('x-hub-signature-256') || '');

    const expected =
      'sha256=' + crypto.createHmac('sha256', config.meta.appSecret).update(rawBody).digest('hex');
    let valid = false;
    try {
      valid =
        signature.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      valid = false;
    }
    if (!valid) {
      res.status(401).send('Unauthorized');
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.status(200).send('EVENT_RECEIVED');
      return;
    }

    const object = payload?.object;
    const entries: any[] = Array.isArray(payload?.entry) ? payload.entry : [];

    // Stage one delivery row per entry (one per WABA).
    for (const entry of entries) {
      const wabaId = String(entry?.id || '').trim();
      if (!wabaId) continue;

      const reg = await Registration.findByPk(wabaId);
      if (!reg || !reg.enabled) {
        logger.debug(`[meta] no registration for waba ${wabaId}, dropping`);
        continue;
      }

      // Prefer a single field label per entry — Meta rarely ships mixed field types.
      const field = entry?.changes?.[0]?.field || null;

      await DeliveryLog.create({
        waba_id: wabaId,
        field,
        payload: { object, entry: [entry] },
        status: 'pending',
      });
    }

    // Kick a dispatch immediately; the periodic tick is a safety net.
    setImmediate(() => {
      triggerDispatch().catch((err) => logger.error('[meta] dispatch trigger failed', err));
    });

    res.status(200).send('EVENT_RECEIVED');
  } catch (err) {
    logger.error('[meta] handler error (swallowed, returning 200)', err);
    res.status(200).send('EVENT_RECEIVED');
  }
}
