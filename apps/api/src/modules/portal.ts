import { Router, type Request } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { forbidden, notFound } from '../lib/errors.js';
import { notify, usersWithPermission } from '../lib/notify.js';
import { getObjectStream } from '../lib/storage.js';
import { requirePerm, tid } from '../middleware/tenant.js';
import { parse } from '../middleware/validate.js';
import { createTicket } from './support.js';
import { getInvoice, getQuotation, sendInvoicePdf, sendQuotationPdf } from './finance.js';

// Customer portal: every query is constrained to the Customer linked to the portal membership.
export const portalRouter = Router();
portalRouter.use('/portal', requirePerm('portal.access'));

function customerId(req: Request) {
  const id = req.ctx!.customerId;
  if (!id) throw forbidden('Your portal account is not linked to a customer record');
  return id;
}

portalRouter.get('/portal/overview', async (req, res) => {
  const c = customerId(req);
  const t = tid(req);
  const [customer, projects, openTickets, unpaid, recentInvoices] = await Promise.all([
    prisma.customer.findFirst({ where: { id: c, tenantId: t }, select: { id: true, name: true, company: true, email: true, onboardingStatus: true, onboarding: { orderBy: { sortOrder: 'asc' }, select: { id: true, title: true, doneAt: true } } } }),
    prisma.project.findMany({ where: { tenantId: t, customerId: c, status: { not: 'CANCELLED' } }, select: { id: true, code: true, name: true, status: true, dueDate: true }, orderBy: { createdAt: 'desc' } }),
    prisma.ticket.count({ where: { tenantId: t, customerId: c, status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER'] } } }),
    prisma.invoice.groupBy({ by: ['currency'], where: { tenantId: t, customerId: c, status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] } }, _sum: { balanceDue: true }, _count: true }),
    prisma.invoice.findMany({ where: { tenantId: t, customerId: c, status: { notIn: ['DRAFT'] } }, orderBy: { issueDate: 'desc' }, take: 5, select: { id: true, number: true, issueDate: true, dueDate: true, total: true, balanceDue: true, status: true, currency: true } }),
  ]);
  if (!customer) throw notFound('Customer');
  res.json({ customer, projects, openTickets, // Amounts due are shown per currency: a customer may be billed in more than one.
    outstanding: { count: unpaid.reduce((s, u) => s + u._count, 0), byCurrency: unpaid.map((u) => ({ currency: u.currency, amount: u._sum.balanceDue ?? 0 })) }, recentInvoices });
});

portalRouter.get('/portal/projects/:id', async (req, res) => {
  const p = await prisma.project.findFirst({
    where: { id: String(req.params.id), tenantId: tid(req), customerId: customerId(req) },
    select: {
      id: true, code: true, name: true, status: true, startDate: true, dueDate: true, description: true, serviceCategory: true,
      milestones: { select: { id: true, title: true, dueDate: true, status: true }, orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }] },
    },
  });
  if (!p) throw notFound('Project');
  const files = await prisma.fileObject.findMany({
    where: { tenantId: tid(req), entityType: 'project', entityId: p.id, visibility: 'customer' },
    select: { id: true, originalName: true, sizeBytes: true, createdAt: true },
  });
  res.json({ ...p, files });
});

portalRouter.get('/portal/invoices', async (req, res) => {
  res.json(await prisma.invoice.findMany({
    where: { tenantId: tid(req), customerId: customerId(req), status: { not: 'DRAFT' } },
    orderBy: { issueDate: 'desc' },
    select: { id: true, number: true, issueDate: true, dueDate: true, total: true, amountPaid: true, balanceDue: true, status: true, currency: true },
  }));
});

portalRouter.get('/portal/invoices/:id/pdf', async (req, res) => {
  const owned = await prisma.invoice.findFirst({ where: { id: String(req.params.id), tenantId: tid(req), customerId: customerId(req), status: { not: 'DRAFT' } }, select: { id: true } });
  if (!owned) throw notFound('Invoice');
  await sendInvoicePdf(res, tid(req), await getInvoice(req, owned.id));
});

portalRouter.get('/portal/quotations', async (req, res) => {
  res.json(await prisma.quotation.findMany({
    where: { tenantId: tid(req), customerId: customerId(req), status: { not: 'DRAFT' } },
    orderBy: { issueDate: 'desc' },
    select: { id: true, number: true, issueDate: true, validUntil: true, total: true, status: true, currency: true },
  }));
});

portalRouter.get('/portal/quotations/:id/pdf', async (req, res) => {
  const owned = await prisma.quotation.findFirst({ where: { id: String(req.params.id), tenantId: tid(req), customerId: customerId(req), status: { not: 'DRAFT' } }, select: { id: true } });
  if (!owned) throw notFound('Quotation');
  await sendQuotationPdf(res, tid(req), await getQuotation(req, owned.id));
});

portalRouter.post('/portal/quotations/:id/respond', async (req, res) => {
  const body = parse(z.object({ decision: z.enum(['ACCEPTED', 'REJECTED']), comment: z.string().max(2000).optional() }), req.body);
  const q = await prisma.quotation.findFirst({ where: { id: String(req.params.id), tenantId: tid(req), customerId: customerId(req), status: 'SENT' } });
  if (!q) throw notFound('Quotation');
  await prisma.quotation.update({ where: { id: q.id }, data: { status: body.decision } });
  await notify(tid(req), [q.createdById, ...(await usersWithPermission(tid(req), 'quotations.convert'))], {
    title: `Quotation ${q.number} ${body.decision.toLowerCase()} by customer`, body: body.comment, link: `/quotations/${q.id}`,
  });
  await audit(req, { action: `portal.quotation_${body.decision.toLowerCase()}`, entityType: 'quotation', entityId: q.id, meta: { comment: body.comment } });
  res.json({ ok: true });
});

portalRouter.get('/portal/tickets', async (req, res) => {
  res.json(await prisma.ticket.findMany({
    where: { tenantId: tid(req), customerId: customerId(req) },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, number: true, subject: true, status: true, priority: true, createdAt: true, updatedAt: true },
  }));
});

portalRouter.post('/portal/tickets', async (req, res) => {
  const body = parse(z.object({
    subject: z.string().min(3).max(200), description: z.string().min(5).max(20000),
    projectId: z.string().optional().nullable(), priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(), categoryId: z.string().optional().nullable(),
  }), req.body);
  if (body.projectId) {
    const own = await prisma.project.findFirst({ where: { id: body.projectId, tenantId: tid(req), customerId: customerId(req) }, select: { id: true } });
    if (!own) throw notFound('Project');
  }
  const ticket = await createTicket(tid(req), req.user!.id, { ...body, customerId: customerId(req), assigneeId: null });
  await notify(tid(req), await usersWithPermission(tid(req), 'tickets.assign'), { title: `New ticket ${ticket.number} from customer`, body: ticket.subject, link: `/tickets/${ticket.id}` });
  res.status(201).json(ticket);
});

portalRouter.get('/portal/tickets/:id', async (req, res) => {
  const t = await prisma.ticket.findFirst({
    where: { id: String(req.params.id), tenantId: tid(req), customerId: customerId(req) },
    select: {
      id: true, number: true, subject: true, description: true, status: true, priority: true, createdAt: true,
      comments: { where: { isInternal: false }, orderBy: { createdAt: 'asc' }, select: { id: true, body: true, userId: true, createdAt: true } },
    },
  });
  if (!t) throw notFound('Ticket');
  const authors = await prisma.user.findMany({ where: { id: { in: t.comments.map((c) => c.userId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  res.json({ ...t, comments: t.comments.map((c) => ({ ...c, author: authors.find((a) => a.id === c.userId)?.name ?? 'Support', mine: c.userId === req.user!.id })) });
});

portalRouter.post('/portal/tickets/:id/comments', async (req, res) => {
  const body = parse(z.object({ body: z.string().trim().min(1).max(20000) }), req.body);
  const t = await prisma.ticket.findFirst({ where: { id: String(req.params.id), tenantId: tid(req), customerId: customerId(req) } });
  if (!t) throw notFound('Ticket');
  const c = await prisma.ticketComment.create({ data: { ticketId: t.id, body: body.body, isInternal: false, userId: req.user!.id } });
  await prisma.ticket.update({ where: { id: t.id }, data: { status: ['WAITING_FOR_CUSTOMER', 'RESOLVED'].includes(t.status) ? 'IN_PROGRESS' : t.status } });
  await notify(tid(req), [t.assigneeId], { title: `Customer replied on ${t.number}`, body: body.body.slice(0, 120), link: `/tickets/${t.id}` });
  res.status(201).json(c);
});

portalRouter.get('/portal/feedback', async (req, res) => {
  res.json(await prisma.feedback.findMany({
    where: { tenantId: tid(req), customerId: customerId(req) },
    orderBy: { createdAt: 'desc' },
    select: { id: true, referenceNo: true, serviceCategory: true, ratingOverall: true, status: true, createdAt: true, events: { where: { isInternal: false }, orderBy: { createdAt: 'asc' }, select: { kind: true, body: true, createdAt: true } } },
  }));
});

portalRouter.get('/portal/files/:id/download', async (req, res) => {
  const file = await prisma.fileObject.findFirst({ where: { id: String(req.params.id), tenantId: tid(req), visibility: 'customer' } });
  if (!file) throw notFound('File');
  const c = customerId(req);
  const owned =
    (file.entityType === 'project' && (await prisma.project.findFirst({ where: { id: file.entityId ?? '', tenantId: tid(req), customerId: c }, select: { id: true } }))) ||
    (file.entityType === 'ticket' && (await prisma.ticket.findFirst({ where: { id: file.entityId ?? '', tenantId: tid(req), customerId: c }, select: { id: true } }))) ||
    (file.entityType === 'customer' && file.entityId === c);
  if (!owned) throw notFound('File');
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.originalName)}"`);
  (await getObjectStream(file.storageKey)).pipe(res);
});
