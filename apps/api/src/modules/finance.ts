import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { InvoiceStatus, Prisma, QuotationStatus } from '@prisma/client';
import { prisma, type Tx } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { dateRange, listParams, orderBy, paged, qstr, toCsv } from '../lib/list.js';
import { DEFAULT_PREFIXES, nextNumber } from '../lib/numbering.js';
import { assertTenantRefs } from '../lib/tenantRefs.js';
import { computeDocument, dueDateFor, GST_RATES, INDIAN_STATES, isInterStateSupply, PAYMENT_TERMS } from '../lib/gst.js';
import { renderFinancialPdf, streamFinancialPdf, type FinancialDoc } from '../lib/pdf.js';
import { getObjectStream } from '../lib/storage.js';
import { tenantSettings } from '../lib/tenants.js';
import { currencyInfo, resolveDocumentCurrency, tenantCurrencies, toBase } from '../lib/currency.js';
import { authorizationSnapshot, loadAuthorizationBlock } from '../lib/authorization.js';
import { asComponents, resolveLineTaxes, type LineRequest, type TaxSnapshot } from '../lib/taxes.js';
import { rescoreLead } from './crm.js';
import { requirePerm, requireStaff, tid } from '../middleware/tenant.js';
import { parse } from '../middleware/validate.js';

export const financeRouter = Router();

export const money = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;

export const GST_TREATMENTS: Record<string, string> = {
  REGISTERED_REGULAR: 'Registered Business - Regular',
  REGISTERED_COMPOSITION: 'Registered Business - Composition',
  UNREGISTERED: 'Unregistered Business',
  CONSUMER: 'Consumer',
  OVERSEAS: 'Overseas',
  SEZ: 'Special Economic Zone',
  DEEMED_EXPORT: 'Deemed Export',
};

financeRouter.get('/finance/meta', requireStaff, async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: tid(req) }, select: { stateCode: true, gstin: true, currency: true, defaultCurrency: true } });
  const settings = tenantSettings((await prisma.tenant.findUnique({ where: { id: tid(req) }, select: { settings: true } }))?.settings);
  res.json({
    gstRates: GST_RATES, states: INDIAN_STATES, gstTreatments: GST_TREATMENTS,
    paymentTerms: Object.entries(PAYMENT_TERMS).map(([code, t]) => ({ code, label: t.label })),
    tdsRates: [{ label: 'Commission or Brokerage [5%]', rate: 5 }, { label: 'Professional Fees [10%]', rate: 10 }, { label: 'Technical Fees [2%]', rate: 2 }, { label: 'Contractors - Others [2%]', rate: 2 }, { label: 'Contractors - Individual/HUF [1%]', rate: 1 }, { label: 'Rent on Land/Building [10%]', rate: 10 }],
    tcsRates: [{ label: 'Sale of goods [0.1%]', rate: 0.1 }, { label: 'Scrap [1%]', rate: 1 }],
    companyStateCode: tenant?.stateCode ?? null, companyGstin: tenant?.gstin ?? null,
    roundOff: settings.tax.roundOff ?? false, defaultTaxRate: settings.tax.defaultTaxRate,
    baseCurrency: tenant?.currency ?? 'INR', defaultCurrency: tenant?.defaultCurrency ?? 'INR',
    currencies: await tenantCurrencies(tid(req)),
  });
});

// ───────────────────────── Items (products & services) ─────────────────────────

const productSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional().nullable(),
  type: z.enum(['SERVICE', 'GOODS']).optional(),
  sku: z.string().max(60).optional().nullable(),
  hsnSac: z.string().max(12).optional().nullable(),
  unit: z.string().max(20).optional(),
  rate: z.coerce.number().min(0),
  taxPreference: z.enum(['TAXABLE', 'EXEMPT']).optional(),
  taxRate: z.coerce.number().refine((r) => GST_RATES.includes(r), 'Invalid GST rate'),
  active: z.boolean().optional(),
});

financeRouter.get('/products', requirePerm('products.manage', 'quotations.create', 'invoices.create'), async (req, res) => {
  const p = listParams(req, ['name', 'createdAt', 'rate']);
  const where: Prisma.ProductWhereInput = {
    tenantId: tid(req),
    ...(p.q ? { OR: [{ name: { contains: p.q, mode: 'insensitive' } }, { description: { contains: p.q, mode: 'insensitive' } }, { hsnSac: { contains: p.q } }, { sku: { contains: p.q, mode: 'insensitive' } }] } : {}),
    ...(req.query.active === '1' ? { active: true } : req.query.active === '0' ? { active: false } : {}),
    ...(qstr(req.query.type) ? { type: String(req.query.type) } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.product.findMany({ where, orderBy: orderBy(p), skip: p.skip, take: p.pageSize }),
    prisma.product.count({ where }),
  ]);
  res.json(paged(items, total, p));
});

financeRouter.post('/products', requirePerm('products.manage'), async (req, res) => {
  const body = parse(productSchema, req.body);
  const product = await prisma.product.create({ data: { ...body, taxRate: body.taxPreference === 'EXEMPT' ? 0 : body.taxRate, tenantId: tid(req) } });
  await audit(req, { action: 'products.create', entityType: 'product', entityId: product.id });
  res.status(201).json(product);
});

financeRouter.patch('/products/:id', requirePerm('products.manage'), async (req, res) => {
  const body = parse(productSchema.partial(), req.body);
  const r = await prisma.product.updateMany({ where: { id: String(req.params.id), tenantId: tid(req) }, data: { ...body, ...(body.taxPreference === 'EXEMPT' ? { taxRate: 0 } : {}) } });
  if (!r.count) throw notFound('Item');
  res.json(await prisma.product.findUnique({ where: { id: String(req.params.id) } }));
});

financeRouter.delete('/products/:id', requirePerm('products.manage'), async (req, res) => {
  // Line items keep their own copy of description/rate, so an item can be marked inactive safely.
  const r = await prisma.product.updateMany({ where: { id: String(req.params.id), tenantId: tid(req) }, data: { active: false } });
  if (!r.count) throw notFound('Item');
  res.json({ ok: true });
});

// ───────────────────────── Shared document helpers ─────────────────────────

/** A document line: a configured tax (taxRateId, from Tax Settings) or, for older clients, a plain GST rate. */
export const lineSchema = z.object({
  productId: z.string().optional().nullable(),
  description: z.string().min(1).max(2000),
  hsnSac: z.string().max(12).optional().nullable(),
  quantity: z.coerce.number().positive().max(1_000_000),
  unit: z.string().max(20).optional().nullable(),
  rate: z.coerce.number().min(0).max(1_000_000_000),
  discountPct: z.coerce.number().min(0).max(100).optional(),
  /** Fixed discount for the whole line, used instead of discountPct. */
  discountAmount: z.coerce.number().min(0).max(1_000_000_000).optional(),
  taxRateId: z.string().optional().nullable(),
  taxRate: z.coerce.number().refine((r) => GST_RATES.includes(r), 'Invalid GST rate').optional().nullable(),
}).refine((l) => !!l.taxRateId || (l.taxRate !== undefined && l.taxRate !== null), { message: 'Choose a tax', path: ['taxRateId'] });
export type LineInputBody = z.infer<typeof lineSchema> & Pick<LineRequest, 'taxName' | 'taxComponents'>;

export const opt = (s: z.ZodTypeAny) => s.optional().nullable();
export const docBase = {
  number: opt(z.string().trim().max(40)),
  customerId: opt(z.string()),
  issueDate: z.coerce.date().optional(),
  placeOfSupply: opt(z.string().regex(/^\d{2}$/)),
  salespersonId: opt(z.string()),
  subject: opt(z.string().max(1000)),
  projectId: opt(z.string()),
  discountType: z.enum(['PERCENT', 'AMOUNT']).optional(),
  discountValue: z.coerce.number().min(0).optional(),
  withholdingType: opt(z.enum(['TDS', 'TCS'])),
  withholdingRate: z.coerce.number().min(0).max(100).optional(),
  adjustmentLabel: opt(z.string().max(60)),
  adjustment: z.coerce.number().min(-10_000_000).max(10_000_000).optional(),
  notes: opt(z.string().max(5000)),
  terms: opt(z.string().max(5000)),
  currency: opt(z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO currency code')),
  /** 1 unit of the document currency in the base currency. Required for foreign currencies (or the last rate used). */
  exchangeRate: opt(z.coerce.number().positive().max(1_000_000)),
  items: z.array(lineSchema).min(1, 'Add at least one line item').max(200),
};

type DocInput = {
  customerId?: string | null; placeOfSupply?: string | null; items: LineInputBody[]; currency?: string | null; exchangeRate?: number | null;
  discountType?: 'PERCENT' | 'AMOUNT'; discountValue?: number; withholdingType?: 'TDS' | 'TCS' | null; withholdingRate?: number; adjustment?: number;
};

/** GST treatments billed as zero-rated supplies (export of services / supplies to SEZ under LUT). */
export const ZERO_RATED_TREATMENTS = ['OVERSEAS', 'SEZ'];
export const FOREIGN_COUNTRY_POS = '96';

type PrepareContext = {
  current?: { currency: string; exchangeRate: unknown };
  userId?: string;
  /** Document date: configured taxes must be in effect on it. */
  on?: Date;
  /** Lines already saved on the document; their taxes may stay even if no longer available for new documents. */
  existing?: TaxSnapshot[];
  /** Keep the tax values carried on the lines (conversions), rather than the configuration's current values. */
  trustSnapshots?: boolean;
  /** Accept configurations that are no longer available (scheduled recurring invoices). */
  allowUnavailable?: boolean;
};

export async function prepareDocument(tx: Tx, tenantId: string, input: DocInput, ctx: PrepareContext = {}) {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  for (const it of input.items) if (it.productId) await assertTenantRefs(tenantId, { product: it.productId }, tx);
  const customer = input.customerId ? await tx.customer.findFirst({ where: { id: input.customerId, tenantId }, select: { stateCode: true, taxPreference: true, gstTreatment: true } }) : null;
  // Tax follows the customer's GST treatment and place of supply, never the document currency.
  const zeroRated = !!customer?.gstTreatment && ZERO_RATED_TREATMENTS.includes(customer.gstTreatment);
  const placeOfSupply = input.placeOfSupply ?? customer?.stateCode ?? (customer?.gstTreatment === 'OVERSEAS' ? FOREIGN_COUNTRY_POS : tenant.stateCode) ?? null;
  // Exports and SEZ supplies are inter-state supplies under the IGST Act.
  const isInterState = zeroRated || isInterStateSupply(tenant.stateCode, placeOfSupply);
  const resolved = await resolveLineTaxes(tx, tenantId, input.items, { on: ctx.on, existing: ctx.existing, trustSnapshots: ctx.trustSnapshots, allowUnavailable: ctx.allowUnavailable });
  // Tax-exempt customers are billed without GST; exports/SEZ are zero-rated (supplied under LUT).
  const noTax = customer?.taxPreference === 'EXEMPT' || zeroRated;
  const items = noTax ? resolved.map((i) => ({ ...i, taxRate: 0, taxRateId: null, taxName: zeroRated ? 'Zero rated (LUT)' : 'Exempt (customer)', taxComponents: null })) : resolved;
  const money = await resolveDocumentCurrency(tx, tenant, { currency: input.currency, exchangeRate: input.exchangeRate, current: ctx.current }, ctx.userId);
  const settings = tenantSettings(tenant.settings);
  const { lines, totals } = computeDocument(items, isInterState, {
    discountType: input.discountType, discountValue: input.discountValue,
    withholdingType: input.withholdingType, withholdingRate: input.withholdingRate,
    adjustment: input.adjustment, roundOff: settings.tax.roundOff ?? false, decimals: money.decimals,
  });
  assertStorable(lines, totals);
  return { tenant, placeOfSupply, isInterState, zeroRated, lines, totals, money: { currency: money.currency, exchangeRate: money.exchangeRate } };
}

/** Largest amount a Decimal(14,2) column holds. */
export const MAX_AMOUNT = 999_999_999_999.99;
function assertStorable(lines: { amount: number; taxable: number; taxAmount: number }[], totals: { subtotal: number; total: number; taxableTotal: number }) {
  const values = [...lines.flatMap((l) => [l.amount, l.taxable, l.taxAmount]), totals.subtotal, totals.total, totals.taxableTotal];
  if (values.some((v) => !Number.isFinite(v) || Math.abs(v) > MAX_AMOUNT)) {
    throw badRequest(`Amount too large: a line or total exceeds ${MAX_AMOUNT.toLocaleString('en-IN')}`, { fieldErrors: { items: ['Amount too large'] } });
  }
}

export const lineData = (l: ReturnType<typeof computeDocument>['lines'][number]) => ({
  productId: l.productId ?? null, description: l.description, hsnSac: l.hsnSac ?? null, quantity: l.quantity, unit: l.unit ?? null,
  rate: l.rate, discountPct: l.discountPct, discountAmount: l.discountAmount, taxRate: l.taxRate,
  taxRateId: l.taxRateId ?? null, taxName: l.taxName ?? null, taxComponents: (l.taxComponents ?? undefined) as Prisma.InputJsonValue | undefined,
  taxable: l.taxable, taxAmount: l.taxAmount, amount: l.amount, sortOrder: l.sortOrder,
});

/** A saved line as input for recalculation, keeping its frozen tax values. */
export const savedLine = (it: { productId: string | null; description: string; hsnSac: string | null; quantity: unknown; unit: string | null; rate: unknown; discountPct: unknown; discountAmount: unknown; taxRate: unknown; taxRateId: string | null; taxName: string | null; taxComponents: Prisma.JsonValue | null }): LineInputBody => ({
  productId: it.productId, description: it.description, hsnSac: it.hsnSac, quantity: Number(it.quantity), unit: it.unit, rate: Number(it.rate),
  discountPct: Number(it.discountPct), discountAmount: Number(it.discountAmount), taxRate: Number(it.taxRate), taxRateId: it.taxRateId,
  taxName: it.taxName, taxComponents: asComponents(it.taxComponents),
});

/** Tax totals of a saved document, for copying it to a new one. */
export const taxTotals = (d: { otherTaxTotal: unknown; taxBreakdown: Prisma.JsonValue | null }) => ({
  otherTaxTotal: Number(d.otherTaxTotal), taxBreakdown: (d.taxBreakdown ?? undefined) as Prisma.InputJsonValue | undefined,
});

export const docFields = (body: Partial<DocInput> & { discountType?: string; discountValue?: number; withholdingType?: string | null; withholdingRate?: number; adjustmentLabel?: string | null; adjustment?: number }) => ({
  discountType: body.discountType ?? 'PERCENT',
  discountValue: body.discountValue ?? 0,
  withholdingType: body.withholdingType ?? null,
  withholdingRate: body.withholdingType ? body.withholdingRate ?? 0 : 0,
  adjustmentLabel: body.adjustmentLabel ?? null,
  adjustment: body.adjustment ?? 0,
});

/** Uses the given number (unique per tenant) or allocates the next one in the series. */
export async function documentNumber(tx: Tx, tenantId: string, type: 'QUOTATION' | 'INVOICE' | 'PROFORMA', manual: string | null | undefined, _table?: string, excludeId?: string) {
  if (!manual) return nextNumber(tx, tenantId, type);
  const where = { tenantId, number: manual, ...(excludeId ? { id: { not: excludeId } } : {}) };
  const exists = type === 'QUOTATION'
    ? await tx.quotation.findFirst({ where, select: { id: true } })
    : type === 'PROFORMA'
      ? await tx.proformaInvoice.findFirst({ where, select: { id: true } })
      : await tx.invoice.findFirst({ where, select: { id: true } });
  if (exists) throw conflict(`Number ${manual} is already in use`);
  return manual;
}

async function loadTenantLogo(tenant: Prisma.TenantGetPayload<object>): Promise<Buffer | null> {
  if (!tenant.logoFileId) return null;
  const file = await prisma.fileObject.findFirst({ where: { id: tenant.logoFileId, tenantId: tenant.id } });
  if (!file || !['image/png', 'image/jpeg'].includes(file.mimeType)) return null; // pdfkit supports PNG and JPEG only
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of await getObjectStream(file.storageKey)) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

export async function sellerOf(tenant: Prisma.TenantGetPayload<object>) {
  return {
    name: tenant.legalName ?? tenant.name, company: tenant.legalName ?? tenant.name,
    address: [tenant.addressLine1, tenant.addressLine2].filter(Boolean).join(', ') || null,
    city: tenant.city, state: tenant.state, stateCode: tenant.stateCode, postalCode: tenant.postalCode,
    gstin: tenant.gstin, pan: tenant.pan, email: tenant.email, phone: tenant.phone, brandColor: tenant.brandColor,
    logo: await loadTenantLogo(tenant),
  };
}

type CustomerLike = Prisma.CustomerGetPayload<object>;
export function buyerOf(c: CustomerLike | null, fallback?: { name: string; company?: string | null; email?: string | null; phone?: string | null }) {
  if (c) return { name: c.billingAttention ?? c.name, company: c.company ?? c.name, address: c.billingAddress, city: c.city, state: c.state, stateCode: c.stateCode, postalCode: c.postalCode, gstin: c.gstin, email: c.email, phone: c.phone };
  return { name: fallback?.name ?? 'Customer', company: fallback?.company ?? null, email: fallback?.email ?? null, phone: fallback?.phone ?? null };
}
export function shipToOf(c: CustomerLike | null) {
  if (!c?.shippingAddress) return null;
  return { name: c.shippingAttention ?? c.name, company: c.company ?? c.name, address: c.shippingAddress, city: c.shippingCity, state: c.shippingState, postalCode: c.shippingPostalCode };
}

export async function memberName(id?: string | null) {
  if (!id) return null;
  return (await prisma.user.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
}

// ───────────────────────── Quotations ─────────────────────────

const quotationSchema = z.object({ ...docBase, referenceNumber: opt(z.string().max(60)), leadId: opt(z.string()), validUntil: z.coerce.date().optional().nullable() });

const QUOTE_EDITABLE: QuotationStatus[] = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'];
const quoteInclude = { items: { orderBy: { sortOrder: 'asc' } }, customer: true, project: { select: { id: true, code: true, name: true } }, lead: { select: { id: true, name: true, company: true, email: true, phone: true } } } satisfies Prisma.QuotationInclude;

financeRouter.get('/quotations', requirePerm('quotations.read'), async (req, res) => {
  const p = listParams(req, ['issueDate', 'createdAt', 'total', 'number', 'validUntil']);
  const where: Prisma.QuotationWhereInput = {
    tenantId: tid(req),
    ...(p.q ? { OR: [{ number: { contains: p.q, mode: 'insensitive' } }, { referenceNumber: { contains: p.q, mode: 'insensitive' } }, { customer: { name: { contains: p.q, mode: 'insensitive' } } }, { lead: { name: { contains: p.q, mode: 'insensitive' } } }] } : {}),
    ...(qstr(req.query.status) ? { status: req.query.status as QuotationStatus } : {}),
    ...(qstr(req.query.customerId) ? { customerId: String(req.query.customerId) } : {}),
    ...(qstr(req.query.leadId) ? { leadId: String(req.query.leadId) } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.quotation.findMany({ where, orderBy: orderBy(p), skip: p.skip, take: p.pageSize, include: { customer: { select: { id: true, name: true, company: true } }, lead: { select: { id: true, name: true, company: true } } } }),
    prisma.quotation.count({ where }),
  ]);
  res.json(paged(items, total, p));
});

financeRouter.get('/quotations/next-number', requirePerm('quotations.create'), async (req, res) => {
  res.json({ number: await peekNumber(tid(req), 'QUOTATION') });
});

export async function peekNumber(tenantId: string, type: 'QUOTATION' | 'INVOICE' | 'PROFORMA') {
  const seq = await prisma.documentSequence.findUnique({ where: { tenantId_type: { tenantId, type } } });
  const prefix = seq?.prefix ?? DEFAULT_PREFIXES[type];
  return `${prefix}${String(seq?.next ?? 1).padStart(seq?.padding ?? 4, '0')}`;
}

financeRouter.post('/quotations', requirePerm('quotations.create'), async (req, res) => {
  const body = parse(quotationSchema, req.body);
  if (!body.customerId && !body.leadId) throw badRequest('Choose a customer or a lead');
  await assertTenantRefs(tid(req), { customer: body.customerId, lead: body.leadId, project: body.projectId, user: body.salespersonId });
  const q = await prisma.$transaction(async (tx) => {
    const d = await prepareDocument(tx, tid(req), body, { userId: req.user!.id, on: body.issueDate });
    const s = tenantSettings(d.tenant.settings);
    return tx.quotation.create({
      data: {
        tenantId: tid(req), number: await documentNumber(tx, tid(req), 'QUOTATION', body.number, 'quotation'),
        referenceNumber: body.referenceNumber, customerId: body.customerId, leadId: body.leadId, projectId: body.projectId,
        salespersonId: body.salespersonId ?? req.user!.id, subject: body.subject,
        issueDate: body.issueDate ?? new Date(),
        validUntil: body.validUntil === undefined ? new Date(Date.now() + s.documents.quotationValidityDays * 86_400_000) : body.validUntil,
        placeOfSupply: d.placeOfSupply, isInterState: d.isInterState, ...docFields(body), ...d.totals, ...d.money,
        notes: body.notes, terms: body.terms ?? s.documents.quotationTerms, createdById: req.user!.id,
        items: { create: d.lines.map(lineData) },
      },
    });
  });
  if (q.leadId) await prisma.activity.create({ data: { tenantId: tid(req), leadId: q.leadId, type: 'SYSTEM', subject: `Quotation ${q.number} created`, userId: req.user!.id } });
  await audit(req, { action: 'quotations.create', entityType: 'quotation', entityId: q.id, meta: { total: q.total } });
  res.status(201).json(q);
});

export async function getQuotation(req: Request, id: string) {
  const q = await prisma.quotation.findFirst({ where: { id, tenantId: tid(req) }, include: quoteInclude });
  if (!q) throw notFound('Quotation');
  return q;
}

financeRouter.get('/quotations/:id', requirePerm('quotations.read'), async (req, res) => {
  const q = await getQuotation(req, String(req.params.id));
  res.json({ ...q, salespersonName: await memberName(q.salespersonId) });
});

financeRouter.patch('/quotations/:id', requirePerm('quotations.create'), async (req, res) => {
  const q = await getQuotation(req, String(req.params.id));
  if (!QUOTE_EDITABLE.includes(q.status)) throw conflict('This quotation has been converted to an invoice. Edit the invoice instead.');
  const body = parse(quotationSchema, req.body);
  await assertTenantRefs(tid(req), { customer: body.customerId, lead: body.leadId, project: body.projectId, user: body.salespersonId });
  const updated = await prisma.$transaction(async (tx) => {
    const d = await prepareDocument(tx, tid(req), body, { current: q, userId: req.user!.id, on: body.issueDate ?? q.issueDate, existing: q.items });
    await tx.quotationItem.deleteMany({ where: { quotationId: q.id } });
    return tx.quotation.update({
      where: { id: q.id },
      data: {
        number: body.number && body.number !== q.number ? await documentNumber(tx, tid(req), 'QUOTATION', body.number, 'quotation', q.id) : q.number,
        referenceNumber: body.referenceNumber, customerId: body.customerId, leadId: body.leadId, projectId: body.projectId,
        salespersonId: body.salespersonId, subject: body.subject, issueDate: body.issueDate ?? q.issueDate, validUntil: body.validUntil,
        // Extending an expired quote's validity makes it live again.
        ...(q.status === 'EXPIRED' && body.validUntil && body.validUntil > new Date() ? { status: 'SENT' as const } : {}),
        placeOfSupply: d.placeOfSupply, isInterState: d.isInterState, ...docFields(body), ...d.totals, ...d.money, notes: body.notes, terms: body.terms,
        items: { create: d.lines.map(lineData) },
      },
    });
  });
  await audit(req, { action: 'quotations.update', entityType: 'quotation', entityId: q.id });
  res.json(updated);
});

export async function markQuotationSent(tenantId: string, q: { id: string; leadId: string | null; number: string; status: QuotationStatus }, userId: string) {
  if (q.status === 'DRAFT') await prisma.quotation.update({ where: { id: q.id }, data: { status: 'SENT', sentAt: new Date(), authorization: await authorizationSnapshot(tenantId, 'quote') } });
  if (q.leadId) {
    const lead = await prisma.lead.findUnique({ where: { id: q.leadId } });
    if (lead && !['WON', 'LOST', 'NEGOTIATION'].includes(lead.stage)) {
      await prisma.lead.update({ where: { id: q.leadId }, data: { stage: 'PROPOSAL_SENT', proposalStatus: 'Sent' } });
      await prisma.activity.create({ data: { tenantId, leadId: q.leadId, type: 'SYSTEM', subject: `Quotation ${q.number} sent`, userId } });
      await rescoreLead(tenantId, q.leadId);
    }
  }
}

financeRouter.post('/quotations/:id/status', requirePerm('quotations.send'), async (req, res) => {
  const q = await getQuotation(req, String(req.params.id));
  const body = parse(z.object({ status: z.enum(['SENT', 'ACCEPTED', 'REJECTED', 'DRAFT']) }), req.body);
  const allowed: Record<string, QuotationStatus[]> = { SENT: ['DRAFT', 'SENT'], ACCEPTED: ['SENT', 'DRAFT', 'REJECTED', 'EXPIRED'], REJECTED: ['SENT', 'DRAFT', 'ACCEPTED'], DRAFT: ['SENT', 'REJECTED', 'EXPIRED'] };
  if (!allowed[body.status].includes(q.status)) throw conflict(`Cannot mark a ${q.status.toLowerCase()} quotation as ${body.status.toLowerCase()}`);
  if (body.status === 'SENT') await markQuotationSent(tid(req), q, req.user!.id);
  else await prisma.quotation.update({ where: { id: q.id }, data: { status: body.status } });
  if (q.leadId && body.status !== 'SENT') {
    const lead = await prisma.lead.findUnique({ where: { id: q.leadId } });
    if (lead && !['WON', 'LOST'].includes(lead.stage)) {
      await prisma.lead.update({ where: { id: q.leadId }, data: body.status === 'ACCEPTED' ? { stage: 'NEGOTIATION', proposalStatus: 'Accepted' } : { proposalStatus: titleCase(body.status) } });
      await rescoreLead(tid(req), q.leadId);
    }
  }
  await audit(req, { action: `quotations.${body.status.toLowerCase()}`, entityType: 'quotation', entityId: q.id });
  res.json(await prisma.quotation.findUnique({ where: { id: q.id } }));
});

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

financeRouter.post('/quotations/:id/convert', requirePerm('quotations.convert'), requirePerm('invoices.create'), async (req, res) => {
  const q = await getQuotation(req, String(req.params.id));
  if (q.status === 'CONVERTED' || q.convertedInvoiceId) throw conflict('This quotation has already been converted');
  if (!['ACCEPTED', 'SENT', 'DRAFT'].includes(q.status)) throw conflict(`A ${q.status.toLowerCase()} quotation cannot be converted`);
  let customerId = q.customerId;
  if (!customerId && q.leadId) customerId = (await prisma.lead.findUnique({ where: { id: q.leadId } }))?.customerId ?? null;
  if (!customerId) throw badRequest('Convert the lead to a customer before invoicing this quotation');
  const invoice = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tid(req) } });
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: customerId! } });
    const s = tenantSettings(tenant.settings);
    const issueDate = new Date();
    const inv = await tx.invoice.create({
      data: {
        tenantId: tid(req), number: await nextNumber(tx, tid(req), 'INVOICE'), customerId: customerId!, quotationId: q.id, projectId: q.projectId,
        salespersonId: q.salespersonId, subject: q.subject, orderNumber: q.referenceNumber, status: 'DRAFT', issueDate,
        paymentTerms: customer.paymentTerms, dueDate: dueDateFor(customer.paymentTerms, issueDate) ?? new Date(issueDate.getTime() + s.documents.defaultDueDays * 86_400_000),
        placeOfSupply: q.placeOfSupply, isInterState: q.isInterState,
        subtotal: q.subtotal, discountType: q.discountType, discountValue: q.discountValue, discountTotal: q.discountTotal, taxableTotal: q.taxableTotal,
        cgstTotal: q.cgstTotal, sgstTotal: q.sgstTotal, igstTotal: q.igstTotal, ...taxTotals(q), withholdingType: q.withholdingType, withholdingRate: q.withholdingRate,
        withholdingAmount: q.withholdingAmount, adjustmentLabel: q.adjustmentLabel, adjustment: q.adjustment, roundOff: q.roundOff,
        total: q.total, balanceDue: q.total, notes: s.documents.invoiceNotes, terms: q.terms ?? s.documents.invoiceTerms, createdById: req.user!.id,
        currency: q.currency, exchangeRate: q.exchangeRate, // the invoice keeps the quote's currency and rate
        emailRecipients: customer.email ? [customer.email] : [],
        items: { create: q.items.map(({ id: _id, quotationId: _q, taxComponents, ...it }) => ({ ...it, taxComponents: taxComponents ?? undefined })) },
      },
    });
    await tx.quotation.update({ where: { id: q.id }, data: { status: 'CONVERTED', convertedInvoiceId: inv.id, customerId } });
    return inv;
  });
  await audit(req, { action: 'quotations.convert', entityType: 'quotation', entityId: q.id, meta: { invoiceId: invoice.id } });
  res.status(201).json(invoice);
});

financeRouter.post('/quotations/:id/clone', requirePerm('quotations.create'), async (req, res) => {
  const q = await getQuotation(req, String(req.params.id));
  const copy = await prisma.$transaction(async (tx) => tx.quotation.create({
    data: {
      tenantId: tid(req), number: await nextNumber(tx, tid(req), 'QUOTATION'), customerId: q.customerId, leadId: q.leadId, projectId: q.projectId,
      salespersonId: q.salespersonId, subject: q.subject, referenceNumber: q.referenceNumber, issueDate: new Date(), validUntil: q.validUntil && new Date(Date.now() + (q.validUntil.getTime() - q.issueDate.getTime())),
      placeOfSupply: q.placeOfSupply, isInterState: q.isInterState, subtotal: q.subtotal, discountType: q.discountType, discountValue: q.discountValue,
      discountTotal: q.discountTotal, taxableTotal: q.taxableTotal, cgstTotal: q.cgstTotal, sgstTotal: q.sgstTotal, igstTotal: q.igstTotal, ...taxTotals(q),
      withholdingType: q.withholdingType, withholdingRate: q.withholdingRate, withholdingAmount: q.withholdingAmount, adjustmentLabel: q.adjustmentLabel,
      adjustment: q.adjustment, roundOff: q.roundOff, total: q.total, currency: q.currency, exchangeRate: q.exchangeRate, notes: q.notes, terms: q.terms, createdById: req.user!.id,
      items: { create: q.items.map(({ id: _id, quotationId: _q, taxComponents, ...it }) => ({ ...it, taxComponents: taxComponents ?? undefined })) },
    },
  }));
  res.status(201).json(copy);
});

financeRouter.delete('/quotations/:id', requirePerm('quotations.create'), async (req, res) => {
  const q = await getQuotation(req, String(req.params.id));
  if (q.status === 'CONVERTED') throw conflict('Converted quotations cannot be deleted');
  await prisma.quotation.delete({ where: { id: q.id } });
  await audit(req, { action: 'quotations.delete', entityType: 'quotation', entityId: q.id, meta: { number: q.number } });
  res.json({ ok: true });
});

/** Currency, exchange-rate line and GST supply note shared by quote and invoice PDFs. */
export async function pdfMoney(tenant: { currency: string }, doc: { currency: string; exchangeRate: unknown; placeOfSupply: string | null; isInterState: boolean }, gstTreatment?: string | null) {
  const c = await currencyInfo(doc.currency);
  const rate = Number(doc.exchangeRate);
  const exchange: [string, string] | null = doc.currency !== tenant.currency ? ['Exchange Rate', `1 ${doc.currency} = ${rate.toLocaleString('en-IN', { maximumFractionDigits: 4 })} ${tenant.currency}`] : null;
  const zeroRated = !!gstTreatment && ZERO_RATED_TREATMENTS.includes(gstTreatment);
  const supplyNote = zeroRated ? (gstTreatment === 'SEZ' ? 'Supply to SEZ - zero rated (LUT)' : 'Export of services - zero rated (LUT)') : null;
  return { currency: { code: c.code, symbol: c.symbol, decimals: c.decimals, name: c.name }, exchange, supplyNote };
}

export async function quotationPdfDoc(tenantId: string, q: Awaited<ReturnType<typeof getQuotation>>): Promise<FinancialDoc> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const m = await pdfMoney(tenant, q, q.customer?.gstTreatment);
  return {
    title: 'QUOTE', number: q.number, issueDate: q.issueDate,
    meta: [['Reference#', q.referenceNumber], ['Project', q.project?.name], ...(m.exchange ? [m.exchange] : [])],
    subject: q.subject, seller: await sellerOf(tenant), buyer: buyerOf(q.customer, q.lead ?? undefined), shipTo: shipToOf(q.customer),
    placeOfSupply: q.placeOfSupply, isInterState: q.isInterState, supplyNote: m.supplyNote, currency: m.currency, items: q.items, totals: q, notes: q.notes, terms: q.terms,
    footer: tenantSettings(tenant.settings).documents.footer, watermark: q.status === 'DRAFT' ? 'DRAFT' : undefined,
    // Sent quotes use the authorization captured when they were sent; drafts show the current settings.
    authorization: await loadAuthorizationBlock(tenantId, 'quote', q.status === 'DRAFT' ? null : q.authorization),
  };
}

financeRouter.get('/quotations/:id/pdf', requirePerm('quotations.read'), async (req, res) => {
  await sendQuotationPdf(res, tid(req), await getQuotation(req, String(req.params.id)));
});

export async function sendQuotationPdf(res: Response, tenantId: string, q: Awaited<ReturnType<typeof getQuotation>>) {
  streamFinancialPdf(res, await quotationPdfDoc(tenantId, q), `${q.number}.pdf`);
}

// ───────────────────────── Invoices ─────────────────────────

const invoiceSchema = z.object({
  ...docBase,
  customerId: z.string(),
  orderNumber: opt(z.string().max(60)),
  paymentTerms: z.enum(Object.keys(PAYMENT_TERMS) as [string, ...string[]]).optional(),
  dueDate: z.coerce.date().optional().nullable(),
  emailRecipients: z.array(z.string().email()).max(20).optional(),
  /** Save and issue in one step (Save and Send). */
  issue: z.boolean().optional(),
});

/**
 * Derives an invoice's settled amounts and status from allocations, credit notes and write-offs.
 * Cancelled and draft invoices keep their status.
 */
export async function refreshInvoiceBalance(tx: Tx, invoiceId: string) {
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const [paid, credited] = await Promise.all([
    tx.paymentAllocation.aggregate({ where: { invoiceId }, _sum: { amount: true } }),
    tx.creditNote.aggregate({ where: { invoiceId, status: 'ISSUED' }, _sum: { total: true } }),
  ]);
  const amountPaid = money(paid._sum.amount);
  const creditedTotal = money(credited._sum.total);
  const writeOff = money(inv.writeOffAmount);
  const balanceDue = Math.max(0, money(Number(inv.total) - amountPaid - creditedTotal - writeOff));
  let status: InvoiceStatus = inv.status;
  if (!['DRAFT', 'CANCELLED'].includes(inv.status)) {
    if (writeOff > 0 && balanceDue <= 0) status = 'WRITTEN_OFF';
    else if (balanceDue <= 0) status = 'PAID';
    else if (inv.dueDate && inv.dueDate < new Date(new Date().toDateString())) status = 'OVERDUE';
    else if (amountPaid > 0 || creditedTotal > 0) status = 'PARTIALLY_PAID';
    else status = 'ISSUED';
  }
  return tx.invoice.update({ where: { id: invoiceId }, data: { amountPaid, creditedTotal, balanceDue, status } });
}

function invoiceWhere(req: Request): Prisma.InvoiceWhereInput {
  const q = req.query;
  const s = qstr(q.q);
  return {
    tenantId: tid(req),
    ...(s ? { OR: [{ number: { contains: s, mode: 'insensitive' } }, { orderNumber: { contains: s, mode: 'insensitive' } }, { customer: { name: { contains: s, mode: 'insensitive' } } }, { customer: { company: { contains: s, mode: 'insensitive' } } }] } : {}),
    ...(q.status === 'unpaid' ? { status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] } } : qstr(q.status) ? { status: q.status as InvoiceStatus } : {}),
    ...(qstr(q.customerId) ? { customerId: String(q.customerId) } : {}),
    ...(qstr(q.projectId) ? { projectId: String(q.projectId) } : {}),
    ...(qstr(q.recurringProfileId) ? { recurringProfileId: String(q.recurringProfileId) } : {}),
    ...(dateRange(q.from, q.to) ? { issueDate: dateRange(q.from, q.to) } : {}),
  };
}

financeRouter.get('/invoices', requirePerm('invoices.read'), async (req, res) => {
  const p = listParams(req, ['issueDate', 'createdAt', 'total', 'dueDate', 'number', 'balanceDue']);
  const where = invoiceWhere(req);
  if (req.query.format === 'csv') {
    const rows = await prisma.invoice.findMany({ where, include: { customer: { select: { name: true, gstin: true } } }, orderBy: { issueDate: 'asc' } });
    await audit(req, { action: 'invoices.export', meta: { count: rows.length } });
    res.type('text/csv').attachment('invoices.csv');
    return res.send(toCsv(rows.map((r) => ({ ...r, customer: r.customer.name, customerGstin: r.customer.gstin })) as never, [
      'number', 'issueDate', 'dueDate', 'status', 'customer', 'customerGstin', 'orderNumber', 'placeOfSupply', 'taxableTotal', 'cgstTotal', 'sgstTotal', 'igstTotal', 'withholdingAmount', 'total', 'amountPaid', 'creditedTotal', 'writeOffAmount', 'balanceDue',
    ]));
  }
  const [items, total, sums] = await Promise.all([
    prisma.invoice.findMany({ where, orderBy: orderBy(p), skip: p.skip, take: p.pageSize, include: { customer: { select: { id: true, name: true, company: true } } } }),
    prisma.invoice.count({ where }),
    // Summed in the database per exchange rate, so the list does not load every matching invoice.
    prisma.invoice.groupBy({ by: ['exchangeRate'], where: { ...where, status: { notIn: ['DRAFT', 'CANCELLED'] } }, _sum: { total: true, amountPaid: true, balanceDue: true } }),
  ]);
  // Totals across currencies are stated in the base currency.
  const sum = (k: 'total' | 'amountPaid' | 'balanceDue') => money(sums.reduce((acc, r) => acc + toBase(r._sum[k], r.exchangeRate), 0));
  res.json({ ...paged(items, total, p), sums: { total: sum('total'), amountPaid: sum('amountPaid'), balanceDue: sum('balanceDue') } });
});

financeRouter.get('/invoices/next-number', requirePerm('invoices.create'), async (req, res) => {
  res.json({ number: await peekNumber(tid(req), 'INVOICE') });
});

async function issueInvoice(tx: Tx, req: Request, invoiceId: string) {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tid(req) } });
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const missing = [!tenant.gstin && 'company GSTIN', !tenant.stateCode && 'company state code'].filter(Boolean);
  if (missing.length && Number(inv.cgstTotal) + Number(inv.sgstTotal) + Number(inv.igstTotal) > 0) {
    throw badRequest(`Complete your tax settings before issuing GST invoices: ${missing.join(', ')}`);
  }
  await tx.invoice.update({
    where: { id: invoiceId },
    data: { status: 'ISSUED', issuedAt: new Date(), number: inv.number ?? (await nextNumber(tx, tid(req), 'INVOICE')), authorization: await authorizationSnapshot(tid(req), 'invoice', tx) },
  });
  return refreshInvoiceBalance(tx, invoiceId);
}

financeRouter.post('/invoices', requirePerm('invoices.create'), async (req, res) => {
  const body = parse(invoiceSchema, req.body);
  await assertTenantRefs(tid(req), { customer: body.customerId, project: body.projectId, user: body.salespersonId });
  if (body.issue && !req.ctx!.permissions.has('invoices.issue')) throw badRequest('You can save drafts but not issue invoices');
  const inv = await prisma.$transaction(async (tx) => {
    const d = await prepareDocument(tx, tid(req), body, { userId: req.user!.id, on: body.issueDate });
    const s = tenantSettings(d.tenant.settings);
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: body.customerId } });
    const issueDate = body.issueDate ?? new Date();
    const terms = body.paymentTerms ?? customer.paymentTerms;
    const created = await tx.invoice.create({
      data: {
        tenantId: tid(req), number: await documentNumber(tx, tid(req), 'INVOICE', body.number, 'invoice'),
        customerId: body.customerId, projectId: body.projectId, orderNumber: body.orderNumber, salespersonId: body.salespersonId ?? req.user!.id,
        subject: body.subject, status: 'DRAFT', issueDate, paymentTerms: terms,
        dueDate: terms === 'CUSTOM' ? body.dueDate ?? issueDate : dueDateFor(terms, issueDate),
        placeOfSupply: d.placeOfSupply, isInterState: d.isInterState, ...docFields(body), ...d.totals, ...d.money, balanceDue: d.totals.total,
        emailRecipients: body.emailRecipients ?? (customer.email ? [customer.email] : []),
        notes: body.notes ?? s.documents.invoiceNotes, terms: body.terms ?? s.documents.invoiceTerms, createdById: req.user!.id,
        items: { create: d.lines.map(lineData) },
      },
    });
    return body.issue ? issueInvoice(tx, req, created.id) : created;
  });
  await audit(req, { action: body.issue ? 'invoices.create_issue' : 'invoices.create', entityType: 'invoice', entityId: inv.id, meta: { total: inv.total, number: inv.number } });
  res.status(201).json(inv);
});

const invoiceInclude = {
  items: { orderBy: { sortOrder: 'asc' } }, customer: { include: { contacts: { where: { email: { not: null } }, select: { id: true, name: true, email: true } } } },
  project: { select: { id: true, code: true, name: true } },
  allocations: { include: { payment: { select: { id: true, number: true, paidAt: true, method: true, reference: true, amount: true } } }, orderBy: { appliedAt: 'desc' } },
  creditNotes: { orderBy: { createdAt: 'desc' } }, recurringProfile: { select: { id: true, profileName: true } },
} satisfies Prisma.InvoiceInclude;

export async function getInvoice(req: Request, id: string) {
  const inv = await prisma.invoice.findFirst({ where: { id, tenantId: tid(req) }, include: invoiceInclude });
  if (!inv) throw notFound('Invoice');
  return inv;
}

financeRouter.get('/invoices/:id', requirePerm('invoices.read'), async (req, res) => {
  const inv = await getInvoice(req, String(req.params.id));
  const quotation = inv.quotationId ? await prisma.quotation.findUnique({ where: { id: inv.quotationId }, select: { id: true, number: true } }) : null;
  const proforma = inv.proformaInvoiceId ? await prisma.proformaInvoice.findFirst({ where: { id: inv.proformaInvoiceId, tenantId: tid(req) }, select: { id: true, number: true } }) : null;
  // `payments` kept for compatibility with older clients: one entry per allocation.
  const payments = inv.allocations.map((a) => ({ ...a.payment, amount: a.amount, allocationId: a.id }));
  res.json({ ...inv, payments, quotation, proforma, salespersonName: await memberName(inv.salespersonId) });
});

financeRouter.patch('/invoices/:id', requirePerm('invoices.create'), async (req, res) => {
  const inv = await getInvoice(req, String(req.params.id));
  if (inv.status === 'CANCELLED') throw conflict('Void invoices cannot be edited');
  if (Number(inv.writeOffAmount) > 0) throw conflict('Cancel the write-off before editing this invoice');
  const issued = inv.status !== 'DRAFT';
  const body = parse(invoiceSchema, req.body);
  await assertTenantRefs(tid(req), { customer: body.customerId, project: body.projectId, user: body.salespersonId });
  if (issued) {
    // Sent invoices can be corrected, but payments and credit notes already recorded must stay consistent.
    if (body.customerId !== inv.customerId && (inv.allocations.length || inv.creditNotes.some((n) => n.status === 'ISSUED'))) {
      throw conflict('Remove the payments and credit notes on this invoice before changing its customer');
    }
    if (inv.creditNotes.some((n) => n.status === 'ISSUED')) throw conflict('This invoice has credit notes. Cancel them before editing the invoice.');
  }
  const updated = await prisma.$transaction(async (tx) => {
    const d = await prepareDocument(tx, tid(req), body, { current: inv, userId: req.user!.id, on: body.issueDate ?? inv.issueDate, existing: inv.items });
    if (issued && d.money.currency !== inv.currency && (inv.allocations.length || inv.creditNotes.length)) {
      throw conflict('This invoice has payments or credit notes in ' + inv.currency + '. Remove them before changing its currency.');
    }
    if (issued && d.totals.total + 0.001 < money(Number(inv.amountPaid))) {
      throw conflict(`The new total (${d.money.currency} ${d.totals.total}) is less than the ${inv.currency} ${money(Number(inv.amountPaid))} already received. Remove a payment first.`);
    }
    await tx.invoiceItem.deleteMany({ where: { invoiceId: inv.id } });
    const issueDate = body.issueDate ?? inv.issueDate;
    const terms = body.paymentTerms ?? inv.paymentTerms;
    const saved = await tx.invoice.update({
      where: { id: inv.id },
      data: {
        number: body.number && body.number !== inv.number ? await documentNumber(tx, tid(req), 'INVOICE', body.number, 'invoice', inv.id) : inv.number,
        customerId: body.customerId, projectId: body.projectId, orderNumber: body.orderNumber, salespersonId: body.salespersonId, subject: body.subject,
        issueDate, paymentTerms: terms, dueDate: terms === 'CUSTOM' ? body.dueDate ?? issueDate : dueDateFor(terms, issueDate),
        placeOfSupply: d.placeOfSupply, isInterState: d.isInterState, ...docFields(body), ...d.totals, ...d.money, balanceDue: d.totals.total,
        emailRecipients: body.emailRecipients ?? inv.emailRecipients, notes: body.notes, terms: body.terms, items: { create: d.lines.map(lineData) },
      },
    });
    if (issued) return refreshInvoiceBalance(tx, saved.id);
    return body.issue ? issueInvoice(tx, req, saved.id) : saved;
  });
  await audit(req, { action: 'invoices.update', entityType: 'invoice', entityId: inv.id, meta: issued ? { status: inv.status, previousTotal: inv.total, total: updated.total } : undefined });
  res.json(updated);
});

financeRouter.post('/invoices/:id/issue', requirePerm('invoices.issue'), async (req, res) => {
  const inv = await getInvoice(req, String(req.params.id));
  if (inv.status !== 'DRAFT') throw conflict('Only draft invoices can be marked as sent');
  const issued = await prisma.$transaction((tx) => issueInvoice(tx, req, inv.id));
  await audit(req, { action: 'invoices.issue', entityType: 'invoice', entityId: inv.id, meta: { number: issued.number, total: issued.total } });
  res.json(issued);
});

financeRouter.post('/invoices/:id/void', requirePerm('invoices.cancel'), async (req, res) => {
  const inv = await getInvoice(req, String(req.params.id));
  const body = parse(z.object({ reason: z.string().trim().min(3).max(500) }), req.body);
  if (inv.status === 'CANCELLED') throw conflict('Invoice is already void');
  if (inv.allocations.length) throw conflict('This invoice has payments applied. Remove them or issue a credit note instead.');
  const updated = await prisma.invoice.update({ where: { id: inv.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: body.reason, balanceDue: 0 } });
  await prisma.timeEntry.updateMany({ where: { tenantId: tid(req), invoiceId: inv.id }, data: { invoiceId: null } });
  await prisma.expense.updateMany({ where: { tenantId: tid(req), invoiceId: inv.id }, data: { invoiceId: null } });
  await audit(req, { action: 'invoices.void', entityType: 'invoice', entityId: inv.id, meta: { reason: body.reason, number: inv.number } });
  res.json(updated);
});

// Backwards-compatible: cancel = delete draft, void otherwise.
financeRouter.post('/invoices/:id/cancel', requirePerm('invoices.cancel'), async (req, res) => {
  const inv = await getInvoice(req, String(req.params.id));
  const body = parse(z.object({ reason: z.string().trim().min(3).max(500) }), req.body);
  if (inv.status === 'CANCELLED') throw conflict('Invoice is already cancelled');
  if (inv.allocations.length) throw conflict('This invoice has payments recorded. Issue a credit note instead of cancelling.');
  if (inv.status === 'DRAFT') {
    await deleteDraftInvoice(req, inv);
    return res.json({ ok: true, deleted: true });
  }
  const updated = await prisma.invoice.update({ where: { id: inv.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: body.reason, balanceDue: 0 } });
  await audit(req, { action: 'invoices.cancel', entityType: 'invoice', entityId: inv.id, meta: { reason: body.reason, number: inv.number } });
  res.json(updated);
});

async function deleteDraftInvoice(req: Request, inv: Awaited<ReturnType<typeof getInvoice>>) {
  await prisma.$transaction(async (tx) => {
    await tx.timeEntry.updateMany({ where: { tenantId: tid(req), invoiceId: inv.id }, data: { invoiceId: null } });
    await tx.expense.updateMany({ where: { tenantId: tid(req), invoiceId: inv.id }, data: { invoiceId: null } });
    await tx.invoice.delete({ where: { id: inv.id } });
    if (inv.quotationId) await tx.quotation.update({ where: { id: inv.quotationId }, data: { status: 'ACCEPTED', convertedInvoiceId: null } });
    if (inv.proformaInvoiceId) {
      const pi = await tx.proformaInvoice.findUniqueOrThrow({ where: { id: inv.proformaInvoiceId } });
      await tx.proformaInvoice.update({ where: { id: pi.id }, data: { status: pi.acceptedAt ? 'ACCEPTED' : pi.sentAt ? 'SENT' : 'DRAFT', convertedInvoiceId: null, convertedAt: null, convertedById: null } });
    }
  });
  await audit(req, { action: inv.status === 'DRAFT' ? 'invoices.delete_draft' : 'invoices.delete', entityType: 'invoice', entityId: inv.id, meta: { number: inv.number, status: inv.status, total: inv.total } });
}

financeRouter.delete('/invoices/:id', requirePerm('invoices.cancel', 'invoices.create'), async (req, res) => {
  const inv = await getInvoice(req, String(req.params.id));
  if (inv.status !== 'DRAFT') {
    // Sent invoices can be deleted only while nothing depends on them.
    if (!req.ctx!.permissions.has('invoices.cancel')) throw forbidden('You can delete drafts but not sent invoices');
    if (inv.allocations.length) throw conflict('This invoice has payments applied. Remove them before deleting it.');
    if (inv.creditNotes.length) throw conflict('This invoice has credit notes and cannot be deleted. Void it instead.');
  }
  await deleteDraftInvoice(req, inv);
  res.json({ ok: true });
});

financeRouter.post('/invoices/:id/write-off', requirePerm('invoices.cancel'), async (req, res) => {
  const inv = await getInvoice(req, String(req.params.id));
  const body = parse(z.object({ reason: z.string().trim().max(500).optional() }), req.body ?? {});
  if (!['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'].includes(inv.status)) throw conflict('Only unpaid issued invoices can be written off');
  const updated = await prisma.$transaction(async (tx) => {
    await tx.invoice.update({ where: { id: inv.id }, data: { writeOffAmount: inv.balanceDue, writtenOffAt: new Date() } });
    return refreshInvoiceBalance(tx, inv.id);
  });
  await audit(req, { action: 'invoices.write_off', entityType: 'invoice', entityId: inv.id, meta: { amount: inv.balanceDue, reason: body.reason } });
  res.json(updated);
});

financeRouter.post('/invoices/:id/cancel-write-off', requirePerm('invoices.cancel'), async (req, res) => {
  const inv = await getInvoice(req, String(req.params.id));
  if (!Number(inv.writeOffAmount)) throw conflict('This invoice has not been written off');
  const updated = await prisma.$transaction(async (tx) => {
    await tx.invoice.update({ where: { id: inv.id }, data: { writeOffAmount: 0, writtenOffAt: null, status: 'ISSUED' } });
    return refreshInvoiceBalance(tx, inv.id);
  });
  await audit(req, { action: 'invoices.cancel_write_off', entityType: 'invoice', entityId: inv.id });
  res.json(updated);
});

financeRouter.post('/invoices/:id/clone', requirePerm('invoices.create'), async (req, res) => {
  const inv = await getInvoice(req, String(req.params.id));
  const copy = await prisma.$transaction(async (tx) => {
    const issueDate = new Date();
    return tx.invoice.create({
      data: {
        tenantId: tid(req), number: await nextNumber(tx, tid(req), 'INVOICE'), customerId: inv.customerId, projectId: inv.projectId, orderNumber: inv.orderNumber,
        salespersonId: inv.salespersonId, subject: inv.subject, status: 'DRAFT', issueDate, paymentTerms: inv.paymentTerms,
        dueDate: dueDateFor(inv.paymentTerms, issueDate) ?? issueDate, placeOfSupply: inv.placeOfSupply, isInterState: inv.isInterState,
        subtotal: inv.subtotal, discountType: inv.discountType, discountValue: inv.discountValue, discountTotal: inv.discountTotal, taxableTotal: inv.taxableTotal,
        cgstTotal: inv.cgstTotal, sgstTotal: inv.sgstTotal, igstTotal: inv.igstTotal, ...taxTotals(inv), withholdingType: inv.withholdingType, withholdingRate: inv.withholdingRate,
        withholdingAmount: inv.withholdingAmount, adjustmentLabel: inv.adjustmentLabel, adjustment: inv.adjustment, roundOff: inv.roundOff, total: inv.total,
        balanceDue: inv.total, currency: inv.currency, exchangeRate: inv.exchangeRate, emailRecipients: inv.emailRecipients, notes: inv.notes, terms: inv.terms, createdById: req.user!.id,
        items: { create: inv.items.map(({ id: _id, invoiceId: _i, taxComponents, ...it }) => ({ ...it, taxComponents: taxComponents ?? undefined })) },
      },
    });
  });
  res.status(201).json(copy);
});

// ───────────────────────── Explicit currency conversion ─────────────────────────
// Changing a document's currency in the editor never converts amounts. This action does, on request,
// with a stated rate: every price, amount discount and adjustment is multiplied by it and totals are recomputed.

const conversionSchema = z.object({
  to: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  /** Units of the target currency per 1 unit of the current currency. */
  rate: z.coerce.number().positive().max(1_000_000),
  rateDate: z.coerce.date().optional(),
  confirm: z.literal(true, { errorMap: () => ({ message: 'Confirm the conversion' }) }),
});

type ConvertibleDoc = {
  id: string; currency: string; exchangeRate: unknown; customerId: string | null; placeOfSupply: string | null;
  discountType: string; discountValue: unknown; withholdingType: string | null; withholdingRate: unknown; adjustment: unknown;
  items: Parameters<typeof savedLine>[0][];
};

async function convertDocument(req: Request, kind: 'invoice' | 'quotation', doc: ConvertibleDoc) {
  const body = parse(conversionSchema, req.body);
  if (body.to === doc.currency) throw badRequest(`The document is already in ${body.to}`);
  const scale = (v: unknown) => money(Number(v ?? 0) * body.rate);
  const items = doc.items.map((it) => ({ ...savedLine(it), rate: scale(it.rate), discountAmount: scale(it.discountAmount) }));
  return prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tid(req) }, select: { currency: true } });
    // The new currency's rate to base follows from the old one: base per new unit = base per old unit / rate.
    const exchangeRate = body.to === tenant.currency ? 1 : Number(doc.exchangeRate) / body.rate;
    const d = await prepareDocument(tx, tid(req), {
      customerId: doc.customerId, placeOfSupply: doc.placeOfSupply, items, currency: body.to, exchangeRate: body.to === tenant.currency ? null : exchangeRate,
      discountType: doc.discountType as 'PERCENT' | 'AMOUNT', discountValue: doc.discountType === 'AMOUNT' ? scale(doc.discountValue) : Number(doc.discountValue),
      withholdingType: doc.withholdingType as 'TDS' | 'TCS' | null, withholdingRate: Number(doc.withholdingRate), adjustment: scale(doc.adjustment),
    }, { userId: req.user!.id, trustSnapshots: true, existing: doc.items });
    // A foreign target's rate is recorded by prepareDocument; converting back to base records the source currency's rate.
    if (body.to === tenant.currency) {
      await tx.exchangeRate.create({ data: { tenantId: tid(req), currencyCode: doc.currency, baseCurrency: tenant.currency, rate: body.rate, rateDate: body.rateDate ?? new Date(), source: 'conversion', createdById: req.user!.id } });
    }
    const data = {
      ...d.totals, ...d.money, discountValue: doc.discountType === 'AMOUNT' ? scale(doc.discountValue) : Number(doc.discountValue), adjustment: d.totals.adjustment,
    };
    if (kind === 'invoice') {
      await tx.invoiceItem.deleteMany({ where: { invoiceId: doc.id } });
      return tx.invoice.update({ where: { id: doc.id }, data: { ...data, balanceDue: d.totals.total, items: { create: d.lines.map(lineData) } } });
    }
    await tx.quotationItem.deleteMany({ where: { quotationId: doc.id } });
    return tx.quotation.update({ where: { id: doc.id }, data: { ...data, items: { create: d.lines.map(lineData) } } });
  });
}

financeRouter.post('/invoices/:id/convert-currency', requirePerm('invoices.create'), async (req, res) => {
  const inv = await getInvoice(req, String(req.params.id));
  if (inv.status !== 'DRAFT') throw conflict('Only draft invoices can be converted. Sent invoices keep the amounts the customer received.');
  const updated = await convertDocument(req, 'invoice', inv);
  await audit(req, { action: 'invoices.convert_currency', entityType: 'invoice', entityId: inv.id, meta: { from: inv.currency, to: updated.currency, rate: req.body.rate, previousTotal: inv.total, total: updated.total } });
  res.json(updated);
});

financeRouter.post('/quotations/:id/convert-currency', requirePerm('quotations.create'), async (req, res) => {
  const q = await getQuotation(req, String(req.params.id));
  if (q.status === 'CONVERTED') throw conflict('This quote has been converted to an invoice');
  const updated = await convertDocument(req, 'quotation', q);
  await audit(req, { action: 'quotations.convert_currency', entityType: 'quotation', entityId: q.id, meta: { from: q.currency, to: updated.currency, rate: req.body.rate, previousTotal: q.total, total: updated.total } });
  res.json(updated);
});

export async function invoicePdfDoc(tenantId: string, inv: Awaited<ReturnType<typeof getInvoice>>): Promise<FinancialDoc> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const s = tenantSettings(tenant.settings);
  const m = await pdfMoney(tenant, inv, inv.customer.gstTreatment);
  return {
    title: 'TAX INVOICE', number: inv.number ?? 'DRAFT', issueDate: inv.issueDate,
    meta: [['Order Number', inv.orderNumber], ['Project', inv.project ? `${inv.project.code} ${inv.project.name}` : null], ...(m.exchange ? [m.exchange] : [])],
    subject: inv.subject, seller: await sellerOf(tenant), buyer: buyerOf(inv.customer), shipTo: shipToOf(inv.customer),
    placeOfSupply: inv.placeOfSupply, isInterState: inv.isInterState, supplyNote: m.supplyNote, currency: m.currency, items: inv.items, totals: inv,
    notes: inv.notes, paymentInstructions: s.documents.bankDetails || null,
    terms: inv.terms, footer: s.documents.footer,
    watermark: inv.status === 'CANCELLED' ? 'VOID' : inv.status === 'DRAFT' ? 'DRAFT' : inv.status === 'PAID' ? 'PAID' : undefined,
    // Issued invoices use the authorization frozen at issue; drafts preview the current settings.
    authorization: await loadAuthorizationBlock(tenantId, 'invoice', inv.status === 'DRAFT' ? null : inv.authorization),
  };
}

financeRouter.get('/invoices/:id/pdf', requirePerm('invoices.read'), async (req, res) => {
  await sendInvoicePdf(res, tid(req), await getInvoice(req, String(req.params.id)));
});

export async function sendInvoicePdf(res: Response, tenantId: string, inv: Awaited<ReturnType<typeof getInvoice>>) {
  streamFinancialPdf(res, await invoicePdfDoc(tenantId, inv), `${inv.number ?? 'draft-invoice'}.pdf`);
}

export async function invoicePdfBuffer(tenantId: string, inv: Awaited<ReturnType<typeof getInvoice>>) {
  return renderFinancialPdf(await invoicePdfDoc(tenantId, inv));
}
export async function quotationPdfBuffer(tenantId: string, q: Awaited<ReturnType<typeof getQuotation>>) {
  return renderFinancialPdf(await quotationPdfDoc(tenantId, q));
}

/** Creates a draft invoice from unbilled time entries and billable expenses. */
financeRouter.post('/invoices/from-unbilled', requirePerm('invoices.create'), async (req, res) => {
  const body = parse(z.object({ customerId: z.string(), projectId: z.string().optional().nullable(), timeEntryIds: z.array(z.string()).default([]), expenseIds: z.array(z.string()).default([]), taxRate: z.coerce.number().default(18) }), req.body);
  await assertTenantRefs(tid(req), { customer: body.customerId, project: body.projectId });
  if (!body.timeEntryIds.length && !body.expenseIds.length) throw badRequest('Select time entries or expenses to invoice');
  const [entries, expenses] = await Promise.all([
    prisma.timeEntry.findMany({ where: { tenantId: tid(req), id: { in: body.timeEntryIds }, invoiceId: null, billable: true, timerStartedAt: null }, include: { project: true } }),
    prisma.expense.findMany({ where: { tenantId: tid(req), id: { in: body.expenseIds }, invoiceId: null, billable: true, customerId: body.customerId }, include: { category: true } }),
  ]);
  const lines: LineInputBody[] = [];
  const byProject = new Map<string, { name: string; minutes: number; rate: number }>();
  for (const e of entries) {
    if (e.project.customerId !== body.customerId) throw badRequest('Time entries must belong to projects of this customer');
    const cur = byProject.get(e.projectId) ?? { name: e.project.name, minutes: 0, rate: Number(e.project.hourlyRate ?? 0) };
    cur.minutes += e.minutes;
    byProject.set(e.projectId, cur);
  }
  for (const [, p] of byProject) lines.push({ description: `${p.name} - time`, quantity: Math.round((p.minutes / 60) * 100) / 100, unit: 'hrs', rate: p.rate, taxRate: body.taxRate, hsnSac: '998314' });
  for (const x of expenses) lines.push({ description: `${x.category?.name ?? 'Expense'}${x.vendor ? ` - ${x.vendor}` : ''}${x.notes ? ` (${x.notes})` : ''}`, quantity: 1, rate: money(Number(x.amount) * (1 + Number(x.markupPct) / 100)), taxRate: GST_RATES.includes(Number(x.taxRate)) ? Number(x.taxRate) : 0 });
  if (!lines.length) throw badRequest('Nothing left to invoice');
  const inv = await prisma.$transaction(async (tx) => {
    // Time and expenses are recorded in the base currency, so the invoice is too.
    const base = (await tx.tenant.findUniqueOrThrow({ where: { id: tid(req) }, select: { currency: true } })).currency;
    const d = await prepareDocument(tx, tid(req), { customerId: body.customerId, items: lines, currency: base });
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: body.customerId } });
    const issueDate = new Date();
    const created = await tx.invoice.create({
      data: {
        tenantId: tid(req), number: await nextNumber(tx, tid(req), 'INVOICE'), customerId: body.customerId, projectId: body.projectId, status: 'DRAFT',
        issueDate, paymentTerms: customer.paymentTerms, dueDate: dueDateFor(customer.paymentTerms, issueDate) ?? issueDate, salespersonId: req.user!.id,
        placeOfSupply: d.placeOfSupply, isInterState: d.isInterState, ...d.totals, ...d.money, balanceDue: d.totals.total, createdById: req.user!.id,
        emailRecipients: customer.email ? [customer.email] : [], items: { create: d.lines.map(lineData) },
      },
    });
    await tx.timeEntry.updateMany({ where: { id: { in: entries.map((e) => e.id) } }, data: { invoiceId: created.id } });
    await tx.expense.updateMany({ where: { id: { in: expenses.map((e) => e.id) } }, data: { invoiceId: created.id } });
    return created;
  });
  await audit(req, { action: 'invoices.from_unbilled', entityType: 'invoice', entityId: inv.id, meta: { timeEntries: entries.length, expenses: expenses.length } });
  res.status(201).json(inv);
});

// ───────────────────────── Payments received ─────────────────────────

const allocationSchema = z.object({ invoiceId: z.string(), amount: z.coerce.number().positive() });
const paymentSchema = z.object({
  customerId: z.string().optional(),
  /** Legacy single-invoice form. */
  invoiceId: z.string().optional(),
  amount: z.coerce.number().positive(),
  bankCharges: z.coerce.number().min(0).optional(),
  taxDeducted: z.coerce.number().min(0).optional(),
  paidAt: z.coerce.date(),
  method: z.enum(['BANK_TRANSFER', 'UPI', 'CARD', 'CASH', 'CHEQUE', 'OTHER']),
  reference: opt(z.string().max(120)),
  notes: opt(z.string().max(2000)),
  allocations: z.array(allocationSchema).max(100).optional(),
  /** Defaults to the currency of the invoices paid. */
  currency: opt(z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/)),
  exchangeRate: opt(z.coerce.number().positive().max(1_000_000)),
});

/**
 * Locks invoice rows for the rest of the transaction (in id order, to avoid deadlocks), so concurrent payments
 * and credit notes against the same invoice are applied one after another and see each other's effect.
 */
export async function lockInvoices(tx: Tx, tenantId: string, ids: string[]) {
  const unique = [...new Set(ids)].sort();
  if (unique.length) await tx.$queryRaw`SELECT id FROM "Invoice" WHERE "tenantId" = ${tenantId} AND id = ANY(${unique}) ORDER BY id FOR UPDATE`;
}

/** Checks allocations; every invoice paid must be in the payment's currency. Returns that currency. */
async function applyAllocations(tx: Tx, tenantId: string, customerId: string, allocations: { invoiceId: string; amount: number }[], currency?: string) {
  let cur = currency;
  await lockInvoices(tx, tenantId, allocations.map((a) => a.invoiceId));
  // The same invoice listed twice must fit its balance in total.
  const perInvoice = new Map<string, number>();
  for (const a of allocations) perInvoice.set(a.invoiceId, money((perInvoice.get(a.invoiceId) ?? 0) + a.amount));
  for (const a of allocations) {
    const inv = await tx.invoice.findFirst({ where: { id: a.invoiceId, tenantId } });
    if (!inv) throw badRequest('Invalid invoice reference');
    if (inv.customerId !== customerId) throw badRequest(`Invoice ${inv.number} belongs to another customer`);
    if (!['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'].includes(inv.status)) throw conflict(`Invoice ${inv.number} is not open for payment`);
    cur ??= inv.currency;
    if (inv.currency !== cur) throw badRequest(`Invoice ${inv.number} is in ${inv.currency}; this payment is in ${cur}. Record a separate payment for each currency.`);
    if (perInvoice.get(a.invoiceId)! > money(inv.balanceDue) + 0.001) throw badRequest(`Amount for ${inv.number} exceeds its balance due (${inv.currency} ${money(inv.balanceDue)})`);
  }
  return cur;
}

const paymentInclude = {
  customer: { select: { id: true, name: true, company: true, email: true } },
  allocations: { include: { invoice: { select: { id: true, number: true, issueDate: true, total: true, balanceDue: true } } } },
  refunds: { orderBy: { refundedAt: 'desc' } },
} satisfies Prisma.PaymentInclude;

financeRouter.get('/payments', requirePerm('payments.read'), async (req, res) => {
  const p = listParams(req, ['paidAt', 'createdAt', 'amount']);
  const where: Prisma.PaymentWhereInput = {
    tenantId: tid(req),
    ...(p.q ? { OR: [{ number: { contains: p.q, mode: 'insensitive' } }, { reference: { contains: p.q, mode: 'insensitive' } }, { customer: { name: { contains: p.q, mode: 'insensitive' } } }, { allocations: { some: { invoice: { number: { contains: p.q, mode: 'insensitive' } } } } }] } : {}),
    ...(qstr(req.query.method) ? { method: String(req.query.method) } : {}),
    ...(qstr(req.query.customerId) ? { customerId: String(req.query.customerId) } : {}),
    ...(qstr(req.query.invoiceId) ? { allocations: { some: { invoiceId: String(req.query.invoiceId) } } } : {}),
    ...(req.query.unused === '1' ? { unusedAmount: { gt: 0 } } : {}),
  };
  const [items, total, sum] = await Promise.all([
    prisma.payment.findMany({ where, orderBy: orderBy(p), skip: p.skip, take: p.pageSize, include: { customer: { select: { id: true, name: true } }, allocations: { select: { invoice: { select: { id: true, number: true } } } } } }),
    prisma.payment.count({ where }),
    prisma.payment.groupBy({ by: ['exchangeRate'], where, _sum: { amount: true, unusedAmount: true } }).then((rows) => ({ _sum: {
      amount: money(rows.reduce((acc, r) => acc + toBase(r._sum.amount, r.exchangeRate), 0)),
      unusedAmount: money(rows.reduce((acc, r) => acc + toBase(r._sum.unusedAmount, r.exchangeRate), 0)),
    } })),
  ]);
  res.json({ ...paged(items.map((x) => ({ ...x, invoice: x.allocations[0] ? { ...x.allocations[0].invoice, customer: x.customer } : null, invoiceNumbers: x.allocations.map((a) => a.invoice.number).filter(Boolean) })), total, p), sum: sum._sum.amount, unused: sum._sum.unusedAmount });
});

financeRouter.get('/payments/next-number', requirePerm('payments.record'), async (req, res) => {
  const seq = await prisma.documentSequence.findUnique({ where: { tenantId_type: { tenantId: tid(req), type: 'PAYMENT' } } });
  res.json({ number: `${seq?.prefix ?? 'PAY-'}${String(seq?.next ?? 1).padStart(seq?.padding ?? 4, '0')}` });
});

financeRouter.get('/customers/:id/open-invoices', requirePerm('payments.record', 'invoices.read'), async (req, res) => {
  await assertTenantRefs(tid(req), { customer: String(req.params.id) });
  const [invoices, credits] = await Promise.all([
    prisma.invoice.findMany({
      where: { tenantId: tid(req), customerId: String(req.params.id), status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] } },
      orderBy: { issueDate: 'asc' }, select: { id: true, number: true, issueDate: true, dueDate: true, total: true, balanceDue: true, status: true, currency: true, exchangeRate: true },
    }),
    prisma.payment.aggregate({ where: { tenantId: tid(req), customerId: String(req.params.id) }, _sum: { unusedAmount: true } }),
  ]);
  res.json({ invoices, unusedCredits: money(credits._sum.unusedAmount) });
});

financeRouter.post('/payments', requirePerm('payments.record'), async (req, res) => {
  const body = parse(paymentSchema, req.body);
  let customerId = body.customerId;
  let allocations = body.allocations ?? [];
  if (body.invoiceId && !allocations.length) {
    const inv = await prisma.invoice.findFirst({ where: { id: body.invoiceId, tenantId: tid(req) } });
    if (!inv) throw notFound('Invoice');
    if (['DRAFT', 'CANCELLED'].includes(inv.status)) throw conflict('Payments can only be recorded against issued invoices');
    if (money(body.amount + (body.taxDeducted ?? 0)) > money(inv.balanceDue) + 0.001) throw badRequest(`Amount exceeds the balance due (${inv.currency} ${money(inv.balanceDue)})`);
    customerId = inv.customerId;
    allocations = [{ invoiceId: inv.id, amount: money(body.amount + (body.taxDeducted ?? 0)) }];
  }
  if (!customerId) throw badRequest('Choose a customer');
  await assertTenantRefs(tid(req), { customer: customerId });
  const applied = money(allocations.reduce((s, a) => s + a.amount, 0));
  const received = money(body.amount + (body.taxDeducted ?? 0));
  if (applied > received + 0.001) throw badRequest(`Amounts applied (${applied}) exceed the amount received (${received})`);
  const payment = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tid(req) } });
    const invoiceCurrency = await applyAllocations(tx, tid(req), customerId!, allocations, body.currency ?? undefined);
    const firstInvoice = allocations[0] ? await tx.invoice.findUniqueOrThrow({ where: { id: allocations[0].invoiceId }, select: { currency: true, exchangeRate: true } }) : undefined;
    // The invoice's currency is allowed even if it has since been switched off; its rate is the fallback.
    const cur = await resolveDocumentCurrency(tx, tenant, { currency: invoiceCurrency ?? tenant.defaultCurrency, exchangeRate: body.exchangeRate, current: firstInvoice }, req.user!.id);
    const pay = await tx.payment.create({
      data: {
        tenantId: tid(req), number: await nextNumber(tx, tid(req), 'PAYMENT'), customerId, invoiceId: allocations[0]?.invoiceId ?? null,
        currency: cur.currency, exchangeRate: cur.exchangeRate,
        amount: money(body.amount), bankCharges: money(body.bankCharges), taxDeducted: money(body.taxDeducted),
        unusedAmount: money(received - applied), paidAt: body.paidAt, method: body.method, reference: body.reference, notes: body.notes, recordedById: req.user!.id,
        allocations: { create: allocations.map((a) => ({ tenantId: tid(req), invoiceId: a.invoiceId, amount: money(a.amount) })) },
      },
    });
    for (const a of allocations) await refreshInvoiceBalance(tx, a.invoiceId);
    return pay;
  });
  await audit(req, { action: 'payments.record', entityType: 'payment', entityId: payment.id, meta: { amount: payment.amount, invoices: allocations.length, unused: payment.unusedAmount } });
  res.status(201).json(payment);
});

financeRouter.get('/payments/:id', requirePerm('payments.read'), async (req, res) => {
  const pay = await prisma.payment.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) }, include: paymentInclude });
  if (!pay) throw notFound('Payment');
  res.json(pay);
});

/** Applies a payment's unused credit to open invoices of the same customer. */
financeRouter.post('/payments/:id/apply', requirePerm('payments.record'), async (req, res) => {
  const body = parse(z.object({ allocations: z.array(allocationSchema).min(1).max(100) }), req.body);
  const pay = await prisma.payment.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) } });
  if (!pay || !pay.customerId) throw notFound('Payment');
  const total = money(body.allocations.reduce((s, a) => s + a.amount, 0));
  if (total > money(pay.unusedAmount) + 0.001) throw badRequest(`Only ${pay.currency} ${money(pay.unusedAmount)} of this payment is unused`);
  await prisma.$transaction(async (tx) => {
    await applyAllocations(tx, tid(req), pay.customerId!, body.allocations, pay.currency);
    await tx.paymentAllocation.createMany({ data: body.allocations.map((a) => ({ tenantId: tid(req), paymentId: pay.id, invoiceId: a.invoiceId, amount: money(a.amount) })) });
    // Conditional decrement: a concurrent apply or refund of the same credit cannot spend it twice.
    const spent = await tx.payment.updateMany({ where: { id: pay.id, unusedAmount: { gte: total } }, data: { unusedAmount: { decrement: total }, invoiceId: pay.invoiceId ?? body.allocations[0].invoiceId } });
    if (!spent.count) throw conflict('The unused amount on this payment changed meanwhile. Reload and try again.');
    for (const a of body.allocations) await refreshInvoiceBalance(tx, a.invoiceId);
  });
  await audit(req, { action: 'payments.apply_credit', entityType: 'payment', entityId: pay.id, meta: { amount: total } });
  res.json({ ok: true });
});

/** Removes one invoice allocation; the amount returns to the payment's unused credit. */
financeRouter.delete('/payments/:id/allocations/:allocationId', requirePerm('payments.record'), async (req, res) => {
  const alloc = await prisma.paymentAllocation.findFirst({ where: { id: String(req.params.allocationId), paymentId: String(req.params.id), tenantId: tid(req) } });
  if (!alloc) throw notFound('Allocation');
  await prisma.$transaction(async (tx) => {
    await tx.paymentAllocation.delete({ where: { id: alloc.id } });
    await tx.payment.update({ where: { id: alloc.paymentId }, data: { unusedAmount: { increment: alloc.amount } } });
    await refreshInvoiceBalance(tx, alloc.invoiceId);
  });
  await audit(req, { action: 'payments.unapply', entityType: 'payment', entityId: alloc.paymentId, meta: { invoiceId: alloc.invoiceId, amount: alloc.amount } });
  res.json({ ok: true });
});

financeRouter.post('/payments/:id/refund', requirePerm('payments.record'), async (req, res) => {
  const body = parse(z.object({ amount: z.coerce.number().positive(), refundedAt: z.coerce.date(), method: z.enum(['BANK_TRANSFER', 'UPI', 'CARD', 'CASH', 'CHEQUE', 'OTHER']), reference: opt(z.string().max(120)), notes: opt(z.string().max(1000)) }), req.body);
  const pay = await prisma.payment.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) } });
  if (!pay) throw notFound('Payment');
  if (money(body.amount) > money(pay.unusedAmount) + 0.001) throw badRequest(`Only the unused amount (${pay.currency} ${money(pay.unusedAmount)}) can be refunded`);
  const refund = await prisma.$transaction(async (tx) => {
    const r = await tx.paymentRefund.create({ data: { ...body, amount: money(body.amount), tenantId: tid(req), paymentId: pay.id, createdById: req.user!.id } });
    const spent = await tx.payment.updateMany({ where: { id: pay.id, unusedAmount: { gte: money(body.amount) } }, data: { unusedAmount: { decrement: money(body.amount) }, refundedAmount: { increment: money(body.amount) } } });
    if (!spent.count) throw conflict('The unused amount on this payment changed meanwhile. Reload and try again.');
    return r;
  });
  await audit(req, { action: 'payments.refund', entityType: 'payment', entityId: pay.id, meta: { amount: refund.amount } });
  res.status(201).json(refund);
});

/** Edits a payment's details. The amount can change as long as it still covers what is applied and refunded. */
financeRouter.patch('/payments/:id', requirePerm('payments.record'), async (req, res) => {
  const body = parse(z.object({
    amount: z.coerce.number().positive(), bankCharges: z.coerce.number().min(0).optional(), taxDeducted: z.coerce.number().min(0).optional(),
    paidAt: z.coerce.date(), method: z.enum(['BANK_TRANSFER', 'UPI', 'CARD', 'CASH', 'CHEQUE', 'OTHER']),
    reference: opt(z.string().max(120)), notes: opt(z.string().max(2000)),
    exchangeRate: opt(z.coerce.number().positive().max(1_000_000)),
  }), req.body);
  const pay = await prisma.payment.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) }, include: { allocations: true } });
  if (!pay) throw notFound('Payment');
  const applied = money(pay.allocations.reduce((s, a) => s + Number(a.amount), 0));
  const committed = money(applied + Number(pay.refundedAmount));
  const received = money(body.amount + (body.taxDeducted ?? 0));
  if (received + 0.001 < committed) throw conflict(`${pay.currency} ${committed} of this payment is already applied or refunded, so the amount cannot be lower than that`);
  const updated = await prisma.payment.update({
    where: { id: pay.id },
    data: {
      amount: money(body.amount), bankCharges: money(body.bankCharges), taxDeducted: money(body.taxDeducted), unusedAmount: money(received - committed),
      paidAt: body.paidAt, method: body.method, reference: body.reference ?? null, notes: body.notes ?? null,
      ...(body.exchangeRate && pay.exchangeRate.toNumber() !== 1 ? { exchangeRate: body.exchangeRate } : {}),
    },
  });
  await audit(req, { action: 'payments.update', entityType: 'payment', entityId: pay.id, meta: { previousAmount: pay.amount, amount: updated.amount } });
  res.json(updated);
});

financeRouter.delete('/payments/:id', requirePerm('payments.record'), async (req, res) => {
  const pay = await prisma.payment.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) }, include: { allocations: true, refunds: true } });
  if (!pay) throw notFound('Payment');
  if (pay.refunds.length) throw conflict('This payment has refunds recorded and cannot be deleted');
  await prisma.$transaction(async (tx) => {
    await tx.payment.delete({ where: { id: pay.id } });
    for (const a of pay.allocations) await refreshInvoiceBalance(tx, a.invoiceId);
  });
  await audit(req, { action: 'payments.reverse', entityType: 'payment', entityId: pay.id, meta: { amount: pay.amount, number: pay.number } });
  res.json({ ok: true });
});

// ───────────────────────── Credit notes ─────────────────────────

financeRouter.get('/credit-notes', requirePerm('invoices.read'), async (req, res) => {
  const p = listParams(req, ['issueDate', 'createdAt', 'total']);
  const where: Prisma.CreditNoteWhereInput = {
    tenantId: tid(req),
    ...(p.q ? { OR: [{ number: { contains: p.q, mode: 'insensitive' } }, { reason: { contains: p.q, mode: 'insensitive' } }, { invoice: { number: { contains: p.q, mode: 'insensitive' } } }] } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.creditNote.findMany({ where, orderBy: orderBy(p), skip: p.skip, take: p.pageSize, include: { invoice: { select: { id: true, number: true, customer: { select: { id: true, name: true } } } } } }),
    prisma.creditNote.count({ where }),
  ]);
  res.json(paged(items, total, p));
});

financeRouter.post('/credit-notes', requirePerm('creditnotes.create'), async (req, res) => {
  const body = parse(z.object({ invoiceId: z.string(), reason: z.string().trim().min(3).max(1000), taxableAmount: z.coerce.number().positive() }), req.body);
  const inv = await prisma.invoice.findFirst({ where: { id: body.invoiceId, tenantId: tid(req) } });
  if (!inv) throw notFound('Invoice');
  if (['DRAFT', 'CANCELLED'].includes(inv.status)) throw conflict('Credit notes can only be raised against issued invoices');
  // Pro-rate tax using the invoice's effective rates so the credit mirrors the original supply.
  const ratio = Number(inv.taxableTotal) ? body.taxableAmount / Number(inv.taxableTotal) : 0;
  const cgst = money(Number(inv.cgstTotal) * ratio);
  const sgst = money(Number(inv.sgstTotal) * ratio);
  const igst = money(Number(inv.igstTotal) * ratio);
  const cn = await prisma.$transaction(async (tx) => {
    await lockInvoices(tx, tid(req), [inv.id]);
    const alreadyCredited = await tx.creditNote.aggregate({ where: { invoiceId: inv.id, status: 'ISSUED' }, _sum: { taxableTotal: true } });
    const remaining = money(Number(inv.taxableTotal) - Number(alreadyCredited._sum.taxableTotal ?? 0));
    if (body.taxableAmount > remaining + 0.001) throw badRequest(`Credit cannot exceed the remaining taxable value (${inv.currency} ${remaining})`);
    const note = await tx.creditNote.create({
      data: {
        tenantId: tid(req), number: await nextNumber(tx, tid(req), 'CREDIT_NOTE'), invoiceId: inv.id, reason: body.reason, currency: inv.currency, exchangeRate: inv.exchangeRate,
        taxableTotal: money(body.taxableAmount), cgstTotal: cgst, sgstTotal: sgst, igstTotal: igst, total: money(body.taxableAmount + cgst + sgst + igst),
        createdById: req.user!.id,
      },
    });
    await refreshInvoiceBalance(tx, inv.id);
    return note;
  });
  await audit(req, { action: 'creditnotes.issue', entityType: 'credit_note', entityId: cn.id, meta: { invoiceId: inv.id, total: cn.total } });
  res.status(201).json(cn);
});

financeRouter.post('/credit-notes/:id/cancel', requirePerm('creditnotes.create'), async (req, res) => {
  const cn = await prisma.creditNote.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) } });
  if (!cn) throw notFound('Credit note');
  if (cn.status === 'CANCELLED') throw conflict('Already cancelled');
  await prisma.$transaction(async (tx) => {
    await tx.creditNote.update({ where: { id: cn.id }, data: { status: 'CANCELLED' } });
    await refreshInvoiceBalance(tx, cn.invoiceId);
  });
  await audit(req, { action: 'creditnotes.cancel', entityType: 'credit_note', entityId: cn.id });
  res.json({ ok: true });
});

financeRouter.delete('/credit-notes/:id', requirePerm('creditnotes.create'), async (req, res) => {
  const cn = await prisma.creditNote.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) } });
  if (!cn) throw notFound('Credit note');
  await prisma.$transaction(async (tx) => {
    await tx.creditNote.delete({ where: { id: cn.id } });
    await refreshInvoiceBalance(tx, cn.invoiceId);
  });
  await audit(req, { action: 'creditnotes.delete', entityType: 'credit_note', entityId: cn.id, meta: { number: cn.number, total: cn.total } });
  res.json({ ok: true });
});

financeRouter.get('/credit-notes/:id/pdf', requirePerm('invoices.read'), async (req, res) => {
  const cn = await prisma.creditNote.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) }, include: { invoice: { include: { customer: true } } } });
  if (!cn) throw notFound('Credit note');
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) } });
  const rate = Number(cn.taxableTotal) ? Math.round(((Number(cn.total) - Number(cn.taxableTotal)) / Number(cn.taxableTotal)) * 10000) / 100 : 0;
  const m = await pdfMoney(tenant, { ...cn.invoice, currency: cn.currency, exchangeRate: cn.exchangeRate }, cn.invoice.customer.gstTreatment);
  streamFinancialPdf(res, {
    title: 'CREDIT NOTE', number: cn.number, issueDate: cn.issueDate, reference: `Against invoice ${cn.invoice.number}`, meta: m.exchange ? [m.exchange] : [],
    currency: m.currency, supplyNote: m.supplyNote,
    seller: await sellerOf(tenant), buyer: buyerOf(cn.invoice.customer), placeOfSupply: cn.invoice.placeOfSupply, isInterState: cn.invoice.isInterState,
    items: [{ description: cn.reason, quantity: 1, rate: cn.taxableTotal, discountPct: 0, taxRate: rate, amount: cn.taxableTotal }],
    totals: { subtotal: cn.taxableTotal, discountTotal: 0, taxableTotal: cn.taxableTotal, cgstTotal: cn.cgstTotal, sgstTotal: cn.sgstTotal, igstTotal: cn.igstTotal, total: cn.total },
    footer: tenantSettings(tenant.settings).documents.footer, watermark: cn.status === 'CANCELLED' ? 'CANCELLED' : undefined,
  }, `${cn.number}.pdf`);
});
