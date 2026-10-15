// Mirrors apps/api/src/lib/gst.ts for live previews. The server recomputes and is authoritative.
import type { TaxBreakdownRow, TaxComponents } from './types';

export interface Line {
  quantity: number; rate: number; discountPct: number; taxRate: number;
  /** Fixed discount for the whole line; used instead of discountPct when greater than zero. */
  discountAmount?: number;
  /** Components of the chosen tax configuration; without them CGST+SGST / IGST is derived from taxRate. */
  taxComponents?: TaxComponents | null;
}
export interface PreviewOptions {
  discountType?: 'PERCENT' | 'AMOUNT';
  discountValue?: number;
  withholdingType?: 'TDS' | 'TCS' | null;
  withholdingRate?: number;
  adjustment?: number;
  roundOff?: boolean;
  /** Minor-unit digits of the document currency (0-2). */
  decimals?: number;
}

export function previewTotals(lines: Line[], interState: boolean, opts: PreviewOptions = {}) {
  const base = lines.map((l) => {
    const gross = Math.round((l.quantity || 0) * Math.round((l.rate || 0) * 100));
    const fixed = Math.max(0, l.discountAmount || 0);
    const d = fixed > 0 ? Math.min(Math.round(fixed * 100), gross) : Math.round((gross * (l.discountPct || 0)) / 100);
    return { l, gross, d, net: gross - d };
  });
  const netSum = base.reduce((s, b) => s + b.net, 0);
  const dv = Math.max(0, opts.discountValue ?? 0);
  let docDiscount = opts.discountType === 'AMOUNT' ? Math.round(dv * 100) : Math.round((netSum * Math.min(dv, 100)) / 100);
  docDiscount = Math.min(docDiscount, netSum);
  let allocated = 0;
  const shares = base.map((b, i) => {
    if (i === base.length - 1) return docDiscount - allocated;
    const s = netSum ? Math.round((docDiscount * b.net) / netSum) : 0;
    allocated += s;
    return s;
  });
  let gross = 0, discount = docDiscount, taxable = 0, tax = 0;
  const summary = new Map<string, TaxBreakdownRow>();
  const charge = (name: string, rate: number, on: number, amount: number) => {
    const row = summary.get(`${name}|${rate}`) ?? { name, rate, taxable: 0, amount: 0 };
    row.taxable += on; row.amount += amount;
    summary.set(`${name}|${rate}`, row);
  };
  const amounts = base.map((b, i) => {
    const t = b.net - shares[i];
    let lineTax = 0;
    const rate = b.l.taxRate || 0;
    if (b.l.taxComponents) {
      for (const c of interState ? b.l.taxComponents.inter : b.l.taxComponents.intra) {
        const a = Math.round((t * c.rate) / 100);
        if (c.rate > 0) charge(c.name, c.rate, t, a);
        lineTax += a;
      }
    } else if (interState) {
      lineTax = Math.round((t * rate) / 100);
      if (rate > 0) charge('IGST', rate, t, lineTax);
    } else {
      const h = Math.round((t * rate) / 200);
      if (rate > 0) { charge('CGST', rate / 2, t, h); charge('SGST', rate / 2, t, h); }
      lineTax = h * 2;
    }
    tax += lineTax;
    gross += b.gross; discount += b.d; taxable += t;
    return b.net / 100;
  });
  const whRate = opts.withholdingRate ?? 0;
  let withholding = 0;
  if (opts.withholdingType === 'TDS') withholding = -Math.round((taxable * whRate) / 100);
  if (opts.withholdingType === 'TCS') withholding = Math.round(((taxable + tax) * whRate) / 100);
  const adjustment = Math.round((opts.adjustment ?? 0) * 100);
  const before = taxable + tax + withholding + adjustment;
  const step = opts.roundOff ? 100 : 10 ** (2 - Math.min(2, Math.max(0, opts.decimals ?? 2)));
  const roundOff = step > 1 ? Math.round(before / step) * step - before : 0;
  return {
    amounts,
    subtotal: (gross - (discount - docDiscount)) / 100, // after line discounts, as shown above the discount row
    lineDiscounts: (discount - docDiscount) / 100,
    docDiscount: docDiscount / 100,
    discountTotal: discount / 100,
    taxableTotal: taxable / 100,
    taxTotal: tax / 100,
    /** Tax by component and rate, e.g. CGST 9%, SGST 9%, IGST 18%. */
    breakdown: [...summary.values()].map((r) => ({ ...r, taxable: r.taxable / 100, amount: r.amount / 100 })),
    withholdingAmount: withholding / 100,
    adjustment: adjustment / 100,
    roundOff: roundOff / 100,
    total: (before + roundOff) / 100,
  };
}
