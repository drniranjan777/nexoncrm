import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, Folder, Printer, Star } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { cn, fmtDate, inr, toDateInput } from '@/lib/utils';
import { Card, EmptyState, ErrorState, Input, LoadingBlock, PageHeader, SearchInput, Table, TBody, TD, TH, THead, Button } from '@/components/ui';

interface CatalogItem { key: string; group: string; title: string; ranged: boolean }
const FAV_KEY = 'nx.report-favourites';
const loadFavs = (): string[] => { try { return JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]'); } catch { return []; } };

export function ReportsCenterPage() {
  const catalog = useQuery({ queryKey: ['reports-catalog'], queryFn: () => api.get<CatalogItem[]>('/reports-center/catalog') });
  const [q, setQ] = useState('');
  const [favs, setFavs] = useState<string[]>(loadFavs);
  const toggle = (k: string) => {
    const next = favs.includes(k) ? favs.filter((x) => x !== k) : [...favs, k];
    setFavs(next);
    try { localStorage.setItem(FAV_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };
  const groups = useMemo(() => {
    const items = (catalog.data ?? []).filter((r) => r.title.toLowerCase().includes(q.toLowerCase()));
    const g = new Map<string, CatalogItem[]>();
    const fav = items.filter((r) => favs.includes(r.key));
    if (fav.length && !q) g.set('Favourites', fav);
    for (const r of items) g.set(r.group, [...(g.get(r.group) ?? []), r]);
    return [...g.entries()];
  }, [catalog.data, q, favs]);
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Reports Center" description="Sales, receivables, payments, taxes, expenses, projects and activity." />
      <SearchInput value={q} onChange={setQ} placeholder="Search reports" className="mb-6 max-w-xl" />
      {catalog.isLoading ? <Card><LoadingBlock /></Card> : catalog.error ? <Card><ErrorState error={catalog.error} /></Card> : !groups.length ? <Card><EmptyState title="No reports match" /></Card> : (
        <Card className="p-6">
          <div className="space-y-8">
            {groups.map(([group, items]) => (
              <section key={group}>
                <h2 className="mb-2 flex items-center gap-2 text-[15px] font-semibold">{group === 'Favourites' ? <Star className="size-4 fill-amber-400 text-amber-400" /> : <Folder className="size-4 text-slate-400" />}{group}</h2>
                <ul className="grid gap-x-10 sm:grid-cols-2">
                  {items.map((r) => (
                    <li key={r.key} className="flex items-center justify-between border-b border-line/70 py-2">
                      <Link to={`/reports-center/${r.key}`} className="text-sm text-brand-700 hover:underline">{r.title}</Link>
                      <button onClick={() => toggle(r.key)} aria-label={favs.includes(r.key) ? 'Remove from favourites' : 'Add to favourites'}><Star className={cn('size-4', favs.includes(r.key) ? 'fill-amber-400 text-amber-400' : 'text-slate-300 hover:text-slate-500')} /></button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

interface ReportResult { title: string; group: string; company: string; from: string | null; to: string; columns: { key: string; label: string; type?: string }[]; rows: Record<string, unknown>[]; totals?: Record<string, unknown> }

const cell = (v: unknown, type?: string) => {
  if (v === null || v === undefined || v === '') return '—';
  if (type === 'money') return inr(v);
  if (type === 'date') return fmtDate(v as string);
  if (type === 'number') return Number(v).toLocaleString('en-IN');
  return String(v).replace(/_/g, ' ');
};

export function ReportViewerPage() {
  const { key } = useParams();
  const now = new Date();
  const fyStart = new Date(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1, 3, 1);
  const [from, setFrom] = useState(toDateInput(fyStart));
  const [to, setTo] = useState(toDateInput(now));
  const r = useQuery({ queryKey: ['report-run', key, from, to], queryFn: () => api.get<ReportResult>(`/reports-center/${key}`, { from, to }) });
  return (
    <div>
      <PageHeader breadcrumb={<Link to="/reports-center" className="hover:underline">Reports Center</Link>} title={r.data?.title ?? 'Report'}
        actions={<div className="no-print flex flex-wrap items-center gap-2">
          {r.data?.from !== null && <><Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" /><span className="text-sm text-muted">to</span></>}
          <Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} aria-label={r.data?.from !== null ? 'To' : 'As of'} />
          <Button variant="secondary" onClick={() => api.download(`/reports-center/${key}`, `${key}.csv`, { from, to, format: 'csv' }).catch((e) => toast.error(errorMessage(e)))}><Download /> Export CSV</Button>
          <Button variant="secondary" onClick={() => window.print()}><Printer /> Print</Button>
        </div>} />
      <Card>
        {r.isLoading ? <LoadingBlock /> : r.error ? <ErrorState error={r.error} onRetry={r.refetch} /> : (
          <>
            <div className="border-b border-line px-5 py-4 text-center">
              <p className="text-sm text-muted">{r.data!.company}</p>
              <p className="text-lg font-semibold">{r.data!.title}</p>
              <p className="text-xs text-muted">{r.data!.from ? `From ${fmtDate(r.data!.from)} to ${fmtDate(r.data!.to)}` : `As of ${fmtDate(r.data!.to)}`}</p>
            </div>
            {!r.data!.rows.length ? <EmptyState title="No data for this period" /> : (
              <Table>
                <THead><tr>{r.data!.columns.map((c) => <TH key={c.key} className={cn(['money', 'number'].includes(c.type ?? '') && 'text-right')}>{c.label}</TH>)}</tr></THead>
                <TBody>
                  {r.data!.rows.map((row, i) => <tr key={i}>{r.data!.columns.map((c) => <TD key={c.key} className={cn(['money', 'number'].includes(c.type ?? '') && 'text-right tabular-nums')}>{cell(row[c.key], c.type)}</TD>)}</tr>)}
                  {r.data!.totals && <tr className="bg-slate-50 font-semibold">{r.data!.columns.map((c, i) => <TD key={c.key} className={cn(['money', 'number'].includes(c.type ?? '') && 'text-right tabular-nums')}>{i === 0 ? 'Total' : c.key in r.data!.totals! ? cell(r.data!.totals![c.key], c.type) : ''}</TD>)}</tr>}
                </TBody>
              </Table>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
