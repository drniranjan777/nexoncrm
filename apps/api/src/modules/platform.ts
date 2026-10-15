import { Router } from 'express';
import { z } from 'zod';
import type { TenantStatus } from '@prisma/client';
import { prisma } from '../lib/db.js';
import { config } from '../lib/config.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { listParams, paged, qstr, searchAny } from '../lib/list.js';
import { provisionTenant } from '../lib/tenants.js';
import { enqueueEmail } from '../lib/queue.js';
import { mailConfigured } from '../lib/mail.js';
import { requireSuperAdmin } from '../middleware/auth.js';
import { platformMailRouter } from './mailSettings.js';
import { parse } from '../middleware/validate.js';

// Platform administration. Super admins manage tenants and plans here; they do NOT receive tenant
// memberships, so they cannot browse tenant business data through the tenant APIs. Every action is audited.
export const platformRouter = Router();
platformRouter.use(requireSuperAdmin);
platformRouter.use(platformMailRouter);

export const MODULES = ['crm', 'feedback', 'projects', 'support', 'finance', 'reports', 'ai'] as const;

platformRouter.get('/overview', async (_req, res) => {
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const [byStatus, byPlan, users, newTenants, storage, ai, feedback, invoices] = await Promise.all([
    prisma.tenant.groupBy({ by: ['status'], _count: true }),
    prisma.tenant.groupBy({ by: ['planId'], _count: true }),
    prisma.user.count({ where: { isActive: true } }),
    prisma.tenant.count({ where: { createdAt: { gte: monthStart } } }),
    prisma.tenant.aggregate({ _sum: { storageUsedBytes: true } }),
    prisma.aiUsage.count({ where: { createdAt: { gte: monthStart } } }),
    prisma.feedback.count({ where: { createdAt: { gte: monthStart } } }),
    prisma.invoice.count({ where: { issuedAt: { gte: monthStart } } }),
  ]);
  const plans = await prisma.plan.findMany({ select: { id: true, name: true, priceMonthly: true } });
  const mrr = byPlan.reduce((s, p) => s + Number(plans.find((x) => x.id === p.planId)?.priceMonthly ?? 0) * p._count, 0);
  res.json({
    tenantsByStatus: byStatus.map((s) => ({ status: s.status, count: s._count })),
    tenantsByPlan: byPlan.map((p) => ({ plan: plans.find((x) => x.id === p.planId)?.name ?? 'No plan', count: p._count })),
    activeUsers: users, newTenantsThisMonth: newTenants,
    storageUsedMb: Math.round(Number(storage._sum.storageUsedBytes ?? 0) / 1048576),
    aiRequestsThisMonth: ai, feedbackThisMonth: feedback, invoicesIssuedThisMonth: invoices,
    // List-price MRR from plan assignments; not reconciled with any payment provider.
    estimatedMrr: mrr,
  });
});

platformRouter.get('/tenants', async (req, res) => {
  const p = listParams(req, ['createdAt', 'name']);
  const where = { ...searchAny(p.q, ['name', 'slug', 'email']), ...(qstr(req.query.status) ? { status: req.query.status as TenantStatus } : {}) };
  const [items, total] = await Promise.all([
    prisma.tenant.findMany({
      where, orderBy: { [p.sort ?? 'createdAt']: p.dir }, skip: p.skip, take: p.pageSize,
      omit: { settings: true },
      include: { plan: { select: { id: true, name: true, code: true, maxUsers: true, storageMb: true } }, _count: { select: { memberships: true, customers: true, invoices: true } } },
    }),
    prisma.tenant.count({ where }),
  ]);
  res.json(paged(items, total, p));
});

platformRouter.post('/tenants', async (req, res) => {
  const body = parse(z.object({
    name: z.string().min(2).max(120),
    slug: z.string().regex(/^[a-z0-9-]{2,48}$/).optional(),
    ownerEmail: z.string().email().toLowerCase(),
    planCode: z.string().optional(),
    trialDays: z.coerce.number().int().min(0).max(365).default(14),
    activate: z.boolean().default(false),
  }), req.body);
  if (body.slug && (await prisma.tenant.findUnique({ where: { slug: body.slug } }))) throw badRequest('This slug is already taken');
  const token = randomToken();
  const tenant = await prisma.$transaction(async (tx) => {
    const t = await provisionTenant({ name: body.name, slug: body.slug, planCode: body.planCode, trialDays: body.trialDays, status: body.activate ? 'ACTIVE' : 'TRIAL' }, tx);
    const owner = await tx.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: t.id, key: 'owner' } } });
    await tx.invitation.create({ data: { tenantId: t.id, email: body.ownerEmail, roleId: owner.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 14 * 86_400_000), invitedById: req.user!.id } });
    return t;
  });
  const link = `${config.appUrl}/accept-invite?token=${token}`;
  await enqueueEmail({ to: body.ownerEmail, subject: `Your ${tenant.name} workspace is ready`, text: `A workspace has been created for ${tenant.name}.\n\nAccept your owner invitation (valid 14 days):\n${link}` });
  await audit(req, { action: 'platform.tenant_create', entityType: 'tenant', entityId: tenant.id, tenantId: tenant.id, meta: { ownerEmail: body.ownerEmail } });
  res.status(201).json({ tenant, inviteLink: (await mailConfigured()) ? undefined : link });
});

platformRouter.get('/tenants/:id', async (req, res) => {
  const tenant = await prisma.tenant.findUnique({
    where: { id: String(req.params.id) },
    omit: { settings: true },
    include: { plan: true },
  });
  if (!tenant) throw notFound('Tenant');
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  // Administrators and usage counters only: no customer or financial records cross the tenant boundary.
  const [admins, counts, ai, invites] = await Promise.all([
    prisma.membership.findMany({
      where: { tenantId: tenant.id, role: { key: { in: ['owner', 'admin'] } } },
      select: { id: true, status: true, role: { select: { key: true, name: true } }, user: { select: { id: true, name: true, email: true, lastLoginAt: true } } },
    }),
    Promise.all([
      prisma.membership.count({ where: { tenantId: tenant.id, status: 'ACTIVE', role: { key: { not: 'customer' } } } }),
      prisma.customer.count({ where: { tenantId: tenant.id } }),
      prisma.project.count({ where: { tenantId: tenant.id } }),
      prisma.invoice.count({ where: { tenantId: tenant.id } }),
      prisma.feedback.count({ where: { tenantId: tenant.id } }),
    ]),
    prisma.aiUsage.count({ where: { tenantId: tenant.id, createdAt: { gte: monthStart } } }),
    prisma.invitation.findMany({ where: { tenantId: tenant.id, acceptedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, email: true, expiresAt: true, role: { select: { name: true } } } }),
  ]);
  await audit(req, { action: 'platform.tenant_view', entityType: 'tenant', entityId: tenant.id, tenantId: tenant.id });
  res.json({
    tenant, admins, pendingInvites: invites,
    usage: { users: counts[0], customers: counts[1], projects: counts[2], invoices: counts[3], feedback: counts[4], aiRequestsThisMonth: ai, storageMb: Math.round(Number(tenant.storageUsedBytes) / 1048576 * 10) / 10 },
  });
});

platformRouter.patch('/tenants/:id', async (req, res) => {
  const body = parse(z.object({
    name: z.string().min(2).max(120).optional(),
    status: z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED']).optional(),
    planId: z.string().nullable().optional(),
    trialEndsAt: z.coerce.date().nullable().optional(),
    currentPeriodEnd: z.coerce.date().nullable().optional(),
    reason: z.string().max(500).optional(),
  }), req.body);
  const { reason, ...data } = body;
  if (data.planId && !(await prisma.plan.findUnique({ where: { id: data.planId } }))) throw badRequest('Unknown plan');
  const tenant = await prisma.tenant.update({ where: { id: String(req.params.id) }, data, omit: { settings: true } });
  if (data.status === 'SUSPENDED' || data.status === 'CANCELLED') {
    await prisma.notification.createMany({
      data: (await prisma.membership.findMany({ where: { tenantId: tenant.id, role: { key: 'owner' } }, select: { userId: true } }))
        .map((m) => ({ tenantId: tenant.id, userId: m.userId, title: `Workspace ${data.status!.toLowerCase()}`, body: reason })),
    });
  }
  await audit(req, { action: data.status ? `platform.tenant_${data.status.toLowerCase()}` : 'platform.tenant_update', entityType: 'tenant', entityId: tenant.id, tenantId: tenant.id, meta: body });
  res.json(tenant);
});

platformRouter.post('/tenants/:id/admins', async (req, res) => {
  const body = parse(z.object({ email: z.string().email().toLowerCase(), role: z.enum(['owner', 'admin']).default('admin') }), req.body);
  const tenant = await prisma.tenant.findUnique({ where: { id: String(req.params.id) } });
  if (!tenant) throw notFound('Tenant');
  const role = await prisma.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenant.id, key: body.role } } });
  const token = randomToken();
  await prisma.invitation.deleteMany({ where: { tenantId: tenant.id, email: body.email, acceptedAt: null } });
  await prisma.invitation.create({ data: { tenantId: tenant.id, email: body.email, roleId: role.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 7 * 86_400_000), invitedById: req.user!.id } });
  const link = `${config.appUrl}/accept-invite?token=${token}`;
  await enqueueEmail({ tenantId: tenant.id, to: body.email, subject: `Administrator access to ${tenant.name}`, text: `You have been invited as ${role.name} of ${tenant.name}.\n\n${link}` });
  await audit(req, { action: 'platform.tenant_admin_invite', entityType: 'tenant', entityId: tenant.id, tenantId: tenant.id, meta: body });
  res.status(201).json({ ok: true, inviteLink: (await mailConfigured(tenant.id)) ? undefined : link });
});

platformRouter.patch('/tenants/:id/admins/:membershipId', async (req, res) => {
  const body = parse(z.object({ status: z.enum(['ACTIVE', 'DISABLED']) }), req.body);
  const m = await prisma.membership.findFirst({ where: { id: String(req.params.membershipId), tenantId: String(req.params.id) } });
  if (!m) throw notFound('Administrator');
  await prisma.membership.update({ where: { id: m.id }, data: { status: body.status } });
  await audit(req, { action: 'platform.tenant_admin_status', entityType: 'membership', entityId: m.id, tenantId: m.tenantId, meta: body });
  res.json({ ok: true });
});

// ── Plans ──

const planSchema = z.object({
  code: z.string().regex(/^[a-z0-9-]{2,30}$/),
  name: z.string().min(2).max(60),
  priceMonthly: z.coerce.number().min(0),
  maxUsers: z.coerce.number().int().min(1),
  maxCustomers: z.coerce.number().int().min(1),
  storageMb: z.coerce.number().int().min(10),
  aiRequests: z.coerce.number().int().min(0),
  modules: z.array(z.enum(MODULES)),
  active: z.boolean().optional(),
});

// ── Currency catalog (global). Tenants choose which of these to enable. ──

const currencySchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO 4217 code'),
  name: z.string().trim().min(2).max(60),
  symbol: z.string().trim().min(1).max(6),
  decimals: z.coerce.number().int().min(0).max(2),
  isActive: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(1000).optional(),
});

platformRouter.get('/currencies', async (_req, res) => {
  const rows = await prisma.currency.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], include: { _count: { select: { tenants: { where: { isActive: true } } } } } });
  res.json(rows.map(({ _count, ...c }) => ({ ...c, tenantsUsing: _count.tenants })));
});

platformRouter.post('/currencies', async (req, res) => {
  const body = parse(currencySchema, req.body);
  if (await prisma.currency.findUnique({ where: { code: body.code } })) throw badRequest(`${body.code} is already in the catalog`);
  const c = await prisma.currency.create({ data: body });
  await audit(req, { action: 'platform.currency_create', entityType: 'currency', entityId: c.code, tenantId: null, meta: body });
  res.status(201).json(c);
});

platformRouter.patch('/currencies/:code', async (req, res) => {
  const body = parse(currencySchema.omit({ code: true }).partial(), req.body);
  const code = String(req.params.code).toUpperCase();
  if (!(await prisma.currency.findUnique({ where: { code } }))) throw notFound('Currency');
  if (body.isActive === false) {
    const usedAsDefault = await prisma.tenant.count({ where: { OR: [{ defaultCurrency: code }, { currency: code }] } });
    if (usedAsDefault) throw badRequest(`${code} is the default or base currency of ${usedAsDefault} organization(s) and cannot be deactivated`);
  }
  const c = await prisma.currency.update({ where: { code }, data: body });
  await audit(req, { action: 'platform.currency_update', entityType: 'currency', entityId: code, tenantId: null, meta: body });
  res.json(c);
});

platformRouter.get('/plans', async (_req, res) => {
  res.json({ plans: await prisma.plan.findMany({ orderBy: { priceMonthly: 'asc' }, include: { _count: { select: { tenants: true } } } }), modules: MODULES });
});

platformRouter.post('/plans', async (req, res) => {
  const body = parse(planSchema, req.body);
  const plan = await prisma.plan.create({ data: body });
  await audit(req, { action: 'platform.plan_create', entityType: 'plan', entityId: plan.id, tenantId: null, meta: body });
  res.status(201).json(plan);
});

platformRouter.patch('/plans/:id', async (req, res) => {
  const body = parse(planSchema.partial(), req.body);
  const plan = await prisma.plan.update({ where: { id: String(req.params.id) }, data: body });
  await audit(req, { action: 'platform.plan_update', entityType: 'plan', entityId: plan.id, tenantId: null, meta: body });
  res.json(plan);
});

// ── Platform settings ──

const SETTING_KEYS = ['defaultFeedbackTenant', 'defaultTrialDays', 'signupEnabled', 'supportEmail'] as const;

platformRouter.get('/settings', async (_req, res) => {
  const rows = await prisma.platformSetting.findMany();
  res.json(Object.fromEntries(SETTING_KEYS.map((k) => [k, rows.find((r) => r.key === k)?.value ?? null])));
});

platformRouter.patch('/settings', async (req, res) => {
  const body = parse(z.object({
    defaultFeedbackTenant: z.string().optional(), defaultTrialDays: z.number().int().min(0).max(365).optional(),
    signupEnabled: z.boolean().optional(), supportEmail: z.string().email().optional(),
  }), req.body);
  if (body.defaultFeedbackTenant && !(await prisma.tenant.findUnique({ where: { slug: body.defaultFeedbackTenant } }))) throw badRequest('No tenant with that slug');
  for (const [key, value] of Object.entries(body)) {
    await prisma.platformSetting.upsert({ where: { key }, create: { key, value: value as never }, update: { value: value as never } });
  }
  await audit(req, { action: 'platform.settings', tenantId: null, meta: body });
  res.json({ ok: true });
});

platformRouter.get('/integrations', async (_req, res) => {
  res.json({
    email: (await mailConfigured()) ? 'smtp' : 'console', storage: config.storage.driver, jobs: config.redisUrl ? 'bullmq' : 'in-process',
    ai: config.ai.provider === 'anthropic' && config.ai.anthropicKey ? `anthropic:${config.ai.anthropicModel}` : 'heuristic',
  });
});

platformRouter.get('/audit-logs', async (req, res) => {
  const p = listParams(req, ['createdAt']);
  const where = {
    ...(qstr(req.query.tenantId) ? { tenantId: String(req.query.tenantId) } : {}),
    ...(qstr(req.query.action) ? { action: { startsWith: String(req.query.action) } } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.pageSize, include: { tenant: { select: { name: true, slug: true } } } }),
    prisma.auditLog.count({ where }),
  ]);
  res.json(paged(items, total, p));
});
