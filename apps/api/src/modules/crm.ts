import { Router } from 'express';
import { z } from 'zod';
import type { Lead, LeadStage } from '@prisma/client';
import { prisma, type Tx } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { listParams, orderBy, paged, parseCsv, qstr, searchAny, toCsv } from '../lib/list.js';
import { nextNumber } from '../lib/numbering.js';
import { assertTenantRefs } from '../lib/tenantRefs.js';
import { tenantSettings } from '../lib/tenants.js';
import { scoreLead } from '../lib/ai/scoring.js';
import { runAi } from '../lib/ai/index.js';
import { notify } from '../lib/notify.js';
import { can, requirePerm, tid } from '../middleware/tenant.js';
import { parse } from '../middleware/validate.js';

export const crmRouter = Router();

export const LEAD_STAGES: LeadStage[] = ['NEW', 'CONTACTED', 'QUALIFIED', 'MEETING_SCHEDULED', 'PROPOSAL_SENT', 'NEGOTIATION', 'WON', 'LOST', 'ON_HOLD'];
const opt = (s: z.ZodString) => s.optional().nullable().or(z.literal('').transform(() => null));
const date = z.coerce.date().optional().nullable().or(z.literal('').transform(() => null));

const leadSchema = z.object({
  name: z.string().min(1).max(160),
  company: opt(z.string().max(160)),
  email: opt(z.string().email()),
  phone: opt(z.string().max(40)),
  source: opt(z.string().max(80)),
  serviceInterest: opt(z.string().max(80)),
  budgetRange: opt(z.string().max(80)),
  estimatedValue: z.coerce.number().min(0).optional().nullable(),
  expectedDecisionAt: date,
  assignedToId: z.string().optional().nullable(),
  stage: z.enum(LEAD_STAGES as [LeadStage, ...LeadStage[]]).optional(),
  nextFollowUpAt: date,
  proposalStatus: opt(z.string().max(80)),
  notes: opt(z.string().max(10000)),
  lostReason: opt(z.string().max(500)),
});

/** Sales executives (leads.update without customers-wide management) only see their own leads. */
function leadScope(req: Parameters<typeof tid>[0]) {
  return req.ctx!.roleKey === 'sales' ? { assignedToId: req.user!.id } : {};
}

async function findLead(req: Parameters<typeof tid>[0], id: string) {
  const lead = await prisma.lead.findFirst({ where: { id, tenantId: tid(req), ...leadScope(req) } });
  if (!lead) throw notFound('Lead');
  return lead;
}

export async function rescoreLead(tenantId: string, leadId: string, tx: Tx = prisma) {
  const lead = await tx.lead.findFirstOrThrow({ where: { id: leadId, tenantId } });
  const activities = await tx.activity.findMany({ where: { tenantId, leadId }, select: { type: true, occurredAt: true, completed: true } });
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const settings = tenantSettings(tenant.settings);
  // Historical conversion rate for the same service, only when enough closed data exists.
  let historicalWinRate: number | undefined;
  if (lead.serviceInterest) {
    const closed = await tx.lead.groupBy({
      by: ['stage'], where: { tenantId, serviceInterest: lead.serviceInterest, stage: { in: ['WON', 'LOST'] } }, _count: true,
    });
    const won = closed.find((c) => c.stage === 'WON')?._count ?? 0;
    const total = closed.reduce((s, c) => s + c._count, 0);
    if (total >= 5) historicalWinRate = Math.round((won / total) * 100);
  }
  const result = scoreLead(
    { ...lead, estimatedValue: lead.estimatedValue ? Number(lead.estimatedValue) : null },
    activities,
    { coreServices: settings.crm.coreServices, historicalWinRate },
  );
  await tx.lead.update({ where: { id: lead.id }, data: { score: result.score, scoreDetails: result as object, scoredAt: new Date() } });
  return result;
}

async function ensureFollowUpTask(tx: Tx, tenantId: string, lead: Lead, userId: string, dueAt: Date, reason: string) {
  const open = await tx.task.findFirst({ where: { tenantId, leadId: lead.id, type: 'FOLLOW_UP', status: { in: ['TODO', 'IN_PROGRESS'] } } });
  if (open) {
    await tx.task.update({ where: { id: open.id }, data: { dueDate: dueAt } });
    return open;
  }
  return tx.task.create({
    data: {
      tenantId, type: 'FOLLOW_UP', title: `Follow up: ${lead.name}${lead.company ? ` (${lead.company})` : ''}`,
      description: reason, dueDate: dueAt, assigneeId: lead.assignedToId ?? userId, createdById: userId, leadId: lead.id, automated: true,
      priority: lead.score >= 75 ? 'HIGH' : 'MEDIUM',
    },
  });
}

crmRouter.get('/leads', requirePerm('leads.read'), async (req, res) => {
  const p = listParams(req, ['createdAt', 'score', 'name', 'nextFollowUpAt', 'estimatedValue']);
  const where = {
    tenantId: tid(req),
    ...leadScope(req),
    ...searchAny(p.q, ['name', 'company', 'email', 'phone']),
    ...(qstr(req.query.stage) ? { stage: req.query.stage as LeadStage } : {}),
    ...(qstr(req.query.assignedToId) ? { assignedToId: String(req.query.assignedToId) } : {}),
    ...(qstr(req.query.source) ? { source: String(req.query.source) } : {}),
    ...(qstr(req.query.serviceInterest) ? { serviceInterest: String(req.query.serviceInterest) } : {}),
  };
  if (req.query.format === 'csv') {
    const rows = await prisma.lead.findMany({ where, orderBy: { createdAt: 'desc' } });
    await audit(req, { action: 'leads.export', meta: { count: rows.length } });
    res.type('text/csv').attachment('leads.csv');
    return res.send(toCsv(rows as never, ['name', 'company', 'email', 'phone', 'source', 'serviceInterest', 'budgetRange', 'estimatedValue', 'stage', 'score', 'nextFollowUpAt', 'createdAt']));
  }
  const [items, total] = await Promise.all([
    prisma.lead.findMany({ where, orderBy: orderBy(p), skip: p.skip, take: p.pageSize }),
    prisma.lead.count({ where }),
  ]);
  res.json(paged(items, total, p));
});

crmRouter.get('/leads/pipeline', requirePerm('leads.read'), async (req, res) => {
  const leads = await prisma.lead.findMany({
    where: { tenantId: tid(req), ...leadScope(req), ...searchAny(qstr(req.query.q), ['name', 'company', 'email']) },
    select: { id: true, name: true, company: true, stage: true, score: true, estimatedValue: true, nextFollowUpAt: true, assignedToId: true, serviceInterest: true },
    orderBy: [{ score: 'desc' }, { updatedAt: 'desc' }],
    take: 1000,
  });
  const columns = LEAD_STAGES.map((stage) => {
    const items = leads.filter((l) => l.stage === stage);
    return { stage, count: items.length, value: items.reduce((s, l) => s + Number(l.estimatedValue ?? 0), 0), items };
  });
  res.json(columns);
});

crmRouter.get('/leads/duplicates', requirePerm('leads.read'), async (req, res) => {
  const email = qstr(req.query.email)?.toLowerCase();
  const phone = qstr(req.query.phone)?.replace(/\D/g, '').slice(-10);
  const company = qstr(req.query.company);
  const or: object[] = [];
  if (email) or.push({ email: { equals: email, mode: 'insensitive' } });
  if (phone && phone.length >= 7) or.push({ phone: { contains: phone } });
  if (company) or.push({ company: { equals: company, mode: 'insensitive' } });
  if (!or.length) return res.json({ leads: [], customers: [] });
  const [leads, customers] = await Promise.all([
    prisma.lead.findMany({ where: { tenantId: tid(req), OR: or }, select: { id: true, name: true, company: true, email: true, stage: true }, take: 10 }),
    can(req, 'customers.read')
      ? prisma.customer.findMany({ where: { tenantId: tid(req), OR: or }, select: { id: true, name: true, company: true, email: true, code: true }, take: 10 })
      : Promise.resolve([]),
  ]);
  res.json({ leads, customers });
});

crmRouter.post('/leads', requirePerm('leads.update'), async (req, res) => {
  const body = parse(leadSchema, req.body);
  await assertTenantRefs(tid(req), { user: body.assignedToId });
  const lead = await prisma.$transaction(async (tx) => {
    const created = await tx.lead.create({
      data: { ...body, tenantId: tid(req), assignedToId: body.assignedToId ?? req.user!.id, email: body.email?.toLowerCase() },
    });
    await tx.activity.create({ data: { tenantId: tid(req), leadId: created.id, type: 'SYSTEM', subject: 'Lead created', userId: req.user!.id } });
    return created;
  });
  const score = await rescoreLead(tid(req), lead.id);
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) } });
  if (tenantSettings(tenant.settings).crm.autoFollowUpTasks) {
    const due = body.nextFollowUpAt ?? new Date(score.suggestedFollowUp);
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.lead.update({ where: { id: lead.id }, data: { nextFollowUpAt: due } });
      await ensureFollowUpTask(tx, tid(req), fresh, req.user!.id, due, score.nextAction);
    });
  }
  if (lead.assignedToId && lead.assignedToId !== req.user!.id) {
    await notify(tid(req), [lead.assignedToId], { title: 'New lead assigned to you', body: lead.name, link: `/leads/${lead.id}` });
  }
  await audit(req, { action: 'leads.create', entityType: 'lead', entityId: lead.id });
  res.status(201).json(await prisma.lead.findUnique({ where: { id: lead.id } }));
});

crmRouter.get('/leads/:id', requirePerm('leads.read'), async (req, res) => {
  const lead = await findLead(req, String(req.params.id));
  const [activities, tasks, quotations] = await Promise.all([
    prisma.activity.findMany({ where: { tenantId: tid(req), leadId: lead.id }, orderBy: { occurredAt: 'desc' } }),
    prisma.task.findMany({ where: { tenantId: tid(req), leadId: lead.id }, orderBy: { dueDate: 'asc' } }),
    can(req, 'quotations.read')
      ? prisma.quotation.findMany({ where: { tenantId: tid(req), leadId: lead.id }, select: { id: true, number: true, status: true, total: true, issueDate: true } })
      : Promise.resolve([]),
  ]);
  res.json({ ...lead, activities, tasks, quotations });
});

crmRouter.patch('/leads/:id', requirePerm('leads.update'), async (req, res) => {
  const lead = await findLead(req, String(req.params.id));
  const body = parse(leadSchema.partial(), req.body);
  await assertTenantRefs(tid(req), { user: body.assignedToId });
  if (body.stage === 'LOST' && !body.lostReason && !lead.lostReason) throw badRequest('Please give a reason the lead was lost');
  await prisma.$transaction(async (tx) => {
    await tx.lead.update({ where: { id: lead.id }, data: { ...body, email: body.email?.toLowerCase() ?? body.email } });
    if (body.stage && body.stage !== lead.stage) {
      await tx.activity.create({
        data: { tenantId: tid(req), leadId: lead.id, type: 'STAGE_CHANGE', subject: `Stage changed from ${lead.stage} to ${body.stage}`, body: body.lostReason ?? undefined, userId: req.user!.id },
      });
      if (['WON', 'LOST'].includes(body.stage)) {
        await tx.task.updateMany({ where: { tenantId: tid(req), leadId: lead.id, type: 'FOLLOW_UP', status: { in: ['TODO', 'IN_PROGRESS'] } }, data: { status: 'CANCELLED' } });
      }
    }
    if (body.nextFollowUpAt) {
      const fresh = await tx.lead.findUniqueOrThrow({ where: { id: lead.id } });
      if (!['WON', 'LOST'].includes(fresh.stage)) await ensureFollowUpTask(tx, tid(req), fresh, req.user!.id, body.nextFollowUpAt, 'Scheduled follow-up');
    }
  });
  await rescoreLead(tid(req), lead.id);
  if (body.assignedToId && body.assignedToId !== lead.assignedToId) {
    await notify(tid(req), [body.assignedToId], { title: 'Lead assigned to you', body: lead.name, link: `/leads/${lead.id}` });
  }
  await audit(req, { action: body.stage && body.stage !== lead.stage ? 'leads.stage_change' : 'leads.update', entityType: 'lead', entityId: lead.id, meta: { fields: Object.keys(body), stage: body.stage } });
  res.json(await prisma.lead.findUnique({ where: { id: lead.id } }));
});

crmRouter.delete('/leads/:id', requirePerm('leads.update'), async (req, res) => {
  const lead = await findLead(req, String(req.params.id));
  if (lead.customerId) throw conflict('Converted leads cannot be deleted; they are part of the customer history');
  await prisma.lead.delete({ where: { id: lead.id } });
  await audit(req, { action: 'leads.delete', entityType: 'lead', entityId: lead.id, meta: { name: lead.name } });
  res.json({ ok: true });
});

crmRouter.post('/leads/:id/score', requirePerm('leads.read'), async (req, res) => {
  const lead = await findLead(req, String(req.params.id));
  res.json(await rescoreLead(tid(req), lead.id));
});

/** Converts a lead into a customer (reusing an existing customer when the email matches) and optionally a project. */
crmRouter.post('/leads/:id/convert', requirePerm('leads.update'), requirePerm('customers.update'), async (req, res) => {
  const lead = await findLead(req, String(req.params.id));
  const body = parse(z.object({
    existingCustomerId: z.string().optional(),
    createProject: z.boolean().default(false),
    projectName: z.string().max(160).optional(),
    startOnboarding: z.boolean().default(true),
  }), req.body ?? {});
  if (lead.customerId) throw conflict('This lead has already been converted');
  if (body.existingCustomerId) await assertTenantRefs(tid(req), { customer: body.existingCustomerId });

  const result = await prisma.$transaction(async (tx) => {
    let customer = body.existingCustomerId
      ? await tx.customer.findFirstOrThrow({ where: { id: body.existingCustomerId, tenantId: tid(req) } })
      : lead.email
        ? await tx.customer.findFirst({ where: { tenantId: tid(req), email: { equals: lead.email, mode: 'insensitive' } } })
        : null;
    let reused = !!customer;
    if (!customer) {
      customer = await tx.customer.create({
        data: {
          tenantId: tid(req), code: await nextNumber(tx, tid(req), 'CUSTOMER'), name: lead.name, company: lead.company,
          email: lead.email, phone: lead.phone, ownerId: lead.assignedToId, convertedFromLeadId: lead.id,
          notes: lead.notes,
        },
      });
      reused = false;
      if (lead.name) {
        await tx.contact.create({ data: { tenantId: tid(req), customerId: customer.id, name: lead.name, email: lead.email, phone: lead.phone, isPrimary: true } });
      }
    }
    // Carry the lead's history onto the customer timeline (activities keep their leadId too).
    await tx.activity.updateMany({ where: { tenantId: tid(req), leadId: lead.id }, data: { customerId: customer.id } });
    await tx.quotation.updateMany({ where: { tenantId: tid(req), leadId: lead.id, customerId: null }, data: { customerId: customer.id } });
    await tx.lead.update({ where: { id: lead.id }, data: { customerId: customer.id, stage: 'WON', convertedAt: new Date() } });
    await tx.task.updateMany({ where: { tenantId: tid(req), leadId: lead.id, type: 'FOLLOW_UP', status: { in: ['TODO', 'IN_PROGRESS'] } }, data: { status: 'DONE', completedAt: new Date() } });
    await tx.activity.create({
      data: { tenantId: tid(req), leadId: lead.id, customerId: customer.id, type: 'SYSTEM', subject: reused ? `Converted and linked to existing customer ${customer.code}` : `Converted to customer ${customer.code}`, userId: req.user!.id },
    });

    let project = null;
    if (body.createProject) {
      const existing = await tx.project.findFirst({ where: { tenantId: tid(req), customerId: customer.id, name: body.projectName ?? `${lead.serviceInterest ?? 'Project'} for ${customer.company ?? customer.name}` } });
      project = existing ?? await tx.project.create({
        data: {
          tenantId: tid(req), code: await nextNumber(tx, tid(req), 'PROJECT'), customerId: customer.id,
          name: body.projectName ?? `${lead.serviceInterest ?? 'Project'} for ${customer.company ?? customer.name}`,
          serviceCategory: lead.serviceInterest, budget: lead.estimatedValue, managerId: req.user!.id,
        },
      });
    }
    if (body.startOnboarding && customer.onboardingStatus === 'NOT_STARTED') {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tid(req) } });
      await tx.onboardingItem.createMany({
        data: tenantSettings(tenant.settings).onboardingTemplate.map((title, i) => ({ tenantId: tid(req), customerId: customer!.id, title, sortOrder: i })),
      });
      await tx.customer.update({ where: { id: customer.id }, data: { onboardingStatus: 'IN_PROGRESS' } });
    }
    return { customer, project, reused };
  });
  await rescoreLead(tid(req), lead.id);
  await audit(req, { action: 'leads.convert', entityType: 'lead', entityId: lead.id, meta: { customerId: result.customer.id, projectId: result.project?.id, reused: result.reused } });
  res.json(result);
});

crmRouter.post('/leads/import', requirePerm('leads.update'), async (req, res) => {
  const body = parse(z.object({ csv: z.string().min(1).max(2_000_000), skipDuplicates: z.boolean().default(true) }), req.body);
  const rows = parseCsv(body.csv);
  if (!rows.length) throw badRequest('The CSV file has no data rows');
  if (rows.length > 2000) throw badRequest('Import at most 2000 rows at a time');
  const pick = (r: Record<string, string>, ...keys: string[]) => {
    for (const k of keys) {
      const hit = Object.keys(r).find((rk) => rk.toLowerCase().replace(/[^a-z]/g, '') === k);
      if (hit && r[hit]) return r[hit];
    }
    return undefined;
  };
  let created = 0;
  const skipped: { row: number; reason: string }[] = [];
  for (const [i, r] of rows.entries()) {
    const parsed = leadSchema.safeParse({
      name: pick(r, 'name', 'fullname', 'contactname'),
      company: pick(r, 'company', 'organization', 'organisation'),
      email: pick(r, 'email', 'emailaddress'),
      phone: pick(r, 'phone', 'mobile', 'phonenumber'),
      source: pick(r, 'source', 'leadsource') ?? 'CSV import',
      serviceInterest: pick(r, 'serviceinterest', 'service'),
      budgetRange: pick(r, 'budgetrange', 'budget'),
      estimatedValue: pick(r, 'estimatedvalue', 'dealvalue', 'value'),
      notes: pick(r, 'notes', 'note'),
    });
    if (!parsed.success) { skipped.push({ row: i + 2, reason: parsed.error.issues[0]?.message ?? 'Invalid row' }); continue; }
    const d = parsed.data;
    if (body.skipDuplicates && d.email) {
      const dup = await prisma.lead.findFirst({ where: { tenantId: tid(req), email: { equals: d.email, mode: 'insensitive' } }, select: { id: true } });
      if (dup) { skipped.push({ row: i + 2, reason: `Duplicate email ${d.email}` }); continue; }
    }
    const lead = await prisma.lead.create({ data: { ...d, email: d.email?.toLowerCase(), tenantId: tid(req), assignedToId: req.user!.id } });
    await rescoreLead(tid(req), lead.id);
    created++;
  }
  await audit(req, { action: 'leads.import', meta: { created, skipped: skipped.length } });
  res.json({ created, skipped });
});

// ── Activities ──

const activitySchema = z.object({
  type: z.enum(['NOTE', 'CALL', 'EMAIL', 'MEETING', 'WHATSAPP']),
  subject: z.string().min(1).max(200),
  body: opt(z.string().max(10000)),
  leadId: z.string().optional().nullable(),
  customerId: z.string().optional().nullable(),
  occurredAt: z.coerce.date().optional(),
  completed: z.boolean().optional(),
  nextFollowUpAt: date,
});

crmRouter.get('/activities', requirePerm('leads.read', 'customers.read'), async (req, res) => {
  const p = listParams(req, ['occurredAt']);
  const where = {
    tenantId: tid(req),
    type: { not: 'SYSTEM' as const },
    ...searchAny(p.q, ['subject', 'body']),
    ...(qstr(req.query.type) ? { type: req.query.type as 'CALL' } : {}),
    ...(qstr(req.query.leadId) ? { leadId: String(req.query.leadId) } : {}),
    ...(qstr(req.query.customerId) ? { customerId: String(req.query.customerId) } : {}),
    ...(req.query.upcoming === '1' ? { completed: false } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.activity.findMany({
      where, orderBy: orderBy(p), skip: p.skip, take: p.pageSize,
      include: { lead: { select: { id: true, name: true, company: true } }, customer: { select: { id: true, name: true } } },
    }),
    prisma.activity.count({ where }),
  ]);
  res.json(paged(items, total, p));
});

crmRouter.post('/activities', requirePerm('leads.update', 'customers.update'), async (req, res) => {
  const { nextFollowUpAt, ...body } = parse(activitySchema, req.body);
  if (!body.leadId && !body.customerId) throw badRequest('Link the activity to a lead or a customer');
  await assertTenantRefs(tid(req), { lead: body.leadId, customer: body.customerId });
  if (body.leadId) await findLead(req, body.leadId);
  const activity = await prisma.$transaction(async (tx) => {
    const a = await tx.activity.create({ data: { ...body, tenantId: tid(req), userId: req.user!.id } });
    if (body.leadId && body.completed !== false && body.type !== 'NOTE') {
      const lead = await tx.lead.update({
        where: { id: body.leadId },
        data: {
          lastContactAt: body.occurredAt ?? new Date(),
          ...(nextFollowUpAt ? { nextFollowUpAt } : {}),
        },
      });
      if (lead.stage === 'NEW') {
        await tx.lead.update({ where: { id: lead.id }, data: { stage: 'CONTACTED' } });
      }
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tid(req) } });
      const crm = tenantSettings(tenant.settings).crm;
      if (!['WON', 'LOST'].includes(lead.stage) && (nextFollowUpAt || crm.autoFollowUpTasks)) {
        const due = nextFollowUpAt ?? new Date(Date.now() + crm.followUpDaysAfterContact * 86_400_000);
        await tx.lead.update({ where: { id: lead.id }, data: { nextFollowUpAt: due } });
        await ensureFollowUpTask(tx, tid(req), lead, req.user!.id, due, `Follow up after ${body.type.toLowerCase()}: ${body.subject}`);
      }
    }
    return a;
  });
  if (body.leadId) await rescoreLead(tid(req), body.leadId);
  res.status(201).json(activity);
});

crmRouter.patch('/activities/:id', requirePerm('leads.update', 'customers.update'), async (req, res) => {
  const body = parse(activitySchema.omit({ leadId: true, customerId: true, nextFollowUpAt: true }).partial(), req.body);
  const r = await prisma.activity.updateMany({ where: { id: String(req.params.id), tenantId: tid(req), type: { not: 'SYSTEM' } }, data: body });
  if (!r.count) throw notFound('Activity');
  res.json(await prisma.activity.findUnique({ where: { id: String(req.params.id) } }));
});

crmRouter.delete('/activities/:id', requirePerm('leads.update', 'customers.update'), async (req, res) => {
  const r = await prisma.activity.deleteMany({ where: { id: String(req.params.id), tenantId: tid(req), type: { not: 'SYSTEM' }, userId: req.user!.id } });
  if (!r.count) throw notFound('Activity');
  res.json({ ok: true });
});

// ── AI assistance (drafts only; nothing is sent automatically) ──

crmRouter.post('/leads/:id/ai/:feature', requirePerm('ai.use'), async (req, res) => {
  const lead = await findLead(req, String(req.params.id));
  const feature = String(req.params.feature);
  if (!['followup_draft', 'summary', 'next_actions'].includes(feature)) throw notFound('AI feature');
  const activities = await prisma.activity.findMany({
    where: { tenantId: tid(req), leadId: lead.id }, orderBy: { occurredAt: 'desc' }, take: 20,
    select: { type: true, subject: true, body: true, occurredAt: true },
  });
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) }, select: { name: true } });
  const details = lead.scoreDetails as { nextAction?: string; missing?: string[] };
  const context = {
    company: tenant.name, sender: req.user!.name,
    lead: { name: lead.name, company: lead.company, stage: lead.stage, serviceInterest: lead.serviceInterest, budgetRange: lead.budgetRange, proposalStatus: lead.proposalStatus, notes: lead.notes?.slice(0, 2000) },
    recentActivities: activities.map((a) => ({ ...a, body: a.body?.slice(0, 500) })),
    heuristic: { score: lead.score, nextAction: details.nextAction, missing: details.missing },
  };
  const first = lead.name.split(' ')[0];
  const templates: Record<string, () => string> = {
    followup_draft: () =>
      `Subject: Following up on your ${lead.serviceInterest ?? 'project'} enquiry\n\nHi ${first},\n\n` +
      `Thank you for your time${activities.length ? ' during our recent conversation' : ''}. I wanted to follow up on your ${lead.serviceInterest ?? ''} requirements` +
      `${lead.company ? ` for ${lead.company}` : ''}.\n\n${lead.stage === 'PROPOSAL_SENT' ? 'Have you had a chance to review our proposal? I would be happy to walk you through it or answer any questions.' : 'Could we schedule a short call this week to discuss your goals and the next steps?'}\n\n` +
      `Best regards,\n${req.user!.name}\n${tenant.name}`,
    summary: () => {
      const lines = [`- Stage: ${lead.stage.replace(/_/g, ' ').toLowerCase()}; heuristic score ${lead.score}/100`];
      if (lead.serviceInterest) lines.push(`- Interested in ${lead.serviceInterest}${lead.budgetRange ? `, budget ${lead.budgetRange}` : ''}`);
      lines.push(`- ${activities.filter((a) => a.type !== 'SYSTEM').length} logged interaction(s)` + (activities[0] ? `, latest: ${activities[0].subject}` : ''));
      if (details.missing?.length) lines.push(`- Missing: ${details.missing.join(', ')}`);
      if (details.nextAction) lines.push(`- Next step: ${details.nextAction}`);
      return lines.join('\n');
    },
    next_actions: () => {
      const acts = [details.nextAction ?? 'Contact the lead'];
      if (details.missing?.length) acts.push(`Capture missing details: ${details.missing.slice(0, 3).join(', ')}`);
      acts.push(lead.stage === 'PROPOSAL_SENT' || lead.stage === 'NEGOTIATION' ? 'Prepare a revised quotation if needed' : 'Share a relevant case study');
      return acts.map((a, i) => `${i + 1}. ${a}`).join('\n');
    },
  };
  res.json(await runAi(tid(req), req.user!.id, feature as 'summary', context, templates[feature]));
});

export { findLead };
