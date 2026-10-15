import { prisma, type Tx } from './db.js';
import { badRequest } from './errors.js';

type RefKind = 'customer' | 'project' | 'lead' | 'user' | 'milestone' | 'product' | 'category' | 'invoice' | 'feedback';

export type Refs = Partial<Record<RefKind, string | null | undefined>>;

/**
 * Verifies that every referenced id belongs to the tenant. Client-sent foreign keys are never trusted.
 * `user` means "an active member of this tenant".
 */
export async function assertTenantRefs(tenantId: string, refs: Refs, tx: Tx = prisma) {
  const checks: Promise<void>[] = [];
  const check = (kind: RefKind, fn: () => Promise<unknown>) => {
    checks.push(
      fn().then((found) => {
        if (!found) throw badRequest(`Invalid ${kind} reference`);
      }),
    );
  };
  if (refs.customer) check('customer', () => tx.customer.findFirst({ where: { id: refs.customer!, tenantId }, select: { id: true } }));
  if (refs.project) check('project', () => tx.project.findFirst({ where: { id: refs.project!, tenantId }, select: { id: true } }));
  if (refs.lead) check('lead', () => tx.lead.findFirst({ where: { id: refs.lead!, tenantId }, select: { id: true } }));
  if (refs.milestone) check('milestone', () => tx.milestone.findFirst({ where: { id: refs.milestone!, tenantId }, select: { id: true } }));
  if (refs.product) check('product', () => tx.product.findFirst({ where: { id: refs.product!, tenantId }, select: { id: true } }));
  if (refs.category) check('category', () => tx.ticketCategory.findFirst({ where: { id: refs.category!, tenantId }, select: { id: true } }));
  if (refs.invoice) check('invoice', () => tx.invoice.findFirst({ where: { id: refs.invoice!, tenantId }, select: { id: true } }));
  if (refs.feedback) check('feedback', () => tx.feedback.findFirst({ where: { id: refs.feedback!, tenantId }, select: { id: true } }));
  if (refs.user)
    check('user', () =>
      tx.membership.findFirst({ where: { userId: refs.user!, tenantId, status: 'ACTIVE' }, select: { id: true } }),
    );
  await Promise.all(checks);
}
