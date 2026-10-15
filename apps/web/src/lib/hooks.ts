import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage, type Paged } from './api';
import { setCurrencyCatalog } from './utils';
import type { TaxOption } from './types';

export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Server-paginated list with search, filters and sorting held in local state. */
export function useList<T>(path: string, initialFilters: Record<string, string> = {}, opts: { sort?: string; dir?: 'asc' | 'desc'; pageSize?: number; storageKey?: string } = {}) {
  const [page, setPage] = useState(1);
  // Rows per page, remembered per list when a storage key is given.
  const [pageSize, setPageSizeState] = useState<number>(() => {
    try { const v = opts.storageKey ? Number(localStorage.getItem(`nx.pageSize.${opts.storageKey}`)) : 0; return v > 0 ? v : opts.pageSize ?? 25; } catch { return opts.pageSize ?? 25; }
  });
  const setPageSize = (n: number) => {
    setPageSizeState(n);
    setPage(1);
    try { if (opts.storageKey) localStorage.setItem(`nx.pageSize.${opts.storageKey}`, String(n)); } catch { /* private mode */ }
  };
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>(initialFilters);
  const [sort, setSort] = useState<{ sort?: string; dir: 'asc' | 'desc' }>({ sort: opts.sort, dir: opts.dir ?? 'desc' });
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, JSON.stringify(filters)]);
  const query = useQuery({
    queryKey: [path, { page, pageSize, q: dq, ...filters, ...sort }],
    queryFn: () => api.get<Paged<T> & Record<string, unknown>>(path, { page, pageSize, q: dq, ...filters, ...sort }),
    placeholderData: keepPreviousData,
  });
  return {
    ...query,
    page, setPage, pageSize, setPageSize, q, setQ, filters,
    setFilter: (k: string, v: string) => setFilters((f) => ({ ...f, [k]: v })),
    sort, toggleSort: (s: string) => setSort((cur) => ({ sort: s, dir: cur.sort === s && cur.dir === 'desc' ? 'asc' : 'desc' })),
    params: { q: dq, ...filters },
  };
}

/** Mutation that toasts on success/failure and invalidates the given query prefixes. */
export function useAction<TVars = void, TRes = unknown>(fn: (v: TVars) => Promise<TRes>, opts: { success?: string | ((r: TRes) => string); invalidate?: QueryKey[]; onSuccess?: (r: TRes, v: TVars) => void } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, v) => {
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success);
      for (const key of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: key });
      opts.onSuccess?.(r, v);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export interface MemberOption { id: string; name: string; email: string; role: string; roleKey: string }
export const useMembers = () => useQuery({ queryKey: ['members-options'], queryFn: () => api.get<MemberOption[]>('/members/options'), staleTime: 5 * 60_000 });

export interface CustomerOption { id: string; name: string; company: string | null; email: string | null; stateCode: string | null; gstin: string | null }
export const useCustomerOptions = (enabled = true) => useQuery({ queryKey: ['customers-options'], queryFn: () => api.get<CustomerOption[]>('/customers/options'), staleTime: 60_000, enabled });

export interface ProjectOption { id: string; code: string; name: string; customerId: string | null }
export const useProjectOptions = (enabled = true) => useQuery({ queryKey: ['projects-options'], queryFn: () => api.get<ProjectOption[]>('/projects/options'), staleTime: 60_000, enabled });

export const useCategories = () => useQuery({ queryKey: ['ticket-categories'], queryFn: () => api.get<{ id: string; name: string; slaHours: number; _count: { tickets: number; articles: number } }[]>('/ticket-categories'), staleTime: 5 * 60_000 });

export interface FinanceMeta {
  gstRates: number[]; states: Record<string, string>; gstTreatments: Record<string, string>;
  paymentTerms: { code: string; label: string }[]; tdsRates: { label: string; rate: number }[]; tcsRates: { label: string; rate: number }[];
  companyStateCode: string | null; companyGstin: string | null; roundOff: boolean; defaultTaxRate?: number;
  /** Reporting currency (GST, reports) and the currency pre-selected on new documents. */
  baseCurrency: string; defaultCurrency: string;
  currencies: { code: string; name: string; symbol: string; decimals: number }[];
  /** States sorted by GST code (object keys like "01" would otherwise sort after "10"). */
  stateList: [string, string][];
}
export const useFinanceMeta = () => useQuery({
  queryKey: ['finance-meta'], staleTime: 5 * 60_000,
  queryFn: async () => {
    const m = await api.get<Omit<FinanceMeta, 'stateList'>>('/finance/meta');
    setCurrencyCatalog(m.currencies ?? []);
    return { ...m, stateList: Object.entries(m.states).sort((a, b) => a[0].localeCompare(b[0])) } as FinanceMeta;
  },
});
/** Tax configurations selectable on new lines (from Settings → Tax Settings). */
export const useTaxOptions = (enabled = true) => useQuery({ queryKey: ['tax-options'], enabled, staleTime: 60_000, queryFn: () => api.get<TaxOption[]>('/tax-rates/options') });

export const termsLabel = (meta: FinanceMeta | undefined, code?: string | null) => meta?.paymentTerms.find((t) => t.code === code)?.label ?? code ?? '';

export function memberName(members: MemberOption[] | undefined, id?: string | null) {
  if (!id) return 'Unassigned';
  return members?.find((m) => m.id === id)?.name ?? 'Former member';
}
