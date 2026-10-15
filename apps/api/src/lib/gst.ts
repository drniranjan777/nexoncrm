// GST computation in integer paise to avoid floating point drift.

export interface TaxComponent { name: string; rate: number }
/** Component split of a tax configuration: intra-state (place of supply in the company's state) and inter-state. */
export interface TaxComponents { intra: TaxComponent[]; inter: TaxComponent[] }

export interface LineInput {
  description: string;
  quantity: number;
  rate: number; // rupees
  discountPct?: number;
  /** Fixed discount for the whole line; takes precedence over discountPct when greater than zero. */
  discountAmount?: number;
  taxRate: number; // percent, e.g. 18
  /**
   * Components of the line's tax configuration. Without them the legacy GST rule applies:
   * CGST + SGST at half the rate each (intra-state) or IGST at the full rate (inter-state).
   */
  taxComponents?: TaxComponents | null;
  taxRateId?: string | null;
  taxName?: string | null;
  hsnSac?: string | null;
  unit?: string | null;
  productId?: string | null;
}

export interface LineResult extends LineInput {
  discountPct: number;
  discountAmount: number;
  taxable: number;
  taxAmount: number;
  amount: number;
  sortOrder: number;
}

/** One row of the tax summary: a component at a rate, with the value it was charged on. */
export type TaxBreakdownRow = { name: string; rate: number; taxable: number; amount: number };

export interface Totals {
  subtotal: number;
  /** Line discounts plus the document-level discount. */
  discountTotal: number;
  taxableTotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  /** Components other than CGST/SGST/IGST, such as cess. */
  otherTaxTotal: number;
  taxBreakdown: TaxBreakdownRow[];
  withholdingAmount: number;
  adjustment: number;
  roundOff: number;
  total: number;
}

/** CGST + SGST halves within the state, IGST across states. */
export const gstComponents = (rate: number): TaxComponents =>
  rate > 0 ? { intra: [{ name: 'CGST', rate: rate / 2 }, { name: 'SGST', rate: rate / 2 }], inter: [{ name: 'IGST', rate }] } : { intra: [], inter: [] };

export interface DocumentOptions {
  /** Document-level discount, applied before tax and spread over lines in proportion to their value. */
  discountType?: 'PERCENT' | 'AMOUNT';
  discountValue?: number;
  /** TDS is deducted by the customer from the payable total; TCS is collected on top of it. */
  withholdingType?: 'TDS' | 'TCS' | null;
  withholdingRate?: number;
  /** Free-form +/- adjustment (e.g. shipping, rounding agreed with the customer). */
  adjustment?: number;
  /** Round the payable total to the nearest whole unit of the currency (e.g. rupee). */
  roundOff?: boolean;
  /** Minor-unit digits of the document currency (0-2). Totals of 0-decimal currencies are rounded to whole units. */
  decimals?: number;
}

const toPaise = (rupees: number) => Math.round(rupees * 100);
const fromPaise = (paise: number) => paise / 100;

export function computeDocument(lines: LineInput[], isInterState: boolean, opts: DocumentOptions = {}): { lines: LineResult[]; totals: Totals } {
  // 1. Line values after line discounts.
  const base = lines.map((line) => {
    const gross = Math.round(line.quantity * toPaise(line.rate));
    const fixed = Math.max(0, line.discountAmount ?? 0);
    const discountPct = fixed > 0 ? 0 : line.discountPct ?? 0;
    const lineDiscount = fixed > 0 ? Math.min(toPaise(fixed), gross) : Math.round((gross * discountPct) / 100);
    return { line, gross, discountPct, discountAmount: fixed > 0 ? fromPaise(lineDiscount) : 0, lineDiscount, net: gross - lineDiscount };
  });
  const netSum = base.reduce((s, b) => s + b.net, 0);

  // 2. Document discount, allocated proportionally; the last line absorbs rounding remainders.
  const dv = Math.max(0, opts.discountValue ?? 0);
  let docDiscount = opts.discountType === 'AMOUNT' ? toPaise(dv) : Math.round((netSum * Math.min(dv, 100)) / 100);
  docDiscount = Math.min(docDiscount, netSum);
  let allocated = 0;
  const shares = base.map((b, i) => {
    if (i === base.length - 1) return docDiscount - allocated;
    const share = netSum ? Math.round((docDiscount * b.net) / netSum) : 0;
    allocated += share;
    return share;
  });

  // 3. Tax per line on the discounted value.
  let gross = 0, discount = docDiscount, taxable = 0, cgst = 0, sgst = 0, igst = 0, other = 0;
  const summary = new Map<string, { name: string; rate: number; taxable: number; amount: number }>();
  const charge = (name: string, rate: number, on: number, amount: number) => {
    const key = `${name}|${rate}`;
    const row = summary.get(key) ?? { name, rate, taxable: 0, amount: 0 };
    row.taxable += on;
    row.amount += amount;
    summary.set(key, row);
    if (name === 'CGST') cgst += amount;
    else if (name === 'SGST') sgst += amount;
    else if (name === 'IGST') igst += amount;
    else other += amount;
  };
  const results = base.map((b, i) => {
    const lineTaxable = b.net - shares[i];
    let lineTax = 0;
    if (b.line.taxComponents) {
      // Each component is rounded independently, as it appears on the document.
      for (const c of isInterState ? b.line.taxComponents.inter : b.line.taxComponents.intra) {
        const amount = Math.round((lineTaxable * c.rate) / 100);
        if (c.rate > 0) charge(c.name, c.rate, lineTaxable, amount);
        lineTax += amount;
      }
    } else if (isInterState) {
      lineTax = Math.round((lineTaxable * b.line.taxRate) / 100);
      if (b.line.taxRate > 0) charge('IGST', b.line.taxRate, lineTaxable, lineTax);
    } else {
      // Split evenly; each half is rounded independently as it appears on the invoice.
      const half = Math.round((lineTaxable * b.line.taxRate) / 200);
      if (b.line.taxRate > 0) {
        charge('CGST', b.line.taxRate / 2, lineTaxable, half);
        charge('SGST', b.line.taxRate / 2, lineTaxable, half);
      }
      lineTax = half * 2;
    }
    gross += b.gross;
    discount += b.lineDiscount;
    taxable += lineTaxable;
    return {
      ...b.line,
      discountPct: b.discountPct,
      discountAmount: b.discountAmount,
      // Shown on the line: value after the line's own discount (document discount is shown in totals).
      taxable: fromPaise(b.net),
      taxAmount: fromPaise(lineTax),
      amount: fromPaise(b.net),
      sortOrder: i,
    };
  });

  // 4. Withholding, adjustment and rounding.
  const tax = cgst + sgst + igst + other;
  const rate = Math.max(0, opts.withholdingRate ?? 0);
  let withholding = 0;
  if (opts.withholdingType === 'TDS') withholding = -Math.round((taxable * rate) / 100); // TDS is on value excluding GST
  if (opts.withholdingType === 'TCS') withholding = Math.round(((taxable + tax) * rate) / 100);
  const adjustment = toPaise(opts.adjustment ?? 0);
  const beforeRound = taxable + tax + withholding + adjustment;
  // Amounts are kept in hundredths; currencies with fewer decimals round the payable total to their smallest unit.
  const step = opts.roundOff ? 100 : 10 ** (2 - Math.min(2, Math.max(0, opts.decimals ?? 2)));
  const roundOff = step > 1 ? Math.round(beforeRound / step) * step - beforeRound : 0;

  return {
    lines: results,
    totals: {
      subtotal: fromPaise(gross),
      discountTotal: fromPaise(discount),
      taxableTotal: fromPaise(taxable),
      cgstTotal: fromPaise(cgst),
      sgstTotal: fromPaise(sgst),
      igstTotal: fromPaise(igst),
      otherTaxTotal: fromPaise(other),
      taxBreakdown: [...summary.values()].map((r) => ({ name: r.name, rate: r.rate, taxable: fromPaise(r.taxable), amount: fromPaise(r.amount) })),
      withholdingAmount: fromPaise(withholding),
      adjustment: fromPaise(adjustment),
      roundOff: fromPaise(roundOff),
      total: fromPaise(beforeRound + roundOff),
    },
  };
}

/** Payment terms as offered on customers, invoices and recurring profiles. */
export const PAYMENT_TERMS: Record<string, { label: string; days?: number; endOfMonth?: 0 | 1 }> = {
  DUE_ON_RECEIPT: { label: 'Due on Receipt', days: 0 },
  NET_15: { label: 'Net 15', days: 15 },
  NET_30: { label: 'Net 30', days: 30 },
  NET_45: { label: 'Net 45', days: 45 },
  NET_60: { label: 'Net 60', days: 60 },
  END_OF_MONTH: { label: 'Due end of the month', endOfMonth: 0 },
  END_OF_NEXT_MONTH: { label: 'Due end of next month', endOfMonth: 1 },
  CUSTOM: { label: 'Custom' },
};

export function dueDateFor(terms: string, issueDate: Date, custom?: Date | null): Date | null {
  const t = PAYMENT_TERMS[terms];
  if (!t || terms === 'CUSTOM') return custom ?? null;
  if (t.endOfMonth !== undefined) return new Date(issueDate.getFullYear(), issueDate.getMonth() + 1 + t.endOfMonth, 0);
  return new Date(issueDate.getTime() + (t.days ?? 0) * 86_400_000);
}

/** Two-digit state code from a GSTIN (first two characters). */
export const stateFromGstin = (gstin?: string | null) => (gstin && /^\d{2}/.test(gstin) ? gstin.slice(0, 2) : null);
/** PAN embedded in a GSTIN (characters 3–12). */
export const panFromGstin = (gstin?: string | null) => (gstin && gstin.length >= 12 ? gstin.slice(2, 12) : null);

/** Inter-state when both state codes are known and differ. Unknown place of supply defaults to intra-state. */
export function isInterStateSupply(tenantStateCode?: string | null, placeOfSupply?: string | null) {
  if (!tenantStateCode || !placeOfSupply) return false;
  return tenantStateCode.trim() !== placeOfSupply.trim();
}

export const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28];

export const INDIAN_STATES: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '96': 'Foreign Country', '97': 'Other Territory',
};

/** Structural GSTIN check (15 chars, state code prefix, PAN body). Does not verify the checksum with GSTN. */
export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
