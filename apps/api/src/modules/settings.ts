import { Router, type Request } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { config } from '../lib/config.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors.js';
import { listParams, paged, qstr } from '../lib/list.js';
import { ALL_PERMISSIONS, PERMISSIONS, type Permission } from '../lib/permissions.js';
import { DEFAULT_PREFIXES, type SequenceType } from '../lib/numbering.js';
import { GSTIN_REGEX, GST_RATES } from '../lib/gst.js';
import { tenantSettings } from '../lib/tenants.js';
import { enqueueEmail } from '../lib/queue.js';
import { mailConfigured } from '../lib/mail.js';
import { assertTenantRefs } from '../lib/tenantRefs.js';
import { can, requirePerm, requireStaff, tid } from '../middleware/tenant.js';
import { parse } from '../middleware/validate.js';

export const settingsRouter = Router();

const opt = (s: z.ZodString) => s.optional().nullable().or(z.literal('').transform(() => null));

// ── Context for the signed-in member (permissions drive the web navigation) ──

settingsRouter.get('/context', async (req, res) => {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tid(req) },
    select: { id: true, name: true, slug: true, status: true, brandColor: true, logoFileId: true, trialEndsAt: true, plan: { select: { name: true, modules: true } } },
  });
  res.json({ tenant, role: req.ctx!.roleKey, permissions: [...req.ctx!.permissions], customerId: req.ctx!.customerId });
});

// ── Company profile ──

const companySchema = z.object({
  name: z.string().min(2).max(120),
  legalName: opt(z.string().max(200)),
  email: opt(z.string().email()),
  phone: opt(z.string().max(40)),
  website: opt(z.string().max(200)),
  addressLine1: opt(z.string().max(200)),
  addressLine2: opt(z.string().max(200)),
  city: opt(z.string().max(80)),
  state: opt(z.string().max(80)),
  stateCode: opt(z.string().regex(/^\d{2}$/, 'Two-digit GST state code')),
  postalCode: opt(z.string().max(12)),
  country: z.string().max(60).optional(),
  gstin: opt(z.string().toUpperCase().regex(GSTIN_REGEX, 'Invalid GSTIN format')),
  pan: opt(z.string().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN format')),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  logoFileId: z.string().optional().nullable(),
});

settingsRouter.get('/settings/company', requireStaff, async (req, res) => {
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) }, omit: { settings: true } });
  res.json(t);
});

settingsRouter.patch('/settings/company', requirePerm('settings.manage'), async (req, res) => {
  const body = parse(companySchema.partial(), req.body);
  if (body.gstin && body.stateCode && body.gstin.slice(0, 2) !== body.stateCode) throw badRequest('GSTIN state code does not match the company state code');
  if (body.logoFileId) {
    const f = await prisma.fileObject.findFirst({ where: { id: body.logoFileId, tenantId: tid(req), mimeType: { startsWith: 'image/' } } });
    if (!f) throw badRequest('Invalid logo file');
  }
  const t = await prisma.tenant.update({ where: { id: tid(req) }, data: body, omit: { settings: true } });
  await audit(req, { action: 'settings.company', meta: { fields: Object.keys(body) } });
  res.json(t);
});

// ── JSON settings sections (tax, documents, notifications, crm, onboarding) ──

const sectionSchemas = {
  tax: z.object({ defaultTaxRate: z.number().refine((r) => GST_RATES.includes(r)), pricesIncludeTax: z.boolean(), sacDefault: z.string().max(12), roundOff: z.boolean() }).partial(),
  documents: z.object({
    quotationTerms: z.string().max(5000), invoiceTerms: z.string().max(5000), invoiceNotes: z.string().max(2000),
    defaultDueDays: z.number().int().min(0).max(365), quotationValidityDays: z.number().int().min(1).max(365),
    proformaTerms: z.string().max(5000), proformaValidityDays: z.number().int().min(1).max(365), proformaLabel: z.string().trim().min(1).max(30),
    bankDetails: z.string().max(2000), footer: z.string().max(500),
  }).partial(),
  notifications: z.object({ emailOnNewFeedback: z.boolean(), emailOnTicketAssigned: z.boolean(), emailCustomerOnFeedback: z.boolean() }).partial(),
  crm: z.object({ autoFollowUpTasks: z.boolean(), followUpDaysAfterContact: z.number().int().min(1).max(60), coreServices: z.array(z.string().max(80)).max(20) }).partial(),
  onboardingTemplate: z.array(z.string().min(1).max(200)).max(50),
};

settingsRouter.get('/settings/preferences', requireStaff, async (req, res) => {
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) }, select: { settings: true } });
  const sequences = await prisma.documentSequence.findMany({ where: { tenantId: tid(req) } });
  res.json({
    ...tenantSettings(t.settings),
    sequences: (Object.keys(DEFAULT_PREFIXES) as SequenceType[]).map((type) => {
      const s = sequences.find((x) => x.type === type);
      return { type, prefix: s?.prefix ?? DEFAULT_PREFIXES[type], next: s?.next ?? 1, padding: s?.padding ?? 4 };
    }),
  });
});

settingsRouter.patch('/settings/preferences/:section', requirePerm('settings.manage'), async (req, res) => {
  const section = String(req.params.section) as keyof typeof sectionSchemas;
  const schema = sectionSchemas[section];
  if (!schema) throw notFound('Settings section');
  const body = parse(schema, req.body);
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) } });
  const current = tenantSettings(t.settings);
  const next = { ...current, [section]: Array.isArray(body) ? body : { ...(current[section] as object), ...(body as object) } };
  await prisma.tenant.update({ where: { id: tid(req) }, data: { settings: next as object } });
  await audit(req, { action: `settings.${section}`, meta: body as Record<string, unknown> });
  res.json(next);
});

settingsRouter.patch('/settings/sequences/:type', requirePerm('settings.manage'), async (req, res) => {
  const type = String(req.params.type) as SequenceType;
  if (!(type in DEFAULT_PREFIXES)) throw notFound('Sequence');
  const body = parse(z.object({ prefix: z.string().max(20).regex(/^[A-Za-z0-9\-/]*$/), next: z.number().int().min(1).optional(), padding: z.number().int().min(1).max(10).optional() }), req.body);
  const existing = await prisma.documentSequence.findUnique({ where: { tenantId_type: { tenantId: tid(req), type } } });
  if (existing && body.next !== undefined && body.next < existing.next) {
    throw badRequest('The next number cannot be lowered, to avoid duplicate document numbers');
  }
  const seq = await prisma.documentSequence.upsert({
    where: { tenantId_type: { tenantId: tid(req), type } },
    create: { tenantId: tid(req), type, prefix: body.prefix, next: body.next ?? 1, padding: body.padding ?? 4 },
    update: body,
  });
  await audit(req, { action: 'settings.sequence', meta: { type, ...body } });
  res.json(seq);
});

// ── Members, invitations and roles ──

settingsRouter.get('/members/options', requireStaff, async (req, res) => {
  // Lightweight list for assignee pickers. Excludes customer portal users.
  const members = await prisma.membership.findMany({
    where: { tenantId: tid(req), status: 'ACTIVE', role: { key: { not: 'customer' } } },
    select: { userId: true, user: { select: { name: true, email: true } }, role: { select: { key: true, name: true } } },
    orderBy: { user: { name: 'asc' } },
  });
  res.json(members.map((m) => ({ id: m.userId, name: m.user.name, email: m.user.email, role: m.role.name, roleKey: m.role.key })));
});

settingsRouter.get('/members', requirePerm('users.manage'), async (req, res) => {
  const [members, invitations] = await Promise.all([
    prisma.membership.findMany({
      where: { tenantId: tid(req) },
      include: { user: { select: { id: true, name: true, email: true, lastLoginAt: true } }, role: { select: { id: true, key: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.invitation.findMany({
      where: { tenantId: tid(req), acceptedAt: null, expiresAt: { gt: new Date() } },
      include: { role: { select: { name: true } } }, omit: { tokenHash: true },
    }),
  ]);
  res.json({ members, invitations });
});

/**
 * A member may only hand out, or manage holders of, roles whose permissions they hold themselves; otherwise a
 * limited user manager could invite a second account of theirs as an admin. Portal access is not a staff power.
 */
function assertCanManageRole(req: Request, role: { name: string; permissions: string[] }, action: string) {
  const missing = role.permissions.filter((p) => p !== 'portal.access' && !can(req, p as Permission));
  if (missing.length) throw forbidden(`You cannot ${action} the ${role.name} role: it has permissions you do not have (${missing.join(', ')})`);
}

async function assertSeat(tenantId: string, roleKey: string) {
  if (roleKey === 'customer') return; // portal users do not consume seats
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, include: { plan: true } });
  const used = await prisma.membership.count({ where: { tenantId, status: 'ACTIVE', role: { key: { not: 'customer' } } } });
  const pending = await prisma.invitation.count({ where: { tenantId, acceptedAt: null, expiresAt: { gt: new Date() }, role: { key: { not: 'customer' } } } });
  if (used + pending >= (t.plan?.maxUsers ?? 5)) throw new HttpError(402, `Your plan allows ${t.plan?.maxUsers ?? 5} users. Upgrade to invite more.`);
}

settingsRouter.post('/invitations', requirePerm('users.manage'), async (req, res) => {
  const body = parse(z.object({ email: z.string().email().toLowerCase(), roleId: z.string(), customerId: z.string().optional().nullable() }), req.body);
  const role = await prisma.role.findFirst({ where: { id: body.roleId, tenantId: tid(req) } });
  if (!role) throw badRequest('Invalid role');
  if (role.key === 'owner' && req.ctx!.roleKey !== 'owner') throw forbidden('Only an owner can invite another owner');
  assertCanManageRole(req, role, 'invite people into');
  if (role.key === 'customer' && !body.customerId) throw badRequest('Choose the customer this portal user belongs to');
  await assertTenantRefs(tid(req), { customer: body.customerId });
  const existing = await prisma.membership.findFirst({ where: { tenantId: tid(req), user: { email: body.email } } });
  if (existing) throw conflict('This person is already a member of the workspace');
  await assertSeat(tid(req), role.key);
  const token = randomToken();
  await prisma.invitation.deleteMany({ where: { tenantId: tid(req), email: body.email, acceptedAt: null } });
  const inv = await prisma.invitation.create({
    data: { tenantId: tid(req), email: body.email, roleId: role.id, customerId: role.key === 'customer' ? body.customerId : null, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 7 * 86_400_000), invitedById: req.user!.id },
  });
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) }, select: { name: true } });
  const link = `${config.appUrl}/accept-invite?token=${token}`;
  await enqueueEmail({
    to: body.email,
    subject: `You're invited to ${tenant.name}`,
    text: `${req.user!.name} invited you to join ${tenant.name} as ${role.name}.\n\nAccept the invitation (valid for 7 days):\n${link}`,
  });
  await audit(req, { action: 'users.invite', entityType: 'invitation', entityId: inv.id, meta: { email: body.email, role: role.key } });
  // The link is returned so admins can share it directly when email is not configured.
  res.status(201).json({ id: inv.id, email: inv.email, expiresAt: inv.expiresAt, inviteLink: mailConfigured() ? undefined : link });
});

settingsRouter.delete('/invitations/:id', requirePerm('users.manage'), async (req, res) => {
  const r = await prisma.invitation.deleteMany({ where: { id: String(req.params.id), tenantId: tid(req), acceptedAt: null } });
  if (!r.count) throw notFound('Invitation');
  res.json({ ok: true });
});

settingsRouter.patch('/members/:id', requirePerm('users.manage'), async (req, res) => {
  const body = parse(z.object({ roleId: z.string().optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional(), title: z.string().max(80).optional().nullable() }), req.body);
  const m = await prisma.membership.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) }, include: { role: true } });
  if (!m) throw notFound('Member');
  if (m.userId === req.user!.id && (body.status === 'DISABLED' || body.roleId)) throw badRequest('You cannot change your own role or disable yourself');
  if (m.role.key === 'owner' && req.ctx!.roleKey !== 'owner') throw forbidden('Only an owner can change another owner');
  assertCanManageRole(req, m.role, 'manage members with');
  if (body.roleId) {
    const role = await prisma.role.findFirst({ where: { id: body.roleId, tenantId: tid(req) } });
    if (!role) throw badRequest('Invalid role');
    if (role.key === 'owner' && req.ctx!.roleKey !== 'owner') throw forbidden('Only an owner can grant the owner role');
    assertCanManageRole(req, role, 'assign');
  }
  if (m.role.key === 'owner' && (body.status === 'DISABLED' || (body.roleId && body.roleId !== m.roleId))) {
    const owners = await prisma.membership.count({ where: { tenantId: tid(req), status: 'ACTIVE', role: { key: 'owner' } } });
    if (owners <= 1) throw badRequest('A workspace must keep at least one active owner');
  }
  const updated = await prisma.membership.update({ where: { id: m.id }, data: body });
  if (body.status === 'DISABLED') {
    // Disabling stops tenant access immediately; sessions are per-user, so other workspaces are unaffected.
    await prisma.task.updateMany({ where: { tenantId: tid(req), assigneeId: m.userId, status: { in: ['TODO', 'IN_PROGRESS'] } }, data: { assigneeId: null } });
  }
  await audit(req, { action: 'users.update', entityType: 'membership', entityId: m.id, meta: body });
  res.json(updated);
});

settingsRouter.get('/roles', requirePerm('users.manage'), async (req, res) => {
  const roles = await prisma.role.findMany({ where: { tenantId: tid(req) }, include: { _count: { select: { memberships: true } } }, orderBy: [{ isSystem: 'desc' }, { name: 'asc' }] });
  res.json({ roles, catalog: Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label })) });
});

const roleSchema = z.object({
  name: z.string().min(2).max(60),
  description: z.string().max(200).optional().nullable(),
  permissions: z.array(z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]])).max(ALL_PERMISSIONS.length),
});

settingsRouter.post('/roles', requirePerm('users.manage'), async (req, res) => {
  const body = parse(roleSchema, req.body);
  // A member cannot create a role with permissions they do not hold themselves.
  const escalation = body.permissions.filter((p) => !can(req, p));
  if (escalation.length) throw forbidden(`You cannot grant permissions you do not have: ${escalation.join(', ')}`);
  const role = await prisma.role.create({ data: { ...body, tenantId: tid(req), key: `custom_${randomToken(6).toLowerCase()}` } });
  await audit(req, { action: 'roles.create', entityType: 'role', entityId: role.id, meta: body });
  res.status(201).json(role);
});

settingsRouter.patch('/roles/:id', requirePerm('users.manage'), async (req, res) => {
  const role = await prisma.role.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) } });
  if (!role) throw notFound('Role');
  if (role.key === 'owner') throw badRequest('The owner role cannot be modified');
  const body = parse(roleSchema.partial(), req.body);
  if (body.permissions) {
    const escalation = body.permissions.filter((p) => !can(req, p));
    if (escalation.length) throw forbidden(`You cannot grant permissions you do not have: ${escalation.join(', ')}`);
  }
  const updated = await prisma.role.update({ where: { id: role.id }, data: body });
  await audit(req, { action: 'roles.update', entityType: 'role', entityId: role.id, meta: body });
  res.json(updated);
});

settingsRouter.delete('/roles/:id', requirePerm('users.manage'), async (req, res) => {
  const role = await prisma.role.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) }, include: { _count: { select: { memberships: true } } } });
  if (!role) throw notFound('Role');
  if (role.isSystem) throw badRequest('System roles cannot be deleted');
  if (role._count.memberships) throw conflict('Reassign members before deleting this role');
  await prisma.role.delete({ where: { id: role.id } });
  await audit(req, { action: 'roles.delete', entityType: 'role', entityId: role.id });
  res.json({ ok: true });
});

// ── Subscription & usage ──

settingsRouter.get('/settings/subscription', requirePerm('subscription.manage', 'settings.manage'), async (req, res) => {
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) }, include: { plan: true } });
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const [users, customers, ai, plans] = await Promise.all([
    prisma.membership.count({ where: { tenantId: t.id, status: 'ACTIVE', role: { key: { not: 'customer' } } } }),
    prisma.customer.count({ where: { tenantId: t.id } }),
    prisma.aiUsage.count({ where: { tenantId: t.id, createdAt: { gte: monthStart } } }),
    prisma.plan.findMany({ where: { active: true }, orderBy: { priceMonthly: 'asc' } }),
  ]);
  res.json({
    status: t.status, trialEndsAt: t.trialEndsAt, currentPeriodEnd: t.currentPeriodEnd, plan: t.plan, plans,
    usage: {
      users: { used: users, limit: t.plan?.maxUsers ?? null },
      customers: { used: customers, limit: t.plan?.maxCustomers ?? null },
      storageMb: { used: Math.round(Number(t.storageUsedBytes) / 1048576 * 10) / 10, limit: t.plan?.storageMb ?? null },
      aiRequests: { used: ai, limit: t.plan?.aiRequests ?? null },
    },
    // Online billing is not connected; plan changes are requested from the platform administrator.
    billingProvider: null,
  });
});

settingsRouter.post('/settings/subscription/request-change', requirePerm('subscription.manage'), async (req, res) => {
  const body = parse(z.object({ planCode: z.string(), note: z.string().max(1000).optional() }), req.body);
  const plan = await prisma.plan.findUnique({ where: { code: body.planCode } });
  if (!plan || !plan.active) throw badRequest('Unknown plan');
  await audit(req, { action: 'subscription.change_requested', meta: { planCode: plan.code, note: body.note } });
  res.json({ ok: true, message: 'Your request has been sent to the platform administrator.' });
});

// ── Integrations (status only; secrets live in server environment variables) ──

settingsRouter.get('/settings/integrations', requirePerm('settings.manage'), (_req, res) => {
  res.json([
    { key: 'email', name: 'Email (SMTP)', connected: mailConfigured(), detail: mailConfigured() ? 'Outgoing email is enabled' : 'Not configured: emails are logged on the server only' },
    { key: 'storage', name: 'File storage', connected: true, detail: config.storage.driver === 's3' ? 'S3-compatible private bucket' : 'Local private disk storage' },
    { key: 'ai', name: 'AI provider', connected: config.ai.provider === 'anthropic' && !!config.ai.anthropicKey, detail: config.ai.provider === 'anthropic' && config.ai.anthropicKey ? `Claude (${config.ai.anthropicModel})` : 'Heuristic mode: templates and rule-based scoring, no external AI calls' },
    { key: 'jobs', name: 'Background jobs', connected: !!config.redisUrl, detail: config.redisUrl ? 'Redis + BullMQ' : 'In-process scheduler' },
    { key: 'whatsapp', name: 'WhatsApp Business', connected: false, detail: 'Not connected. Requires WhatsApp Business API credentials and customer opt-in.' },
  ]);
});

// ── Audit logs ──

settingsRouter.get('/audit-logs', requirePerm('audit.read'), async (req, res) => {
  const p = listParams(req, ['createdAt']);
  const where = {
    tenantId: tid(req),
    ...(qstr(req.query.action) ? { action: { startsWith: String(req.query.action) } } : {}),
    ...(qstr(req.query.actorId) ? { actorId: String(req.query.actorId) } : {}),
    ...(qstr(req.query.entityType) ? { entityType: String(req.query.entityType) } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.pageSize }),
    prisma.auditLog.count({ where }),
  ]);
  res.json(paged(items, total, p));
});
