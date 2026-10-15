import type { Permission } from './lib/permissions.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  isSuperAdmin: boolean;
  sessionId: string;
}

export interface TenantContext {
  tenantId: string;
  membershipId: string;
  roleKey: string;
  permissions: Set<Permission>;
  /** Set for portal users: the Customer record they are allowed to see. */
  customerId: string | null;
  tenantStatus: string;
  modules: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      ctx?: TenantContext;
    }
  }
}

export {};
