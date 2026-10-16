import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Prisma, type ProformaStatus } from '@prisma/client';
import { prisma } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { dateRange, listParams, orderBy, paged, qstr } from '../lib/list.js';
import { nextNumber } from '../lib/numbering.js';
import { assertTenantRefs } from '../lib/tenantRefs.js';
import { dueDateFor, PAYMENT_TERMS } from '../lib/gst.js';
import { renderFinancialPdf, streamFinancialPdf, type FinancialDoc } from '../lib/pdf.js';
import { tenantSettings } from '../lib/tenants.js';
import { authorizationSnapshot, loadAuthorizationBlock } from '../lib/authorization.js';
import { requirePerm, tid } from '../middleware/tenant.js';
import { parse } from '../middleware/validate.js';
import {
  buyerOf, docBase, docFields, documentNumber, lineData, memberName, opt, pdfMoney, peekNumber, prepareDocument, savedLine, sellerOf, shipToOf,
} from './finance.js';

// Proforma invoices: a request for payment before supply. A proforma is never a tax invoice; converting it creates
// a draft invoice (with its own number from the invoice series) that then follows the normal invoicing workflow.
export const proformaRouter = Router();

const billToSchema = z.object({
  name: z.string().trim().min(1).max(160),
  company: opt(z.string().trim().max(200)),
  address: opt(z.string().trim().max(500)),
  city: opt(z.string().trim().max(80)),
  state: opt(z.string().trim().max(80)),
  stateCode: opt(z.string().regex(/^\d{2}$/)),
  postalCode: opt(z.string().trim().max(12)),
  gstin: opt(z.string().trim().toUpperCase().max(15)),
  email: opt(z.string().trim().email()),
  phone: opt(z.string().trim().max(40)),
});

const proformaSchema = z.object({
  ...docBase,
  customerId: z.string(),
  referenceNumber: opt(z.string().max(60)),
  serviceReference: opt(z.string().max(200)),
  validUntil: z.coerce.date().optional().nullable(),
  paymentTerms: z.enum(Object.keys(PAYMENT_TERMS) as [string, ...string[]]).optional(),
  emailRecipients: z.array(z.string().email()).max(20).optional(),
  /** Billing details for this document only; null uses the customer's record. */
  billTo: billToSchema.optional().nullable(),
});

const include = {
  items: { orderBy: { sortOrder: 'asc' } },
  customer: { include: { contacts: { where: { email: { not: null } }, select: { id: true, name: true, email: true } } } },
  project: { select: { id: true, code: true, name: true } },
} satisfies Prisma.ProformaInvoiceInclude;

export async function getProforma(req: Request, id: string) {
  const p = await prisma.proformaInvoice.findFirst({ where: { id, tenantId: tid(req) }, include });
  if (!p) throw notFound('Proforma invoice');
  return p;
}
type Proforma = Awaited<ReturnType<typeof getProforma>>;

const CONVERTIBLE: ProformaStatus[] = ['DRAFT', 'SENT', 'VIEWED', 'ACCEPTED', 'EXPIRED'];

// ── List ──

proformaRouter.get('/proforma-invoices', requirePerm('proforma.read'), async (req, res) => {
  const p = listParams(req, ['issueDate', 'createdAt', 'total', 'number', 'validUntil']);
  const from = qstr(req.query.from);
  const to = qstr(req.query.to);
  const where: Prisma.ProformaInvoiceWhereInput = {
    tenantId: tid(req),
    ...(p.q ? { OR: [
      { number: { contains: p.q, mode: 'insensitive' } }, { referenceNumber: { contains: p.q, mode: 'insensitive' } },
      { customer: { name: { contains: p.q, mode: 'insensitive' } } }, { customer: { company: { contains: p.q, mode: 'insensitive' } } },
    ] } : {}),
    ...(qstr(req.query.status) ? { status: req.query.status as ProformaStatus } : {}),
    ...(qstr(req.query.customerId) ? { customerId: String(req.query.customerId) } : {}),
    ...(qstr(req.query.currency) ? { currency: String(req.query.currency) } : {}),
    ...(dateRange(from, to) ? { issueDate: dateRange(from, to) } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.proformaInvoice.findMany({ where, orderBy: orderBy(p), skip: p.skip, take: p.pageSize, include: { customer: { select: { id: true, name: true, company: true } } } }),
    prisma.proformaInvoice.count({ where }),
  ]);
  res.json(paged(items, total, p));
});

proformaRouter.get('/proforma-invoices/next-number', requirePerm('proforma.create'), async (req, res) => {
  res.json({ number: await peekNumber(tid(req), 'PROFORMA') });
});

// ── Create / edit ──

async function checkRefs(req: Request, body: z.infer<typeof proformaSchema>) {
  await assertTenantRefs(tid(req), { customer: body.customerId, project: body.projectId, user: body.salespersonId });
}

proformaRouter.post('/proforma-invoices', requirePerm('proforma.create'), async (req, res) => {
  const body = parse(proformaSchema, req.body);
  await checkRefs(req, body);
  const created = await prisma.$transaction(async (tx) => {
    const issueDate = body.issueDate ?? new Date();
    const d = await prepareDocument(tx, tid(req), body, { userId: req.user!.id, on: issueDate });
    const s = tenantSettings(d.tenant.settings);
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: body.customerId } });
    return tx.proformaInvoice.create({
      data: {
        tenantId: tid(req), number: await documentNumber(tx, tid(req), 'PROFORMA', body.number), customerId: body.customerId,
        referenceNumber: body.referenceNumber, serviceReference: body.serviceReference, billTo: body.billTo ?? undefined,
        projectId: body.projectId, salespersonId: body.salespersonId ?? req.user!.id, subject: body.subject, status: 'DRAFT', issueDate,
        validUntil: body.validUntil === undefined ? new Date(issueDate.getTime() + s.documents.proformaValidityDays * 86_400_000) : body.validUntil,
        paymentTerms: body.paymentTerms ?? customer.paymentTerms, placeOfSupply: d.placeOfSupply, isInterState: d.isInterState,
        ...docFields(body), ...d.totals, ...d.money,
        emailRecipients: body.emailRecipients ?? (customer.email ? [customer.email] : []),
        notes: body.notes, terms: body.terms ?? s.documents.proformaTerms, createdById: req.user!.id,
        items: { create: d.lines.map(lineData) },
      },
    });
  });
  await audit(req, { action: 'proforma.create', entityType: 'proforma_invoice', entityId: created.id, meta: { number: created.number, total: created.total, currency: created.currency } });
  res.status(201).json(created);
});

proformaRouter.get('/proforma-invoices/:id', requirePerm('proforma.read'), async (req, res) => {
  const p = await getProforma(req, String(req.params.id));
  const invoice = p.convertedInvoiceId ? await prisma.invoice.findFirst({ where: { id: p.convertedInvoiceId, tenantId: tid(req) }, select: { id: true, number: true, status: true } }) : null;
  res.json({ ...p, convertedInvoice: invoice, salespersonName: await memberName(p.salespersonId) });
});

proformaRouter.patch('/proforma-invoices/:id', requirePerm('proforma.create'), async (req, res) => {
  const p = await getProforma(req, String(req.params.id));
  if (p.status !== 'DRAFT') throw conflict(`Only draft proforma invoices can be edited. This one is ${p.status.toLowerCase()}; duplicate it to make changes.`);
  const body = parse(proformaSchema, req.body);
  await checkRefs(req, body);
  const updated = await prisma.$transaction(async (tx) => {
    const issueDate = body.issueDate ?? p.issueDate;
    const d = await prepareDocument(tx, tid(req), body, { current: p, userId: req.user!.id, on: issueDate, existing: p.items });
    // Guard against a concurrent send/convert between the read above and this write.
    const claimed = await tx.proformaInvoice.updateMany({ where: { id: p.id, status: 'DRAFT' }, data: { updatedAt: new Date() } });
    if (!claimed.count) throw conflict('This proforma invoice is no longer a draft');
    await tx.proformaInvoiceItem.deleteMany({ where: { proformaInvoiceId: p.id } });
    return tx.proformaInvoice.update({
      where: { id: p.id },
      data: {
        number: body.number && body.number !== p.number ? await documentNumber(tx, tid(req), 'PROFORMA', body.number, undefined, p.id) : p.number,
        customerId: body.customerId, referenceNumber: body.referenceNumber, serviceReference: body.serviceReference,
        billTo: body.billTo === null ? Prisma.DbNull : body.billTo ?? undefined,
        projectId: body.projectId, salespersonId: body.salespersonId, subject: body.subject, issueDate, validUntil: body.validUntil,
        paymentTerms: body.paymentTerms ?? p.paymentTerms, placeOfSupply: d.placeOfSupply, isInterState: d.isInterState,
        ...docFields(body), ...d.totals, ...d.money, emailRecipients: body.emailRecipients ?? p.emailRecipients,
        notes: body.notes, terms: body.terms, items: { create: d.lines.map(lineData) },
      },
    });
  });
  await audit(req, { action: 'proforma.update', entityType: 'proforma_invoice', entityId: p.id, meta: { previousTotal: p.total, total: updated.total } });
  res.json(updated);
});

/** Copies a proforma into a new draft with the next number and today's date. Taxes are recalculated. */
proformaRouter.post('/proforma-invoices/:id/duplicate', requirePerm('proforma.create'), async (req, res) => {
  const p = await getProforma(req, String(req.params.id));
  const copy = await prisma.$transaction(async (tx) => {
    const issueDate = new Date();
    const d = await prepareDocument(tx, tid(req), {
      customerId: p.customerId, placeOfSupply: p.placeOfSupply, items: p.items.map(savedLine), currency: p.currency,
      discountType: p.discountType as 'PERCENT' | 'AMOUNT', discountValue: Number(p.discountValue), withholdingType: p.withholdingType as 'TDS' | 'TCS' | null,
      withholdingRate: Number(p.withholdingRate), adjustment: Number(p.adjustment),
    }, { current: p, userId: req.user!.id, on: issueDate, existing: p.items });
    const validity = p.validUntil ? p.validUntil.getTime() - p.issueDate.getTime() : tenantSettings(d.tenant.settings).documents.proformaValidityDays * 86_400_000;
    return tx.proformaInvoice.create({
      data: {
        tenantId: tid(req), number: await nextNumber(tx, tid(req), 'PROFORMA'), customerId: p.customerId, referenceNumber: p.referenceNumber,
        serviceReference: p.serviceReference, billTo: p.billTo ?? undefined, projectId: p.projectId, salespersonId: p.salespersonId, subject: p.subject,
        status: 'DRAFT', issueDate, validUntil: new Date(issueDate.getTime() + Math.max(0, validity)), paymentTerms: p.paymentTerms,
        placeOfSupply: d.placeOfSupply, isInterState: d.isInterState, discountType: p.discountType, discountValue: p.discountValue,
        withholdingType: p.withholdingType, withholdingRate: p.withholdingRate, adjustmentLabel: p.adjustmentLabel, ...d.totals, ...d.money,
        emailRecipients: p.emailRecipients, notes: p.notes, terms: p.terms, createdById: req.user!.id, items: { create: d.lines.map(lineData) },
      },
    });
  });
  await audit(req, { action: 'proforma.duplicate', entityType: 'proforma_invoice', entityId: copy.id, meta: { from: p.number, number: copy.number } });
  res.status(201).json(copy);
});

// ── Status changes ──

/** Marks a draft as sent and freezes the seal/signature shown on it. */
export async function markProformaSent(tenantId: string, p: { id: string; status: ProformaStatus }) {
  if (p.status !== 'DRAFT') return;
  await prisma.proformaInvoice.updateMany({
    where: { id: p.id, tenantId, status: 'DRAFT' },
    data: { status: 'SENT', sentAt: new Date(), authorization: await authorizationSnapshot(tenantId, 'invoice') },
  });
}

proformaRouter.post('/proforma-invoices/:id/status', requirePerm('proforma.send'), async (req, res) => {
  const p = await getProforma(req, String(req.params.id));
  const body = parse(z.object({ status: z.enum(['SENT', 'ACCEPTED', 'REJECTED']) }), req.body);
  const allowed: Record<typeof body.status, ProformaStatus[]> = {
    SENT: ['DRAFT'],
    ACCEPTED: ['DRAFT', 'SENT', 'VIEWED', 'REJECTED', 'EXPIRED'],
    REJECTED: ['DRAFT', 'SENT', 'VIEWED', 'ACCEPTED'],
  };
  if (!allowed[body.status].includes(p.status)) throw conflict(`A ${p.status.toLowerCase()} proforma invoice cannot be marked as ${body.status.toLowerCase()}`);
  if (body.status === 'SENT') await markProformaSent(tid(req), p);
  else {
    const r = await prisma.proformaInvoice.updateMany({
      where: { id: p.id, tenantId: tid(req), status: { in: allowed[body.status] } },
      data: { status: body.status, ...(body.status === 'ACCEPTED' ? { acceptedAt: new Date() } : {}), ...(p.status === 'DRAFT' ? { sentAt: p.sentAt ?? new Date(), authorization: await authorizationSnapshot(tid(req), 'invoice') } : {}) },
    });
    if (!r.count) throw conflict('This proforma invoice changed meanwhile. Reload and try again.');
  }
  await audit(req, { action: `proforma.${body.status.toLowerCase()}`, entityType: 'proforma_invoice', entityId: p.id, meta: { from: p.status } });
  res.json(await prisma.proformaInvoice.findUnique({ where: { id: p.id } }));
});

proformaRouter.post('/proforma-invoices/:id/cancel', requirePerm('proforma.create'), async (req, res) => {
  const p = await getProforma(req, String(req.params.id));
  const body = parse(z.object({ reason: z.string().trim().min(3).max(500) }), req.body);
  if (p.status === 'CONVERTED') throw conflict('A converted proforma invoice cannot be cancelled. Void or credit the invoice instead.');
  if (p.status === 'CANCELLED') throw conflict('Already cancelled');
  const r = await prisma.proformaInvoice.updateMany({ where: { id: p.id, tenantId: tid(req), status: { notIn: ['CONVERTED', 'CANCELLED'] } }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: body.reason } });
  if (!r.count) throw conflict('This proforma invoice changed meanwhile. Reload and try again.');
  await audit(req, { action: 'proforma.cancel', entityType: 'proforma_invoice', entityId: p.id, meta: { reason: body.reason, number: p.number } });
  res.json(await prisma.proformaInvoice.findUnique({ where: { id: p.id } }));
});

// ── Convert to invoice ──

/**
 * Creates a draft invoice from the proforma: same customer, lines, discounts, currency and tax selections,
 * recalculated by the invoice engine, numbered from the invoice series. No payment is recorded and the invoice is
 * not issued; it follows the normal invoicing workflow from here.
 */
proformaRouter.post('/proforma-invoices/:id/convert', requirePerm('proforma.convert'), requirePerm('invoices.create'), async (req, res) => {
  const p = await getProforma(req, String(req.params.id));
  if (p.status === 'CONVERTED' || p.convertedInvoiceId) throw conflict('This proforma invoice has already been converted to an invoice');
  if (!CONVERTIBLE.includes(p.status)) throw conflict(`A ${p.status.toLowerCase()} proforma invoice cannot be converted`);
  const invoice = await prisma.$transaction(async (tx) => {
    // Claim the proforma first: the row lock makes a concurrent second conversion wait, then find nothing to claim.
    const claimed = await tx.proformaInvoice.updateMany({
      where: { id: p.id, tenantId: tid(req), convertedInvoiceId: null, status: { in: CONVERTIBLE } },
      data: { status: 'CONVERTED', convertedAt: new Date(), convertedById: req.user!.id },
    });
    if (!claimed.count) throw conflict('This proforma invoice has already been converted to an invoice');
    const issueDate = new Date();
    const d = await prepareDocument(tx, tid(req), {
      customerId: p.customerId, placeOfSupply: p.placeOfSupply, items: p.items.map(savedLine), currency: p.currency,
      discountType: p.discountType as 'PERCENT' | 'AMOUNT', discountValue: Number(p.discountValue), withholdingType: p.withholdingType as 'TDS' | 'TCS' | null,
      withholdingRate: Number(p.withholdingRate), adjustment: Number(p.adjustment),
    }, { current: p, userId: req.user!.id, on: issueDate, existing: p.items, trustSnapshots: true });
    const s = tenantSettings(d.tenant.settings);
    const inv = await tx.invoice.create({
      data: {
        tenantId: tid(req), number: await nextNumber(tx, tid(req), 'INVOICE'), customerId: p.customerId, proformaInvoiceId: p.id, projectId: p.projectId,
        salespersonId: p.salespersonId, subject: p.subject, orderNumber: p.referenceNumber, status: 'DRAFT', issueDate, paymentTerms: p.paymentTerms,
        dueDate: dueDateFor(p.paymentTerms, issueDate) ?? new Date(issueDate.getTime() + s.documents.defaultDueDays * 86_400_000),
        placeOfSupply: d.placeOfSupply, isInterState: d.isInterState, discountType: p.discountType, discountValue: p.discountValue,
        withholdingType: p.withholdingType, withholdingRate: p.withholdingRate, adjustmentLabel: p.adjustmentLabel,
        ...d.totals, ...d.money, balanceDue: d.totals.total, emailRecipients: p.emailRecipients,
        // The proforma's terms describe a proforma; the invoice uses the invoice defaults.
        notes: p.notes ?? s.documents.invoiceNotes, terms: s.documents.invoiceTerms, createdById: req.user!.id,
        items: { create: d.lines.map(lineData) },
      },
    });
    await tx.proformaInvoice.update({ where: { id: p.id }, data: { convertedInvoiceId: inv.id } });
    return inv;
  });
  await audit(req, { action: 'proforma.convert', entityType: 'proforma_invoice', entityId: p.id, meta: { number: p.number, invoiceId: invoice.id, invoiceNumber: invoice.number, total: invoice.total, proformaTotal: p.total } });
  await audit(req, { action: 'invoices.create_from_proforma', entityType: 'invoice', entityId: invoice.id, meta: { proformaId: p.id, proformaNumber: p.number } });
  res.status(201).json(invoice);
});

// ── PDF ──

const NOT_A_TAX_INVOICE = 'This is a proforma invoice, issued to request payment or confirm an order. It is not a tax invoice and cannot be used to claim input tax credit. A tax invoice will be issued at the time of supply.';

export async function proformaPdfDoc(tenantId: string, p: Proforma): Promise<FinancialDoc> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const s = tenantSettings(tenant.settings);
  const m = await pdfMoney(tenant, p, p.customer.gstTreatment);
  const override = (p.billTo ?? null) as z.infer<typeof billToSchema> | null;
  return {
    title: 'PROFORMA INVOICE', numberLabel: 'Proforma Invoice No.', number: p.number, issueDate: p.issueDate,
    meta: [
      ['Client Ref / PO', p.referenceNumber],
      ['Project / Service', p.serviceReference ?? (p.project ? `${p.project.code} ${p.project.name}` : null)],
      ...(m.exchange ? [m.exchange] : []),
    ],
    subject: p.subject, seller: await sellerOf(tenant), buyer: override ? { ...override, company: override.company ?? override.name } : buyerOf(p.customer), shipTo: shipToOf(p.customer),
    placeOfSupply: p.placeOfSupply, isInterState: p.isInterState, supplyNote: m.supplyNote, currency: m.currency, items: p.items, totals: p,
    notice: NOT_A_TAX_INVOICE, notes: p.notes, paymentInstructions: s.documents.bankDetails || null, terms: p.terms, footer: s.documents.footer,
    watermark: p.status === 'DRAFT' ? 'DRAFT' : p.status === 'CANCELLED' ? 'CANCELLED' : undefined,
    // Sent proformas use the seal/signature frozen when sent; drafts preview the current invoice settings.
    authorization: await loadAuthorizationBlock(tenantId, 'invoice', p.status === 'DRAFT' ? null : p.authorization),
  };
}

export async function sendProformaPdf(res: Response, tenantId: string, p: Proforma) {
  streamFinancialPdf(res, await proformaPdfDoc(tenantId, p), `${p.number}.pdf`);
}
export async function proformaPdfBuffer(tenantId: string, p: Proforma) {
  return renderFinancialPdf(await proformaPdfDoc(tenantId, p));
}

proformaRouter.get('/proforma-invoices/:id/pdf', requirePerm('proforma.read'), async (req, res) => {
  await sendProformaPdf(res, tid(req), await getProforma(req, String(req.params.id)));
});

/** Email activity for the document: recipients, sender and what is known about delivery. */
proformaRouter.get('/proforma-invoices/:id/emails', requirePerm('proforma.read'), async (req, res) => {
  const p = await getProforma(req, String(req.params.id));
  const logs = await prisma.emailLog.findMany({ where: { tenantId: tid(req), entityType: 'proforma', entityId: p.id }, orderBy: { createdAt: 'desc' }, take: 50 });
  const senders = await prisma.user.findMany({ where: { id: { in: [...new Set(logs.map((l) => l.sentById).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
  res.json(logs.map((l) => ({ ...l, sentByName: senders.find((u) => u.id === l.sentById)?.name ?? null })));
});

