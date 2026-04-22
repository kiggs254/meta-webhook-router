import type { Request, Response, NextFunction } from 'express';
import { Tenant } from '../models/index.js';
import { timingSafeEqual } from '../utils/hmac.js';
import logger from '../utils/logger.js';

export interface TenantRequest extends Request {
  tenant?: Tenant;
}

/**
 * Authenticates the caller as a registered tenant.
 * Headers:
 *   x-shopflow-tenant-id: <tenant_id>
 *   Authorization: Bearer <shared_secret>
 *
 * Returns 401 on any mismatch without revealing which field failed.
 */
export async function tenantAuth(req: TenantRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = String(req.header('x-shopflow-tenant-id') || '').trim();
    const authHeader = String(req.header('authorization') || '').trim();
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    const presented = match?.[1] || '';

    if (!tenantId || !presented) {
      res.status(401).json({ status: 'error', message: 'Unauthorized' });
      return;
    }

    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant || !tenant.enabled) {
      res.status(401).json({ status: 'error', message: 'Unauthorized' });
      return;
    }

    if (!timingSafeEqual(presented, tenant.shared_secret)) {
      res.status(401).json({ status: 'error', message: 'Unauthorized' });
      return;
    }

    req.tenant = tenant;
    next();
  } catch (err) {
    logger.error('[tenantAuth] error', err);
    res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
}
