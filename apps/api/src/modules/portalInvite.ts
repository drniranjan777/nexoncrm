import type { Request } from 'express';
import type { Customer } from '@prisma/client';
import { prisma } from '../lib/db.js';
import { config } from '../lib/config.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';
import { enqueueEmail } from '../lib/queue.js';
import { mailConfigured } from '../lib/mail.js';

/**
 * "Allow portal access for this customer": invites the customer's primary email as a portal user
 * limited to this customer's records. Idempotent if the person already has access.
 */
export async function invitePortalUser(req: Request, customer: Customer) {
  if (!customer.email) throw badRequest('Add an email address before enabling portal access');
  const tenantId = customer.tenantId;
  const existing = await prisma.membership.findFirst({ where: { tenantId, customerId: customer.id, user: { email: customer.email.toLowerCase() } } });
  if (existing) return { status: 'already_enabled' as const };
  const role = await prisma.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId, key: 'customer' } } });
  const token = randomToken();
  await prisma.invitation.deleteMany({ where: { tenantId, email: customer.email.toLowerCase(), acceptedAt: null } });
  await prisma.invitation.create({
    data: { tenantId, email: customer.email.toLowerCase(), roleId: role.id, customerId: customer.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 14 * 86_400_000), invitedById: req.user!.id },
  });
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });
  const link = `${config.appUrl}/accept-invite?token=${token}`;
  await enqueueEmail({
    tenantId,
    to: customer.email,
    subject: `Your customer portal at ${tenant.name}`,
    text: `Hi ${customer.name},\n\n${tenant.name} has given you access to its customer portal, where you can view quotes and invoices, download PDFs, raise support requests and share feedback.\n\nSet up your access (link valid 14 days):\n${link}`,
  });
  await audit(req, { action: 'customers.portal_invite', entityType: 'customer', entityId: customer.id });
  return { status: 'invited' as const, inviteLink: (await mailConfigured(tenantId)) ? undefined : link };
}
