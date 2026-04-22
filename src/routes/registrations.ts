import { Router, type Response } from 'express';
import { tenantAuth, type TenantRequest } from '../middleware/tenantAuth.js';
import { Registration } from '../models/index.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(tenantAuth);

function validUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * PUT /api/v1/registrations — upsert the WABA → forward_url mapping for this tenant.
 * Body: { waba_id, forward_url, forward_secret }
 */
router.put('/', async (req: TenantRequest, res: Response) => {
  try {
    const tenant = req.tenant!;
    const wabaId = String(req.body?.waba_id || '').trim();
    const forwardUrl = String(req.body?.forward_url || '').trim();
    const forwardSecret = String(req.body?.forward_secret || '').trim();

    if (!wabaId) {
      res.status(400).json({ status: 'error', message: 'waba_id is required' });
      return;
    }
    if (!validUrl(forwardUrl)) {
      res.status(400).json({ status: 'error', message: 'forward_url must be http(s)' });
      return;
    }
    if (!forwardSecret || forwardSecret.length < 32) {
      res.status(400).json({
        status: 'error',
        message: 'forward_secret must be at least 32 characters of entropy',
      });
      return;
    }

    const existing = await Registration.findByPk(wabaId);
    if (existing && existing.tenant_id !== tenant.id) {
      // Prevent one tenant from hijacking another tenant's WABA registration.
      res.status(409).json({
        status: 'error',
        message: 'waba_id is registered by a different tenant',
      });
      return;
    }

    await Registration.upsert({
      waba_id: wabaId,
      tenant_id: tenant.id,
      forward_url: forwardUrl,
      forward_secret: forwardSecret,
      enabled: true,
    });

    const row = await Registration.findByPk(wabaId);
    res.json({
      status: 'success',
      data: {
        waba_id: row!.waba_id,
        tenant_id: row!.tenant_id,
        forward_url: row!.forward_url,
        enabled: row!.enabled,
        created_at: row!.created_at,
        updated_at: row!.updated_at,
      },
    });
  } catch (err) {
    logger.error('[registrations] upsert error', err);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

router.get('/:wabaId', async (req: TenantRequest, res: Response) => {
  try {
    const tenant = req.tenant!;
    const row = await Registration.findByPk(req.params.wabaId);
    if (!row || row.tenant_id !== tenant.id) {
      res.status(404).json({ status: 'error', message: 'Not found' });
      return;
    }
    res.json({
      status: 'success',
      data: {
        waba_id: row.waba_id,
        tenant_id: row.tenant_id,
        forward_url: row.forward_url,
        enabled: row.enabled,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    });
  } catch (err) {
    logger.error('[registrations] get error', err);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

router.delete('/:wabaId', async (req: TenantRequest, res: Response) => {
  try {
    const tenant = req.tenant!;
    const row = await Registration.findByPk(req.params.wabaId);
    if (!row) {
      res.json({ status: 'success', data: { deleted: false } });
      return;
    }
    if (row.tenant_id !== tenant.id) {
      res.status(404).json({ status: 'error', message: 'Not found' });
      return;
    }
    await row.destroy();
    res.json({ status: 'success', data: { deleted: true } });
  } catch (err) {
    logger.error('[registrations] delete error', err);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

export default router;
