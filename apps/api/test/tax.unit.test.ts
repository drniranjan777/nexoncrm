import { describe, expect, it } from 'vitest';
import { computeDocument, gstComponents } from '../src/lib/gst.js';
import { defaultComponents, taxRateSchema } from '../src/lib/taxes.js';

// Configurable tax components, multiple rates per document and fixed line discounts.
describe('tax calculation with configured components', () => {
  it('gives the same result as the legacy GST rule for a GST configuration', () => {
    const lines = [{ description: 'A', quantity: 3, rate: 1234.56, discountPct: 7, taxRate: 18 }];
    for (const inter of [false, true]) {
      const legacy = computeDocument(lines, inter, { discountType: 'PERCENT', discountValue: 5 });
      const configured = computeDocument(lines.map((l) => ({ ...l, taxComponents: gstComponents(18) })), inter, { discountType: 'PERCENT', discountValue: 5 });
      expect(configured.totals).toEqual(legacy.totals);
    }
  });

  it('applies different rates per line and summarises tax by component and rate', () => {
    const { totals } = computeDocument([
      { description: 'Hosting', quantity: 1, rate: 10000, taxRate: 18, taxComponents: gstComponents(18) },
      { description: 'Books', quantity: 2, rate: 500, taxRate: 5, taxComponents: gstComponents(5) },
      { description: 'Exempt', quantity: 1, rate: 2000, taxRate: 0, taxComponents: { intra: [], inter: [] } },
    ], false);
    expect(totals.taxableTotal).toBe(13000);
    expect(totals.cgstTotal).toBe(900 + 25);
    expect(totals.sgstTotal).toBe(925);
    expect(totals.igstTotal).toBe(0);
    expect(totals.total).toBe(13000 + 1850);
    expect(totals.taxBreakdown).toEqual([
      { name: 'CGST', rate: 9, taxable: 10000, amount: 900 },
      { name: 'SGST', rate: 9, taxable: 10000, amount: 900 },
      { name: 'CGST', rate: 2.5, taxable: 1000, amount: 25 },
      { name: 'SGST', rate: 2.5, taxable: 1000, amount: 25 },
    ]);
  });

  it('uses inter-state components across states and keeps other components (cess) separate', () => {
    const cess = { intra: [{ name: 'CGST', rate: 14 }, { name: 'SGST', rate: 14 }, { name: 'CESS', rate: 12 }], inter: [{ name: 'IGST', rate: 28 }, { name: 'CESS', rate: 12 }] };
    const { totals } = computeDocument([{ description: 'Car', quantity: 1, rate: 100000, taxRate: 40, taxComponents: cess }], true);
    expect(totals.igstTotal).toBe(28000);
    expect(totals.otherTaxTotal).toBe(12000);
    expect(totals.cgstTotal + totals.sgstTotal).toBe(0);
    expect(totals.total).toBe(140000);
  });

  it('supports a fixed-amount line discount, capped at the line value', () => {
    const { lines, totals } = computeDocument([
      { description: 'A', quantity: 2, rate: 1000, discountAmount: 150, taxRate: 18 },
      { description: 'B', quantity: 1, rate: 100, discountAmount: 500, taxRate: 18 },
    ], true);
    expect(lines[0].amount).toBe(1850);
    expect(lines[0].discountAmount).toBe(150);
    expect(lines[0].discountPct).toBe(0);
    expect(lines[1].amount).toBe(0);
    expect(totals.discountTotal).toBe(250);
    expect(totals.igstTotal).toBe(333);
  });
});

describe('tax configuration validation', () => {
  const base = { name: 'GST 18%', code: 'gst18', taxType: 'GST' as const, rate: 18 };
  it('normalises the code and accepts the default split', () => {
    const r = taxRateSchema.safeParse({ ...base, components: defaultComponents('GST', 18) });
    expect(r.success).toBe(true);
    expect(r.success && r.data.code).toBe('GST18');
  });
  it('rejects components that do not add up to the rate', () => {
    expect(taxRateSchema.safeParse({ ...base, components: { intra: [{ name: 'CGST', rate: 9 }], inter: [{ name: 'IGST', rate: 18 }] } }).success).toBe(false);
  });
  it('rejects a non-zero exempt tax and an end date before the start', () => {
    expect(taxRateSchema.safeParse({ ...base, taxType: 'EXEMPT' }).success).toBe(false);
    expect(taxRateSchema.safeParse({ ...base, effectiveFrom: '2026-01-01', effectiveUntil: '2025-01-01' }).success).toBe(false);
  });
});
