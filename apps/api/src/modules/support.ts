import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Prisma, TicketStatus } from '@prisma/client';
import { prisma } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { forbidden, notFound } from '../lib/errors.js';
import { listParams, orderBy, paged, qstr, searchAny } from '../lib/list.js';
import { nextNumber } from '../lib/numbering.js';
import { assertTenantRefs } from '../lib/tenantRefs.js';
import { notify } from '../lib/notify.js';
import { enqueueEmail } from '../lib/queue.js';
import { slugify } from '../lib/tenants.js';
import { can, requirePerm, tid } from '../middleware/tenant.js';
import { parse } from '../middleware/validate.js';

export const supportRouter = Router();

const STATUSES: TicketStatus[] = ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'];

/** Agents with only tickets.read_assigned see tickets assigned to them (or that they created). */
export function ticketScope(req: Request): Prisma.TicketWhereInput {
  if (can(req, 'tickets.read')) return { tenantId: tid(req) };
  if (can(req, 'tickets.read_assigned')) return { tenantId: tid(req), OR: [{ assigneeId: req.user!.id }, { createdById: req.user!.id }] };
  throw forbidden('Missing permission: tickets.read');
}

async function findTicket(req: Request, id: string) {
  const t = await prisma.ticket.findFirst({ where: { AND: [ticketScope(req), { id }] } });
  if (!t) throw notFound('Ticket');
  return t;
}

supportRouter.get('/tickets', requirePerm('tickets.read', 'tickets.read_assigned'), async (req, res) => {
  const p = listParams(req, ['createdAt', 'updatedAt', 'priority', 'dueAt']);
  const status = qstr(req.query.status);
  const where: Prisma.TicketWhereInput = {
    AND: [
      ticketScope(req),
      searchAny(p.q, ['number', 'subject', 'description']),
      status === 'open' ? { status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER'] } } : status ? { status: status as TicketStatus } : {},
      qstr(req.query.priority) ? { priority: req.query.priority as 'HIGH' } : {},
      qstr(req.query.categoryId) ? { categoryId: String(req.query.categoryId) } : {},
      qstr(req.query.customerId) ? { customerId: String(req.query.customerId) } : {},
      req.query.mine === '1' ? { assigneeId: req.user!.id } : {},
      req.query.unassigned === '1' ? { assigneeId: null } : {},
      req.query.overdue === '1' ? { dueAt: { lt: new Date() }, status: { in: ['OPEN', 'IN_PROGRESS'] } } : {},
    ],
  };
  const [items, total] = await Promise.all([
    prisma.ticket.findMany({
      where, orderBy: orderBy(p), skip: p.skip, take: p.pageSize,
      include: { customer: { select: { id: true, name: true } }, category: { select: { id: true, name: true } }, _count: { select: { comments: true } } },
    }),
    prisma.ticket.count({ where }),
  ]);
  res.json(paged(items, total, p));
});

const ticketSchema = z.object({
  subject: z.string().min(1).max(200),
  description: z.string().min(1).max(20000),
  customerId: z.string().optional().nullable(),
  projectId: z.string().optional().nullable(),
  categoryId: z.string().optional().nullable(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  assigneeId: z.string().optional().nullable(),
});

export async function createTicket(tenantId: string, userId: string, body: z.infer<typeof ticketSchema>) {
  await assertTenantRefs(tenantId, { customer: body.customerId, project: body.projectId, category: body.categoryId, user: body.assigneeId });
  const category = body.categoryId ? await prisma.ticketCategory.findUnique({ where: { id: body.categoryId } }) : null;
  const slaHours = category?.slaHours ?? 48;
  const factor = { URGENT: 0.25, HIGH: 0.5, MEDIUM: 1, LOW: 2 }[body.priority ?? 'MEDIUM'];
  return prisma.$transaction(async (tx) =>
    tx.ticket.create({
      data: {
        ...body, tenantId, createdById: userId, number: await nextNumber(tx, tenantId, 'TICKET'),
        dueAt: new Date(Date.now() + slaHours * factor * 3_600_000),
      },
    }),
  );
}

supportRouter.post('/tickets', requirePerm('tickets.update'), async (req, res) => {
  const body = parse(ticketSchema, req.body);
  if (body.assigneeId && body.assigneeId !== req.user!.id && !can(req, 'tickets.assign')) throw forbidden('You cannot assign tickets to others');
  const ticket = await createTicket(tid(req), req.user!.id, body);
  if (ticket.assigneeId && ticket.assigneeId !== req.user!.id) {
    await notify(tid(req), [ticket.assigneeId], { title: `Ticket ${ticket.number} assigned to you`, body: ticket.subject, link: `/tickets/${ticket.id}` });
  }
  await audit(req, { action: 'tickets.create', entityType: 'ticket', entityId: ticket.id });
  res.status(201).json(ticket);
});

supportRouter.get('/tickets/:id', requirePerm('tickets.read', 'tickets.read_assigned'), async (req, res) => {
  const t = await findTicket(req, String(req.params.id));
  const [full, files] = await Promise.all([
    prisma.ticket.findUniqueOrThrow({
      where: { id: t.id },
      include: {
        comments: { orderBy: { createdAt: 'asc' } },
        customer: { select: { id: true, name: true, company: true, email: true, phone: true } },
        project: { select: { id: true, code: true, name: true } },
        category: true,
      },
    }),
    prisma.fileObject.findMany({ where: { tenantId: tid(req), entityType: 'ticket', entityId: t.id }, select: { id: true, originalName: true, mimeType: true, sizeBytes: true, createdAt: true } }),
  ]);
  res.json({ ...full, files });
});

supportRouter.patch('/tickets/:id', requirePerm('tickets.update', 'tickets.assign'), async (req, res) => {
  const t = await findTicket(req, String(req.params.id));
  const body = parse(ticketSchema.partial().extend({ status: z.enum(STATUSES as [TicketStatus, ...TicketStatus[]]).optional() }), req.body);
  if (body.assigneeId !== undefined && body.assigneeId !== t.assigneeId && !can(req, 'tickets.assign')) throw forbidden('You cannot reassign tickets');
  if (!can(req, 'tickets.update')) {
    // Assign-only users may change just the assignee.
    for (const k of Object.keys(body)) if (k !== 'assigneeId') throw forbidden('Missing permission: tickets.update');
  }
  await assertTenantRefs(tid(req), { customer: body.customerId, project: body.projectId, category: body.categoryId, user: body.assigneeId });
  const updated = await prisma.ticket.update({
    where: { id: t.id },
    data: { ...body, ...(body.status ? { resolvedAt: ['RESOLVED', 'CLOSED'].includes(body.status) ? new Date() : null } : {}) },
  });
  if (body.status && body.status !== t.status) {
    await prisma.ticketComment.create({ data: { ticketId: t.id, body: `Status changed to ${body.status.replace(/_/g, ' ').toLowerCase()}`, isInternal: true, userId: req.user!.id } });
  }
  if (body.assigneeId && body.assigneeId !== t.assigneeId) {
    await notify(tid(req), [body.assigneeId], { title: `Ticket ${t.number} assigned to you`, body: t.subject, link: `/tickets/${t.id}` });
  }
  await audit(req, { action: 'tickets.update', entityType: 'ticket', entityId: t.id, meta: body });
  res.json(updated);
});

supportRouter.post('/tickets/:id/comments', requirePerm('tickets.update'), async (req, res) => {
  const t = await findTicket(req, String(req.params.id));
  const body = parse(z.object({ body: z.string().trim().min(1).max(20000), isInternal: z.boolean().default(false) }), req.body);
  const comment = await prisma.ticketComment.create({ data: { ticketId: t.id, body: body.body, isInternal: body.isInternal, userId: req.user!.id } });
  if (!body.isInternal) {
    await prisma.ticket.update({ where: { id: t.id }, data: { status: t.status === 'OPEN' ? 'IN_PROGRESS' : t.status } });
    if (t.customerId) {
      const customer = await prisma.customer.findUnique({ where: { id: t.customerId }, select: { email: true, name: true } });
      if (customer?.email) {
        await enqueueEmail({ tenantId: t.tenantId, to: customer.email, subject: `[${t.number}] ${t.subject}`, text: `Hi ${customer.name},\n\n${body.body}\n\n${req.user!.name}` });
      }
    }
    const portalUsers = await prisma.membership.findMany({ where: { tenantId: tid(req), customerId: t.customerId ?? '__none__', status: 'ACTIVE' }, select: { userId: true } });
    await notify(tid(req), portalUsers.map((u) => u.userId), { title: `Reply on ticket ${t.number}`, body: body.body.slice(0, 120), link: `/portal/tickets/${t.id}` });
  }
  res.status(201).json(comment);
});

// ── Categories ──

supportRouter.get('/ticket-categories', async (req, res) => {
  res.json(await prisma.ticketCategory.findMany({ where: { tenantId: tid(req) }, orderBy: { name: 'asc' }, include: { _count: { select: { tickets: true, articles: true } } } }));
});

const categorySchema = z.object({ name: z.string().min(1).max(80), slaHours: z.coerce.number().int().min(1).max(2000).optional() });

supportRouter.post('/ticket-categories', requirePerm('kb.manage', 'settings.manage'), async (req, res) => {
  const body = parse(categorySchema, req.body);
  res.status(201).json(await prisma.ticketCategory.create({ data: { ...body, tenantId: tid(req) } }));
});

supportRouter.patch('/ticket-categories/:id', requirePerm('kb.manage', 'settings.manage'), async (req, res) => {
  const body = parse(categorySchema.partial(), req.body);
  const r = await prisma.ticketCategory.updateMany({ where: { id: String(req.params.id), tenantId: tid(req) }, data: body });
  if (!r.count) throw notFound('Category');
  res.json({ ok: true });
});

supportRouter.delete('/ticket-categories/:id', requirePerm('kb.manage', 'settings.manage'), async (req, res) => {
  const r = await prisma.ticketCategory.deleteMany({ where: { id: String(req.params.id), tenantId: tid(req) } });
  if (!r.count) throw notFound('Category');
  res.json({ ok: true });
});

// ── Knowledge base ──

const articleSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(100000),
  categoryId: z.string().optional().nullable(),
  published: z.boolean().optional(),
});

supportRouter.get('/kb', async (req, res) => {
  const manage = can(req, 'kb.manage');
  const items = await prisma.knowledgeArticle.findMany({
    where: {
      tenantId: tid(req), ...(manage ? {} : { published: true }),
      ...searchAny(qstr(req.query.q), ['title', 'body']),
      ...(qstr(req.query.categoryId) ? { categoryId: String(req.query.categoryId) } : {}),
    },
    select: { id: true, title: true, slug: true, published: true, updatedAt: true, category: { select: { id: true, name: true } }, body: true },
    orderBy: { updatedAt: 'desc' },
  });
  res.json(items.map((a) => ({ ...a, excerpt: a.body.slice(0, 220), body: undefined })));
});

supportRouter.get('/kb/:id', async (req, res) => {
  const a = await prisma.knowledgeArticle.findFirst({
    where: { id: String(req.params.id), tenantId: tid(req), ...(can(req, 'kb.manage') ? {} : { published: true }) },
    include: { category: { select: { id: true, name: true } } },
  });
  if (!a) throw notFound('Article');
  res.json(a);
});

supportRouter.post('/kb', requirePerm('kb.manage'), async (req, res) => {
  const body = parse(articleSchema, req.body);
  await assertTenantRefs(tid(req), { category: body.categoryId });
  let slug = slugify(body.title);
  for (let i = 2; await prisma.knowledgeArticle.findUnique({ where: { tenantId_slug: { tenantId: tid(req), slug } } }); i++) slug = `${slugify(body.title)}-${i}`;
  const a = await prisma.knowledgeArticle.create({ data: { ...body, slug, tenantId: tid(req), authorId: req.user!.id } });
  res.status(201).json(a);
});

supportRouter.patch('/kb/:id', requirePerm('kb.manage'), async (req, res) => {
  const body = parse(articleSchema.partial(), req.body);
  await assertTenantRefs(tid(req), { category: body.categoryId });
  const r = await prisma.knowledgeArticle.updateMany({ where: { id: String(req.params.id), tenantId: tid(req) }, data: body });
  if (!r.count) throw notFound('Article');
  res.json(await prisma.knowledgeArticle.findUnique({ where: { id: String(req.params.id) } }));
});

supportRouter.delete('/kb/:id', requirePerm('kb.manage'), async (req, res) => {
  const r = await prisma.knowledgeArticle.deleteMany({ where: { id: String(req.params.id), tenantId: tid(req) } });
  if (!r.count) throw notFound('Article');
  res.json({ ok: true });
});
