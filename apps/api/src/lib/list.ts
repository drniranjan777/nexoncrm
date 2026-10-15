import type { Request } from 'express';
import { badRequest } from './errors.js';

export interface ListParams {
  page: number;
  pageSize: number;
  skip: number;
  q?: string;
  sort?: string;
  dir: 'asc' | 'desc';
}

export function listParams(req: Request, allowedSort: string[] = ['createdAt'], opts: { maxPageSize?: number } = {}): ListParams {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(opts.maxPageSize ?? 200, Math.max(1, Number(req.query.pageSize) || 25));
  const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : undefined;
  const sortRaw = typeof req.query.sort === 'string' ? req.query.sort : undefined;
  const sort = sortRaw && allowedSort.includes(sortRaw) ? sortRaw : allowedSort[0];
  const dir = req.query.dir === 'asc' ? 'asc' : 'desc';
  return { page, pageSize, skip: (page - 1) * pageSize, q, sort, dir };
}

export const orderBy = (p: ListParams) => (p.sort ? { [p.sort]: p.dir } : undefined);

export function paged<T>(items: T[], total: number, p: ListParams) {
  return { items, total, page: p.page, pageSize: p.pageSize, pages: Math.max(1, Math.ceil(total / p.pageSize)) };
}

export const qstr = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);

/**
 * Parses a date query parameter. A plain YYYY-MM-DD `to` date covers that whole day, so documents created later
 * that day are included. Unparseable values are rejected with a 400.
 */
export function dateParam(v: unknown, opts: { endOfDay?: boolean } = {}): Date | undefined {
  const s = qstr(v);
  if (!s) return undefined;
  const d = opts.endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T23:59:59.999Z`) : new Date(s);
  if (Number.isNaN(d.getTime())) throw badRequest(`Invalid date: ${s.slice(0, 40)}`);
  return d;
}

/** Prisma range filter from `from` / `to` query parameters (inclusive of the whole `to` day). */
export function dateRange(from: unknown, to: unknown) {
  const gte = dateParam(from);
  const lte = dateParam(to, { endOfDay: true });
  return gte || lte ? { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } : undefined;
}

/** Case-insensitive contains filter across several fields. */
export const searchAny = (q: string | undefined, fields: string[]) =>
  q ? { OR: fields.map((f) => ({ [f]: { contains: q, mode: 'insensitive' as const } })) } : {};

export function toCsv(rows: Record<string, unknown>[], columns: string[]) {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString() : String(v);
    // Neutralise spreadsheet formula injection.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n');
}

/** Picks the delimiter used in the header line: comma, tab (TSV / pasted from a spreadsheet) or semicolon (Excel in some regions). */
function detectDelimiter(text: string) {
  const header = text.slice(0, text.search(/\r?\n|$/));
  const count = (d: string) => header.replace(/"[^"]*"/g, '').split(d).length - 1;
  return [',', '\t', ';'].reduce((best, d) => (count(d) > count(best) ? d : best), ',');
}

export function parseCsv(input: string): Record<string, string>[] {
  const text = input.replace(/^\uFEFF/, ''); // byte-order mark added by Excel
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

/**
 * Reads an amount typed by people or exported by other tools: "35000", "35,000.00", "₹ 1,30,000", "Rs. 25,000/-",
 * "INR 9,000" and values whose currency symbol was lost in a character-set conversion ("? 35,000.00").
 * Grouping commas (Indian or western) are dropped. Returns null when empty, NaN when it is not an amount.
 */
export function parseAmount(raw: string | null | undefined): number | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const cleaned = s
    .replace(/^(?:[A-Za-z]{2,3}\.?|[^\d\s.,+-]+)\s*/, '') // leading currency code or symbol(s): INR, Rs., ₹, $, ?, …
    .replace(/\s*(?:\/-|[A-Za-z]{2,3}\.?)$/, '') // trailing "/-" or currency code
    .replace(/[\s,]/g, '');
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : NaN;
}
