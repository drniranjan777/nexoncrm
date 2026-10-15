import type { Currency, Tenant } from '@prisma/client';
import { prisma, type Tx } from './db.js';
import { badRequest } from './errors.js';

export interface CurrencyInfo { code: string; name: string; symbol: string; decimals: number }

/** Currencies a tenant can use on documents: active in the platform catalog and enabled by the tenant. */
export async function tenantCurrencies(tenantId: string, tx: Tx = prisma) {
  const rows = await tx.tenantCurrency.findMany({
    where: { tenantId, isActive: true, currency: { isActive: true } },
    include: { currency: true },
    orderBy: { currency: { sortOrder: 'asc' } },
  });
  return rows.map((r) => r.currency);
}

/** Enables every active catalog currency for a new tenant. */
export async function enableCatalogFor(tenantId: string, tx: Tx = prisma) {
  const catalog = await tx.currency.findMany({ where: { isActive: true }, select: { code: true } });
  if (catalog.length) {
    await tx.tenantCurrency.createMany({ data: catalog.map((c) => ({ tenantId, currencyCode: c.code })), skipDuplicates: true });
  }
}

export async function currencyInfo(code: string, tx: Tx = prisma): Promise<CurrencyInfo> {
  const c = await tx.currency.findUnique({ where: { code } });
  return c ? pick(c) : { code, name: code, symbol: code, decimals: 2 };
}

const pick = (c: Currency): CurrencyInfo => ({ code: c.code, name: c.name, symbol: c.symbol, decimals: c.decimals });

/** Most recent rate the tenant used for a currency (1 unit = rate units of the base currency). */
export async function latestRate(tenantId: string, code: string, tx: Tx = prisma) {
  const r = await tx.exchangeRate.findFirst({ where: { tenantId, currencyCode: code }, orderBy: [{ rateDate: 'desc' }, { createdAt: 'desc' }] });
  return r ? Number(r.rate) : null;
}

/**
 * Validates the currency chosen for a document and settles its exchange rate to the base currency.
 * Base-currency documents always use 1. Foreign-currency documents need a rate: the one given, or the
 * tenant's latest rate for that currency. A newly entered rate is remembered for next time.
 */
export async function resolveDocumentCurrency(
  tx: Tx, tenant: Pick<Tenant, 'id' | 'currency' | 'defaultCurrency'>,
  input: { currency?: string | null; exchangeRate?: number | null; current?: { currency: string; exchangeRate: unknown } },
  userId?: string,
) {
  const code = (input.currency ?? input.current?.currency ?? tenant.defaultCurrency).toUpperCase();
  const info = await tx.currency.findUnique({ where: { code } });
  const enabled = info?.isActive && (await tx.tenantCurrency.findUnique({ where: { tenantId_currencyCode: { tenantId: tenant.id, currencyCode: code } } }))?.isActive;
  // A document that already uses a currency may keep it even if the currency was switched off later.
  const keeping = input.current?.currency === code;
  if (!info || (!enabled && !keeping)) throw badRequest(`Currency ${code} is not enabled for this organization`, { fieldErrors: { currency: ['Not enabled'] } });
  if (code === tenant.currency) return { currency: code, exchangeRate: 1, decimals: info.decimals };

  let rate = input.exchangeRate ?? null;
  if (rate === null && keeping) rate = Number(input.current!.exchangeRate);
  if (rate === null) rate = await latestRate(tenant.id, code, tx);
  if (!rate || !(rate > 0)) {
    throw badRequest(`Enter the exchange rate from ${code} to ${tenant.currency}`, { fieldErrors: { exchangeRate: ['Required for foreign-currency documents'] } });
  }
  if (input.exchangeRate && input.exchangeRate !== (await latestRate(tenant.id, code, tx))) {
    await tx.exchangeRate.create({ data: { tenantId: tenant.id, currencyCode: code, baseCurrency: tenant.currency, rate: input.exchangeRate, rateDate: new Date(), createdById: userId } });
  }
  return { currency: code, exchangeRate: rate, decimals: info.decimals };
}

/** Formats an amount for emails and plain text, e.g. "USD 1,100.00" or "₹59,000.00". */
export function formatMoney(amount: unknown, c: Pick<CurrencyInfo, 'code' | 'symbol' | 'decimals'>) {
  const v = Number(amount ?? 0);
  const locale = c.code === 'INR' ? 'en-IN' : 'en-US';
  const digits = Math.min(2, Math.max(0, c.decimals));
  const num = Math.abs(v).toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${v < 0 ? '-' : ''}${c.symbol}${num}`;
}

/** Converts a document amount to the base currency for reports. */
export const toBase = (amount: unknown, rate: unknown) => Math.round(Number(amount ?? 0) * Number(rate ?? 1) * 100) / 100;
