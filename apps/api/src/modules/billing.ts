import { latestRate, resolveDocumentCurrency } from '../lib/currency.js';
import { authorizationSnapshot } from '../lib/authorization.js';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Prisma, RecurrenceFrequency, RecurringProfile } from '@prisma/client';
import { prisma } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { dateRange, listParams, orderBy, paged, qstr, toCsv } from '../lib/list.js';
import { nextNumber } from '../lib/numbering.js';
import { assertTenantRefs } from '../lib/tenantRefs.js';
import { dueDateFor, GST_RATES, PAYMENT_TERMS } from '../lib/gst.js';
import { tenantSettings } from '../lib/tenants.js';
import { notify } from '../lib/notify.js';
import { can, requirePerm, tid } from '../middleware/tenant.js';
import { parse } from '../middleware/validate.js';
import { lineData, lineSchema, money, prepareDocument, refreshInvoiceBalance, type LineInputBody } from './finance.js';
import { resolveLineTaxes } from '../lib/taxes.js';
import { projectScope } from './projects.js';

export const billingRouter = Router();

// ───────────────────────── Recurring invoices ─────────────────────────

export const FREQUENCIES: Record<RecurrenceFrequency, { label: string; months?: number; days?: number }> = {
  WEEK: { label: 'Week', days: 7 },
  TWO_WEEKS: { label: '2 Weeks', days: 14 },
  MONTH: { label: 'Month', months: 1 },
  TWO_MONTHS: { label: '2 Months', months: 2 },
  THREE_MONTHS: { label: '3 Months', months: 3 },
  SIX_MONTHS: { label: '6 Months', months: 6 },
  YEAR: { label: 'Year', months: 12 },
  TWO_YEARS: { label: '2 Years', months: 24 },
  THREE_YEARS: { label: '3 Years', months: 36 },
};

export function advance(date: Date, f: RecurrenceFrequency): Date {
  const spec = FREQUENCIES[f];
  if (spec.days) return new Date(date.getTime() + spec.days * 86_400_000);
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + (spec.months ?? 1));
  // Keep the day of month, clamped to the month's length (31 Jan -> 28/29 Feb).
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return d;
}

const recurringSchema = z.object({
  profileName: z.string().trim().min(1).max(120),
  customerId: z.string(),
  projectId: z.string().optional().nullable(),
  orderNumber: z.string().max(60).optional().nullable(),
  frequency: z.enum(Object.keys(FREQUENCIES) as [RecurrenceFrequency, ...RecurrenceFrequency[]]),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().optional().nullable(),
  paymentTerms: z.enum(Object.keys(PAYMENT_TERMS) as [string, ...string[]]).optional(),
  salespersonId: z.string().optional().nullable(),
  subject: z.string().max(1000).optional().nullable(),
  placeOfSupply: z.string().regex(/^\d{2}$/).optional().nullable(),
  discountType: z.enum(['PERCENT', 'AMOUNT']).optional(),
  discountValue: z.coerce.number().min(0).optional(),
  withholdingType: z.enum(['TDS', 'TCS']).optional().nullable(),
  withholdingRate: z.coerce.number().min(0).max(100).optional(),
  adjustmentLabel: z.string().max(60).optional().nullable(),
  adjustment: z.coerce.number().optional(),
  items: z.array(lineSchema).min(1).max(200),
  notes: z.string().max(5000).optional().nullable(),
  terms: z.string().max(5000).optional().nullable(),
  createAs: z.enum(['DRAFT', 'SEND']).optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional().nullable(),
  exchangeRate: z.coerce.number().positive().max(1_000_000).optional().nullable(),
});

/** Creates the invoice for one run of a recurring profile and moves the schedule forward. */
export async function generateFromProfile(profile: RecurringProfile, runDate = profile.nextRunDate) {
  const items = profile.items as unknown as LineInputBody[];
  const inv = await prisma.$transaction(async (tx) => {
    // Foreign-currency runs use the newest rate recorded for the currency, else the profile's rate.
    const rate = (await latestRate(profile.tenantId, profile.currency, tx)) ?? Number(profile.exchangeRate);
    const d = await prepareDocument(tx, profile.tenantId, {
      customerId: profile.customerId, placeOfSupply: profile.placeOfSupply, items,
      discountType: profile.discountType as 'PERCENT', discountValue: Number(profile.discountValue),
      withholdingType: profile.withholdingType as 'TDS' | null, withholdingRate: Number(profile.withholdingRate), adjustment: Number(profile.adjustment),
    }, { current: { currency: profile.currency, exchangeRate: rate }, allowUnavailable: true, on: runDate });
    const s = tenantSettings(d.tenant.settings);
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: profile.customerId } });
    const send = profile.createAs === 'SEND' && !!d.tenant.gstin;
    const created = await tx.invoice.create({
      data: {
        tenantId: profile.tenantId, number: await nextNumber(tx, profile.tenantId, 'INVOICE'), customerId: profile.customerId, projectId: profile.projectId,
        recurringProfileId: profile.id, orderNumber: profile.orderNumber, salespersonId: profile.salespersonId, subject: profile.subject,
        status: send ? 'ISSUED' : 'DRAFT', issuedAt: send ? new Date() : null, issueDate: runDate, paymentTerms: profile.paymentTerms,
        dueDate: dueDateFor(profile.paymentTerms, runDate) ?? runDate, placeOfSupply: d.placeOfSupply, isInterState: d.isInterState,
        discountType: profile.discountType, discountValue: profile.discountValue, withholdingType: profile.withholdingType, withholdingRate: profile.withholdingRate,
        adjustmentLabel: profile.adjustmentLabel, ...d.totals, ...d.money, balanceDue: d.totals.total, emailRecipients: customer.email ? [customer.email] : [],
        ...(send ? { authorization: await authorizationSnapshot(profile.tenantId, 'invoice', tx) } : {}),
        notes: profile.notes ?? s.documents.invoiceNotes, terms: profile.terms ?? s.documents.invoiceTerms, createdById: profile.createdById,
        items: { create: d.lines.map(lineData) },
      },
    });
    if (send) await refreshInvoiceBalance(tx, created.id);
    const next = advance(runDate, profile.frequency);
    const expired = profile.endDate && next > profile.endDate;
    await tx.recurringProfile.update({ where: { id: profile.id }, data: { lastRunDate: runDate, nextRunDate: next, ...(expired ? { status: 'EXPIRED' } : {}) } });
    return created;
  });
  await notify(profile.tenantId, [profile.createdById], { title: `Recurring invoice ${inv.number} created`, body: profile.profileName, link: `/invoices/${inv.id}` });
  return inv;
}

/** Runs all due recurring profiles (called by the scheduler). Each profile catches up at most 12 missed runs. */
export async function runDueRecurringProfiles(now = new Date()) {
  const due = await prisma.recurringProfile.findMany({ where: { status: 'ACTIVE', nextRunDate: { lte: now } } });
  let created = 0;
  for (const p of due) {
    let profile: RecurringProfile | null = p;
    for (let i = 0; i < 12 && profile && profile.status === 'ACTIVE' && profile.nextRunDate <= now && (!profile.endDate || profile.nextRunDate <= profile.endDate); i++) {
      try {
        await generateFromProfile(profile);
        created++;
      } catch (e) {
        console.error('[recurring] failed for profile', profile.id, e);
        break;
      }
      profile = await prisma.recurringProfile.findUnique({ where: { id: p.id } });
    }
  }
  return created;
}

billingRouter.get('/recurring-invoices/meta', (_req, res) => {
  res.json({ frequencies: Object.entries(FREQUENCIES).map(([code, f]) => ({ code, label: f.label })) });
});

billingRouter.get('/recurring-invoices', requirePerm('invoices.read'), async (req, res) => {
  const p = listParams(req, ['createdAt', 'nextRunDate', 'profileName']);
  const where: Prisma.RecurringProfileWhereInput = {
    tenantId: tid(req),
    ...(p.q ? { OR: [{ profileName: { contains: p.q, mode: 'insensitive' } }, { customer: { name: { contains: p.q, mode: 'insensitive' } } }] } : {}),
    ...(qstr(req.query.status) ? { status: req.query.status as 'ACTIVE' } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.recurringProfile.findMany({ where, orderBy: orderBy(p), skip: p.skip, take: p.pageSize, include: { customer: { select: { id: true, name: true } }, _count: { select: { invoices: true } } } }),
    prisma.recurringProfile.count({ where }),
  ]);
  const withAmount = await Promise.all(items.map(async (r) => {
    const d = await prepareDocument(prisma as never, tid(req), { customerId: r.customerId, placeOfSupply: r.placeOfSupply, items: r.items as unknown as LineInputBody[], discountType: r.discountType as 'PERCENT', discountValue: Number(r.discountValue), withholdingType: r.withholdingType as 'TDS' | null, withholdingRate: Number(r.withholdingRate), adjustment: Number(r.adjustment) }, { current: r, allowUnavailable: true });
    return { ...r, amount: d.totals.total };
  }));
  res.json(paged(withAmount, total, p));
});

billingRouter.post('/recurring-invoices', requirePerm('invoices.create'), async (req, res) => {
  const body = parse(recurringSchema, req.body);
  await assertTenantRefs(tid(req), { customer: body.customerId, project: body.projectId, user: body.salespersonId });
  if (body.endDate && body.endDate < body.startDate) throw badRequest('End date must be after the start date');
  if (body.createAs === 'SEND' && !can(req, 'invoices.issue')) throw badRequest('You are not allowed to send invoices automatically');
  await resolveLineTaxes(prisma as never, tid(req), body.items); // taxes must be this tenant's and available
  const customer = await prisma.customer.findFirstOrThrow({ where: { id: body.customerId, tenantId: tid(req) } });
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) } });
  const cur = await resolveDocumentCurrency(prisma as never, tenant, { currency: body.currency, exchangeRate: body.exchangeRate }, req.user!.id);
  const profile = await prisma.recurringProfile.create({
    data: {
      ...body, currency: cur.currency, exchangeRate: cur.exchangeRate, tenantId: tid(req), items: body.items as object[], paymentTerms: body.paymentTerms ?? customer.paymentTerms,
      salespersonId: body.salespersonId ?? req.user!.id, nextRunDate: body.startDate, createdById: req.user!.id,
      discountValue: body.discountValue ?? 0, withholdingRate: body.withholdingType ? body.withholdingRate ?? 0 : 0, adjustment: body.adjustment ?? 0,
    },
  });
  await audit(req, { action: 'recurring.create', entityType: 'recurring_profile', entityId: profile.id });
  // A profile starting today creates its first invoice immediately.
  if (profile.startDate <= new Date()) await generateFromProfile(profile);
  res.status(201).json(await prisma.recurringProfile.findUnique({ where: { id: profile.id } }));
});

async function findProfile(req: Request, id: string) {
  const p = await prisma.recurringProfile.findFirst({ where: { id, tenantId: tid(req) }, include: { customer: { select: { id: true, name: true, company: true, email: true } }, project: { select: { id: true, name: true } } } });
  if (!p) throw notFound('Recurring invoice');
  return p;
}

billingRouter.get('/recurring-invoices/:id', requirePerm('invoices.read'), async (req, res) => {
  const p = await findProfile(req, String(req.params.id));
  const invoices = await prisma.invoice.findMany({ where: { tenantId: tid(req), recurringProfileId: p.id }, orderBy: { issueDate: 'desc' }, select: { id: true, number: true, issueDate: true, total: true, balanceDue: true, status: true, currency: true } });
  const upcoming: Date[] = [];
  let d = p.nextRunDate;
  for (let i = 0; i < 5 && p.status === 'ACTIVE' && (!p.endDate || d <= p.endDate); i++) { upcoming.push(d); d = advance(d, p.frequency); }
  res.json({ ...p, invoices, upcoming });
});

billingRouter.patch('/recurring-invoices/:id', requirePerm('invoices.create'), async (req, res) => {
  const p = await findProfile(req, String(req.params.id));
  const body = parse(recurringSchema.partial(), req.body);
  await assertTenantRefs(tid(req), { customer: body.customerId, project: body.projectId, user: body.salespersonId });
  if (body.items) await resolveLineTaxes(prisma as never, tid(req), body.items, { allowUnavailable: true });
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) } });
  const cur = await resolveDocumentCurrency(prisma as never, tenant, { currency: body.currency, exchangeRate: body.exchangeRate, current: p }, req.user!.id);
  const updated = await prisma.recurringProfile.update({
    where: { id: p.id },
    data: {
      ...body, currency: cur.currency, exchangeRate: cur.exchangeRate, items: body.items ? (body.items as object[]) : undefined,
      // Changing the start date of a profile that has not run yet reschedules it.
      ...(body.startDate && !p.lastRunDate ? { nextRunDate: body.startDate } : {}),
    },
  });
  await audit(req, { action: 'recurring.update', entityType: 'recurring_profile', entityId: p.id });
  res.json(updated);
});

async function recurringAction(req: Request, action: 'stop' | 'resume' | 'run') {
  const p = await findProfile(req, String(req.params.id));
  if (action === 'stop') await prisma.recurringProfile.update({ where: { id: p.id }, data: { status: 'STOPPED' } });
  if (action === 'resume') {
    if (p.endDate && p.endDate < new Date()) throw conflict('This profile has ended. Extend the end date first.');
    let next = p.nextRunDate;
    while (next < new Date(new Date().toDateString())) next = advance(next, p.frequency);
    await prisma.recurringProfile.update({ where: { id: p.id }, data: { status: 'ACTIVE', nextRunDate: next } });
  }
  const invoice = action === 'run' ? await generateFromProfile(p, new Date()) : null;
  await audit(req, { action: `recurring.${action}`, entityType: 'recurring_profile', entityId: p.id });
  return { ok: true, invoice };
}

for (const action of ['stop', 'resume', 'run'] as const) {
  billingRouter.post(`/recurring-invoices/:id/${action}`, requirePerm('invoices.create'), async (req, res) => {
    res.json(await recurringAction(req, action));
  });
}

billingRouter.delete('/recurring-invoices/:id', requirePerm('invoices.create'), async (req, res) => {
  const p = await findProfile(req, String(req.params.id));
  await prisma.recurringProfile.delete({ where: { id: p.id } });
  await audit(req, { action: 'recurring.delete', entityType: 'recurring_profile', entityId: p.id, meta: { name: p.profileName } });
  res.json({ ok: true });
});

// ───────────────────────── Expenses ─────────────────────────

const DEFAULT_EXPENSE_CATEGORIES = ['Advertising & Marketing', 'Automobile Expense', 'Consultant Expense', 'Hosting & Domains', 'IT and Internet Expenses', 'Office Supplies', 'Rent Expense', 'Software Subscriptions', 'Telephone Expense', 'Travel Expense', 'Meals & Entertainment', 'Other Expenses'];

billingRouter.get('/expense-categories', requirePerm('invoices.read', 'invoices.create'), async (req, res) => {
  let cats = await prisma.expenseCategory.findMany({ where: { tenantId: tid(req) }, orderBy: { name: 'asc' } });
  if (!cats.length) {
    await prisma.expenseCategory.createMany({ data: DEFAULT_EXPENSE_CATEGORIES.map((name) => ({ tenantId: tid(req), name })), skipDuplicates: true });
    cats = await prisma.expenseCategory.findMany({ where: { tenantId: tid(req) }, orderBy: { name: 'asc' } });
  }
  res.json(cats);
});

billingRouter.post('/expense-categories', requirePerm('invoices.create'), async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(1).max(80) }), req.body);
  res.status(201).json(await prisma.expenseCategory.create({ data: { tenantId: tid(req), name: body.name } }));
});

billingRouter.patch('/expense-categories/:id', requirePerm('invoices.create'), async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(1).max(80) }), req.body);
  const cat = await prisma.expenseCategory.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) } });
  if (!cat) throw notFound('Category');
  res.json(await prisma.expenseCategory.update({ where: { id: cat.id }, data: { name: body.name } }));
});

billingRouter.delete('/expense-categories/:id', requirePerm('invoices.create'), async (req, res) => {
  const cat = await prisma.expenseCategory.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) }, include: { _count: { select: { expenses: true } } } });
  if (!cat) throw notFound('Category');
  if (cat._count.expenses) throw conflict(`${cat._count.expenses} expense${cat._count.expenses === 1 ? ' uses' : 's use'} this category. Move them to another category first.`);
  await prisma.expenseCategory.delete({ where: { id: cat.id } });
  res.json({ ok: true });
});

const expenseSchema = z.object({
  date: z.coerce.date(),
  categoryId: z.string().optional().nullable(),
  amount: z.coerce.number().positive(),
  taxRate: z.coerce.number().refine((r) => [0, ...GST_RATES].includes(r), 'Invalid GST rate').optional(),
  amountIncludesTax: z.boolean().optional(),
  paidThrough: z.enum(['CASH', 'BANK', 'CARD', 'UPI', 'OTHER']).optional(),
  vendor: z.string().max(160).optional().nullable(),
  reference: z.string().max(80).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  customerId: z.string().optional().nullable(),
  projectId: z.string().optional().nullable(),
  billable: z.boolean().optional(),
  markupPct: z.coerce.number().min(0).max(1000).optional(),
});

function expenseAmounts(b: { amount: number; taxRate?: number; amountIncludesTax?: boolean }) {
  const rate = b.taxRate ?? 0;
  const base = b.amountIncludesTax ? money(b.amount / (1 + rate / 100)) : money(b.amount);
  const tax = money((base * rate) / 100);
  return { amount: base, taxRate: rate, taxAmount: tax, total: money(base + tax) };
}

billingRouter.get('/expenses', requirePerm('invoices.read'), async (req, res) => {
  const p = listParams(req, ['date', 'createdAt', 'total']);
  const where: Prisma.ExpenseWhereInput = {
    tenantId: tid(req),
    ...(p.q ? { OR: [{ vendor: { contains: p.q, mode: 'insensitive' } }, { reference: { contains: p.q, mode: 'insensitive' } }, { notes: { contains: p.q, mode: 'insensitive' } }] } : {}),
    ...(qstr(req.query.categoryId) ? { categoryId: String(req.query.categoryId) } : {}),
    ...(qstr(req.query.customerId) ? { customerId: String(req.query.customerId) } : {}),
    ...(qstr(req.query.projectId) ? { projectId: String(req.query.projectId) } : {}),
    ...(req.query.status === 'unbilled' ? { billable: true, invoiceId: null } : req.query.status === 'invoiced' ? { invoiceId: { not: null } } : req.query.status === 'nonbillable' ? { billable: false } : {}),
    ...(dateRange(req.query.from, req.query.to) ? { date: dateRange(req.query.from, req.query.to) } : {}),
  };
  if (req.query.format === 'csv') {
    const rows = await prisma.expense.findMany({ where, orderBy: { date: 'asc' }, include: { category: true, customer: true } });
    res.type('text/csv').attachment('expenses.csv');
    return res.send(toCsv(rows.map((r) => ({ ...r, category: r.category?.name, customer: r.customer?.name })) as never, ['date', 'category', 'vendor', 'reference', 'amount', 'taxRate', 'taxAmount', 'total', 'paidThrough', 'customer', 'billable']));
  }
  const [items, total, sum] = await Promise.all([
    prisma.expense.findMany({ where, orderBy: orderBy(p), skip: p.skip, take: p.pageSize, include: { category: true, customer: { select: { id: true, name: true } }, project: { select: { id: true, name: true } }, invoice: { select: { id: true, number: true } } } }),
    prisma.expense.count({ where }),
    prisma.expense.aggregate({ where, _sum: { total: true } }),
  ]);
  res.json({ ...paged(items, total, p), sum: sum._sum.total });
});

billingRouter.post('/expenses', requirePerm('invoices.create'), async (req, res) => {
  const body = parse(expenseSchema, req.body);
  await assertTenantRefs(tid(req), { customer: body.customerId, project: body.projectId });
  if (body.categoryId && !(await prisma.expenseCategory.findFirst({ where: { id: body.categoryId, tenantId: tid(req) } }))) throw badRequest('Invalid category');
  if (body.billable && !body.customerId) throw badRequest('Choose the customer to bill this expense to');
  const { amountIncludesTax: _a, ...rest } = body;
  const expense = await prisma.expense.create({ data: { ...rest, ...expenseAmounts(body), tenantId: tid(req), createdById: req.user!.id } });
  await audit(req, { action: 'expenses.create', entityType: 'expense', entityId: expense.id, meta: { total: expense.total } });
  res.status(201).json(expense);
});

billingRouter.patch('/expenses/:id', requirePerm('invoices.create'), async (req, res) => {
  const e = await prisma.expense.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) } });
  if (!e) throw notFound('Expense');
  if (e.invoiceId) throw conflict('This expense has been invoiced and cannot be edited');
  const body = parse(expenseSchema.partial(), req.body);
  await assertTenantRefs(tid(req), { customer: body.customerId, project: body.projectId });
  if (body.categoryId && !(await prisma.expenseCategory.findFirst({ where: { id: body.categoryId, tenantId: tid(req) } }))) throw badRequest('Invalid category');
  const { amountIncludesTax: _a, ...rest } = body;
  // A new amount or a new rate recalculates tax and total; the stored amount is already net of tax.
  const amounts = body.amount !== undefined || body.taxRate !== undefined
    ? expenseAmounts({ amount: body.amount ?? Number(e.amount), taxRate: body.taxRate ?? Number(e.taxRate), amountIncludesTax: body.amount !== undefined && body.amountIncludesTax })
    : {};
  const updated = await prisma.expense.update({ where: { id: e.id }, data: { ...rest, ...amounts } });
  res.json(updated);
});

billingRouter.delete('/expenses/:id', requirePerm('invoices.create'), async (req, res) => {
  const e = await prisma.expense.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) } });
  if (!e) throw notFound('Expense');
  if (e.invoiceId) throw conflict('This expense has been invoiced and cannot be deleted');
  await prisma.expense.delete({ where: { id: e.id } });
  await audit(req, { action: 'expenses.delete', entityType: 'expense', entityId: e.id, meta: { total: e.total } });
  res.json({ ok: true });
});

// ───────────────────────── Time tracking ─────────────────────────

const timeSchema = z.object({
  projectId: z.string(),
  taskId: z.string().optional().nullable(),
  userId: z.string().optional(),
  date: z.coerce.date(),
  minutes: z.coerce.number().int().min(1).max(24 * 60),
  notes: z.string().max(2000).optional().nullable(),
  billable: z.boolean().optional(),
});

/** Who can see time entries: managers see all, others only their own. */
const timeScope = (req: Request): Prisma.TimeEntryWhereInput =>
  can(req, 'projects.update') || can(req, 'invoices.create') ? { tenantId: tid(req) } : { tenantId: tid(req), userId: req.user!.id };

async function assertProjectAccess(req: Request, projectId: string) {
  const p = await prisma.project.findFirst({ where: { AND: [projectScope(req), { id: projectId }] }, select: { id: true } });
  if (!p) throw notFound('Project');
}

billingRouter.get('/time-entries', requirePerm('tasks.read', 'projects.read', 'projects.read_assigned'), async (req, res) => {
  const p = listParams(req, ['date', 'createdAt', 'minutes']);
  const where: Prisma.TimeEntryWhereInput = {
    AND: [
      timeScope(req),
      qstr(req.query.projectId) ? { projectId: String(req.query.projectId) } : {},
      qstr(req.query.userId) ? { userId: String(req.query.userId) } : {},
      req.query.status === 'unbilled' ? { billable: true, invoiceId: null } : req.query.status === 'invoiced' ? { invoiceId: { not: null } } : {},
      qstr(req.query.customerId) ? { project: { customerId: String(req.query.customerId) } } : {},
      dateRange(req.query.from, req.query.to) ? { date: dateRange(req.query.from, req.query.to) } : {},
    ],
  };
  const [items, total, sum, running] = await Promise.all([
    prisma.timeEntry.findMany({ where, orderBy: orderBy(p), skip: p.skip, take: p.pageSize, include: { project: { select: { id: true, code: true, name: true, customerId: true, hourlyRate: true } }, invoice: { select: { id: true, number: true } } } }),
    prisma.timeEntry.count({ where }),
    prisma.timeEntry.aggregate({ where, _sum: { minutes: true } }),
    prisma.timeEntry.findFirst({ where: { tenantId: tid(req), userId: req.user!.id, timerStartedAt: { not: null } }, include: { project: { select: { id: true, name: true } } } }),
  ]);
  res.json({ ...paged(items, total, p), totalMinutes: sum._sum.minutes ?? 0, runningTimer: running });
});

billingRouter.post('/time-entries', requirePerm('tasks.read', 'projects.read_assigned', 'projects.read'), async (req, res) => {
  const body = parse(timeSchema, req.body);
  await assertProjectAccess(req, body.projectId);
  const userId = body.userId && can(req, 'projects.update') ? body.userId : req.user!.id;
  await assertTenantRefs(tid(req), { user: userId });
  const entry = await prisma.timeEntry.create({ data: { ...body, userId, tenantId: tid(req) } });
  res.status(201).json(entry);
});

billingRouter.post('/time-entries/timer/start', requirePerm('tasks.read', 'projects.read_assigned', 'projects.read'), async (req, res) => {
  const body = parse(z.object({ projectId: z.string(), taskId: z.string().optional().nullable(), notes: z.string().max(2000).optional().nullable(), billable: z.boolean().optional() }), req.body);
  await assertProjectAccess(req, body.projectId);
  const running = await prisma.timeEntry.findFirst({ where: { tenantId: tid(req), userId: req.user!.id, timerStartedAt: { not: null } } });
  if (running) throw conflict('A timer is already running. Stop it first.');
  const entry = await prisma.timeEntry.create({ data: { ...body, tenantId: tid(req), userId: req.user!.id, date: new Date(), minutes: 0, timerStartedAt: new Date() } });
  res.status(201).json(entry);
});

billingRouter.post('/time-entries/timer/stop', requirePerm('tasks.read', 'projects.read_assigned', 'projects.read'), async (req, res) => {
  const running = await prisma.timeEntry.findFirst({ where: { tenantId: tid(req), userId: req.user!.id, timerStartedAt: { not: null } } });
  if (!running) throw notFound('Running timer');
  const minutes = Math.max(1, Math.round((Date.now() - running.timerStartedAt!.getTime()) / 60_000));
  const entry = await prisma.timeEntry.update({ where: { id: running.id }, data: { minutes: running.minutes + minutes, timerStartedAt: null } });
  res.json(entry);
});

billingRouter.patch('/time-entries/:id', requirePerm('tasks.read', 'projects.read_assigned', 'projects.read'), async (req, res) => {
  const e = await prisma.timeEntry.findFirst({ where: { AND: [timeScope(req), { id: String(req.params.id) }] } });
  if (!e) throw notFound('Time entry');
  if (e.invoiceId) throw conflict('This entry has been invoiced and cannot be edited');
  const body = parse(timeSchema.partial(), req.body);
  if (body.projectId) await assertProjectAccess(req, body.projectId);
  res.json(await prisma.timeEntry.update({ where: { id: e.id }, data: { ...body, userId: undefined } }));
});

billingRouter.delete('/time-entries/:id', requirePerm('tasks.read', 'projects.read_assigned', 'projects.read'), async (req, res) => {
  const e = await prisma.timeEntry.findFirst({ where: { AND: [timeScope(req), { id: String(req.params.id) }] } });
  if (!e) throw notFound('Time entry');
  if (e.invoiceId) throw conflict('This entry has been invoiced and cannot be deleted');
  await prisma.timeEntry.delete({ where: { id: e.id } });
  res.json({ ok: true });
});

/** Unbilled time and expenses for a customer, for the "Create invoice from unbilled" flow. */
billingRouter.get('/customers/:id/unbilled', requirePerm('invoices.create'), async (req, res) => {
  await assertTenantRefs(tid(req), { customer: String(req.params.id) });
  const [time, expenses] = await Promise.all([
    prisma.timeEntry.findMany({ where: { tenantId: tid(req), billable: true, invoiceId: null, timerStartedAt: null, project: { customerId: String(req.params.id) } }, include: { project: { select: { id: true, name: true, hourlyRate: true } } }, orderBy: { date: 'asc' } }),
    prisma.expense.findMany({ where: { tenantId: tid(req), billable: true, invoiceId: null, customerId: String(req.params.id) }, include: { category: true }, orderBy: { date: 'asc' } }),
  ]);
  res.json({ time, expenses });
});
