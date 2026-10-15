import { z } from 'zod';
import type { Prisma, TaxRate } from '@prisma/client';
import { prisma, type Tx } from './db.js';
import { badRequest } from './errors.js';
import { GST_RATES, gstComponents, type LineInput, type TaxComponents } from './gst.js';

// Tenant tax configurations. A document line stores the configuration's id together with a copy of its name, rate
// and components, so editing or deactivating a configuration never changes documents that were already saved.

export const TAX_TYPES = {
  GST: 'GST (CGST + SGST within the state, IGST across states)',
  IGST: 'IGST only',
  CUSTOM: 'Custom components',
  EXEMPT: 'Exempt',
  NIL_RATED: 'Nil rated',
  ZERO_RATED: 'Zero rated (export / SEZ)',
} as const;
export type TaxType = keyof typeof TAX_TYPES;
/** Types that never carry tax. */
export const ZERO_TYPES: TaxType[] = ['EXEMPT', 'NIL_RATED', 'ZERO_RATED'];

/** Default components for a type and rate; administrators may change them for GST and CUSTOM types. */
export function defaultComponents(type: TaxType, rate: number): TaxComponents {
  if (ZERO_TYPES.includes(type) || rate <= 0) return { intra: [], inter: [] };
  if (type === 'IGST') return { intra: [{ name: 'IGST', rate }], inter: [{ name: 'IGST', rate }] };
  if (type === 'CUSTOM') return { intra: [{ name: 'TAX', rate }], inter: [{ name: 'TAX', rate }] };
  return gstComponents(rate);
}

/** Seeded for new organizations (the migration seeds the same set for existing ones). */
export const DEFAULT_TAX_RATES: { name: string; code: string; taxType: TaxType; rate: number; description?: string; sortOrder: number }[] = [
  { name: 'GST 0%', code: 'GST0', taxType: 'GST', rate: 0, description: 'Nil-rated supplies', sortOrder: 10 },
  { name: 'GST 5%', code: 'GST5', taxType: 'GST', rate: 5, sortOrder: 20 },
  { name: 'GST 12%', code: 'GST12', taxType: 'GST', rate: 12, sortOrder: 30 },
  { name: 'GST 18%', code: 'GST18', taxType: 'GST', rate: 18, sortOrder: 40 },
  { name: 'GST 28%', code: 'GST28', taxType: 'GST', rate: 28, sortOrder: 50 },
  { name: 'Exempt', code: 'EXEMPT', taxType: 'EXEMPT', rate: 0, description: 'Exempt supplies', sortOrder: 90 },
];

export async function seedTaxRates(tenantId: string, tx: Tx = prisma) {
  await tx.taxRate.createMany({
    data: DEFAULT_TAX_RATES.map((t) => ({ ...t, tenantId, components: defaultComponents(t.taxType, t.rate) as object, effectiveFrom: new Date('2017-07-01') })),
    skipDuplicates: true,
  });
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const componentSchema = z.object({ name: z.string().trim().toUpperCase().min(1).max(20).regex(/^[A-Z0-9 _-]+$/, 'Use letters, digits, spaces, - or _'), rate: z.coerce.number().min(0).max(100) });

export const taxRateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().toUpperCase().min(1).max(20).regex(/^[A-Z0-9_-]+$/, 'Use letters, digits, - or _'),
  taxType: z.enum(Object.keys(TAX_TYPES) as [TaxType, ...TaxType[]]),
  rate: z.coerce.number().min(0).max(100),
  components: z.object({ intra: z.array(componentSchema).max(6), inter: z.array(componentSchema).max(6) }).optional(),
  jurisdiction: z.string().trim().toUpperCase().min(2).max(10).default('IN'),
  description: z.string().trim().max(500).optional().nullable(),
  isActive: z.boolean().optional(),
  effectiveFrom: z.coerce.date().optional(),
  effectiveUntil: z.coerce.date().optional().nullable(),
  sortOrder: z.coerce.number().int().min(0).max(10_000).optional(),
}).superRefine((t, ctx) => {
  if (ZERO_TYPES.includes(t.taxType) && t.rate !== 0) ctx.addIssue({ code: 'custom', path: ['rate'], message: `${TAX_TYPES[t.taxType]} must have a 0% rate` });
  if (t.effectiveFrom && t.effectiveUntil && t.effectiveUntil <= t.effectiveFrom) ctx.addIssue({ code: 'custom', path: ['effectiveUntil'], message: 'Must be after the effective-from date' });
  if (!t.components) return;
  for (const side of ['intra', 'inter'] as const) {
    const list = t.components[side];
    const sum = round2(list.reduce((s, c) => s + c.rate, 0));
    if (ZERO_TYPES.includes(t.taxType) ? list.length > 0 : sum !== round2(t.rate)) {
      ctx.addIssue({ code: 'custom', path: ['components', side], message: ZERO_TYPES.includes(t.taxType) ? 'A zero-rate tax has no components' : `${side === 'intra' ? 'Intra-state' : 'Inter-state'} components add up to ${sum}%, not ${t.rate}%` });
    }
    if (new Set(list.map((c) => c.name)).size !== list.length) ctx.addIssue({ code: 'custom', path: ['components', side], message: 'Each component may appear once' });
  }
});
export type TaxRateInput = z.infer<typeof taxRateSchema>;

/** Components to store for a saved configuration: the submitted split, or the default for its type. */
export const componentsFor = (t: Pick<TaxRateInput, 'taxType' | 'rate' | 'components'>): TaxComponents =>
  ZERO_TYPES.includes(t.taxType) ? { intra: [], inter: [] } : t.components ?? defaultComponents(t.taxType, t.rate);

export const isEffective = (t: Pick<TaxRate, 'isActive' | 'effectiveFrom' | 'effectiveUntil'>, on: Date) =>
  t.isActive && t.effectiveFrom <= on && (!t.effectiveUntil || t.effectiveUntil >= on);

/** Configurations offered on new document lines: active and in effect on the given date. */
export function availableTaxRates(tenantId: string, on = new Date()) {
  return prisma.taxRate.findMany({
    where: { tenantId, isActive: true, effectiveFrom: { lte: on }, OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: on } }] },
    orderBy: [{ sortOrder: 'asc' }, { rate: 'asc' }, { name: 'asc' }],
  });
}

export const asComponents = (v: Prisma.JsonValue | null | undefined): TaxComponents | null => {
  const c = v as { intra?: unknown; inter?: unknown } | null;
  return c && Array.isArray(c.intra) && Array.isArray(c.inter) ? (c as unknown as TaxComponents) : null;
};

/** A line as received from the API: either a configured tax (taxRateId) or a plain GST rate. */
export type LineRequest = Omit<LineInput, 'taxRate'> & { taxRate?: number | null };
/** A saved line's tax: kept as-is when its configuration is no longer available for new documents. */
export type TaxSnapshot = { taxRateId: string | null; taxRate: unknown; taxName: string | null; taxComponents: Prisma.JsonValue | null };

/**
 * Turns requested lines into calculable lines. Configured taxes must belong to the tenant and be in effect on
 * the document date; a configuration that is no longer available may stay on a line that already had it, with the
 * values frozen when it was saved. `trustSnapshots` keeps the saved values even for available configurations
 * (used when converting a document, so the new document carries exactly the tax that was agreed).
 * `allowUnavailable` accepts inactive configurations at their current values (recurring profiles agreed earlier).
 */
export async function resolveLineTaxes(tx: Tx, tenantId: string, lines: LineRequest[], opts: { on?: Date; existing?: TaxSnapshot[]; trustSnapshots?: boolean; allowUnavailable?: boolean } = {}): Promise<LineInput[]> {
  const ids = [...new Set(lines.map((l) => l.taxRateId).filter((x): x is string => !!x))];
  const configs = ids.length ? await tx.taxRate.findMany({ where: { tenantId, id: { in: ids } } }) : [];
  const saved = new Map((opts.existing ?? []).filter((s) => s.taxRateId).map((s) => [s.taxRateId!, s]));
  const on = opts.on ?? new Date();
  return lines.map((l) => {
    if (!l.taxRateId) {
      const rate = Number(l.taxRate ?? NaN);
      if (!GST_RATES.includes(rate)) throw badRequest('Choose a tax for every line', { fieldErrors: { items: ['Invalid tax'] } });
      return { ...l, taxRate: rate, taxRateId: null, taxName: null, taxComponents: null };
    }
    const cfg = configs.find((c) => c.id === l.taxRateId);
    if (!cfg) throw badRequest('Invalid tax reference', { fieldErrors: { items: ['Unknown tax'] } });
    const snap = (opts.trustSnapshots ? l : undefined)?.taxComponents ? { taxRate: l.taxRate, taxName: l.taxName, taxComponents: l.taxComponents } : undefined;
    const keep = snap ?? (!isEffective(cfg, on) ? saved.get(cfg.id) : undefined);
    if (keep) {
      return { ...l, taxRate: Number(keep.taxRate), taxRateId: cfg.id, taxName: keep.taxName ?? cfg.name, taxComponents: asComponents(keep.taxComponents as Prisma.JsonValue) ?? gstComponents(Number(keep.taxRate)) };
    }
    if (!isEffective(cfg, on) && !opts.allowUnavailable) throw badRequest(`${cfg.name} is not available for new documents`, { fieldErrors: { items: [`${cfg.name} is inactive or not in effect`] } });
    return { ...l, taxRate: Number(cfg.rate), taxRateId: cfg.id, taxName: cfg.name, taxComponents: asComponents(cfg.components) ?? gstComponents(Number(cfg.rate)) };
  });
}

/** Saved document lines and recurring profiles that use a configuration (such configurations are deactivated, not deleted). */
export async function taxRateUsage(tenantId: string, taxRateId: string, tx: Tx = prisma) {
  const [q, i, p, r] = await Promise.all([
    tx.quotationItem.count({ where: { taxRateId, quotation: { tenantId } } }),
    tx.invoiceItem.count({ where: { taxRateId, invoice: { tenantId } } }),
    tx.proformaInvoiceItem.count({ where: { taxRateId, proformaInvoice: { tenantId } } }),
    // Recurring profiles keep their lines as JSON.
    tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "RecurringProfile" WHERE "tenantId" = ${tenantId} AND "items"::text LIKE ${`%${taxRateId}%`}`.then((rows) => Number(rows[0]?.n ?? 0)),
  ]);
  return q + i + p + r;
}
