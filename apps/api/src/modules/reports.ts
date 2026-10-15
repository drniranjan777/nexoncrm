import { Router, type Request } from 'express';
import { prisma } from '../lib/db.js';
import { dateParam } from '../lib/list.js';
import { can, requirePerm, tid } from '../middleware/tenant.js';
import { taskScope } from './tasks.js';
import { projectScope } from './projects.js';
import { ticketScope } from './support.js';

export const reportsRouter = Router();

const num = (v: unknown) => Number(v ?? 0);

function range(req: Request) {
  const to = dateParam(req.query.to, { endOfDay: true }) ?? new Date();
  const from = dateParam(req.query.from) ?? new Date(to.getTime() - 180 * 86_400_000);
  return { from, to };
}

type MonthRow = { month: Date; value: unknown; count?: unknown };
const monthly = (rows: MonthRow[]) =>
  rows.map((r) => ({ month: r.month.toISOString().slice(0, 7), value: num(r.value), count: num(r.count) }));

// ── Dashboard: each widget is included only if the user may see it ──

reportsRouter.get('/dashboard', requirePerm('dashboard.read'), async (req, res) => {
  const t = tid(req);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const out: Record<string, unknown> = {};

  const myTasks = await prisma.task.findMany({
    where: { AND: [taskScope(req), { assigneeId: req.user!.id, status: { in: ['TODO', 'IN_PROGRESS', 'REVIEW'] } }] },
    orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }], take: 8,
    select: { id: true, title: true, dueDate: true, priority: true, status: true, type: true },
  });
  out.myTasks = myTasks;

  if (can(req, 'leads.read')) {
    const scope = req.ctx!.roleKey === 'sales' ? { assignedToId: req.user!.id } : {};
    const [open, won, pipeline, hot] = await Promise.all([
      prisma.lead.count({ where: { tenantId: t, ...scope, stage: { notIn: ['WON', 'LOST'] } } }),
      prisma.lead.count({ where: { tenantId: t, ...scope, stage: 'WON', convertedAt: { gte: monthStart } } }),
      prisma.lead.aggregate({ where: { tenantId: t, ...scope, stage: { notIn: ['WON', 'LOST'] } }, _sum: { estimatedValue: true } }),
      prisma.lead.findMany({ where: { tenantId: t, ...scope, stage: { notIn: ['WON', 'LOST'] } }, orderBy: { score: 'desc' }, take: 5, select: { id: true, name: true, company: true, score: true, stage: true, nextFollowUpAt: true } }),
    ]);
    out.crm = { openLeads: open, wonThisMonth: won, pipelineValue: num(pipeline._sum.estimatedValue), hotLeads: hot };
  }
  if (can(req, 'feedback.read')) {
    const [newCount, urgent, avg, recent] = await Promise.all([
      prisma.feedback.count({ where: { tenantId: t, status: 'NEW' } }),
      prisma.feedback.count({ where: { tenantId: t, isUrgent: true, status: { notIn: ['RESOLVED', 'CLOSED'] } } }),
      prisma.feedback.aggregate({ where: { tenantId: t, createdAt: { gte: new Date(now.getTime() - 90 * 86_400_000) } }, _avg: { ratingOverall: true } }),
      prisma.feedback.findMany({ where: { tenantId: t }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, referenceNo: true, name: true, ratingOverall: true, status: true, isUrgent: true, createdAt: true } }),
    ]);
    out.feedback = { new: newCount, urgentOpen: urgent, avgRating90d: avg._avg.ratingOverall, recent };
  }
  if (can(req, 'projects.read') || can(req, 'projects.read_assigned')) {
    const scope = projectScope(req);
    const [active, overdue] = await Promise.all([
      prisma.project.count({ where: { AND: [scope, { status: 'IN_PROGRESS' }] } }),
      prisma.project.count({ where: { AND: [scope, { status: { in: ['PLANNING', 'IN_PROGRESS'] }, dueDate: { lt: now } }] } }),
    ]);
    out.projects = { active, overdue };
  }
  if (can(req, 'tickets.read') || can(req, 'tickets.read_assigned')) {
    const scope = ticketScope(req);
    const [open, overdueT, mine] = await Promise.all([
      prisma.ticket.count({ where: { AND: [scope, { status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER'] } }] } }),
      prisma.ticket.count({ where: { AND: [scope, { status: { in: ['OPEN', 'IN_PROGRESS'] }, dueAt: { lt: now } }] } }),
      prisma.ticket.count({ where: { AND: [scope, { assigneeId: req.user!.id, status: { in: ['OPEN', 'IN_PROGRESS'] } }] } }),
    ]);
    out.support = { open, overdue: overdueT, assignedToMe: mine };
  }
  if (can(req, 'reports.financial') || can(req, 'invoices.read')) {
    const [invoiced, collected, outstanding, overdueInv, trend] = await Promise.all([
      prisma.invoice.aggregate({ where: { tenantId: t, status: { notIn: ['DRAFT', 'CANCELLED'] }, issueDate: { gte: monthStart } }, _sum: { total: true } }),
      prisma.payment.aggregate({ where: { tenantId: t, paidAt: { gte: monthStart } }, _sum: { amount: true } }),
      prisma.invoice.aggregate({ where: { tenantId: t, status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] } }, _sum: { balanceDue: true } }),
      prisma.invoice.aggregate({ where: { tenantId: t, status: 'OVERDUE' }, _sum: { balanceDue: true }, _count: true }),
      prisma.$queryRaw<MonthRow[]>`
        SELECT date_trunc('month', "paidAt") AS month, SUM(amount) AS value, COUNT(*) AS count
        FROM "Payment" WHERE "tenantId" = ${t} AND "paidAt" >= ${new Date(now.getFullYear(), now.getMonth() - 5, 1)}
        GROUP BY 1 ORDER BY 1`,
    ]);
    out.finance = {
      invoicedThisMonth: num(invoiced._sum.total), collectedThisMonth: num(collected._sum.amount),
      outstanding: num(outstanding._sum.balanceDue), overdue: num(overdueInv._sum.balanceDue), overdueCount: overdueInv._count,
      collectionsTrend: monthly(trend),
    };
  }
  res.json(out);
});

// ── Reports ──

reportsRouter.get('/reports/crm', requirePerm('reports.read'), async (req, res) => {
  const t = tid(req);
  const { from, to } = range(req);
  const [byStage, bySource, byOwner, created, lost] = await Promise.all([
    prisma.lead.groupBy({ by: ['stage'], where: { tenantId: t }, _count: true, _sum: { estimatedValue: true } }),
    prisma.lead.groupBy({ by: ['source'], where: { tenantId: t, createdAt: { gte: from, lte: to } }, _count: true }),
    prisma.lead.groupBy({ by: ['assignedToId', 'stage'], where: { tenantId: t, createdAt: { gte: from, lte: to } }, _count: true }),
    prisma.$queryRaw<MonthRow[]>`SELECT date_trunc('month', "createdAt") AS month, COUNT(*) AS value FROM "Lead" WHERE "tenantId" = ${t} AND "createdAt" BETWEEN ${from} AND ${to} GROUP BY 1 ORDER BY 1`,
    prisma.lead.groupBy({ by: ['lostReason'], where: { tenantId: t, stage: 'LOST', updatedAt: { gte: from, lte: to } }, _count: true }),
  ]);
  const users = await prisma.user.findMany({ where: { id: { in: byOwner.map((o) => o.assignedToId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const owners = new Map<string, { name: string; total: number; won: number; lost: number }>();
  for (const r of byOwner) {
    const key = r.assignedToId ?? 'unassigned';
    const o = owners.get(key) ?? { name: users.find((u) => u.id === key)?.name ?? 'Unassigned', total: 0, won: 0, lost: 0 };
    o.total += r._count;
    if (r.stage === 'WON') o.won += r._count;
    if (r.stage === 'LOST') o.lost += r._count;
    owners.set(key, o);
  }
  const won = byStage.find((s) => s.stage === 'WON')?._count ?? 0;
  const lostN = byStage.find((s) => s.stage === 'LOST')?._count ?? 0;
  res.json({
    byStage: byStage.map((s) => ({ stage: s.stage, count: s._count, value: num(s._sum.estimatedValue) })),
    bySource: bySource.map((s) => ({ source: s.source ?? 'Unknown', count: s._count })),
    byOwner: [...owners.values()],
    leadsCreated: monthly(created),
    lostReasons: lost.map((l) => ({ reason: l.lostReason ?? 'Not given', count: l._count })),
    winRate: won + lostN ? Math.round((won / (won + lostN)) * 100) : null,
  });
});

reportsRouter.get('/reports/feedback', requirePerm('reports.read', 'feedback.read'), async (req, res) => {
  const t = tid(req);
  const { from, to } = range(req);
  const where = { tenantId: t, createdAt: { gte: from, lte: to } };
  const [byCategory, bySentiment, byStatus, avg, trend, ratingDist, resolution] = await Promise.all([
    prisma.feedback.groupBy({ by: ['serviceCategory'], where, _count: true, _avg: { ratingOverall: true } }),
    prisma.feedback.groupBy({ by: ['sentiment'], where, _count: true }),
    prisma.feedback.groupBy({ by: ['status'], where, _count: true }),
    prisma.feedback.aggregate({ where, _avg: { ratingOverall: true, ratingCommunication: true, ratingQuality: true, ratingTimeliness: true, ratingTechnical: true }, _count: true }),
    prisma.$queryRaw<MonthRow[]>`SELECT date_trunc('month', "createdAt") AS month, AVG("ratingOverall") AS value, COUNT(*) AS count FROM "Feedback" WHERE "tenantId" = ${t} AND "createdAt" BETWEEN ${from} AND ${to} GROUP BY 1 ORDER BY 1`,
    prisma.feedback.groupBy({ by: ['ratingOverall'], where, _count: true }),
    prisma.$queryRaw<{ hours: unknown }[]>`SELECT AVG(EXTRACT(EPOCH FROM ("resolvedAt" - "createdAt")) / 3600) AS hours FROM "Feedback" WHERE "tenantId" = ${t} AND "resolvedAt" IS NOT NULL AND "createdAt" BETWEEN ${from} AND ${to}`,
  ]);
  const cats = await prisma.$queryRaw<{ category: string; count: bigint }[]>`
    SELECT unnest("aiCategories") AS category, COUNT(*) AS count FROM "Feedback" WHERE "tenantId" = ${t} AND "createdAt" BETWEEN ${from} AND ${to} GROUP BY 1 ORDER BY 2 DESC`;
  const promoters = ratingDist.filter((r) => r.ratingOverall === 5).reduce((s, r) => s + r._count, 0);
  const detractors = ratingDist.filter((r) => r.ratingOverall <= 3).reduce((s, r) => s + r._count, 0);
  res.json({
    total: avg._count,
    averages: avg._avg,
    // A CSAT-style "satisfied" share (4 or 5 stars). Not an NPS: the form does not ask the NPS question.
    satisfiedPct: avg._count ? Math.round((ratingDist.filter((r) => r.ratingOverall >= 4).reduce((s, r) => s + r._count, 0) / avg._count) * 100) : null,
    promoters, detractors,
    byCategory: byCategory.map((c) => ({ category: c.serviceCategory, count: c._count, avgRating: c._avg.ratingOverall })),
    bySentiment: bySentiment.map((s) => ({ sentiment: s.sentiment ?? 'unknown', count: s._count })),
    byStatus: byStatus.map((s) => ({ status: s.status, count: s._count })),
    ratingDistribution: [1, 2, 3, 4, 5].map((r) => ({ rating: r, count: ratingDist.find((d) => d.ratingOverall === r)?._count ?? 0 })),
    topics: cats.map((c) => ({ topic: c.category, count: Number(c.count) })),
    trend: monthly(trend),
    avgResolutionHours: resolution[0]?.hours ? Math.round(num(resolution[0].hours)) : null,
  });
});

reportsRouter.get('/reports/projects', requirePerm('reports.read'), async (req, res) => {
  const t = tid(req);
  const [byStatus, overdue, taskByStatus, workload] = await Promise.all([
    prisma.project.groupBy({ by: ['status'], where: { tenantId: t }, _count: true }),
    prisma.project.findMany({ where: { tenantId: t, status: { in: ['PLANNING', 'IN_PROGRESS'] }, dueDate: { lt: new Date() } }, select: { id: true, code: true, name: true, dueDate: true } }),
    prisma.task.groupBy({ by: ['status'], where: { tenantId: t, projectId: { not: null } }, _count: true }),
    prisma.task.groupBy({ by: ['assigneeId'], where: { tenantId: t, status: { in: ['TODO', 'IN_PROGRESS', 'REVIEW'] } }, _count: true }),
  ]);
  const users = await prisma.user.findMany({ where: { id: { in: workload.map((w) => w.assigneeId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  res.json({
    byStatus: byStatus.map((s) => ({ status: s.status, count: s._count })),
    overdue,
    tasksByStatus: taskByStatus.map((s) => ({ status: s.status, count: s._count })),
    workload: workload.map((w) => ({ name: users.find((u) => u.id === w.assigneeId)?.name ?? 'Unassigned', open: w._count })).sort((a, b) => b.open - a.open),
  });
});

reportsRouter.get('/reports/support', requirePerm('reports.read'), async (req, res) => {
  const t = tid(req);
  const { from, to } = range(req);
  const where = { tenantId: t, createdAt: { gte: from, lte: to } };
  const [byStatus, byPriority, byCategory, trend, resolution, breached] = await Promise.all([
    prisma.ticket.groupBy({ by: ['status'], where, _count: true }),
    prisma.ticket.groupBy({ by: ['priority'], where, _count: true }),
    prisma.ticket.groupBy({ by: ['categoryId'], where, _count: true }),
    prisma.$queryRaw<MonthRow[]>`SELECT date_trunc('month', "createdAt") AS month, COUNT(*) AS value FROM "Ticket" WHERE "tenantId" = ${t} AND "createdAt" BETWEEN ${from} AND ${to} GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<{ hours: unknown }[]>`SELECT AVG(EXTRACT(EPOCH FROM ("resolvedAt" - "createdAt")) / 3600) AS hours FROM "Ticket" WHERE "tenantId" = ${t} AND "resolvedAt" IS NOT NULL AND "createdAt" BETWEEN ${from} AND ${to}`,
    prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM "Ticket" WHERE "tenantId" = ${t} AND "createdAt" BETWEEN ${from} AND ${to} AND "dueAt" IS NOT NULL AND COALESCE("resolvedAt", NOW()) > "dueAt"`,
  ]);
  const cats = await prisma.ticketCategory.findMany({ where: { tenantId: t }, select: { id: true, name: true } });
  const total = byStatus.reduce((s, r) => s + r._count, 0);
  res.json({
    total,
    byStatus: byStatus.map((s) => ({ status: s.status, count: s._count })),
    byPriority: byPriority.map((s) => ({ priority: s.priority, count: s._count })),
    byCategory: byCategory.map((c) => ({ category: cats.find((x) => x.id === c.categoryId)?.name ?? 'Uncategorised', count: c._count })),
    trend: monthly(trend),
    avgResolutionHours: resolution[0]?.hours ? Math.round(num(resolution[0].hours)) : null,
    slaBreachPct: total ? Math.round((Number(breached[0]?.n ?? 0) / total) * 100) : null,
  });
});

reportsRouter.get('/reports/sales', requirePerm('reports.financial'), async (req, res) => {
  const t = tid(req);
  const { from, to } = range(req);
  const [quotes, conversion, invoicedTrend, topCustomers, byService] = await Promise.all([
    prisma.quotation.groupBy({ by: ['status'], where: { tenantId: t, issueDate: { gte: from, lte: to } }, _count: true, _sum: { total: true } }),
    prisma.quotation.count({ where: { tenantId: t, issueDate: { gte: from, lte: to }, status: { in: ['ACCEPTED', 'CONVERTED'] } } }),
    prisma.$queryRaw<MonthRow[]>`SELECT date_trunc('month', "issueDate") AS month, SUM("taxableTotal") AS value, COUNT(*) AS count FROM "Invoice" WHERE "tenantId" = ${t} AND status NOT IN ('DRAFT', 'CANCELLED') AND "issueDate" BETWEEN ${from} AND ${to} GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<{ id: string; name: string; value: unknown }[]>`
      SELECT c.id, c.name, SUM(i."taxableTotal") AS value FROM "Invoice" i JOIN "Customer" c ON c.id = i."customerId"
      WHERE i."tenantId" = ${t} AND c."tenantId" = ${t} AND i.status NOT IN ('DRAFT', 'CANCELLED') AND i."issueDate" BETWEEN ${from} AND ${to}
      GROUP BY c.id, c.name ORDER BY value DESC LIMIT 10`,
    prisma.$queryRaw<{ service: string | null; value: unknown }[]>`
      SELECT p."serviceCategory" AS service, SUM(i."taxableTotal") AS value FROM "Invoice" i LEFT JOIN "Project" p ON p.id = i."projectId"
      WHERE i."tenantId" = ${t} AND i.status NOT IN ('DRAFT', 'CANCELLED') AND i."issueDate" BETWEEN ${from} AND ${to}
      GROUP BY 1 ORDER BY 2 DESC`,
  ]);
  const totalQuotes = quotes.reduce((s, q) => s + q._count, 0);
  res.json({
    quotations: quotes.map((q) => ({ status: q.status, count: q._count, value: num(q._sum.total) })),
    quoteConversionPct: totalQuotes ? Math.round((conversion / totalQuotes) * 100) : null,
    revenueTrend: monthly(invoicedTrend),
    topCustomers: topCustomers.map((c) => ({ ...c, value: num(c.value) })),
    byService: byService.map((s) => ({ service: s.service ?? 'Unassigned', value: num(s.value) })),
  });
});

reportsRouter.get('/reports/financial', requirePerm('reports.financial'), async (req, res) => {
  const t = tid(req);
  const { from, to } = range(req);
  const [gst, collections, aging, creditNotes, byMethod] = await Promise.all([
    prisma.$queryRaw<{ month: Date; taxable: unknown; cgst: unknown; sgst: unknown; igst: unknown; total: unknown }[]>`
      SELECT date_trunc('month', "issueDate") AS month, SUM("taxableTotal") AS taxable, SUM("cgstTotal") AS cgst, SUM("sgstTotal") AS sgst,
        SUM("igstTotal") AS igst, SUM(total) AS total
      FROM "Invoice" WHERE "tenantId" = ${t} AND status NOT IN ('DRAFT', 'CANCELLED') AND "issueDate" BETWEEN ${from} AND ${to} GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<MonthRow[]>`SELECT date_trunc('month', "paidAt") AS month, SUM(amount) AS value, COUNT(*) AS count FROM "Payment" WHERE "tenantId" = ${t} AND "paidAt" BETWEEN ${from} AND ${to} GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<{ bucket: string; value: unknown; count: bigint }[]>`
      SELECT CASE
          WHEN "dueDate" IS NULL OR "dueDate" >= NOW() THEN 'Current'
          WHEN NOW() - "dueDate" <= INTERVAL '30 days' THEN '1-30 days'
          WHEN NOW() - "dueDate" <= INTERVAL '60 days' THEN '31-60 days'
          WHEN NOW() - "dueDate" <= INTERVAL '90 days' THEN '61-90 days'
          ELSE '90+ days' END AS bucket,
        SUM("balanceDue") AS value, COUNT(*) AS count
      FROM "Invoice" WHERE "tenantId" = ${t} AND status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE') GROUP BY 1`,
    prisma.creditNote.aggregate({ where: { tenantId: t, status: 'ISSUED', issueDate: { gte: from, lte: to } }, _sum: { taxableTotal: true, cgstTotal: true, sgstTotal: true, igstTotal: true, total: true }, _count: true }),
    prisma.payment.groupBy({ by: ['method'], where: { tenantId: t, paidAt: { gte: from, lte: to } }, _sum: { amount: true } }),
  ]);
  const order = ['Current', '1-30 days', '31-60 days', '61-90 days', '90+ days'];
  res.json({
    gstSummary: gst.map((g) => ({ month: g.month.toISOString().slice(0, 7), taxable: num(g.taxable), cgst: num(g.cgst), sgst: num(g.sgst), igst: num(g.igst), total: num(g.total) })),
    creditNotes: { count: creditNotes._count, ...Object.fromEntries(Object.entries(creditNotes._sum).map(([k, v]) => [k, num(v)])) },
    collections: monthly(collections),
    aging: order.map((b) => {
      const row = aging.find((a) => a.bucket === b);
      return { bucket: b, value: num(row?.value), count: Number(row?.count ?? 0) };
    }),
    byMethod: byMethod.map((m) => ({ method: m.method, value: num(m._sum.amount) })),
  });
});
