import { Router, type Request } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { availableTaxRates, componentsFor, defaultComponents, taxRateSchema, taxRateUsage, TAX_TYPES } from '../lib/taxes.js';
import { requirePerm, tid } from '../middleware/tenant.js';
import { parse } from '../middleware/validate.js';
import { lineSchema, prepareDocument } from './finance.js';

// Settings → Finance Settings → Tax Settings. Documents copy a configuration's values onto each line, so changing
// or deactivating one here never alters documents already saved.
export const taxesRouter = Router();

const DOC_EDITORS = ['quotations.create', 'invoices.create', 'proforma.create', 'products.manage', 'settings.manage'] as const;

taxesRouter.get('/tax-rates/meta', requirePerm(...DOC_EDITORS), (_req, res) => {
  res.json({ taxTypes: Object.entries(TAX_TYPES).map(([code, label]) => ({ code, label, components: defaultComponents(code as keyof typeof TAX_TYPES, 18) })) });
});

/** All configurations, including inactive ones (Tax Settings page). */
taxesRouter.get('/tax-rates', requirePerm('settings.manage'), async (req, res) => {
  const rows = await prisma.taxRate.findMany({ where: { tenantId: tid(req) }, orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { rate: 'asc' }, { name: 'asc' }] });
  const usage = await Promise.all(rows.map((r) => taxRateUsage(tid(req), r.id)));
  res.json(rows.map((r, i) => ({ ...r, usage: usage[i] })));
});

/** Configurations selectable on new quotation, proforma and invoice lines. */
taxesRouter.get('/tax-rates/options', requirePerm(...DOC_EDITORS), async (req, res) => {
  const on = typeof req.query.date === 'string' && !Number.isNaN(Date.parse(req.query.date)) ? new Date(req.query.date) : new Date();
  const rows = await availableTaxRates(tid(req), on);
  res.json(rows.map((r) => ({ id: r.id, name: r.name, code: r.code, taxType: r.taxType, rate: r.rate, components: r.components })));
});

async function findRate(req: Request) {
  const r = await prisma.taxRate.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) } });
  if (!r) throw notFound('Tax');
  return r;
}

const duplicate = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

taxesRouter.post('/tax-rates', requirePerm('settings.manage'), async (req, res) => {
  const body = parse(taxRateSchema, req.body);
  try {
    const row = await prisma.taxRate.create({
      data: { ...body, tenantId: tid(req), components: componentsFor(body) as object, createdById: req.user!.id, effectiveFrom: body.effectiveFrom ?? new Date() },
    });
    await audit(req, { action: 'tax_rates.create', entityType: 'tax_rate', entityId: row.id, meta: { code: row.code, rate: row.rate, components: row.components } });
    res.status(201).json(row);
  } catch (e) {
    if (duplicate(e)) throw conflict(`A tax with code ${body.code} already exists`);
    throw e;
  }
});

taxesRouter.patch('/tax-rates/:id', requirePerm('settings.manage'), async (req, res) => {
  const current = await findRate(req);
  const patch = (req.body ?? {}) as Record<string, unknown>;
  // A new rate or type without an explicit split gets the default split for it.
  const resplit = !patch.components && ((patch.rate !== undefined && Number(patch.rate) !== Number(current.rate)) || (patch.taxType !== undefined && patch.taxType !== current.taxType));
  const merged = { ...current, rate: Number(current.rate), components: resplit ? undefined : current.components, ...patch };
  const body = parse(taxRateSchema, merged);
  const components = componentsFor(body);
  try {
    const row = await prisma.taxRate.update({ where: { id: current.id }, data: { ...body, components: components as object } });
    await audit(req, { action: 'tax_rates.update', entityType: 'tax_rate', entityId: row.id, meta: { before: { rate: current.rate, components: current.components, isActive: current.isActive }, after: { rate: row.rate, components: row.components, isActive: row.isActive } } });
    res.json(row);
  } catch (e) {
    if (duplicate(e)) throw conflict(`A tax with code ${body.code} already exists`);
    throw e;
  }
});

for (const [action, isActive] of [['activate', true], ['deactivate', false]] as const) {
  taxesRouter.post(`/tax-rates/:id/${action}`, requirePerm('settings.manage'), async (req, res) => {
    const r = await findRate(req);
    const row = await prisma.taxRate.update({ where: { id: r.id }, data: { isActive } });
    await audit(req, { action: `tax_rates.${action}`, entityType: 'tax_rate', entityId: r.id, meta: { code: r.code } });
    res.json(row);
  });
}

/** Deletes an unused configuration. One used by any document or recurring profile must be deactivated instead. */
taxesRouter.delete('/tax-rates/:id', requirePerm('settings.manage'), async (req, res) => {
  const r = await findRate(req);
  const used = await taxRateUsage(tid(req), r.id);
  if (used) throw conflict(`${r.name} is used on ${used} document line${used === 1 ? '' : 's'}. Deactivate it instead so those documents keep their tax.`);
  await prisma.taxRate.delete({ where: { id: r.id } });
  await audit(req, { action: 'tax_rates.delete', entityType: 'tax_rate', entityId: r.id, meta: { code: r.code, rate: r.rate } });
  res.json({ ok: true });
});

/**
 * Calculates lines and totals with the server's engine without saving anything: tax per line, the component
 * breakdown and the payable total, using the customer's place of supply and GST treatment.
 */
taxesRouter.post('/tax-rates/calculate', requirePerm(...DOC_EDITORS), async (req, res) => {
  const body = parse(z.object({
    customerId: z.string().optional().nullable(),
    placeOfSupply: z.string().regex(/^\d{2}$/).optional().nullable(),
    issueDate: z.coerce.date().optional(),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
    discountType: z.enum(['PERCENT', 'AMOUNT']).optional(),
    discountValue: z.coerce.number().min(0).optional(),
    adjustment: z.coerce.number().optional(),
    items: z.array(lineSchema).min(1).max(200),
  }), req.body);
  // The currency is passed as "current" so no exchange rate is recorded and no rate is required.
  const d = await prepareDocument(prisma as never, tid(req), { ...body, currency: undefined }, { on: body.issueDate, current: { currency: body.currency ?? (await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) }, select: { defaultCurrency: true } })).defaultCurrency, exchangeRate: 1 } });
  res.json({ placeOfSupply: d.placeOfSupply, isInterState: d.isInterState, zeroRated: d.zeroRated, lines: d.lines, totals: d.totals });
});
