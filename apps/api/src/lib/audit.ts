import type { Request } from 'express';
import { prisma, type Tx } from './db.js';

export interface AuditInput {
  action: string;
  entityType?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
  tenantId?: string | null;
}

/** Records an audit event for the current request's actor and tenant. Never throws. */
export async function audit(req: Request, input: AuditInput, tx: Tx = prisma) {
  try {
    await tx.auditLog.create({
      data: {
        tenantId: input.tenantId !== undefined ? input.tenantId : (req.ctx?.tenantId ?? null),
        actorId: req.user?.id,
        actorEmail: req.user?.email,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        meta: (input.meta ?? {}) as object,
        ip: req.ip,
      },
    });
  } catch (err) {
    console.error('[audit] failed to write audit log', err);
  }
}
