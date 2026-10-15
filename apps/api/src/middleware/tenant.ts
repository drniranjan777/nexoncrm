import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/db.js';
import { badRequest, forbidden, HttpError, unauthorized } from '../lib/errors.js';
import type { Permission } from '../lib/permissions.js';

export const TENANT_HEADER = 'x-tenant-id';

/**
 * Resolves tenant context from the authenticated user's ACTIVE membership.
 * The X-Tenant-Id header only selects among the user's own memberships; it never grants access.
 */
export async function requireTenant(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  const requested = req.header(TENANT_HEADER);
  if (!requested) return next(badRequest('Select a workspace (X-Tenant-Id header missing)'));

  const membership = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId: requested, userId: req.user.id } },
    include: { role: true, tenant: { include: { plan: true } } },
  });
  if (!membership || membership.status !== 'ACTIVE') {
    return next(forbidden('You are not a member of this workspace'));
  }
  const tenant = membership.tenant;
  if (tenant.status === 'SUSPENDED' || tenant.status === 'CANCELLED') {
    return next(new HttpError(423, 'This workspace is suspended. Contact the platform administrator.'));
  }
  if (tenant.status === 'TRIAL' && tenant.trialEndsAt && tenant.trialEndsAt < new Date()) {
    return next(new HttpError(402, 'The trial period for this workspace has ended.'));
  }

  req.ctx = {
    tenantId: tenant.id,
    membershipId: membership.id,
    roleKey: membership.role.key,
    permissions: new Set(membership.role.permissions as Permission[]),
    customerId: membership.customerId,
    tenantStatus: tenant.status,
    modules: tenant.plan?.modules ?? [],
  };
  next();
}

export function can(req: Request, perm: Permission) {
  return !!req.ctx?.permissions.has(perm);
}

/** Passes when the member holds ANY of the listed permissions. */
export function requirePerm(...perms: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.ctx) return next(unauthorized());
    if (perms.some((p) => req.ctx!.permissions.has(p))) return next();
    next(forbidden(`Missing permission: ${perms.join(' or ')}`));
  };
}

/** Staff only: any permission besides customer-portal access. Keeps portal users out of internal data. */
export function requireStaff(req: Request, _res: Response, next: NextFunction) {
  if (!req.ctx) return next(unauthorized());
  if ([...req.ctx.permissions].some((p) => p !== 'portal.access')) return next();
  next(forbidden('Not available in the customer portal'));
}

/** Module entitlement from the subscription plan. An empty module list means all modules. */
export function requireModule(mod: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const mods = req.ctx?.modules ?? [];
    if (mods.length === 0 || mods.includes(mod)) return next();
    next(new HttpError(402, `The ${mod} module is not included in your subscription plan`));
  };
}

export const tid = (req: Request) => req.ctx!.tenantId;
