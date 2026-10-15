import { describe, expect, it } from 'vitest';
import { computeDocument, isInterStateSupply } from '../src/lib/gst.js';
import { scoreLead } from '../src/lib/ai/scoring.js';
import { analyzeFeedback } from '../src/lib/ai/index.js';
import { amountInWords } from '../src/lib/pdf.js';
import { parseCsv, toCsv } from '../src/lib/list.js';
import { sanitizeServiceAnswers } from '../src/lib/feedbackForms.js';

describe('GST computation', () => {
  it('splits intra-state tax into CGST and SGST', () => {
    const { totals, lines } = computeDocument([{ description: 'Website', quantity: 1, rate: 85000, taxRate: 18 }], false);
    expect(totals.taxableTotal).toBe(85000);
    expect(totals.cgstTotal).toBe(7650);
    expect(totals.sgstTotal).toBe(7650);
    expect(totals.igstTotal).toBe(0);
    expect(totals.total).toBe(100300);
    expect(lines[0].amount).toBe(85000); // line amount is before tax, as shown on the document
    expect(lines[0].taxAmount).toBe(15300);
  });

  it('applies a document discount before tax, then TDS, adjustment and round-off', () => {
    const { totals } = computeDocument(
      [
        { description: 'A', quantity: 1, rate: 8000, taxRate: 18 },
        { description: 'B', quantity: 1, rate: 10000, taxRate: 18 },
      ],
      false,
      { discountType: 'PERCENT', discountValue: 10, withholdingType: 'TDS', withholdingRate: 2, adjustment: 0.4, roundOff: true },
    );
    expect(totals.subtotal).toBe(18000);
    expect(totals.discountTotal).toBe(1800);
    expect(totals.taxableTotal).toBe(16200);
    expect(totals.cgstTotal + totals.sgstTotal).toBe(2916);
    expect(totals.withholdingAmount).toBe(-324); // 2% of 16,200
    // 16200 + 2916 - 324 + 0.40 = 18792.40 -> rounds to 18792
    expect(totals.roundOff).toBe(-0.4);
    expect(totals.total).toBe(18792);
  });

  it('adds TCS on the tax-inclusive value and supports fixed-amount discounts', () => {
    const { totals } = computeDocument([{ description: 'A', quantity: 2, rate: 5000, taxRate: 18 }], true,
      { discountType: 'AMOUNT', discountValue: 1000, withholdingType: 'TCS', withholdingRate: 1 });
    expect(totals.taxableTotal).toBe(9000);
    expect(totals.igstTotal).toBe(1620);
    expect(totals.withholdingAmount).toBe(106.2);
    expect(totals.total).toBe(10726.2);
  });

  it('charges IGST for inter-state supply', () => {
    const { totals } = computeDocument([{ description: 'SEO', quantity: 3, rate: 20000, taxRate: 18 }], true);
    expect(totals.igstTotal).toBe(10800);
    expect(totals.cgstTotal + totals.sgstTotal).toBe(0);
    expect(totals.total).toBe(70800);
  });

  it('applies line discounts before tax and keeps paise exact', () => {
    const { totals } = computeDocument([
      { description: 'A', quantity: 3, rate: 333.33, discountPct: 10, taxRate: 18 },
      { description: 'B', quantity: 1.5, rate: 99.99, taxRate: 5 },
    ], false);
    // 3 x 333.33 = 999.99, less 10% (100.00) = 899.99; 1.5 x 99.99 = 149.99 (rounded)
    expect(totals.subtotal).toBe(1149.98);
    expect(totals.discountTotal).toBe(100);
    expect(totals.taxableTotal).toBe(1049.98);
    expect(Number((totals.taxableTotal + totals.cgstTotal + totals.sgstTotal).toFixed(2))).toBe(totals.total);
  });

  it('detects inter-state supply only when both state codes differ', () => {
    expect(isInterStateSupply('27', '29')).toBe(true);
    expect(isInterStateSupply('27', '27')).toBe(false);
    expect(isInterStateSupply('27', null)).toBe(false);
  });
});

describe('heuristic lead scoring', () => {
  const now = new Date('2026-10-15T00:00:00Z');
  it('scores an engaged, well-qualified lead higher than a cold one', () => {
    const hot = scoreLead(
      { email: 'a@b.c', phone: '1', company: 'X', serviceInterest: 'SEO', budgetRange: '5L', estimatedValue: 600000, expectedDecisionAt: new Date('2026-10-20'), lastContactAt: new Date('2026-10-14'), stage: 'NEGOTIATION', createdAt: now },
      [{ type: 'MEETING', occurredAt: new Date('2026-10-10'), completed: true }, { type: 'CALL', occurredAt: new Date('2026-10-12'), completed: true }],
      { now },
    );
    const cold = scoreLead({ stage: 'NEW', createdAt: now }, [], { now });
    expect(hot.score).toBeGreaterThan(70);
    expect(cold.score).toBeLessThan(20);
    expect(hot.model).toBe('heuristic-v1');
    expect(cold.missing).toContain('Email');
    expect(hot.factors.reduce((s, f) => s + f.points, 0)).toBeGreaterThan(0);
  });

  it('pins won and lost leads to 100 and 0', () => {
    expect(scoreLead({ stage: 'WON', createdAt: now }, [], { now }).score).toBe(100);
    expect(scoreLead({ stage: 'LOST', createdAt: now }, [], { now }).score).toBe(0);
  });

  it('recommends re-engagement for stale leads', () => {
    const r = scoreLead({ stage: 'QUALIFIED', lastContactAt: new Date('2026-09-01'), createdAt: now }, [], { now });
    expect(r.nextAction).toMatch(/Re-engage/);
  });
});

describe('feedback analysis', () => {
  it('flags urgent negative feedback', () => {
    const a = analyzeFeedback({ ratingOverall: 2, texts: ['Checkout is broken and payment failing'], urgentIssues: 'Site down' });
    expect(a.sentiment).toBe('negative');
    expect(a.isUrgent).toBe(true);
    expect(a.categories).toContain('Functionality');
  });
  it('treats "none" in urgent issues as not urgent', () => {
    const a = analyzeFeedback({ ratingOverall: 5, texts: ['Excellent work, very happy'], urgentIssues: 'None' });
    expect(a.sentiment).toBe('positive');
    expect(a.isUrgent).toBe(false);
  });
});

describe('helpers', () => {
  it('writes amounts in Indian words', () => {
    expect(amountInWords(100300)).toBe('Rupees One Lakh Three Hundred Only');
    expect(amountInWords(1250.5)).toBe('Rupees One Thousand Two Hundred Fifty and Fifty Paise Only');
  });
  it('round-trips CSV and neutralises formulas', () => {
    const csv = toCsv([{ a: 'x,y', b: '=SUM(1)' }], ['a', 'b']);
    expect(csv).toContain(`"x,y"`);
    expect(csv).toContain(`'=SUM(1)`);
    expect(parseCsv('name,email\n"Doe, J",j@x.in\n')).toEqual([{ name: 'Doe, J', email: 'j@x.in' }]);
  });
  it('drops unknown or invalid service answers', () => {
    expect(sanitizeServiceAnswers('eCommerce', { checkout: 4, payments: 'Yes', hacked: 'x', orders: 9 })).toEqual({ checkout: 4, payments: 'Yes' });
  });
});
