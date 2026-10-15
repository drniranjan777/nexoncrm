import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

const inrFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const inrShort = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', notation: 'compact', maximumFractionDigits: 1 });

export const inr = (v: unknown) => inrFmt.format(Number(v ?? 0));

// ── Currency-aware money ──
// Symbols and decimals come from the currency catalog (loaded with the finance meta). Known defaults keep
// formatting right before it loads.
type Cur = { code: string; symbol: string; decimals: number };
const catalog = new Map<string, Cur>([
  ['INR', { code: 'INR', symbol: '₹', decimals: 2 }], ['USD', { code: 'USD', symbol: '$', decimals: 2 }], ['GBP', { code: 'GBP', symbol: '£', decimals: 2 }],
  ['EUR', { code: 'EUR', symbol: '€', decimals: 2 }], ['AUD', { code: 'AUD', symbol: 'A$', decimals: 2 }], ['AED', { code: 'AED', symbol: 'د.إ', decimals: 2 }],
  ['CAD', { code: 'CAD', symbol: 'C$', decimals: 2 }], ['SGD', { code: 'SGD', symbol: 'S$', decimals: 2 }],
]);
export function setCurrencyCatalog(list: Cur[]) { for (const c of list) catalog.set(c.code, { code: c.code, symbol: c.symbol, decimals: c.decimals }); }
export const currencyOf = (code?: string | null): Cur => catalog.get(code ?? 'INR') ?? { code: code ?? 'INR', symbol: `${code} `, decimals: 2 };
export const currencySymbol = (code?: string | null) => currencyOf(code).symbol;

/** Formats an amount in a document's currency, e.g. "$1,100.00", "₹59,000.00", "د.إ 250.00". INR uses Indian grouping. */
export function money(v: unknown, code?: string | null) {
  const c = currencyOf(code);
  const d = Math.min(2, Math.max(0, c.decimals));
  const x = Number(v ?? 0);
  const num = Math.abs(x).toLocaleString(c.code === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  // Multi-letter symbols get a space ("CHF 10.00", "د.إ 10.00"); "$", "₹", "A$" do not.
  const sym = c.symbol.length > 1 && !c.symbol.endsWith('$') ? `${c.symbol} ` : c.symbol;
  return `${x < 0 ? '-' : ''}${sym}${num}`;
}
/** Plain number in the currency's precision (for inputs and tables with a currency header). */
export const amountOnly = (v: unknown, code?: string | null) => {
  const c = currencyOf(code);
  const d = Math.min(2, Math.max(0, c.decimals));
  return Number(v ?? 0).toLocaleString(c.code === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};
export const inrCompact = (v: unknown) => inrShort.format(Number(v ?? 0));
export const num = (v: unknown) => Number(v ?? 0);

export function fmtDate(v?: string | Date | null, opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' }) {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-IN', opts);
}

export function fmtDateTime(v?: string | Date | null) {
  if (!v) return '—';
  return new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(v?: string | Date | null) {
  if (!v) return '—';
  const s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
  const abs = Math.abs(s);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 60) return 'just now';
  if (abs < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(-Math.round(s / 86400), 'day');
  return fmtDate(v);
}

/** For <input type="date"> values, in the user's local calendar (toISOString would shift IST dates back a day). */
export function toDateInput(v?: string | Date | null) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const ACRONYMS: Record<string, string> = { Upi: 'UPI', Gst: 'GST', Tds: 'TDS', Tcs: 'TCS', Igst: 'IGST', Neft: 'NEFT', Rtgs: 'RTGS', Imps: 'IMPS' };
export const titleCase = (s?: string | null) =>
  (s ?? '').toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\b(Upi|Gst|Tds|Tcs|Igst|Neft|Rtgs|Imps)\b/g, (w) => ACRONYMS[w]);

export const initials = (name?: string | null) =>
  (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');

export const fileSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
