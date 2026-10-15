import { Router } from 'express';
import { prisma } from '../lib/db.js';
import { forbidden, notFound } from '../lib/errors.js';
import { dateParam, qstr, toCsv } from '../lib/list.js';
import { INDIAN_STATES } from '../lib/gst.js';
import { toBase } from '../lib/currency.js';
import { can, requirePerm, tid } from '../middleware/tenant.js';
import { FREQUENCIES } from './billing.js';

export const insightsRouter = Router();

const n = (v: unknown) => Number(v ?? 0);
/** Amount converted to the base currency at the document's exchange rate. All report figures are in the base currency. */
const b = (v: unknown, rate: unknown) => toBase(v, rate);
const ZERO_RATED = ['OVERSEAS', 'SEZ'];
const r2 = (v: number) => Math.round(v * 100) / 100;
const DAY = 86_400_000;
const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const OPEN = ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] as const;
const BILLED = { notIn: ['DRAFT', 'CANCELLED'] as ('DRAFT' | 'CANCELLED')[] };

function fiscalYear(startMonth: number, ref = new Date()) {
  const y = ref.getMonth() + 1 >= startMonth ? ref.getFullYear() : ref.getFullYear() - 1;
  return { from: new Date(y, startMonth - 1, 1), to: new Date(y + 1, startMonth - 1, 0, 23, 59, 59) };
}

// ───────────────────────── Home dashboard (billing) ─────────────────────────

insightsRouter.get('/dashboard/billing', requirePerm('invoices.read', 'reports.financial'), async (req, res) => {
  const t = tid(req);
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: t }, select: { fiscalYearStartMonth: true } });
  const fy = fiscalYear(tenant.fiscalYearStartMonth);
  const today = startOfDay();

  const open = await prisma.invoice.findMany({ where: { tenantId: t, status: { in: [...OPEN] } }, select: { dueDate: true, balanceDue: true, exchangeRate: true } });
  const buckets = { current: 0, d1_15: 0, d16_30: 0, d31_45: 0, d45plus: 0 };
  for (const i of open) {
    const days = i.dueDate ? Math.floor((today.getTime() - startOfDay(i.dueDate).getTime()) / DAY) : 0;
    const v = b(i.balanceDue, i.exchangeRate);
    if (days <= 0) buckets.current += v;
    else if (days <= 15) buckets.d1_15 += v;
    else if (days <= 30) buckets.d16_30 += v;
    else if (days <= 45) buckets.d31_45 += v;
    else buckets.d45plus += v;
  }

  const [inv, pays, exps] = await Promise.all([
    prisma.invoice.findMany({ where: { tenantId: t, status: BILLED, issueDate: { gte: fy.from, lte: fy.to } }, select: { issueDate: true, total: true, balanceDue: true, exchangeRate: true } }),
    prisma.payment.findMany({ where: { tenantId: t, paidAt: { gte: fy.from, lte: fy.to } }, select: { paidAt: true, amount: true, exchangeRate: true } }),
    prisma.expense.findMany({ where: { tenantId: t, date: { gte: fy.from, lte: fy.to } }, select: { date: true, total: true, category: { select: { name: true } } } }),
  ]);
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(fy.from.getFullYear(), fy.from.getMonth() + i, 1);
    return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }), sales: 0, receipts: 0, expenses: 0 };
  });
  const mk = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const byKey = new Map(months.map((m) => [m.key, m]));
  for (const i of inv) { const m = byKey.get(mk(i.issueDate)); if (m) m.sales += b(i.total, i.exchangeRate); }
  for (const p of pays) { const m = byKey.get(mk(p.paidAt)); if (m) m.receipts += b(p.amount, p.exchangeRate); }
  for (const e of exps) { const m = byKey.get(mk(e.date)); if (m) m.expenses += n(e.total); }
  const cats = new Map<string, number>();
  for (const e of exps) cats.set(e.category?.name ?? 'Uncategorised', (cats.get(e.category?.name ?? 'Uncategorised') ?? 0) + n(e.total));

  const now = new Date();
  const weekStart = new Date(today.getTime() - ((today.getDay() + 6) % 7) * DAY);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const qStartMonth = fy.from.getMonth() + Math.floor((((now.getMonth() - fy.from.getMonth()) + 12) % 12) / 3) * 3;
  const quarterStart = new Date(now.getFullYear() - (qStartMonth > now.getMonth() ? 1 : 0), qStartMonth % 12, 1);
  const periods = [['Today', today], ['This Week', weekStart], ['This Month', monthStart], ['This Quarter', quarterStart], ['This Year', fy.from]] as const;
  const srd = await Promise.all(periods.map(async ([label, from]) => {
    const [s, r] = await Promise.all([
      prisma.invoice.findMany({ where: { tenantId: t, status: BILLED, issueDate: { gte: from } }, select: { total: true, balanceDue: true, exchangeRate: true } }),
      prisma.payment.findMany({ where: { tenantId: t, paidAt: { gte: from } }, select: { amount: true, exchangeRate: true } }),
    ]);
    return { label, sales: s.reduce((a, x) => a + b(x.total, x.exchangeRate), 0), receipts: r.reduce((a, x) => a + b(x.amount, x.exchangeRate), 0), due: s.reduce((a, x) => a + b(x.balanceDue, x.exchangeRate), 0) };
  }));

  const projects = can(req, 'projects.read') ? await prisma.project.findMany({
    where: { tenantId: t, status: 'IN_PROGRESS' }, take: 6, orderBy: { updatedAt: 'desc' },
    select: { id: true, name: true, code: true, customer: { select: { name: true } }, timeEntries: { where: { billable: true, invoiceId: null }, select: { minutes: true } } },
  }) : [];

  res.json({
    receivables: { total: r2(Object.values(buckets).reduce((a, b) => a + b, 0)), ...Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, r2(v)])) },
    fiscalYear: { from: fy.from, to: fy.to },
    monthly: months.map((m) => ({ ...m, sales: r2(m.sales), receipts: r2(m.receipts), expenses: r2(m.expenses) })),
    totals: { sales: r2(inv.reduce((s, i) => s + b(i.total, i.exchangeRate), 0)), receipts: r2(pays.reduce((s, p) => s + b(p.amount, p.exchangeRate), 0)), expenses: r2(exps.reduce((s, e) => s + n(e.total), 0)) },
    topExpenses: [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, total]) => ({ name, total: r2(total) })),
    salesReceiptsDues: srd.map((x) => ({ ...x, sales: r2(x.sales), receipts: r2(x.receipts), due: r2(x.due) })),
    projects: projects.map((p) => ({ id: p.id, name: p.name, code: p.code, customer: p.customer?.name ?? null, unbilledHours: r2(p.timeEntries.reduce((s, e) => s + e.minutes, 0) / 60) })),
  });
});

// ───────────────────────── Reports Center ─────────────────────────

type Col = { key: string; label: string; type?: 'money' | 'date' | 'number' | 'text' };
type Result = { columns: Col[]; rows: Record<string, unknown>[]; totals?: Record<string, unknown> };
interface ReportDef { group: string; title: string; perm: string; ranged: boolean; description?: string; run: (t: string, from: Date, to: Date) => Promise<Result> }

const sumCols = (rows: Record<string, unknown>[], keys: string[]) => Object.fromEntries(keys.map((k) => [k, r2(rows.reduce((s, r) => s + n(r[k]), 0))]));
const money = (key: string, label: string): Col => ({ key, label, type: 'money' });
const date = (key: string, label: string): Col => ({ key, label, type: 'date' });

async function names(ids: (string | null)[]) {
  const users = await prisma.user.findMany({ where: { id: { in: ids.filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

async function agingRows(t: string, asOf: Date, detailed: boolean): Promise<Result> {
  const inv = await prisma.invoice.findMany({ where: { tenantId: t, status: { in: [...OPEN] }, issueDate: { lte: asOf } }, include: { customer: { select: { name: true } } }, orderBy: { dueDate: 'asc' } });
  const bucket = (due: Date | null) => {
    const d = due ? Math.floor((startOfDay(asOf).getTime() - startOfDay(due).getTime()) / DAY) : 0;
    return d <= 0 ? 'current' : d <= 15 ? 'd1_15' : d <= 30 ? 'd16_30' : d <= 45 ? 'd31_45' : 'd45plus';
  };
  if (detailed) {
    const rows = inv.map((i) => ({ date: i.issueDate, number: i.number, customer: i.customer.name, dueDate: i.dueDate, age: i.dueDate ? Math.max(0, Math.floor((asOf.getTime() - i.dueDate.getTime()) / DAY)) : 0, status: i.status, currency: i.currency, amount: b(i.total, i.exchangeRate), balance: b(i.balanceDue, i.exchangeRate) }));
    return { columns: [date('date', 'Date'), { key: 'number', label: 'Invoice#' }, { key: 'customer', label: 'Customer' }, date('dueDate', 'Due date'), { key: 'age', label: 'Age (days)', type: 'number' }, { key: 'status', label: 'Status' }, { key: 'currency', label: 'Invoice currency' }, money('amount', 'Amount'), money('balance', 'Balance due')], rows, totals: sumCols(rows, ['amount', 'balance']) };
  }
  const by = new Map<string, Record<string, number | string>>();
  for (const i of inv) {
    const r = by.get(i.customerId) ?? { customer: i.customer.name, current: 0, d1_15: 0, d16_30: 0, d31_45: 0, d45plus: 0, total: 0 };
    r[bucket(i.dueDate)] = n(r[bucket(i.dueDate)]) + b(i.balanceDue, i.exchangeRate);
    r.total = n(r.total) + b(i.balanceDue, i.exchangeRate);
    by.set(i.customerId, r);
  }
  const rows = [...by.values()];
  const cols = ['current', 'd1_15', 'd16_30', 'd31_45', 'd45plus', 'total'];
  return { columns: [{ key: 'customer', label: 'Customer' }, money('current', 'Current'), money('d1_15', '1-15 days'), money('d16_30', '16-30 days'), money('d31_45', '31-45 days'), money('d45plus', '> 45 days'), money('total', 'Total')], rows, totals: sumCols(rows, cols) };
}

export const REPORTS: Record<string, ReportDef> = {
  'sales-by-customer': {
    group: 'Sales', title: 'Sales by Customer', perm: 'reports.financial', ranged: true,
    run: async (t, from, to) => {
      const inv = await prisma.invoice.findMany({ where: { tenantId: t, status: BILLED, issueDate: { gte: from, lte: to } }, include: { customer: { select: { name: true } } } });
      const by = new Map<string, { customer: string; count: number; sales: number; salesWithTax: number }>();
      for (const i of inv) { const r = by.get(i.customerId) ?? { customer: i.customer.name, count: 0, sales: 0, salesWithTax: 0 }; r.count++; r.sales += b(i.taxableTotal, i.exchangeRate); r.salesWithTax += b(i.total, i.exchangeRate); by.set(i.customerId, r); }
      const rows = [...by.values()].sort((a, b) => b.salesWithTax - a.salesWithTax);
      return { columns: [{ key: 'customer', label: 'Customer' }, { key: 'count', label: 'Invoices', type: 'number' }, money('sales', 'Sales'), money('salesWithTax', 'Sales with tax')], rows, totals: sumCols(rows, ['count', 'sales', 'salesWithTax']) };
    },
  },
  'sales-by-item': {
    group: 'Sales', title: 'Sales by Item', perm: 'reports.financial', ranged: true,
    run: async (t, from, to) => {
      const items = await prisma.invoiceItem.findMany({ where: { invoice: { tenantId: t, status: BILLED, issueDate: { gte: from, lte: to } } }, select: { description: true, productId: true, quantity: true, amount: true, invoice: { select: { exchangeRate: true } } } });
      const products = await prisma.product.findMany({ where: { tenantId: t }, select: { id: true, name: true } });
      const pname = new Map(products.map((p) => [p.id, p.name]));
      const by = new Map<string, { item: string; quantity: number; amount: number }>();
      for (const i of items) { const k = i.productId ?? i.description.split('\n')[0]; const r = by.get(k) ?? { item: (i.productId && pname.get(i.productId)) || i.description.split('\n')[0], quantity: 0, amount: 0 }; r.quantity += n(i.quantity); r.amount += b(i.amount, i.invoice.exchangeRate); by.set(k, r); }
      const rows = [...by.values()].map((r) => ({ ...r, average: r.quantity ? r2(r.amount / r.quantity) : 0 })).sort((a, b) => b.amount - a.amount);
      return { columns: [{ key: 'item', label: 'Item' }, { key: 'quantity', label: 'Quantity sold', type: 'number' }, money('amount', 'Amount'), money('average', 'Average price')], rows, totals: sumCols(rows, ['quantity', 'amount']) };
    },
  },
  'sales-by-salesperson': {
    group: 'Sales', title: 'Sales by Salesperson', perm: 'reports.financial', ranged: true,
    run: async (t, from, to) => {
      const inv = await prisma.invoice.findMany({ where: { tenantId: t, status: BILLED, issueDate: { gte: from, lte: to } }, select: { salespersonId: true, taxableTotal: true, total: true, exchangeRate: true } });
      const nm = await names(inv.map((i) => i.salespersonId));
      const by = new Map<string, { salesperson: string; count: number; sales: number; salesWithTax: number }>();
      for (const i of inv) { const k = i.salespersonId ?? 'none'; const r = by.get(k) ?? { salesperson: nm.get(k) ?? 'Unassigned', count: 0, sales: 0, salesWithTax: 0 }; r.count++; r.sales += b(i.taxableTotal, i.exchangeRate); r.salesWithTax += b(i.total, i.exchangeRate); by.set(k, r); }
      const rows = [...by.values()];
      return { columns: [{ key: 'salesperson', label: 'Salesperson' }, { key: 'count', label: 'Invoices', type: 'number' }, money('sales', 'Sales'), money('salesWithTax', 'Sales with tax')], rows, totals: sumCols(rows, ['count', 'sales', 'salesWithTax']) };
    },
  },
  'ar-aging-summary': { group: 'Receivables', title: 'AR Aging Summary', perm: 'reports.financial', ranged: false, run: (t, _f, to) => agingRows(t, to, false) },
  'ar-aging-details': { group: 'Receivables', title: 'AR Aging Details', perm: 'reports.financial', ranged: false, run: (t, _f, to) => agingRows(t, to, true) },
  'invoice-details': {
    group: 'Receivables', title: 'Invoice Details', perm: 'reports.financial', ranged: true,
    run: async (t, from, to) => {
      const inv = await prisma.invoice.findMany({ where: { tenantId: t, issueDate: { gte: from, lte: to }, status: { not: 'DRAFT' } }, include: { customer: { select: { name: true } } }, orderBy: { issueDate: 'asc' } });
      const rows = inv.map((i) => ({ status: i.status, date: i.issueDate, dueDate: i.dueDate, number: i.number, orderNumber: i.orderNumber, customer: i.customer.name, currency: i.currency, fcyTotal: n(i.total), total: b(i.total, i.exchangeRate), balance: b(i.balanceDue, i.exchangeRate) }));
      return { columns: [{ key: 'status', label: 'Status' }, date('date', 'Invoice date'), date('dueDate', 'Due date'), { key: 'number', label: 'Invoice#' }, { key: 'orderNumber', label: 'Order number' }, { key: 'customer', label: 'Customer' }, { key: 'currency', label: 'Currency' }, { key: 'fcyTotal', label: 'Amount (invoice currency)', type: 'number' }, money('total', 'Invoice amount'), money('balance', 'Balance due')], rows, totals: sumCols(rows, ['total', 'balance']) };
    },
  },
  'quote-details': {
    group: 'Receivables', title: 'Quote Details', perm: 'quotations.read', ranged: true,
    run: async (t, from, to) => {
      const q = await prisma.quotation.findMany({ where: { tenantId: t, issueDate: { gte: from, lte: to } }, include: { customer: { select: { name: true } }, lead: { select: { name: true } } }, orderBy: { issueDate: 'asc' } });
      const rows = q.map((x) => ({ status: x.status, date: x.issueDate, expiry: x.validUntil, number: x.number, reference: x.referenceNumber, customer: x.customer?.name ?? x.lead?.name, currency: x.currency, total: b(x.total, x.exchangeRate) }));
      return { columns: [{ key: 'status', label: 'Status' }, date('date', 'Quote date'), date('expiry', 'Expiry date'), { key: 'number', label: 'Quote#' }, { key: 'reference', label: 'Reference#' }, { key: 'customer', label: 'Customer' }, { key: 'currency', label: 'Currency' }, money('total', 'Amount')], rows, totals: sumCols(rows, ['total']) };
    },
  },
  'quote-item-details': {
    group: 'Receivables', title: 'Quote Item Details', perm: 'quotations.read', ranged: true,
    run: async (t, from, to) => {
      const items = await prisma.quotationItem.findMany({ where: { quotation: { tenantId: t, issueDate: { gte: from, lte: to } } }, include: { quotation: { select: { number: true, issueDate: true, status: true, exchangeRate: true } } } });
      const rows = items.map((i) => ({ number: i.quotation.number, date: i.quotation.issueDate, status: i.quotation.status, item: i.description.split('\n')[0], quantity: n(i.quantity), rate: b(i.rate, i.quotation.exchangeRate), amount: b(i.amount, i.quotation.exchangeRate) }));
      return { columns: [{ key: 'number', label: 'Quote#' }, date('date', 'Date'), { key: 'status', label: 'Status' }, { key: 'item', label: 'Item' }, { key: 'quantity', label: 'Quantity', type: 'number' }, money('rate', 'Rate'), money('amount', 'Amount')], rows, totals: sumCols(rows, ['quantity', 'amount']) };
    },
  },
  'bad-debts': {
    group: 'Receivables', title: 'Bad Debts', perm: 'reports.financial', ranged: true,
    run: async (t, from, to) => {
      const inv = await prisma.invoice.findMany({ where: { tenantId: t, writtenOffAt: { gte: from, lte: to } }, include: { customer: { select: { name: true } } } });
      const rows = inv.map((i) => ({ date: i.writtenOffAt, number: i.number, customer: i.customer.name, amount: b(i.writeOffAmount, i.exchangeRate) }));
      return { columns: [date('date', 'Written off on'), { key: 'number', label: 'Invoice#' }, { key: 'customer', label: 'Customer' }, money('amount', 'Amount written off')], rows, totals: sumCols(rows, ['amount']) };
    },
  },
  'bank-charges': {
    group: 'Receivables', title: 'Bank Charges', perm: 'reports.financial', ranged: true,
    run: async (t, from, to) => {
      const p = await prisma.payment.findMany({ where: { tenantId: t, paidAt: { gte: from, lte: to }, bankCharges: { gt: 0 } }, include: { customer: { select: { name: true } } } });
      const rows = p.map((x) => ({ date: x.paidAt, number: x.number, customer: x.customer?.name, amount: b(x.bankCharges, x.exchangeRate) }));
      return { columns: [date('date', 'Date'), { key: 'number', label: 'Payment#' }, { key: 'customer', label: 'Customer' }, money('amount', 'Bank charges')], rows, totals: sumCols(rows, ['amount']) };
    },
  },
  'customer-balance-summary': {
    group: 'Receivables', title: 'Customer Balance Summary', perm: 'reports.financial', ranged: true,
    run: async (t, from, to) => {
      const [inv, pay] = await Promise.all([
        prisma.invoice.findMany({ where: { tenantId: t, status: BILLED, issueDate: { gte: from, lte: to } }, select: { customerId: true, total: true, balanceDue: true, exchangeRate: true } }),
        prisma.payment.findMany({ where: { tenantId: t, paidAt: { gte: from, lte: to } }, select: { customerId: true, amount: true, unusedAmount: true, exchangeRate: true } }),
      ]);
      const ids = [...new Set([...inv.map((i) => i.customerId), ...pay.map((p) => p.customerId).filter((x): x is string => !!x)])];
      const cust = await prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
      const rows = cust.map((c) => {
        const i = inv.filter((x) => x.customerId === c.id); const p = pay.filter((x) => x.customerId === c.id);
        return {
          customer: c.name, invoiced: i.reduce((a, x) => a + b(x.total, x.exchangeRate), 0), received: p.reduce((a, x) => a + b(x.amount, x.exchangeRate), 0),
          balance: i.reduce((a, x) => a + b(x.balanceDue, x.exchangeRate), 0), credits: p.reduce((a, x) => a + b(x.unusedAmount, x.exchangeRate), 0),
        };
      });
      return { columns: [{ key: 'customer', label: 'Customer' }, money('invoiced', 'Invoiced amount'), money('received', 'Amount received'), money('balance', 'Closing balance'), money('credits', 'Unused credits')], rows, totals: sumCols(rows, ['invoiced', 'received', 'balance', 'credits']) };
    },
  },
  'receivable-summary': {
    group: 'Receivables', title: 'Receivable Summary', perm: 'reports.financial', ranged: false,
    run: async (t) => {
      const inv = await prisma.invoice.findMany({ where: { tenantId: t, status: { in: [...OPEN] } }, include: { customer: { select: { name: true } } } });
      const by = new Map<string, { customer: string; count: number; total: number; balance: number }>();
      for (const i of inv) { const r = by.get(i.customerId) ?? { customer: i.customer.name, count: 0, total: 0, balance: 0 }; r.count++; r.total += b(i.total, i.exchangeRate); r.balance += b(i.balanceDue, i.exchangeRate); by.set(i.customerId, r); }
      const rows = [...by.values()].sort((a, b) => b.balance - a.balance);
      return { columns: [{ key: 'customer', label: 'Customer' }, { key: 'count', label: 'Open invoices', type: 'number' }, money('total', 'Total'), money('balance', 'Balance due')], rows, totals: sumCols(rows, ['count', 'total', 'balance']) };
    },
  },
  'receivable-details': {
    group: 'Receivables', title: 'Receivable Details', perm: 'reports.financial', ranged: false,
    run: async (t) => {
      const inv = await prisma.invoice.findMany({ where: { tenantId: t, status: { in: [...OPEN] } }, include: { customer: { select: { name: true } } }, orderBy: { dueDate: 'asc' } });
      const rows = inv.map((i) => ({ customer: i.customer.name, number: i.number, date: i.issueDate, dueDate: i.dueDate, status: i.status, total: b(i.total, i.exchangeRate), balance: b(i.balanceDue, i.exchangeRate) }));
      return { columns: [{ key: 'customer', label: 'Customer' }, { key: 'number', label: 'Invoice#' }, date('date', 'Date'), date('dueDate', 'Due date'), { key: 'status', label: 'Status' }, money('total', 'Amount'), money('balance', 'Balance due')], rows, totals: sumCols(rows, ['total', 'balance']) };
    },
  },
  'payments-received': {
    group: 'Payments Received', title: 'Payments Received', perm: 'reports.financial', ranged: true,
    run: async (t, from, to) => {
      const p = await prisma.payment.findMany({ where: { tenantId: t, paidAt: { gte: from, lte: to } }, include: { customer: { select: { name: true } }, allocations: { include: { invoice: { select: { number: true } } } } }, orderBy: { paidAt: 'asc' } });
      const rows = p.map((x) => ({ number: x.number, date: x.paidAt, reference: x.reference, customer: x.customer?.name, invoices: x.allocations.map((a) => a.invoice.number).join(', '), mode: x.method, currency: x.currency, amount: b(x.amount, x.exchangeRate), unused: b(x.unusedAmount, x.exchangeRate) }));
      return { columns: [{ key: 'number', label: 'Payment#' }, date('date', 'Date'), { key: 'reference', label: 'Reference#' }, { key: 'customer', label: 'Customer' }, { key: 'invoices', label: 'Invoice#' }, { key: 'mode', label: 'Mode' }, { key: 'currency', label: 'Currency' }, money('amount', 'Amount'), money('unused', 'Unused amount')], rows, totals: sumCols(rows, ['amount', 'unused']) };
    },
  },
  'time-to-get-paid': {
    group: 'Payments Received', title: 'Time to Get Paid', perm: 'reports.financial', ranged: true,
    run: async (t, from, to) => {
      const allocs = await prisma.paymentAllocation.findMany({ where: { tenantId: t, payment: { paidAt: { gte: from, lte: to } } }, include: { payment: { select: { paidAt: true } }, invoice: { select: { issueDate: true, customerId: true, customer: { select: { name: true } } } } } });
      const by = new Map<string, { customer: string; b0_15: number; b16_30: number; b31_45: number; b45plus: number; days: number[] }>();
      for (const a of allocs) {
        const days = Math.max(0, Math.round((a.payment.paidAt.getTime() - a.invoice.issueDate.getTime()) / DAY));
        const r = by.get(a.invoice.customerId) ?? { customer: a.invoice.customer.name, b0_15: 0, b16_30: 0, b31_45: 0, b45plus: 0, days: [] };
        r[days <= 15 ? 'b0_15' : days <= 30 ? 'b16_30' : days <= 45 ? 'b31_45' : 'b45plus']++;
        r.days.push(days);
        by.set(a.invoice.customerId, r);
      }
      const rows = [...by.values()].map(({ days, ...r }) => ({ ...r, average: Math.round(days.reduce((s, d) => s + d, 0) / days.length) }));
      return { columns: [{ key: 'customer', label: 'Customer' }, { key: 'b0_15', label: '0-15 days', type: 'number' }, { key: 'b16_30', label: '16-30 days', type: 'number' }, { key: 'b31_45', label: '31-45 days', type: 'number' }, { key: 'b45plus', label: '> 45 days', type: 'number' }, { key: 'average', label: 'Average days', type: 'number' }], rows };
    },
  },
  'refund-history': {
    group: 'Payments Received', title: 'Refund History', perm: 'reports.financial', ranged: true,
    run: async (t, from, to) => {
      const r = await prisma.paymentRefund.findMany({ where: { tenantId: t, refundedAt: { gte: from, lte: to } }, include: { payment: { select: { number: true, exchangeRate: true, customer: { select: { name: true } } } } } });
      const rows = r.map((x) => ({ date: x.refundedAt, payment: x.payment.number, customer: x.payment.customer?.name, mode: x.method, reference: x.reference, amount: b(x.amount, x.payment.exchangeRate) }));
      return { columns: [date('date', 'Date'), { key: 'payment', label: 'Payment#' }, { key: 'customer', label: 'Customer' }, { key: 'mode', label: 'Mode' }, { key: 'reference', label: 'Reference#' }, money('amount', 'Amount')], rows, totals: sumCols(rows, ['amount']) };
    },
  },
  'withholding-tax': {
    group: 'Payments Received', title: 'Withholding Tax', perm: 'reports.financial', ranged: true,
    run: async (t, from, to) => {
      const p = await prisma.payment.findMany({ where: { tenantId: t, paidAt: { gte: from, lte: to }, taxDeducted: { gt: 0 } }, include: { customer: { select: { name: true, pan: true } } } });
      const rows = p.map((x) => ({ date: x.paidAt, number: x.number, customer: x.customer?.name, pan: x.customer?.pan, received: b(x.amount, x.exchangeRate), tds: b(x.taxDeducted, x.exchangeRate) }));
      return { columns: [date('date', 'Date'), { key: 'number', label: 'Payment#' }, { key: 'customer', label: 'Customer' }, { key: 'pan', label: 'PAN' }, money('received', 'Amount received'), money('tds', 'TDS deducted')], rows, totals: sumCols(rows, ['received', 'tds']) };
    },
  },
  'recurring-invoice-details': {
    group: 'Recurring Invoices', title: 'Recurring Invoice Details', perm: 'invoices.read', ranged: false,
    run: async (t) => {
      const p = await prisma.recurringProfile.findMany({ where: { tenantId: t }, include: { customer: { select: { name: true } }, _count: { select: { invoices: true } } } });
      const rows = p.map((x) => ({ profile: x.profileName, customer: x.customer.name, frequency: FREQUENCIES[x.frequency].label, status: x.status, start: x.startDate, end: x.endDate, last: x.lastRunDate, next: x.status === 'ACTIVE' ? x.nextRunDate : null, invoices: x._count.invoices }));
      return { columns: [{ key: 'profile', label: 'Profile name' }, { key: 'customer', label: 'Customer' }, { key: 'frequency', label: 'Frequency' }, { key: 'status', label: 'Status' }, date('start', 'Start'), date('end', 'Ends'), date('last', 'Last invoice'), date('next', 'Next invoice'), { key: 'invoices', label: 'Invoices', type: 'number' }], rows };
    },
  },
  'expense-details': {
    group: 'Purchases and Expenses', title: 'Expense Details', perm: 'reports.financial', ranged: true,
    run: async (t, from, to) => {
      const e = await prisma.expense.findMany({ where: { tenantId: t, date: { gte: from, lte: to } }, include: { category: true, customer: { select: { name: true } }, project: { select: { name: true } } }, orderBy: { date: 'asc' } });
      const rows = e.map((x) => ({ date: x.date, category: x.category?.name, vendor: x.vendor, reference: x.reference, customer: x.customer?.name, project: x.project?.name, status: x.invoiceId ? 'Invoiced' : x.billable ? 'Unbilled' : 'Non-billable', amount: n(x.amount), tax: n(x.taxAmount), total: n(x.total) }));
      return { columns: [date('date', 'Date'), { key: 'category', label: 'Category' }, { key: 'vendor', label: 'Vendor' }, { key: 'reference', label: 'Reference#' }, { key: 'customer', label: 'Customer' }, { key: 'project', label: 'Project' }, { key: 'status', label: 'Status' }, money('amount', 'Amount'), money('tax', 'Tax'), money('total', 'Total')], rows, totals: sumCols(rows, ['amount', 'tax', 'total']) };
    },
  },
  'expenses-by-category': {
    group: 'Purchases and Expenses', title: 'Expenses by Category', perm: 'reports.financial', ranged: true,
    run: (t, from, to) => groupExpenses(t, from, to, 'category'),
  },
  'expenses-by-customer': { group: 'Purchases and Expenses', title: 'Expenses by Customer', perm: 'reports.financial', ranged: true, run: (t, from, to) => groupExpenses(t, from, to, 'customer') },
  'expenses-by-project': { group: 'Purchases and Expenses', title: 'Expenses by Project', perm: 'reports.financial', ranged: true, run: (t, from, to) => groupExpenses(t, from, to, 'project') },
  'billable-expense-details': {
    group: 'Purchases and Expenses', title: 'Billable Expense Details', perm: 'reports.financial', ranged: true,
    run: async (t, from, to) => {
      const e = await prisma.expense.findMany({ where: { tenantId: t, billable: true, date: { gte: from, lte: to } }, include: { category: true, customer: { select: { name: true } }, invoice: { select: { number: true } } } });
      const rows = e.map((x) => ({ date: x.date, category: x.category?.name, customer: x.customer?.name, invoice: x.invoice?.number ?? 'Unbilled', total: n(x.total), billed: r2(n(x.amount) * (1 + n(x.markupPct) / 100)) }));
      return { columns: [date('date', 'Date'), { key: 'category', label: 'Category' }, { key: 'customer', label: 'Customer' }, { key: 'invoice', label: 'Invoice#' }, money('total', 'Expense amount'), money('billed', 'Billable amount')], rows, totals: sumCols(rows, ['total', 'billed']) };
    },
  },
  'tax-summary': {
    group: 'Taxes', title: 'Tax Summary', perm: 'reports.financial', ranged: true,
    run: async (t, from, to) => {
      const items = await prisma.invoiceItem.findMany({ where: { invoice: { tenantId: t, status: BILLED, issueDate: { gte: from, lte: to } } }, include: { invoice: { select: { isInterState: true, discountTotal: true, exchangeRate: true } } } });
      const by = new Map<string, { tax: string; taxable: number; amount: number }>();
      for (const i of items) {
        const k = `${i.invoice.isInterState ? 'IGST' : 'CGST+SGST'} ${n(i.taxRate)}%`;
        const r = by.get(k) ?? { tax: k, taxable: 0, amount: 0 };
        r.taxable += b(i.taxable, i.invoice.exchangeRate); r.amount += b(i.taxAmount, i.invoice.exchangeRate); by.set(k, r);
      }
      const rows = [...by.values()];
      return { columns: [{ key: 'tax', label: 'Tax' }, money('taxable', 'Taxable amount'), money('amount', 'Tax amount')], rows, totals: sumCols(rows, ['taxable', 'amount']) };
    },
  },
  'tds-receivable-summary': {
    group: 'Taxes', title: 'TDS Receivable Summary', perm: 'reports.financial', ranged: true,
    run: async (t, from, to) => {
      const pays = await prisma.payment.findMany({ where: { tenantId: t, paidAt: { gte: from, lte: to }, taxDeducted: { gt: 0 } }, select: { customerId: true, taxDeducted: true, amount: true, exchangeRate: true } });
      const ids = [...new Set(pays.map((x) => x.customerId).filter((x): x is string => !!x))];
      const cust = await prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, pan: true } });
      const rows = ids.map((id) => { const c = cust.find((y) => y.id === id); const mine = pays.filter((x) => x.customerId === id); return { customer: c?.name, pan: c?.pan, received: mine.reduce((a, x) => a + b(x.amount, x.exchangeRate), 0), tds: mine.reduce((a, x) => a + b(x.taxDeducted, x.exchangeRate), 0) }; });
      return { columns: [{ key: 'customer', label: 'Customer' }, { key: 'pan', label: 'PAN' }, money('received', 'Amount received'), money('tds', 'TDS receivable')], rows, totals: sumCols(rows, ['received', 'tds']) };
    },
  },
  'gstr3b-summary': { group: 'Taxes', title: 'GSTR-3B Summary', perm: 'reports.financial', ranged: true, run: async (t, from, to) => gstr3bTable(await gstReturns(t, from, to)) },
  'outward-supplies': {
    group: 'Taxes', title: 'Summary of Outward Supplies', perm: 'reports.financial', ranged: true,
    run: async (t, from, to) => {
      const g = await gstReturns(t, from, to);
      const rows = [
        { section: 'B2B (registered)', ...g.summary.b2b }, { section: 'B2C Large (inter-state > ₹1L)', ...g.summary.b2cl },
        { section: 'B2C Small', ...g.summary.b2cs }, { section: 'Exports / SEZ (zero rated)', ...g.summary.exp }, { section: 'Nil rated / exempt', ...g.summary.nil }, { section: 'Credit notes (registered)', ...g.summary.cdnr },
      ];
      return { columns: [{ key: 'section', label: 'Section' }, { key: 'count', label: 'Documents', type: 'number' }, money('taxable', 'Taxable value'), money('igst', 'IGST'), money('cgst', 'CGST'), money('sgst', 'SGST')], rows };
    },
  },
  'timesheet-details': {
    group: 'Projects and Timesheet', title: 'Timesheet Details', perm: 'reports.read', ranged: true,
    run: async (t, from, to) => {
      const e = await prisma.timeEntry.findMany({ where: { tenantId: t, date: { gte: from, lte: to } }, include: { project: { select: { name: true, customer: { select: { name: true } } } }, invoice: { select: { number: true } } }, orderBy: { date: 'asc' } });
      const nm = await names(e.map((x) => x.userId));
      const rows = e.map((x) => ({ date: x.date, project: x.project.name, customer: x.project.customer?.name, user: nm.get(x.userId), hours: r2(x.minutes / 60), billable: x.billable ? 'Yes' : 'No', invoice: x.invoice?.number, notes: x.notes }));
      return { columns: [date('date', 'Date'), { key: 'project', label: 'Project' }, { key: 'customer', label: 'Customer' }, { key: 'user', label: 'User' }, { key: 'hours', label: 'Hours', type: 'number' }, { key: 'billable', label: 'Billable' }, { key: 'invoice', label: 'Invoice#' }, { key: 'notes', label: 'Notes' }], rows, totals: sumCols(rows, ['hours']) };
    },
  },
  'project-summary': {
    group: 'Projects and Timesheet', title: 'Project Summary', perm: 'reports.read', ranged: true,
    run: async (t, from, to) => {
      const p = await prisma.project.findMany({ where: { tenantId: t }, include: { customer: { select: { name: true } }, timeEntries: { where: { date: { gte: from, lte: to } }, select: { minutes: true, billable: true, invoiceId: true } } } });
      const rows = p.map((x) => {
        const total = x.timeEntries.reduce((s, e) => s + e.minutes, 0); const billable = x.timeEntries.filter((e) => e.billable).reduce((s, e) => s + e.minutes, 0);
        const billed = x.timeEntries.filter((e) => e.invoiceId).reduce((s, e) => s + e.minutes, 0);
        return { project: x.name, customer: x.customer?.name, status: x.status, logged: r2(total / 60), billable: r2(billable / 60), billed: r2(billed / 60), unbilled: r2((billable - billed) / 60) };
      });
      return { columns: [{ key: 'project', label: 'Project' }, { key: 'customer', label: 'Customer' }, { key: 'status', label: 'Status' }, { key: 'logged', label: 'Logged hours', type: 'number' }, { key: 'billable', label: 'Billable hours', type: 'number' }, { key: 'billed', label: 'Billed hours', type: 'number' }, { key: 'unbilled', label: 'Unbilled hours', type: 'number' }], rows, totals: sumCols(rows, ['logged', 'billable', 'billed', 'unbilled']) };
    },
  },
  'projects-revenue-summary': {
    group: 'Projects and Timesheet', title: 'Projects Revenue Summary', perm: 'reports.financial', ranged: true,
    run: async (t, from, to) => {
      const [p, inv, exp] = await Promise.all([
        prisma.project.findMany({ where: { tenantId: t }, select: { id: true, name: true, budget: true, customer: { select: { name: true } } } }),
        prisma.invoice.findMany({ where: { tenantId: t, status: BILLED, issueDate: { gte: from, lte: to }, projectId: { not: null } }, select: { projectId: true, taxableTotal: true, balanceDue: true, exchangeRate: true } }),
        prisma.expense.groupBy({ by: ['projectId'], where: { tenantId: t, date: { gte: from, lte: to }, projectId: { not: null } }, _sum: { total: true } }),
      ]);
      const rows = p.map((x) => { const i = inv.filter((y) => y.projectId === x.id); const e = exp.find((y) => y.projectId === x.id); const revenue = i.reduce((a, y) => a + b(y.taxableTotal, y.exchangeRate), 0); const cost = n(e?._sum.total); return { project: x.name, customer: x.customer?.name, budget: n(x.budget), revenue, outstanding: i.reduce((a, y) => a + b(y.balanceDue, y.exchangeRate), 0), expenses: cost, profit: r2(revenue - cost) }; }).filter((r) => r.revenue || r.expenses);
      return { columns: [{ key: 'project', label: 'Project' }, { key: 'customer', label: 'Customer' }, money('budget', 'Budget'), money('revenue', 'Revenue'), money('outstanding', 'Outstanding'), money('expenses', 'Expenses'), money('profit', 'Profit')], rows, totals: sumCols(rows, ['budget', 'revenue', 'outstanding', 'expenses', 'profit']) };
    },
  },
  'system-mails': {
    group: 'Activity', title: 'System Mails', perm: 'audit.read', ranged: true,
    run: async (t, from, to) => {
      const logs = await prisma.auditLog.findMany({ where: { tenantId: t, action: { endsWith: '.emailed' }, createdAt: { gte: from, lte: to } }, orderBy: { createdAt: 'desc' } });
      const rows = logs.map((l) => ({ date: l.createdAt, type: l.action.replace('.emailed', ''), sentBy: l.actorEmail, to: ((l.meta as { to?: string[] }).to ?? []).join(', ') }));
      return { columns: [date('date', 'Sent on'), { key: 'type', label: 'Document' }, { key: 'sentBy', label: 'Sent by' }, { key: 'to', label: 'Recipients' }], rows };
    },
  },
  'activity-logs': {
    group: 'Activity', title: 'Activity Logs & Audit Trail', perm: 'audit.read', ranged: true,
    run: async (t, from, to) => {
      const logs = await prisma.auditLog.findMany({ where: { tenantId: t, createdAt: { gte: from, lte: to } }, orderBy: { createdAt: 'desc' }, take: 2000 });
      const rows = logs.map((l) => ({ date: l.createdAt, user: l.actorEmail, action: l.action, entity: l.entityType, ip: l.ip }));
      return { columns: [date('date', 'Date'), { key: 'user', label: 'User' }, { key: 'action', label: 'Action' }, { key: 'entity', label: 'Entity' }, { key: 'ip', label: 'IP' }], rows };
    },
  },
  'portal-activities': {
    group: 'Activity', title: 'Portal Activities', perm: 'audit.read', ranged: true,
    run: async (t, from, to) => {
      const logs = await prisma.auditLog.findMany({ where: { tenantId: t, action: { startsWith: 'portal.' }, createdAt: { gte: from, lte: to } }, orderBy: { createdAt: 'desc' } });
      const rows = logs.map((l) => ({ date: l.createdAt, user: l.actorEmail, action: l.action.replace('portal.', '').replace(/_/g, ' '), entity: l.entityType }));
      return { columns: [date('date', 'Date'), { key: 'user', label: 'Customer user' }, { key: 'action', label: 'Action' }, { key: 'entity', label: 'Document' }], rows };
    },
  },
  'customer-reviews': {
    group: 'Activity', title: 'Customer Reviews', perm: 'feedback.read', ranged: true,
    run: async (t, from, to) => {
      const f = await prisma.feedback.findMany({ where: { tenantId: t, createdAt: { gte: from, lte: to } }, orderBy: { createdAt: 'desc' } });
      const rows = f.map((x) => ({ date: x.createdAt, reference: x.referenceNo, customer: x.company ?? x.name, service: x.serviceCategory, rating: x.ratingOverall, sentiment: x.sentiment, status: x.status }));
      return { columns: [date('date', 'Date'), { key: 'reference', label: 'Reference' }, { key: 'customer', label: 'Customer' }, { key: 'service', label: 'Service' }, { key: 'rating', label: 'Rating', type: 'number' }, { key: 'sentiment', label: 'Sentiment' }, { key: 'status', label: 'Status' }], rows };
    },
  },
};

async function groupExpenses(t: string, from: Date, to: Date, by: 'category' | 'customer' | 'project'): Promise<Result> {
  const e = await prisma.expense.findMany({ where: { tenantId: t, date: { gte: from, lte: to } }, include: { category: true, customer: { select: { name: true } }, project: { select: { name: true } } } });
  const m = new Map<string, { name: string; count: number; amount: number; total: number }>();
  for (const x of e) {
    const key = by === 'category' ? x.category?.name ?? 'Uncategorised' : by === 'customer' ? x.customer?.name ?? 'No customer' : x.project?.name ?? 'No project';
    const r = m.get(key) ?? { name: key, count: 0, amount: 0, total: 0 };
    r.count++; r.amount += n(x.amount); r.total += n(x.total); m.set(key, r);
  }
  const rows = [...m.values()].sort((a, b) => b.total - a.total);
  return { columns: [{ key: 'name', label: by === 'category' ? 'Category' : by === 'customer' ? 'Customer' : 'Project' }, { key: 'count', label: 'Expenses', type: 'number' }, money('amount', 'Amount'), money('total', 'Amount with tax')], rows, totals: sumCols(rows, ['count', 'amount', 'total']) };
}

insightsRouter.get('/reports-center/catalog', (req, res) => {
  const list = Object.entries(REPORTS).filter(([, r]) => can(req, r.perm as never)).map(([key, r]) => ({ key, group: r.group, title: r.title, ranged: r.ranged }));
  res.json(list);
});

insightsRouter.get('/reports-center/:key', async (req, res) => {
  const def = REPORTS[String(req.params.key)];
  if (!def) throw notFound('Report');
  if (!can(req, def.perm as never)) throw forbidden(`Missing permission: ${def.perm}`);
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) }, select: { fiscalYearStartMonth: true, name: true } });
  const fy = fiscalYear(tenant.fiscalYearStartMonth);
  const from = dateParam(req.query.from) ?? fy.from;
  const to = dateParam(req.query.to, { endOfDay: true }) ?? new Date();
  const result = await def.run(tid(req), from, to);
  if (req.query.format === 'csv') {
    res.type('text/csv').attachment(`${String(req.params.key)}.csv`);
    const header = Object.fromEntries(result.columns.map((c) => [c.key, c.label]));
    const rows = result.rows.map((r) => Object.fromEntries(result.columns.map((c) => [c.label, r[c.key] instanceof Date ? (r[c.key] as Date).toISOString().slice(0, 10) : r[c.key]])));
    return res.send(toCsv(rows, Object.values(header)));
  }
  res.json({ key: req.params.key, title: def.title, group: def.group, company: tenant.name, from: def.ranged ? from : null, to, ...result });
});

// ───────────────────────── GST returns ─────────────────────────

type Sec = { count: number; taxable: number; igst: number; cgst: number; sgst: number };
const sec = (): Sec => ({ count: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 });
const B2CL_THRESHOLD = 100_000; // inter-state invoices to unregistered persons above ₹1 lakh

export async function gstReturns(t: string, from: Date, to: Date) {
  const [inv, cns, items] = await Promise.all([
    prisma.invoice.findMany({ where: { tenantId: t, status: BILLED, issueDate: { gte: from, lte: to } }, include: { customer: { select: { name: true, gstin: true, gstTreatment: true } } }, orderBy: { issueDate: 'asc' } }),
    prisma.creditNote.findMany({ where: { tenantId: t, status: 'ISSUED', issueDate: { gte: from, lte: to } }, include: { invoice: { select: { number: true, isInterState: true, placeOfSupply: true, customer: { select: { name: true, gstin: true } } } } } }),
    prisma.invoiceItem.findMany({ where: { invoice: { tenantId: t, status: BILLED, issueDate: { gte: from, lte: to } } }, include: { invoice: { select: { isInterState: true, exchangeRate: true } } } }),
  ]);
  // GST is reported in INR: foreign-currency documents are converted at the rate stated on each document.
  const inr = <T extends { taxableTotal: unknown; igstTotal: unknown; cgstTotal: unknown; sgstTotal: unknown; total: unknown; exchangeRate: unknown }>(d: T) => ({
    taxable: b(d.taxableTotal, d.exchangeRate), igst: b(d.igstTotal, d.exchangeRate), cgst: b(d.cgstTotal, d.exchangeRate), sgst: b(d.sgstTotal, d.exchangeRate), value: b(d.total, d.exchangeRate),
  });
  const summary = { b2b: sec(), b2cl: sec(), b2cs: sec(), exp: sec(), nil: sec(), cdnr: sec() };
  const add = (s: Sec, v: { taxable: number; igst: number; cgst: number; sgst: number }) => { s.count++; s.taxable += v.taxable; s.igst += v.igst; s.cgst += v.cgst; s.sgst += v.sgst; };
  const b2b: Record<string, unknown>[] = [], b2cl: Record<string, unknown>[] = [], exp: Record<string, unknown>[] = [];
  const b2csMap = new Map<string, Record<string, unknown> & { taxable: number; igst: number; cgst: number; sgst: number }>();
  for (const i of inv) {
    const v = inr(i);
    const tax = v.igst + v.cgst + v.sgst;
    const pos = i.placeOfSupply ? `${i.placeOfSupply}-${i.placeOfSupply === '96' ? 'Foreign Country' : INDIAN_STATES[i.placeOfSupply] ?? ''}` : '';
    const rec = { gstin: i.customer.gstin, customer: i.customer.name, number: i.number, date: i.issueDate, currency: i.currency, value: v.value, pos, taxable: v.taxable, igst: v.igst, cgst: v.cgst, sgst: v.sgst };
    if (i.customer.gstTreatment && ZERO_RATED.includes(i.customer.gstTreatment)) {
      // Exports and SEZ supplies (zero rated, under LUT): GSTR-1 table 6 / GSTR-3B 3.1(b).
      add(summary.exp, v);
      exp.push({ ...rec, type: i.customer.gstTreatment === 'SEZ' ? 'SEZ without payment' : 'Export without payment (LUT)' });
    } else if (tax === 0) add(summary.nil, v);
    else if (i.customer.gstin) { add(summary.b2b, v); b2b.push(rec); }
    else if (i.isInterState && v.value > B2CL_THRESHOLD) { add(summary.b2cl, v); b2cl.push(rec); }
    else {
      add(summary.b2cs, v);
      const k = `${pos}|${i.isInterState ? 'Inter' : 'Intra'}`;
      const r = b2csMap.get(k) ?? { pos, supplyType: i.isInterState ? 'Inter-state' : 'Intra-state', taxable: 0, igst: 0, cgst: 0, sgst: 0 };
      r.taxable += v.taxable; r.igst += v.igst; r.cgst += v.cgst; r.sgst += v.sgst;
      b2csMap.set(k, r);
    }
  }
  const cdnr = cns.filter((c) => c.invoice.customer.gstin).map((c) => {
    const v = inr(c);
    add(summary.cdnr, v);
    return { gstin: c.invoice.customer.gstin, customer: c.invoice.customer.name, number: c.number, date: c.issueDate, invoice: c.invoice.number, taxable: v.taxable, igst: v.igst, cgst: v.cgst, sgst: v.sgst, value: v.value };
  });
  const allCn = cns.map(inr).reduce((s, c) => ({ taxable: s.taxable + c.taxable, igst: s.igst + c.igst, cgst: s.cgst + c.cgst, sgst: s.sgst + c.sgst }), { taxable: 0, igst: 0, cgst: 0, sgst: 0 });
  const hsnMap = new Map<string, { hsn: string; rate: number; quantity: number; taxable: number; igst: number; cgst: number; sgst: number }>();
  for (const it of items) {
    const k = `${it.hsnSac ?? 'NA'}|${n(it.taxRate)}`;
    const r = hsnMap.get(k) ?? { hsn: it.hsnSac ?? 'Not specified', rate: n(it.taxRate), quantity: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    const rate = it.invoice.exchangeRate;
    r.quantity += n(it.quantity); r.taxable += b(it.taxable, rate);
    if (it.invoice.isInterState) r.igst += b(it.taxAmount, rate); else { r.cgst += b(it.taxAmount, rate) / 2; r.sgst += b(it.taxAmount, rate) / 2; }
    hsnMap.set(k, r);
  }
  const round = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v])) as T;
  const taxable = [summary.b2b, summary.b2cl, summary.b2cs];
  const outward = taxable.reduce((s, x) => ({ taxable: s.taxable + x.taxable, igst: s.igst + x.igst, cgst: s.cgst + x.cgst, sgst: s.sgst + x.sgst }), { taxable: 0, igst: 0, cgst: 0, sgst: 0 });
  return {
    period: { from, to },
    summary: Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, round(v)])) as typeof summary,
    gstr1: { b2b: b2b.map(round), b2cl: b2cl.map(round), b2cs: [...b2csMap.values()].map(round), exp: exp.map(round), cdnr: cdnr.map(round), hsn: [...hsnMap.values()].map(round) },
    gstr3b: {
      outwardTaxable: round({ taxable: outward.taxable - allCn.taxable, igst: outward.igst - allCn.igst, cgst: outward.cgst - allCn.cgst, sgst: outward.sgst - allCn.sgst }),
      zeroRated: round({ taxable: summary.exp.taxable, igst: summary.exp.igst }),
      nilExempt: round({ taxable: summary.nil.taxable }),
      interStateUnregistered: [...b2csMap.values(), ...b2cl.map((x) => ({ pos: x.pos as string, taxable: x.taxable as number, igst: x.igst as number }))].filter((x) => n((x as { igst: number }).igst) > 0).map(round),
    },
  };
}

function gstr3bTable(g: Awaited<ReturnType<typeof gstReturns>>): Result {
  const rows = [
    { nature: '3.1(a) Outward taxable supplies (other than zero rated, nil rated and exempted)', ...g.gstr3b.outwardTaxable },
    { nature: '3.1(b) Outward taxable supplies (zero rated)', taxable: g.gstr3b.zeroRated.taxable, igst: g.gstr3b.zeroRated.igst, cgst: 0, sgst: 0 },
    { nature: '3.1(c) Other outward supplies (nil rated, exempted)', taxable: g.gstr3b.nilExempt.taxable, igst: 0, cgst: 0, sgst: 0 },
  ];
  return { columns: [{ key: 'nature', label: 'Nature of supplies' }, money('taxable', 'Total taxable value'), money('igst', 'Integrated tax'), money('cgst', 'Central tax'), money('sgst', 'State/UT tax')], rows };
}

insightsRouter.get('/gst/returns', requirePerm('reports.financial'), async (req, res) => {
  const month = qstr(req.query.month) ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw notFound('Period');
  const [y, m] = month.split('-').map(Number);
  const from = new Date(y, m - 1, 1);
  const to = new Date(y, m, 0, 23, 59, 59);
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) }, select: { gstin: true, legalName: true, name: true } });
  const data = await gstReturns(tid(req), from, to);
  const section = qstr(req.query.section);
  if (req.query.format === 'csv' && section && section in data.gstr1) {
    const rows = (data.gstr1 as Record<string, Record<string, unknown>[]>)[section].map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : v])));
    res.type('text/csv').attachment(`gstr1-${section}-${month}.csv`);
    return res.send(toCsv(rows, rows[0] ? Object.keys(rows[0]) : []));
  }
  res.json({ month, gstin: tenant.gstin, legalName: tenant.legalName ?? tenant.name, ...data });
});

