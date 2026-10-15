import { Router, type Request } from 'express';
import { z } from 'zod';
import type { FeedbackStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/db.js';
import { config } from '../lib/config.js';
import { audit } from '../lib/audit.js';
import { randomToken } from '../lib/crypto.js';
import { notFound } from '../lib/errors.js';
import { dateParam, listParams, orderBy, paged, qstr, searchAny, toCsv } from '../lib/list.js';
import { nextNumber } from '../lib/numbering.js';
import { assertTenantRefs } from '../lib/tenantRefs.js';
import { notify } from '../lib/notify.js';
import { enqueueEmail } from '../lib/queue.js';
import { runAi } from '../lib/ai/index.js';
import { SERVICE_CATEGORIES } from '../lib/feedbackForms.js';
import { requirePerm, tid } from '../middleware/tenant.js';
import { parse } from '../middleware/validate.js';

export const feedbackRouter = Router();

const STATUSES: FeedbackStatus[] = ['NEW', 'UNDER_REVIEW', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'];

function feedbackWhere(req: Request): Prisma.FeedbackWhereInput {
  const q = req.query;
  const from = dateParam(q.from);
  const to = dateParam(q.to, { endOfDay: true });
  return {
    tenantId: tid(req),
    ...searchAny(qstr(q.q), ['referenceNo', 'name', 'company', 'email', 'needsImprovement', 'workingWell', 'comments']),
    ...(qstr(q.status) ? { status: q.status as FeedbackStatus } : {}),
    ...(qstr(q.serviceCategory) ? { serviceCategory: String(q.serviceCategory) } : {}),
    ...(qstr(q.projectId) ? { projectId: String(q.projectId) } : {}),
    ...(qstr(q.customerId) ? { customerId: String(q.customerId) } : {}),
    ...(qstr(q.assignedToId) ? { assignedToId: q.assignedToId === 'me' ? req.user!.id : String(q.assignedToId) } : {}),
    ...(qstr(q.rating) ? { ratingOverall: Number(q.rating) } : {}),
    ...(qstr(q.maxRating) ? { ratingOverall: { lte: Number(q.maxRating) } } : {}),
    ...(qstr(q.sentiment) ? { sentiment: String(q.sentiment) } : {}),
    ...(q.urgent === '1' ? { isUrgent: true } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
  };
}

feedbackRouter.get('/feedback', requirePerm('feedback.read'), async (req, res) => {
  const p = listParams(req, ['createdAt', 'ratingOverall', 'referenceNo']);
  const where = feedbackWhere(req);
  if (req.query.format === 'csv') {
    const rows = await prisma.feedback.findMany({ where, orderBy: { createdAt: 'desc' } });
    await audit(req, { action: 'feedback.export', meta: { count: rows.length } });
    res.type('text/csv').attachment('feedback.csv');
    return res.send(toCsv(rows as never, [
      'referenceNo', 'createdAt', 'status', 'name', 'company', 'email', 'serviceCategory', 'ratingOverall', 'ratingCommunication',
      'ratingQuality', 'ratingTimeliness', 'ratingTechnical', 'sentiment', 'isUrgent', 'expectationStatus', 'workingWell', 'needsImprovement', 'requestedChanges', 'urgentIssues', 'comments',
    ]));
  }
  const [items, total, counts] = await Promise.all([
    prisma.feedback.findMany({
      where, orderBy: orderBy(p), skip: p.skip, take: p.pageSize,
      select: {
        id: true, referenceNo: true, name: true, company: true, email: true, serviceCategory: true, ratingOverall: true,
        status: true, sentiment: true, isUrgent: true, assignedToId: true, createdAt: true, aiCategories: true,
        project: { select: { id: true, code: true, name: true } }, customer: { select: { id: true, name: true } },
      },
    }),
    prisma.feedback.count({ where }),
    prisma.feedback.groupBy({ by: ['status'], where: { tenantId: tid(req) }, _count: true }),
  ]);
  res.json({ ...paged(items, total, p), statusCounts: Object.fromEntries(counts.map((c) => [c.status, c._count])) });
});

feedbackRouter.get('/feedback/meta', requirePerm('feedback.read'), (_req, res) => {
  res.json({ statuses: STATUSES, serviceCategories: SERVICE_CATEGORIES });
});

feedbackRouter.get('/feedback/:id', requirePerm('feedback.read'), async (req, res) => {
  const fb = await prisma.feedback.findFirst({
    where: { id: String(req.params.id), tenantId: tid(req) },
    include: {
      events: { orderBy: { createdAt: 'asc' } },
      project: { select: { id: true, code: true, name: true } },
      customer: { select: { id: true, name: true, company: true, code: true } },
      tasks: { select: { id: true, title: true, status: true, assigneeId: true, dueDate: true } },
    },
  });
  if (!fb) throw notFound('Feedback');
  const [files, tickets] = await Promise.all([
    prisma.fileObject.findMany({ where: { tenantId: tid(req), entityType: 'feedback', entityId: fb.id }, select: { id: true, originalName: true, mimeType: true, sizeBytes: true, createdAt: true } }),
    prisma.ticket.findMany({ where: { tenantId: tid(req), feedbackId: fb.id }, select: { id: true, number: true, subject: true, status: true } }),
  ]);
  const { trackingTokenHash: _omit, ...safe } = fb;
  res.json({ ...safe, files, tickets });
});

feedbackRouter.patch('/feedback/:id', requirePerm('feedback.resolve'), async (req, res) => {
  const body = parse(z.object({
    status: z.enum(STATUSES as [FeedbackStatus, ...FeedbackStatus[]]).optional(),
    assignedToId: z.string().nullable().optional(),
    projectId: z.string().nullable().optional(),
    customerId: z.string().nullable().optional(),
    isUrgent: z.boolean().optional(),
  }), req.body);
  const fb = await prisma.feedback.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) } });
  if (!fb) throw notFound('Feedback');
  await assertTenantRefs(tid(req), { user: body.assignedToId, project: body.projectId, customer: body.customerId });
  const events: Prisma.FeedbackEventCreateManyInput[] = [];
  const data: Prisma.FeedbackUncheckedUpdateInput = { ...body };
  if (body.assignedToId !== undefined && body.assignedToId !== fb.assignedToId) {
    events.push({ feedbackId: fb.id, kind: 'ASSIGN', userId: req.user!.id, meta: { assignedToId: body.assignedToId }, isInternal: true, body: body.assignedToId ? 'Assigned' : 'Unassigned' });
    if (body.assignedToId && fb.status === 'NEW' && !body.status) data.status = 'ASSIGNED';
  }
  const newStatus = (data.status as FeedbackStatus | undefined) ?? undefined;
  if (newStatus && newStatus !== fb.status) {
    events.push({ feedbackId: fb.id, kind: 'STATUS', userId: req.user!.id, body: `Status changed to ${newStatus.replace(/_/g, ' ').toLowerCase()}`, isInternal: false, meta: { from: fb.status, to: newStatus } });
    data.resolvedAt = newStatus === 'RESOLVED' || newStatus === 'CLOSED' ? new Date() : null;
  }
  const [updated] = await prisma.$transaction([
    prisma.feedback.update({ where: { id: fb.id }, data }),
    prisma.feedbackEvent.createMany({ data: events }),
  ]);
  if (body.assignedToId && body.assignedToId !== fb.assignedToId) {
    await notify(tid(req), [body.assignedToId], { title: `Feedback ${fb.referenceNo} assigned to you`, body: `${fb.name}: ${fb.ratingOverall}/5`, link: `/feedback/${fb.id}` });
  }
  await audit(req, { action: 'feedback.update', entityType: 'feedback', entityId: fb.id, meta: body });
  res.json(updated);
});

/** Internal note (isInternal) or a reply to the customer (emailed and visible on the tracking page). */
feedbackRouter.post('/feedback/:id/events', requirePerm('feedback.resolve'), async (req, res) => {
  const body = parse(z.object({ body: z.string().trim().min(1).max(10000), kind: z.enum(['NOTE', 'REPLY']), setStatus: z.enum(STATUSES as [FeedbackStatus, ...FeedbackStatus[]]).optional() }), req.body);
  const fb = await prisma.feedback.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) }, include: { tenant: { select: { name: true, slug: true } } } });
  if (!fb) throw notFound('Feedback');
  const event = await prisma.feedbackEvent.create({
    data: { feedbackId: fb.id, kind: body.kind, body: body.body, isInternal: body.kind === 'NOTE', userId: req.user!.id },
  });
  const status = body.setStatus ?? (body.kind === 'REPLY' && ['NEW', 'UNDER_REVIEW', 'ASSIGNED'].includes(fb.status) ? 'IN_PROGRESS' : undefined);
  if (status && status !== fb.status) {
    await prisma.$transaction([
      prisma.feedback.update({ where: { id: fb.id }, data: { status, resolvedAt: ['RESOLVED', 'CLOSED'].includes(status) ? new Date() : null } }),
      prisma.feedbackEvent.create({ data: { feedbackId: fb.id, kind: 'STATUS', body: `Status changed to ${status.replace(/_/g, ' ').toLowerCase()}`, isInternal: false, userId: req.user!.id } }),
    ]);
  }
  if (body.kind === 'REPLY') {
    await enqueueEmail({
      tenantId: fb.tenantId,
      to: fb.email,
      subject: `Update on your feedback ${fb.referenceNo}`,
      text: `Hi ${fb.name},\n\n${body.body}\n\nRegards,\n${req.user!.name}\n${fb.tenant.name}\n\n(Reply via your tracking link to respond.)`,
    });
  }
  await audit(req, { action: body.kind === 'REPLY' ? 'feedback.reply' : 'feedback.note', entityType: 'feedback', entityId: fb.id });
  res.status(201).json(event);
});

feedbackRouter.post('/feedback/:id/task', requirePerm('feedback.resolve'), async (req, res) => {
  const body = parse(z.object({
    title: z.string().min(1).max(200), description: z.string().max(5000).optional(), assigneeId: z.string().optional(),
    dueDate: z.coerce.date().optional(), priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  }), req.body);
  const fb = await prisma.feedback.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) } });
  if (!fb) throw notFound('Feedback');
  await assertTenantRefs(tid(req), { user: body.assigneeId });
  const task = await prisma.task.create({
    data: {
      tenantId: tid(req), type: 'FEEDBACK', title: body.title, description: body.description ?? fb.needsImprovement ?? fb.requestedChanges,
      assigneeId: body.assigneeId ?? req.user!.id, createdById: req.user!.id, dueDate: body.dueDate, priority: body.priority ?? (fb.isUrgent ? 'URGENT' : 'MEDIUM'),
      feedbackId: fb.id, projectId: fb.projectId, customerId: fb.customerId,
    },
  });
  await prisma.feedbackEvent.create({ data: { feedbackId: fb.id, kind: 'SYSTEM', body: `Task created: ${task.title}`, userId: req.user!.id } });
  if (task.assigneeId !== req.user!.id) await notify(tid(req), [task.assigneeId], { title: 'Task from feedback', body: task.title, link: `/tasks?open=${task.id}` });
  res.status(201).json(task);
});

feedbackRouter.post('/feedback/:id/ticket', requirePerm('feedback.resolve'), requirePerm('tickets.update', 'tickets.assign'), async (req, res) => {
  const body = parse(z.object({ subject: z.string().min(1).max(200).optional(), assigneeId: z.string().optional(), categoryId: z.string().optional() }), req.body);
  const fb = await prisma.feedback.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) } });
  if (!fb) throw notFound('Feedback');
  await assertTenantRefs(tid(req), { user: body.assigneeId, category: body.categoryId });
  const ticket = await prisma.$transaction(async (tx) => {
    const t = await tx.ticket.create({
      data: {
        tenantId: tid(req), number: await nextNumber(tx, tid(req), 'TICKET'), subject: body.subject ?? `Feedback ${fb.referenceNo}: ${fb.serviceCategory}`,
        description: [fb.urgentIssues && `Urgent: ${fb.urgentIssues}`, fb.needsImprovement && `Needs improvement: ${fb.needsImprovement}`, fb.requestedChanges && `Requested changes: ${fb.requestedChanges}`, fb.comments].filter(Boolean).join('\n\n') || 'Created from customer feedback',
        customerId: fb.customerId, projectId: fb.projectId, categoryId: body.categoryId, assigneeId: body.assigneeId, createdById: req.user!.id,
        priority: fb.isUrgent ? 'URGENT' : fb.ratingOverall <= 2 ? 'HIGH' : 'MEDIUM', feedbackId: fb.id,
      },
    });
    await tx.feedbackEvent.create({ data: { feedbackId: fb.id, kind: 'SYSTEM', body: `Support ticket ${t.number} created`, userId: req.user!.id, isInternal: false } });
    return t;
  });
  if (ticket.assigneeId) await notify(tid(req), [ticket.assigneeId], { title: `Ticket ${ticket.number} assigned to you`, body: ticket.subject, link: `/tickets/${ticket.id}` });
  await audit(req, { action: 'feedback.ticket_created', entityType: 'feedback', entityId: fb.id, meta: { ticketId: ticket.id } });
  res.status(201).json(ticket);
});

feedbackRouter.post('/feedback/:id/ai-reply', requirePerm('feedback.resolve'), requirePerm('ai.use'), async (req, res) => {
  const fb = await prisma.feedback.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) }, include: { tenant: { select: { name: true } } } });
  if (!fb) throw notFound('Feedback');
  const context = {
    company: fb.tenant.name, sender: req.user!.name, customer: fb.name, service: fb.serviceCategory, rating: fb.ratingOverall,
    workingWell: fb.workingWell, needsImprovement: fb.needsImprovement, requestedChanges: fb.requestedChanges, urgentIssues: fb.urgentIssues, comments: fb.comments,
  };
  const template = () =>
    `Hi ${fb.name.split(' ')[0]},\n\nThank you for taking the time to share your feedback on our ${fb.serviceCategory} work` +
    `${fb.workingWell ? ', and we are glad to hear what is working well' : ''}.\n\n` +
    (fb.needsImprovement || fb.requestedChanges || fb.urgentIssues
      ? `We have noted the points you raised${fb.urgentIssues ? ', including the urgent issue,' : ''} and our team is reviewing them now. We will update you with the next steps shortly.\n\n`
      : 'We will keep working to maintain this standard.\n\n') +
    `Regards,\n${req.user!.name}\n${fb.tenant.name}`;
  res.json(await runAi(tid(req), req.user!.id, 'feedback_reply', context, template));
});

// ── Secure project-specific feedback links ──

feedbackRouter.get('/feedback-links', requirePerm('feedback.read'), async (req, res) => {
  const links = await prisma.feedbackLink.findMany({
    where: { tenantId: tid(req), ...(qstr(req.query.projectId) ? { projectId: String(req.query.projectId) } : {}) },
    include: { project: { select: { id: true, code: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(links.map((l) => ({ ...l, url: `${config.feedbackPublicUrl}/f/${l.token}` })));
});

feedbackRouter.post('/feedback-links', requirePerm('feedback.resolve'), async (req, res) => {
  const body = parse(z.object({
    projectId: z.string().optional().nullable(), customerId: z.string().optional().nullable(),
    serviceCategory: z.enum(SERVICE_CATEGORIES).optional().nullable(), expiresInDays: z.coerce.number().int().min(1).max(365).optional(),
  }), req.body);
  await assertTenantRefs(tid(req), { project: body.projectId, customer: body.customerId });
  const link = await prisma.feedbackLink.create({
    data: {
      tenantId: tid(req), token: randomToken(24), projectId: body.projectId, customerId: body.customerId, serviceCategory: body.serviceCategory,
      expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null, createdById: req.user!.id,
    },
  });
  await audit(req, { action: 'feedback.link_create', entityType: 'feedback_link', entityId: link.id });
  res.status(201).json({ ...link, url: `${config.feedbackPublicUrl}/f/${link.token}` });
});

feedbackRouter.patch('/feedback-links/:id', requirePerm('feedback.resolve'), async (req, res) => {
  const body = parse(z.object({ active: z.boolean() }), req.body);
  const r = await prisma.feedbackLink.updateMany({ where: { id: String(req.params.id), tenantId: tid(req) }, data: body });
  if (!r.count) throw notFound('Feedback link');
  res.json({ ok: true });
});
