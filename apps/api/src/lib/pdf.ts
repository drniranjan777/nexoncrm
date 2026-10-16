import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import type { Response } from 'express';
import { INDIAN_STATES } from './gst.js';
import type { AuthorizationBlock } from './authorization.js';

interface Party {
  name: string;
  company?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  stateCode?: string | null;
  postalCode?: string | null;
  gstin?: string | null;
  email?: string | null;
  phone?: string | null;
}

interface Item {
  description: string;
  hsnSac?: string | null;
  quantity: unknown;
  unit?: string | null;
  rate: unknown;
  discountPct: unknown;
  /** Fixed discount for the line, shown instead of the percentage. */
  discountAmount?: unknown;
  taxRate: unknown;
  taxAmount?: unknown;
  amount: unknown;
}

export interface PdfCurrency { code: string; symbol: string; decimals: number; name?: string }

export interface FinancialDoc {
  title: string;
  number: string;
  /** Label of the number row, e.g. "Proforma Invoice No.". */
  numberLabel?: string;
  issueDate: Date;
  /** Extra header rows, e.g. Reference#, Order number, Terms, Salesperson. */
  meta?: [string, string | null | undefined][];
  reference?: string;
  subject?: string | null;
  seller: Party & { pan?: string | null; brandColor?: string; logo?: Buffer | null };
  buyer: Party;
  shipTo?: Party | null;
  placeOfSupply?: string | null;
  isInterState: boolean;
  /** Shown under the place of supply instead of the IGST/CGST note, e.g. for exports. */
  supplyNote?: string | null;
  /** Document currency. Defaults to INR. */
  currency?: PdfCurrency;
  items: Item[];
  totals: {
    subtotal: unknown; discountTotal: unknown; taxableTotal: unknown;
    cgstTotal: unknown; sgstTotal: unknown; igstTotal: unknown; total: unknown;
    withholdingType?: string | null; withholdingRate?: unknown; withholdingAmount?: unknown;
    adjustmentLabel?: string | null; adjustment?: unknown; roundOff?: unknown;
    amountPaid?: unknown; creditedTotal?: unknown; writeOffAmount?: unknown; balanceDue?: unknown;
    /** Tax summary by component and rate; when present it replaces the CGST/SGST/IGST rows. */
    taxBreakdown?: unknown;
  };
  /** Highlighted statement under the totals, e.g. that a proforma invoice is not a tax invoice. */
  notice?: string | null;
  notes?: string | null;
  /** Bank / payment details, shown in their own section. */
  paymentInstructions?: string | null;
  terms?: string | null;
  footer?: string | null;
  watermark?: string;
  /** Company seal and authorized signature block; omitted entirely when null. */
  authorization?: AuthorizationBlock | null;
}

const INR: PdfCurrency = { code: 'INR', symbol: '₹', decimals: 2, name: 'Indian Rupee' };
const n = (v: unknown) => Number(v ?? 0);
const fmtDate = (d: Date) => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

// ── Fonts ──
// Bundled Noto Sans (assets/fonts, SIL OFL) covers ₹, $, £, € and the other Latin currency symbols; Noto Sans Arabic
// draws Arabic-script symbols such as د.إ. PDF_FONT_REGULAR / PDF_FONT_BOLD override the body font. If no Unicode
// font is found, Helvetica is used and symbols outside Latin-1 fall back to the ISO code.
const FONT_DIR = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));
const fontPair = (regular?: string, bold = regular) =>
  regular && bold && fs.existsSync(regular) && fs.existsSync(bold) ? { regular, bold } : null;
const unicodeFont = fontPair(process.env.PDF_FONT_REGULAR, process.env.PDF_FONT_BOLD ?? process.env.PDF_FONT_REGULAR)
  ?? fontPair(path.join(FONT_DIR, 'NotoSans-Regular.ttf'), path.join(FONT_DIR, 'NotoSans-Bold.ttf'));
const arabicFont = fontPair(path.join(FONT_DIR, 'NotoSansArabic-Regular.ttf'), path.join(FONT_DIR, 'NotoSansArabic-Bold.ttf'));
const F = unicodeFont ? { regular: 'Body', bold: 'Body-Bold' } : { regular: 'Helvetica', bold: 'Helvetica-Bold' };
/** A4 document; pages are buffered so the footer can be stamped on each page at the end. */
function newPdf() {
  const pdf = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  if (unicodeFont) {
    pdf.registerFont('Body', unicodeFont.regular);
    pdf.registerFont('Body-Bold', unicodeFont.bold);
  }
  if (arabicFont) {
    pdf.registerFont('Arabic', arabicFont.regular);
    pdf.registerFont('Arabic-Bold', arabicFont.bold);
  }
  return pdf;
}
const LATIN1 = /^[\x20-\x7E -ÿ€]*$/;
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
/** Arabic-script symbols are drawn as a separate run in the Arabic font (pdfkit has no font fallback). */
const arabicSymbol = (c: PdfCurrency) => Boolean(arabicFont && unicodeFont && ARABIC.test(c.symbol));
/** Symbol the body font can draw, or the ISO code with a space. */
const printableSymbol = (c: PdfCurrency) =>
  LATIN1.test(c.symbol) || (unicodeFont && !ARABIC.test(c.symbol)) ? c.symbol : `${c.code} `;

/** Number with the currency's grouping and decimals (Indian grouping for INR). */
export function formatAmount(v: unknown, c: PdfCurrency = INR) {
  const digits = Math.min(2, Math.max(0, c.decimals));
  return n(v).toLocaleString(c.code === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
const withSymbol = (v: unknown, c: PdfCurrency) => `${n(v) < 0 ? '-' : ''}${printableSymbol(c)}${formatAmount(Math.abs(n(v)), c)}`;

/** Right-aligned amount with its currency symbol, in the current fill colour. */
function moneyText(pdf: PDFKit.PDFDocument, v: unknown, c: PdfCurrency, x: number, y: number, width: number, bold: boolean, size: number) {
  const body = bold ? F.bold : F.regular;
  if (!arabicSymbol(c)) {
    pdf.font(body).fontSize(size).text(withSymbol(v, c), x, y, { width, align: 'right' });
    return;
  }
  // "د.إ 1,234.00": fontkit shapes the Arabic run and lays it out right-to-left on its own.
  const sym = bold ? 'Arabic-Bold' : 'Arabic';
  const num = ` ${formatAmount(Math.abs(n(v)), c)}`;
  const sign = n(v) < 0 ? '-' : '';
  const signW = pdf.font(body).fontSize(size).widthOfString(sign);
  const numW = pdf.widthOfString(num);
  const symW = pdf.font(sym).fontSize(size).widthOfString(c.symbol);
  let cx = x + width - signW - symW - numW;
  // pdfkit places the baseline at y + ascender, so shift the Arabic run onto the body font's baseline.
  const ascender = (font: string) => (pdf.font(font) as unknown as { _font: { ascender: number } })._font.ascender / 1000 * size;
  const bodyAsc = ascender(body);
  const symAsc = ascender(sym);
  if (sign) { pdf.font(body).fontSize(size).text(sign, cx, y, { lineBreak: false }); cx += signW; }
  pdf.font(sym).fontSize(size).text(c.symbol, cx, y + bodyAsc - symAsc, { lineBreak: false });
  pdf.font(body).fontSize(size).text(num, cx + symW, y, { lineBreak: false });
}

// ── Amount in words ──
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = (x: number) => (x < 20 ? ONES[x] : `${TENS[Math.floor(x / 10)]}${x % 10 ? ' ' + ONES[x % 10] : ''}`);
const three = (x: number) => (x >= 100 ? `${ONES[Math.floor(x / 100)]} Hundred${x % 100 ? ' ' + two(x % 100) : ''}` : two(x));

function indianWords(x: number): string {
  if (x === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(x / 1e7); x %= 1e7;
  const lakh = Math.floor(x / 1e5); x %= 1e5;
  const thousand = Math.floor(x / 1e3); x %= 1e3;
  if (crore) parts.push(`${indianWords(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (x) parts.push(three(x));
  return parts.join(' ');
}

function internationalWords(x: number): string {
  if (x === 0) return 'Zero';
  const scales = ['', ' Thousand', ' Million', ' Billion', ' Trillion'];
  const parts: string[] = [];
  for (let i = 0; x > 0 && i < scales.length; i++, x = Math.floor(x / 1000)) {
    const chunk = x % 1000;
    if (chunk) parts.unshift(`${three(chunk)}${scales[i]}`);
  }
  return parts.join(' ');
}

const UNIT_NAMES: Record<string, [string, string]> = {
  INR: ['Rupees', 'Paise'], USD: ['US Dollars', 'Cents'], GBP: ['Pounds Sterling', 'Pence'], EUR: ['Euros', 'Cents'],
  AUD: ['Australian Dollars', 'Cents'], AED: ['UAE Dirhams', 'Fils'], CAD: ['Canadian Dollars', 'Cents'], SGD: ['Singapore Dollars', 'Cents'],
};

export function amountInWords(amount: number, c: PdfCurrency = INR): string {
  const [major, minor] = UNIT_NAMES[c.code] ?? [c.name ?? c.code, 'Cents'];
  const sign = amount < 0 ? 'Minus ' : '';
  amount = Math.abs(amount);
  const whole = Math.floor(amount);
  const fraction = c.decimals > 0 ? Math.round((amount - whole) * 100) : 0;
  const words = c.code === 'INR' ? indianWords(whole) : internationalWords(whole);
  return `${sign}${major} ${words}${fraction ? ` and ${two(fraction)} ${minor}` : ''} Only`;
}

function partyLines(p: Party) {
  const lines: string[] = [];
  if (p.address) lines.push(p.address);
  const cityLine = [p.city, p.state, p.postalCode].filter(Boolean).join(', ');
  if (cityLine) lines.push(cityLine);
  if (p.gstin) lines.push(`GSTIN: ${p.gstin}`);
  if (p.stateCode) lines.push(`State code: ${p.stateCode}`);
  if (p.email) lines.push(p.email);
  if (p.phone) lines.push(p.phone);
  return lines;
}

const PAGE_BOTTOM = 770; // keep clear of the footer line at 790

const AUTH_WIDTH = 230;
const NAVY = '#0f2a5c';
const ACCENT = '#0f766e';
const authImageHeight = (a: AuthorizationBlock) => (a.seal || a.signature ? 96 : 30); // without images, leave a short space for a wet signature
const authHeight = (a: AuthorizationBlock) => 22 + authImageHeight(a) + 40;

/** Shaded section title with an accent bar on the left. Returns where the section's content starts. */
function sectionHeader(pdf: PDFKit.PDFDocument, title: string, x: number, y: number, w: number) {
  pdf.roundedRect(x, y, w, 17, 3).fill('#e8f0fa');
  pdf.rect(x, y, 3, 17).fill(ACCENT);
  pdf.font(F.bold).fontSize(8.5).fillColor(NAVY).text(title.toUpperCase(), x + 12, y + 4.5, { width: w - 16, characterSpacing: 0.9, lineBreak: false });
  return y + 25;
}

// "ACCOUNT NUMBER - 5020…", "IFSC Code: HDFC…": a short label with no digits, then ":" or "-", then the value.
const KEY_VALUE = /^([A-Za-z][A-Za-z .&/()']{1,38}?)\s*[:\-–]\s*(?!\/)(\S.*)$/;

/**
 * A notes / terms section in the reference style. A first line ending in ":" ("BANK ACCOUNT DETAIL:") becomes the
 * section title; "LABEL - value" lines are laid out as an aligned label : value table; terms are shown as bullets.
 * With `measure`, nothing is drawn and the returned y tells how tall the section would be.
 */
function drawNoteSection(pdf: PDFKit.PDFDocument, fallbackTitle: string, body: string, bullets: boolean, x: number, y: number, w: number, measure = false) {
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let title = fallbackTitle;
  if (lines.length > 1 && lines[0].endsWith(':') && !KEY_VALUE.test(lines[0].slice(0, -1))) title = lines.shift()!.slice(0, -1);
  const pairs = lines.map((l) => KEY_VALUE.exec(l));
  const table = !bullets && pairs.filter(Boolean).length >= 2;
  const ensure = (h: number) => { if (!measure && y + h > PAGE_BOTTOM) { pdf.addPage(); y = 50; } };

  ensure(40);
  y = measure ? y + 25 : sectionHeader(pdf, title, x, y, w);
  pdf.fontSize(8.5);
  const labelW = table ? Math.min(130, Math.max(...pairs.map((m) => (m ? pdf.font(F.regular).widthOfString(m[1].toUpperCase()) : 0)))) : 0;
  lines.forEach((line, i) => {
    const m = pairs[i];
    if (table && m) {
      const valueX = x + 4 + labelW + 18;
      const h = Math.max(pdf.font(F.bold).heightOfString(m[2], { width: x + w - valueX }), 11);
      ensure(h);
      if (!measure) {
        pdf.font(F.regular).fillColor('#334155').text(m[1].toUpperCase(), x + 4, y, { width: labelW, lineBreak: false, ellipsis: true });
        pdf.text(':', x + 4 + labelW + 6, y, { lineBreak: false });
        pdf.font(F.bold).fillColor(NAVY).text(m[2], valueX, y, { width: x + w - valueX });
      }
      y += h + 5;
    } else if (bullets) {
      const h = pdf.font(F.regular).heightOfString(line, { width: w - 18 });
      ensure(h);
      if (!measure) {
        pdf.circle(x + 6, y + 4.5, 2).fill(ACCENT);
        pdf.fillColor('#1e293b').text(line, x + 16, y, { width: w - 18 });
      }
      y += h + 4;
    } else {
      const h = pdf.font(F.regular).heightOfString(line, { width: w - 4 });
      ensure(h);
      if (!measure) pdf.fillColor('#1e293b').text(line, x + 4, y, { width: w - 4 });
      y += h + 4;
    }
  });
  return y + 10;
}

/** "For <Company>", the signature stamped over the seal, then the signatory's name and designation, centred. */
function drawAuthorization(pdf: PDFKit.PDFDocument, a: AuthorizationBlock, y: number, right: number) {
  const width = AUTH_WIDTH;
  const x = right - width;
  const imgH = authImageHeight(a);
  if (y + authHeight(a) > PAGE_BOTTOM) { pdf.addPage(); y = 50; }
  pdf.font(F.bold).fontSize(11).fillColor(NAVY).text(`For ${a.company}`, x, y + 2, { width, align: 'center' });
  const top = pdf.y + 6;
  // Seal and signature share one centre; the signature is drawn last so it sits on top of the seal, as when a
  // document is signed across its stamp. Both keep their aspect ratio inside fixed boxes.
  const cx = x + width / 2;
  if (a.seal) {
    try { pdf.image(a.seal, cx - imgH / 2, top, { fit: [imgH, imgH], align: 'center', valign: 'center' }); } catch { /* unreadable image: skipped */ }
  }
  if (a.signature) {
    try { pdf.image(a.signature, cx - 70, top + 18, { fit: [140, imgH - 36], align: 'center', valign: 'center' }); } catch { /* skipped */ }
  }
  const lineY = top + imgH + 6;
  pdf.moveTo(x + 8, lineY).lineTo(right - 8, lineY).strokeColor(NAVY).lineWidth(1).stroke();
  pdf.font(F.bold).fontSize(9.5).fillColor(NAVY).text('Authorized Signatory', x, lineY + 7, { width, align: 'center' });
  const who = [a.signatoryName, a.designation].filter(Boolean).join(', ');
  if (who) pdf.font(F.regular).fontSize(8.5).fillColor('#334155').text(who, x, pdf.y + 2, { width, align: 'center' });
  return pdf.y + 6;
}

function draw(pdf: PDFKit.PDFDocument, doc: FinancialDoc) {
  const brand = doc.seller.brandColor || '#1e3a8a';
  const cur = doc.currency ?? INR;
  const amt = (v: unknown) => formatAmount(v, cur);
  const left = 40;
  const right = 555;
  const width = right - left;

  if (doc.watermark) {
    pdf.save().rotate(-30, { origin: [300, 420] }).font(F.bold).fontSize(80).fillColor('#e5e7eb')
      .text(doc.watermark, 60, 380, { width: 480, align: 'center' }).restore();
  }

  // Seller block
  pdf.rect(0, 0, 595, 6).fill(brand);
  let nameY = 30;
  if (doc.seller.logo) {
    try {
      pdf.image(doc.seller.logo, left, 22, { fit: [170, 52] });
      nameY = 80;
    } catch {
      /* unsupported image: text-only header */
    }
  }
  pdf.fillColor('#0f172a').font(F.bold).fontSize(nameY > 30 ? 12 : 16).text(doc.seller.company || doc.seller.name, left, nameY, { width: 280 });
  const sellerLines = partyLines(doc.seller);
  if (doc.seller.pan) sellerLines.push(`PAN: ${doc.seller.pan}`);
  pdf.font(F.regular).fontSize(8.5).fillColor('#475569').text(sellerLines.join('\n'), left, pdf.y + 4, { width: 280 });
  const headerBottom = pdf.y;

  // Title and document meta
  pdf.font(F.bold).fontSize(18).fillColor(brand).text(doc.title, 300, 30, { width: right - 300, align: 'right' });
  pdf.font(F.regular).fontSize(9);
  const meta: [string, string][] = [[doc.numberLabel ?? 'Number', doc.number], ['Date', fmtDate(doc.issueDate)]];
  for (const [k, v] of doc.meta ?? []) if (v) meta.push([k, v]);
  if (doc.reference) meta.push(['Reference', doc.reference]);
  // Values sit in a column sized to the widest one at the right edge, with each label right-aligned just before
  // its value, so "Number" reads next to "INV-0001" instead of across a wide gap.
  const valueW = Math.min(180, Math.max(...meta.map(([, v]) => pdf.widthOfString(v))) + 1);
  const valueX = right - valueW;
  let my = 58;
  for (const [k, v] of meta) {
    pdf.fillColor('#64748b').text(k, valueX - 130, my, { width: 120, align: 'right' });
    pdf.fillColor('#0f172a').text(v, valueX, my, { width: valueW });
    my = Math.max(my + 13, pdf.y + 2);
  }

  // Parties
  let y = Math.max(headerBottom, my) + 16;
  pdf.moveTo(left, y).lineTo(right, y).strokeColor('#e2e8f0').lineWidth(1).stroke();
  y += 10;
  const colW = doc.shipTo ? 170 : 260;
  pdf.font(F.bold).fontSize(8).fillColor('#64748b').text('BILL TO', left, y);
  if (doc.shipTo) pdf.text('SHIP TO', left + 185, y);
  pdf.text('PLACE OF SUPPLY', 380, y, { width: right - 380, align: 'right' });
  const partyBlock = (p: Party, x: number) => {
    const name = p.company || p.name;
    const attn = p.company && p.name && p.company !== p.name ? [`Attn: ${p.name}`] : [];
    pdf.font(F.bold).fontSize(9.5).fillColor('#0f172a').text(name, x, y + 12, { width: colW });
    pdf.font(F.regular).fontSize(8.5).fillColor('#334155').text([...attn, ...partyLines(p)].join('\n'), x, pdf.y + 2, { width: colW });
    return pdf.y;
  };
  let bottom = partyBlock(doc.buyer, left);
  if (doc.shipTo) bottom = Math.max(bottom, partyBlock(doc.shipTo, left + 185));
  const posName = doc.placeOfSupply === '96' ? 'Outside India' : INDIAN_STATES[doc.placeOfSupply ?? ''] ?? doc.placeOfSupply;
  const pos = doc.placeOfSupply ? `${posName} (${doc.placeOfSupply})` : 'Not specified';
  const supply = doc.supplyNote ?? (doc.isInterState ? 'Inter-state supply (IGST)' : 'Intra-state supply (CGST + SGST)');
  pdf.font(F.regular).fontSize(8.5).fillColor('#0f172a').text(`${pos}\n${supply}`, 380, y + 12, { width: right - 380, align: 'right' });
  y = Math.max(bottom, pdf.y) + 12;

  if (doc.subject) {
    pdf.font(F.bold).fontSize(8).fillColor('#64748b').text('SUBJECT', left, y);
    pdf.font(F.regular).fontSize(9).fillColor('#0f172a').text(doc.subject, left, y + 11, { width });
    y = pdf.y + 12;
  }

  // Items
  const cols = [
    { key: '#', w: 20, align: 'left' as const },
    { key: 'Item & Description', w: 175, align: 'left' as const },
    { key: 'HSN/SAC', w: 50, align: 'left' as const },
    { key: 'Qty', w: 45, align: 'right' as const },
    { key: `Rate (${cur.code})`, w: 65, align: 'right' as const },
    { key: 'Disc', w: 35, align: 'right' as const },
    { key: 'Tax%', w: 30, align: 'right' as const },
    { key: `Amount (${cur.code})`, w: width - 420, align: 'right' as const },
  ];
  const drawRow = (vals: string[], yy: number, bold = false) => {
    let x = left;
    pdf.font(bold ? F.bold : F.regular).fontSize(8);
    let h = 0;
    vals.forEach((v, i) => {
      pdf.text(v, x + 3, yy, { width: cols[i].w - 6, align: cols[i].align });
      h = Math.max(h, pdf.heightOfString(v, { width: cols[i].w - 6 }));
      x += cols[i].w;
    });
    return h;
  };
  const header = () => {
    pdf.rect(left, y, width, 18).fill('#f1f5f9');
    pdf.fillColor('#334155');
    drawRow(cols.map((c) => c.key), y + 5, true);
    y += 24;
    pdf.fillColor('#0f172a');
  };
  header();
  doc.items.forEach((it, i) => {
    if (y > 700) { pdf.addPage(); y = 50; header(); }
    const h = drawRow([
      String(i + 1), it.description, it.hsnSac ?? '', `${n(it.quantity)}${it.unit ? ' ' + it.unit : ''}`,
      amt(it.rate), n(it.discountAmount) ? amt(it.discountAmount) : n(it.discountPct) ? `${n(it.discountPct)}%` : '-', `${n(it.taxRate)}`, amt(it.amount),
    ], y);
    y += h + 8;
    pdf.moveTo(left, y - 4).lineTo(right, y - 4).strokeColor('#e2e8f0').stroke();
  });

  // Totals
  const t = doc.totals;
  if (y > 600) { pdf.addPage(); y = 50; }
  y += 8;
  const lineDiscounts = n(t.discountTotal);
  const rows: [string, string | { money: unknown }, boolean?][] = [['Sub Total', amt(t.subtotal)]];
  if (lineDiscounts) rows.push(['Discount', `- ${amt(lineDiscounts)}`]);
  rows.push(['Taxable value', amt(t.taxableTotal)]);
  const breakdown = Array.isArray(t.taxBreakdown) ? (t.taxBreakdown as { name: string; rate: unknown; amount: unknown }[]) : null;
  if (breakdown) for (const b of breakdown) rows.push([`${b.name} @ ${n(b.rate)}%`, amt(b.amount)]);
  else if (doc.isInterState) rows.push(['IGST', amt(t.igstTotal)]);
  else rows.push(['CGST', amt(t.cgstTotal)], ['SGST', amt(t.sgstTotal)]);
  if (n(t.withholdingAmount)) rows.push([`${t.withholdingType ?? 'TDS'} (${n(t.withholdingRate)}%)`, `${n(t.withholdingAmount) < 0 ? '- ' : ''}${amt(Math.abs(n(t.withholdingAmount)))}`]);
  if (n(t.adjustment)) rows.push([t.adjustmentLabel || 'Adjustment', amt(t.adjustment)]);
  if (n(t.roundOff)) rows.push(['Round Off', amt(t.roundOff)]);
  rows.push([`Total (${cur.code})`, { money: t.total }, true]);
  if (n(t.amountPaid)) rows.push(['Payment Made', `(-) ${amt(t.amountPaid)}`]);
  if (n(t.creditedTotal)) rows.push(['Credits Applied', `(-) ${amt(t.creditedTotal)}`]);
  if (n(t.writeOffAmount)) rows.push(['Written Off', `(-) ${amt(t.writeOffAmount)}`]);
  const ty = y;
  for (const [label, value, bold] of rows) {
    pdf.font(bold ? F.bold : F.regular).fontSize(bold ? 10 : 9).fillColor(bold ? '#0f172a' : '#334155');
    pdf.text(label, 340, y, { width: 115 });
    if (typeof value === 'string') pdf.text(value, 445, y, { width: right - 445, align: 'right' });
    else moneyText(pdf, value.money, cur, 445, y, right - 445, Boolean(bold), bold ? 10 : 9);
    y += bold ? 16 : 13;
  }
  if (t.balanceDue !== undefined) {
    // Highlighted balance due
    pdf.rect(335, y - 2, right - 335, 20).fill('#f1f5f9');
    pdf.font(F.bold).fontSize(10).fillColor(brand).text('Balance Due', 340, y + 3, { width: 115 });
    moneyText(pdf, t.balanceDue, cur, 445, y + 3, right - 450, true, 10);
    y += 24;
  }
  pdf.font(F.bold).fontSize(8).fillColor('#64748b').text('TOTAL IN WORDS', left, ty);
  pdf.font(F.regular).fontSize(9).fillColor('#0f172a').text(amountInWords(n(t.total), cur), left, ty + 12, { width: 280 });

  y = Math.max(y, pdf.y) + 20;
  if (doc.notice) {
    if (y > 740) { pdf.addPage(); y = 50; }
    const h = pdf.font(F.regular).fontSize(8.5).heightOfString(doc.notice, { width: width - 20 }) + 12;
    pdf.rect(left, y, width, h).fill('#fef3c7');
    pdf.fillColor('#92400e').text(doc.notice, left + 10, y + 6, { width: width - 20 });
    y += h + 14;
  }
  // The signatory block sits to the right of the notes and terms, on the page where they start, whenever it fits
  // there; the notes then wrap in the narrower left column. Otherwise it follows them as before.
  const auth = doc.authorization;
  const sections = ([['Notes', doc.notes, false], ['Payment Instructions', doc.paymentInstructions, false], ['Terms & Conditions', doc.terms, true]] as const)
    .filter(([, body]) => body?.trim());
  const sideW = width - AUTH_WIDTH - 30;
  const notesHeight = (w: number) => sections.reduce((h, [label, body, bullets], i) => h + (i ? 10 : 0) + drawNoteSection(pdf, label, body as string, bullets, left, 0, w, true), 0);
  // Keep the notes and the signatory together: if they don't fit in what is left of this page but would fit on a
  // fresh one, start them there rather than splitting the bank details across pages.
  const blockH = auth ? Math.max(notesHeight(sideW), authHeight(auth)) : notesHeight(width);
  if (sections.length + (auth ? 1 : 0) > 0 && y + blockH > PAGE_BOTTOM && 50 + blockH <= PAGE_BOTTOM) { pdf.addPage(); y = 50; }
  const beside = auth && y + authHeight(auth) <= PAGE_BOTTOM ? { y, page: pdf.bufferedPageRange().count - 1 } : null;
  const textW = beside ? sideW : width;
  sections.forEach(([label, body, bullets], i) => {
    if (i > 0) {
      pdf.moveTo(left, y - 2).lineTo(left + textW, y - 2).strokeColor('#cbd5e1').lineWidth(0.7).stroke();
      y += 10;
    }
    y = drawNoteSection(pdf, label, body as string, bullets, left, y, textW);
  });

  if (auth && beside) {
    const last = pdf.bufferedPageRange().count - 1;
    pdf.switchToPage(pdf.bufferedPageRange().start + beside.page);
    const end = drawAuthorization(pdf, auth, beside.y, right);
    // Vertical rule between the notes and the signatory column.
    const ruleX = right - AUTH_WIDTH - 15;
    pdf.moveTo(ruleX, beside.y).lineTo(ruleX, last === beside.page ? Math.max(y - 6, end) : end).strokeColor('#cbd5e1').lineWidth(0.7).stroke();
    pdf.switchToPage(pdf.bufferedPageRange().start + last);
    if (last === beside.page) y = Math.max(y, end);
  } else if (auth) {
    y = drawAuthorization(pdf, auth, y + 4, right);
  }

  // Footer on every page
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    pdf.font(F.regular).fontSize(7.5).fillColor('#94a3b8').text(doc.footer ?? 'This is a computer-generated document.', left, 790, {
      width, align: 'center', lineBreak: false,
    });
    if (range.count > 1) pdf.text(`Page ${i - range.start + 1} of ${range.count}`, left, 778, { width, align: 'right', lineBreak: false });
  }
}

export function streamFinancialPdf(res: Response, doc: FinancialDoc, filename: string) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename.replace(/[^\w.-]/g, '_')}"`);
  const pdf = newPdf();
  pdf.pipe(res);
  draw(pdf, doc);
  pdf.end();
}

/** Renders a document to an in-memory PDF (used for email attachments). */
export function renderFinancialPdf(doc: FinancialDoc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = newPdf();
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    draw(pdf, doc);
    pdf.end();
  });
}

export interface StatementDoc {
  seller: FinancialDoc['seller'];
  customer: Party;
  from: Date;
  to: Date;
  opening: number;
  currency?: PdfCurrency;
  rows: { date: Date; type: string; number: string; amount: number; payment: number; balance: number }[];
  closing: number;
}

/** Customer account statement: invoices, payments and credits with a running balance, in one currency. */
export function renderStatementPdf(s: StatementDoc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = newPdf();
    const cur = s.currency ?? INR;
    const amt = (v: unknown) => formatAmount(v, cur);
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    const left = 40, right = 555;
    pdf.rect(0, 0, 595, 6).fill(s.seller.brandColor || '#1e3a8a');
    let y = 30;
    if (s.seller.logo) { try { pdf.image(s.seller.logo, left, 22, { fit: [150, 46] }); y = 74; } catch { /* ignore */ } }
    pdf.fillColor('#0f172a').font(F.bold).fontSize(12).text(s.seller.company || s.seller.name, left, y);
    pdf.font(F.bold).fontSize(16).fillColor('#0f172a').text('STATEMENT OF ACCOUNTS', 300, 30, { width: right - 300, align: 'right' });
    pdf.font(F.regular).fontSize(9).fillColor('#475569').text(`${fmtDate(s.from)} to ${fmtDate(s.to)} · ${cur.code}`, 300, 52, { width: right - 300, align: 'right' });
    y = Math.max(pdf.y, y + 20) + 20;
    pdf.font(F.bold).fontSize(8).fillColor('#64748b').text('TO', left, y);
    pdf.font(F.bold).fontSize(10).fillColor('#0f172a').text(s.customer.company || s.customer.name, left, y + 12);
    pdf.font(F.regular).fontSize(8.5).fillColor('#334155').text(partyLines(s.customer).join('\n'), left, pdf.y + 2, { width: 260 });
    const summary: [string, number][] = [['Opening Balance', s.opening], ['Invoiced Amount', s.rows.reduce((a, r) => a + r.amount, 0)], ['Amount Received', s.rows.reduce((a, r) => a + r.payment, 0)], ['Balance Due', s.closing]];
    let sy = y;
    for (const [k, v] of summary) {
      pdf.font(k === 'Balance Due' ? F.bold : F.regular).fontSize(9).fillColor('#0f172a').text(k, 360, sy, { width: 100 });
      if (k === 'Balance Due') moneyText(pdf, v, cur, 460, sy, right - 460, true, 9);
      else pdf.text(amt(v), 460, sy, { width: right - 460, align: 'right' });
      sy += 14;
    }
    y = Math.max(pdf.y, sy) + 20;
    const cols = [70, 110, 110, 75, 75, 75];
    const heads = ['Date', 'Transaction', 'Details', `Amount (${cur.code})`, 'Payments', 'Balance'];
    pdf.rect(left, y, right - left, 18).fill('#f1f5f9');
    let x = left;
    heads.forEach((h, i) => { pdf.font(F.bold).fontSize(8).fillColor('#334155').text(h, x + 3, y + 5, { width: cols[i] - 6, align: i >= 3 ? 'right' : 'left' }); x += cols[i]; });
    y += 24;
    const rows = [{ date: s.from, type: 'Opening Balance', number: '', amount: 0, payment: 0, balance: s.opening }, ...s.rows];
    for (const r of rows) {
      if (y > 760) { pdf.addPage(); y = 50; }
      const vals = [fmtDate(r.date), r.type, r.number, r.amount ? amt(r.amount) : '', r.payment ? amt(r.payment) : '', amt(r.balance)];
      x = left;
      vals.forEach((v, i) => { pdf.font(F.regular).fontSize(8).fillColor('#0f172a').text(v, x + 3, y, { width: cols[i] - 6, align: i >= 3 ? 'right' : 'left' }); x += cols[i]; });
      y += 16;
    }
    pdf.end();
  });
}
