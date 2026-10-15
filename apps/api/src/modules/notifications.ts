import { Router } from 'express';
import { prisma } from '../lib/db.js';
import { tid } from '../middleware/tenant.js';

export const notificationsRouter = Router();

notificationsRouter.get('/notifications', async (req, res) => {
  const where = { tenantId: tid(req), userId: req.user!.id };
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: 30 }),
    prisma.notification.count({ where: { ...where, readAt: null } }),
  ]);
  res.json({ items, unread });
});

notificationsRouter.post('/notifications/read', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).filter((x): x is string => typeof x === 'string') : null;
  await prisma.notification.updateMany({
    where: { tenantId: tid(req), userId: req.user!.id, readAt: null, ...(ids ? { id: { in: ids } } : {}) },
    data: { readAt: new Date() },
  });
  res.json({ ok: true });
});

/** Global search across the records the member may see. */
notificationsRouter.get('/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 2) return res.json([]);
  const t = tid(req);
  const has = (p: string) => req.ctx!.permissions.has(p as never);
  const like = { contains: q, mode: 'insensitive' as const };
  const results: { type: string; id: string; title: string; subtitle?: string | null; link: string }[] = [];
  const jobs: Promise<void>[] = [];
  if (has('customers.read')) jobs.push(prisma.customer.findMany({ where: { tenantId: t, OR: [{ name: like }, { company: like }, { email: like }, { code: like }] }, take: 5 }).then((r) => { results.push(...r.map((c) => ({ type: 'Customer', id: c.id, title: c.name, subtitle: c.company ?? c.email, link: `/customers/${c.id}` }))); }));
  if (has('leads.read')) jobs.push(prisma.lead.findMany({ where: { tenantId: t, ...(req.ctx!.roleKey === 'sales' ? { assignedToId: req.user!.id } : {}), OR: [{ name: like }, { company: like }, { email: like }] }, take: 5 }).then((r) => { results.push(...r.map((l) => ({ type: 'Lead', id: l.id, title: l.name, subtitle: l.company, link: `/leads/${l.id}` }))); }));
  if (has('projects.read')) jobs.push(prisma.project.findMany({ where: { tenantId: t, OR: [{ name: like }, { code: like }] }, take: 5 }).then((r) => { results.push(...r.map((p) => ({ type: 'Project', id: p.id, title: p.name, subtitle: p.code, link: `/projects/${p.id}` }))); }));
  if (has('tickets.read')) jobs.push(prisma.ticket.findMany({ where: { tenantId: t, OR: [{ subject: like }, { number: like }] }, take: 5 }).then((r) => { results.push(...r.map((x) => ({ type: 'Ticket', id: x.id, title: x.subject, subtitle: x.number, link: `/tickets/${x.id}` }))); }));
  if (has('feedback.read')) jobs.push(prisma.feedback.findMany({ where: { tenantId: t, OR: [{ referenceNo: like }, { name: like }, { company: like }] }, take: 5 }).then((r) => { results.push(...r.map((f) => ({ type: 'Feedback', id: f.id, title: `${f.referenceNo} · ${f.name}`, subtitle: f.serviceCategory, link: `/feedback/${f.id}` }))); }));
  if (has('invoices.read')) jobs.push(prisma.invoice.findMany({ where: { tenantId: t, number: like }, take: 5 }).then((r) => { results.push(...r.map((i) => ({ type: 'Invoice', id: i.id, title: i.number ?? 'Draft', subtitle: i.status, link: `/invoices/${i.id}` }))); }));
  if (has('proforma.read')) jobs.push(prisma.proformaInvoice.findMany({ where: { tenantId: t, OR: [{ number: like }, { referenceNumber: like }] }, take: 5 }).then((r) => { results.push(...r.map((x) => ({ type: 'Proforma Invoice', id: x.id, title: x.number, subtitle: x.status, link: `/proforma-invoices/${x.id}` }))); }));
  if (has('quotations.read')) jobs.push(prisma.quotation.findMany({ where: { tenantId: t, number: like }, take: 5 }).then((r) => { results.push(...r.map((x) => ({ type: 'Quotation', id: x.id, title: x.number, subtitle: x.status, link: `/quotations/${x.id}` }))); }));
  await Promise.all(jobs);
  res.json(results);
});
