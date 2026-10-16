import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, inr, inrCompact } from '@/lib/utils';
import { Card, CardHeader, EmptyState, ErrorState, LoadingBlock, Table, TBody, TD, TH, THead } from './ui';

interface BillingHomeData {
  receivables: { total: number; current: number; d1_15: number; d16_30: number; d31_45: number; d45plus: number };
  fiscalYear: { from: string; to: string };
  monthly: { key: string; label: string; sales: number; receipts: number; expenses: number }[];
  totals: { sales: number; receipts: number; expenses: number };
  topExpenses: { name: string; total: number }[];
  salesReceiptsDues: { label: string; sales: number; receipts: number; due: number }[];
  projects: { id: string; name: string; code: string; customer: string | null; unbilledHours: number }[];
}

const BUCKETS: { key: keyof BillingHomeData['receivables']; label: string; color: string; sub: string }[] = [
  { key: 'current', label: 'Current', color: '#3b6ef5', sub: 'Not yet due' },
  { key: 'd1_15', label: 'Overdue', color: '#fbbf24', sub: '1-15 Days' },
  { key: 'd16_30', label: '', color: '#f59e0b', sub: '16-30 Days' },
  { key: 'd31_45', label: '', color: '#f97316', sub: '31-45 Days' },
  { key: 'd45plus', label: '', color: '#ea580c', sub: 'Above 45 days' },
];

export function BillingHome() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['billing-home'], queryFn: () => api.get<BillingHomeData>('/dashboard/billing') });
  if (q.isLoading) return <Card><LoadingBlock rows={6} /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} onRetry={q.refetch} /></Card>;
  const d = q.data;
  const total = d.receivables.total || 1;
  const fyLabel = `${new Date(d.fiscalYear.from).getFullYear()}-${String(new Date(d.fiscalYear.to).getFullYear()).slice(2)}`;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Total Receivables" actions={can('invoices.create') && <Link to="/invoices/new" className="flex items-center gap-1 text-[13px] font-medium text-brand-700 hover:underline"><Plus className="size-3.5" /> New</Link>} />
        <div className="p-5">
          <p className="text-xs text-muted">Total unpaid invoices {inr(d.receivables.total)}</p>
          <div className="mt-2 flex h-3 overflow-hidden rounded-full bg-slate-100" role="img" aria-label="Receivables by age">
            {BUCKETS.map((b) => d.receivables[b.key] > 0 && <div key={b.key} style={{ width: `${(d.receivables[b.key] / total) * 100}%`, background: b.color }} title={`${b.sub}: ${inr(d.receivables[b.key])}`} />)}
          </div>
          <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-5">
            {BUCKETS.map((b, i) => (
              <div key={b.key} className={i === 1 ? 'sm:border-l sm:border-line sm:pl-4' : ''}>
                <p className={cn('h-4 text-[11px] font-semibold uppercase tracking-wide', i === 0 ? 'text-brand-600' : 'text-orange-700')}>{b.label}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">{inr(d.receivables[b.key])}</p>
                <p className="text-xs text-muted">{b.sub}</p>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Sales and Expenses" description={`Financial year ${fyLabel}`} />
        <div className="grid lg:grid-cols-[1fr_220px]">
          <div className="h-72 p-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={d.monthly} margin={{ left: 4, right: 8 }}>
                <CartesianGrid vertical={false} stroke="var(--color-line)" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} stroke="var(--color-muted)" interval={1} />
                <YAxis tickLine={false} axisLine={false} fontSize={11} stroke="var(--color-muted)" tickFormatter={(v) => inrCompact(v)} width={60} />
                <Tooltip formatter={(v) => inr(v)} cursor={{ fill: 'var(--color-slate-100)' }} contentStyle={{ borderRadius: 8, borderColor: 'var(--color-line)', background: 'var(--color-surface)', color: 'var(--color-ink)', fontSize: 13 }} />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-slate-600">{v}</span>} />
                <Bar dataKey="sales" name="Sales" fill="#3b6ef5" radius={[3, 3, 0, 0]} maxBarSize={14} />
                <Bar dataKey="receipts" name="Receipts" fill="#22c55e" radius={[3, 3, 0, 0]} maxBarSize={14} />
                <Bar dataKey="expenses" name="Expenses" fill="#ef4444" radius={[3, 3, 0, 0]} maxBarSize={14} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="flex flex-col justify-center gap-5 border-t border-line p-5 text-right lg:border-l lg:border-t-0">
            <div><p className="text-xs text-brand-600">Total Sales</p><p className="text-xl font-semibold tabular-nums">{inr(d.totals.sales)}</p></div>
            <div><p className="text-xs text-emerald-700">Total Receipts</p><p className="text-xl font-semibold tabular-nums">{inr(d.totals.receipts)}</p></div>
            <div><p className="text-xs text-red-600">Total Expenses</p><p className="text-xl font-semibold tabular-nums">{inr(d.totals.expenses)}</p></div>
          </div>
        </div>
        <p className="border-t border-line px-5 py-2 text-[11px] text-muted">* Sales value is inclusive of tax.</p>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Projects" description="Active projects and unbilled hours" />
          {!d.projects.length ? <EmptyState title="No active projects" /> : (
            <ul className="divide-y divide-line">{d.projects.map((p) => (
              <li key={p.id}><Link to={`/projects/${p.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50"><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{p.name}</span><span className="text-xs text-muted">{p.customer ?? 'Internal'}</span></span><span className="text-xs text-muted">{p.unbilledHours} unbilled hrs</span></Link></li>
            ))}</ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Top Expenses" description="This financial year" />
          {!d.topExpenses.length ? <EmptyState title="No expenses recorded this financial year" /> : (
            <ul className="space-y-3 p-5">{d.topExpenses.map((e) => (
              <li key={e.name}><div className="flex justify-between text-sm"><span>{e.name}</span><span className="tabular-nums">{inr(e.total)}</span></div><div className="mt-1 h-1.5 rounded-full bg-slate-100"><div className="h-full rounded-full bg-red-400" style={{ width: `${(e.total / d.topExpenses[0].total) * 100}%` }} /></div></li>
            ))}</ul>
          )}
        </Card>
      </div>

      <Card className="lg:w-1/2">
        <CardHeader title="Sales, Receipts, and Dues" />
        <Table><THead><tr><TH /><TH className="text-right">Sales</TH><TH className="text-right">Receipts</TH><TH className="text-right">Due</TH></tr></THead><TBody>
          {d.salesReceiptsDues.map((r) => <tr key={r.label}><TD className="font-medium">{r.label}</TD><TD className="text-right tabular-nums">{inr(r.sales)}</TD><TD className="text-right tabular-nums">{inr(r.receipts)}</TD><TD className="text-right tabular-nums">{inr(r.due)}</TD></tr>)}
        </TBody></Table>
      </Card>
    </div>
  );
}

export function RecentUpdates() {
  const q = useQuery({ queryKey: ['/audit-logs', 'recent'], queryFn: () => api.get<{ items: { id: string; action: string; actorEmail: string | null; entityType: string | null; createdAt: string; meta: Record<string, unknown> }[] }>('/audit-logs', { pageSize: 40 }) });
  if (q.isLoading) return <Card><LoadingBlock /></Card>;
  if (q.error) return <Card><ErrorState error={q.error} /></Card>;
  return (
    <Card>
      <ul className="divide-y divide-line">
        {q.data?.items.map((a) => (
          <li key={a.id} className="flex items-start gap-3 px-5 py-3 text-sm">
            <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand-500" />
            <span className="flex-1"><span className="font-medium">{a.action.replace(/[._]/g, ' ')}</span>{a.entityType && <span className="text-muted"> · {a.entityType}</span>}<span className="block text-xs text-muted">{a.actorEmail ?? 'System'} · {new Date(a.createdAt).toLocaleString('en-IN')}</span></span>
          </li>
        ))}
        {!q.data?.items.length && <li className="p-6 text-center text-sm text-muted">No recent activity.</li>}
      </ul>
    </Card>
  );
}
