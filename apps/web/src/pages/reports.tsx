import { useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts';
import { api } from '@/lib/api';
import { inr, inrCompact, titleCase, toDateInput } from '@/lib/utils';
import { Card, CardHeader, EmptyState, ErrorState, Input, LoadingBlock, PageHeader, Stat, Table, TBody, TD, TH, THead } from '@/components/ui';

const PALETTE = ['#1d42b8', '#3b6ef5', '#93b4fd', '#0f766e', '#f59e0b', '#ef4444', '#8b5cf6', '#64748b', '#14b8a6'];
const grid = <CartesianGrid vertical={false} stroke="var(--color-line)" />;
const axis = { tickLine: false, axisLine: false, fontSize: 12, stroke: 'var(--color-muted)' } as const;
const tooltipStyle = { borderRadius: 8, borderColor: 'var(--color-line)', background: 'var(--color-surface)', color: 'var(--color-ink)', fontSize: 13 };
const month = (m: string) => new Date(`${m}-01`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });

function ChartCard({ title, description, children, empty, className }: { title: string; description?: string; children: ReactNode; empty?: boolean; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader title={title} description={description} />
      <div className="h-72 p-4">{empty ? <EmptyState title="No data for this period" /> : <ResponsiveContainer width="100%" height="100%">{children as React.ReactElement}</ResponsiveContainer>}</div>
    </Card>
  );
}

function SimpleBar({ data, x, y, money, color = PALETTE[0], horizontal }: { data: Record<string, unknown>[]; x: string; y: string; money?: boolean; color?: string; horizontal?: boolean }) {
  return horizontal ? (
    <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
      {grid}<XAxis type="number" {...axis} tickFormatter={money ? (v) => inrCompact(v) : undefined} /><YAxis type="category" dataKey={x} {...axis} width={140} />
      <Tooltip contentStyle={tooltipStyle} formatter={(v) => (money ? inr(v) : v)} cursor={{ fill: 'var(--color-slate-100)' }} /><Bar dataKey={y} fill={color} radius={[0, 4, 4, 0]} maxBarSize={22} />
    </BarChart>
  ) : (
    <BarChart data={data} margin={{ left: 8, right: 8 }}>
      {grid}<XAxis dataKey={x} {...axis} /><YAxis {...axis} tickFormatter={money ? (v) => inrCompact(v) : undefined} width={money ? 64 : 32} allowDecimals={false} />
      <Tooltip contentStyle={tooltipStyle} formatter={(v) => (money ? inr(v) : v)} cursor={{ fill: 'var(--color-slate-100)' }} /><Bar dataKey={y} fill={color} radius={[4, 4, 0, 0]} maxBarSize={40} />
    </BarChart>
  );
}

function Donut({ data, name, value }: { data: Record<string, unknown>[]; name: string; value: string }) {
  return (
    <PieChart>
      <Pie data={data} dataKey={value} nameKey={name} innerRadius="55%" outerRadius="80%" paddingAngle={2}>{data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}</Pie>
      <Tooltip contentStyle={tooltipStyle} /><Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-slate-600">{v}</span>} />
    </PieChart>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type R = any;

function CrmReport({ d }: { d: R }) {
  const open = d.byStage.filter((s: R) => !['WON', 'LOST'].includes(s.stage)).reduce((a: number, s: R) => a + s.value, 0);
  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Win rate" value={d.winRate != null ? `${d.winRate}%` : '—'} hint="Won ÷ (won + lost)" />
        <Stat label="Open pipeline" value={inrCompact(open)} />
        <Stat label="Leads won" value={d.byStage.find((s: R) => s.stage === 'WON')?.count ?? 0} tone="good" />
        <Stat label="Leads lost" value={d.byStage.find((s: R) => s.stage === 'LOST')?.count ?? 0} tone="bad" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard title="Pipeline by stage" description="Lead count" empty={!d.byStage.length}><SimpleBar data={d.byStage.map((s: R) => ({ ...s, stage: titleCase(s.stage) }))} x="stage" y="count" horizontal /></ChartCard>
        <ChartCard title="Leads created" empty={!d.leadsCreated.length}><SimpleBar data={d.leadsCreated.map((m: R) => ({ ...m, month: month(m.month) }))} x="month" y="value" /></ChartCard>
        <ChartCard title="Lead sources" empty={!d.bySource.length}><Donut data={d.bySource} name="source" value="count" /></ChartCard>
        <ChartCard title="Lost reasons" empty={!d.lostReasons.length}><SimpleBar data={d.lostReasons} x="reason" y="count" horizontal color={PALETTE[5]} /></ChartCard>
      </div>
      <Card>
        <CardHeader title="Salesperson performance" description="Leads created in this period" />
        <Table><THead><tr><TH>Salesperson</TH><TH className="text-right">Leads</TH><TH className="text-right">Won</TH><TH className="text-right">Lost</TH><TH className="text-right">Win rate</TH></tr></THead><TBody>
          {d.byOwner.map((o: R) => <tr key={o.name}><TD className="font-medium">{o.name}</TD><TD className="text-right">{o.total}</TD><TD className="text-right">{o.won}</TD><TD className="text-right">{o.lost}</TD><TD className="text-right">{o.won + o.lost ? `${Math.round((o.won / (o.won + o.lost)) * 100)}%` : '—'}</TD></tr>)}
        </TBody></Table>
      </Card>
    </>
  );
}

function FeedbackReport({ d }: { d: R }) {
  const avg = d.averages;
  const radar = [['Overall', avg.ratingOverall], ['Communication', avg.ratingCommunication], ['Quality', avg.ratingQuality], ['Timeliness', avg.ratingTimeliness], ['Technical', avg.ratingTechnical]].filter(([, v]) => v != null).map(([k, v]) => ({ dimension: k, rating: Math.round((v as number) * 10) / 10 }));
  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Submissions" value={d.total} />
        <Stat label="Average rating" value={avg.ratingOverall ? `${avg.ratingOverall.toFixed(2)}/5` : '—'} />
        <Stat label="Satisfied (4–5 stars)" value={d.satisfiedPct != null ? `${d.satisfiedPct}%` : '—'} tone="good" />
        <Stat label="Avg. resolution time" value={d.avgResolutionHours != null ? `${d.avgResolutionHours} h` : '—'} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard title="Average rating over time" empty={!d.trend.length}>
          <LineChart data={d.trend.map((m: R) => ({ ...m, month: month(m.month), value: Math.round(m.value * 100) / 100 }))} margin={{ left: 8, right: 16 }}>
            {grid}<XAxis dataKey="month" {...axis} /><YAxis domain={[1, 5]} {...axis} width={28} /><Tooltip contentStyle={tooltipStyle} /><Line type="monotone" dataKey="value" name="Avg rating" stroke={PALETTE[0]} strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ChartCard>
        <ChartCard title="Rating breakdown" description="Average by dimension" empty={!radar.length}><SimpleBar data={radar} x="dimension" y="rating" /></ChartCard>
        <ChartCard title="Rating distribution" empty={!d.total}><SimpleBar data={d.ratingDistribution.map((r: R) => ({ ...r, rating: `${r.rating}★` }))} x="rating" y="count" /></ChartCard>
        <ChartCard title="Sentiment" empty={!d.bySentiment.length}><Donut data={d.bySentiment.map((s: R) => ({ ...s, sentiment: titleCase(s.sentiment) }))} name="sentiment" value="count" /></ChartCard>
        <ChartCard title="Common improvement topics" description="Auto-detected from comments" empty={!d.topics.length}><SimpleBar data={d.topics} x="topic" y="count" horizontal color={PALETTE[4]} /></ChartCard>
        <ChartCard title="By service" description="Average rating" empty={!d.byCategory.length}><SimpleBar data={d.byCategory.map((c: R) => ({ category: c.category, avg: Math.round((c.avgRating ?? 0) * 10) / 10 }))} x="category" y="avg" horizontal color={PALETTE[3]} /></ChartCard>
      </div>
    </>
  );
}

function ProjectsReport({ d }: { d: R }) {
  return (
    <>
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard title="Projects by status" empty={!d.byStatus.length}><Donut data={d.byStatus.map((s: R) => ({ ...s, status: titleCase(s.status) }))} name="status" value="count" /></ChartCard>
        <ChartCard title="Project tasks by status" empty={!d.tasksByStatus.length}><SimpleBar data={d.tasksByStatus.map((s: R) => ({ ...s, status: titleCase(s.status) }))} x="status" y="count" /></ChartCard>
        <ChartCard title="Open task workload" empty={!d.workload.length}><SimpleBar data={d.workload} x="name" y="open" horizontal /></ChartCard>
        <Card>
          <CardHeader title="Overdue projects" />
          {!d.overdue.length ? <EmptyState title="No overdue projects" /> : <ul className="divide-y divide-line">{d.overdue.map((p: R) => <li key={p.id} className="flex justify-between px-5 py-3 text-sm"><span className="font-medium">{p.code} · {p.name}</span><span className="text-red-600">{new Date(p.dueDate).toLocaleDateString('en-IN')}</span></li>)}</ul>}
        </Card>
      </div>
    </>
  );
}

function SupportReport({ d }: { d: R }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <Stat label="Tickets" value={d.total} />
        <Stat label="Avg. resolution time" value={d.avgResolutionHours != null ? `${d.avgResolutionHours} h` : '—'} />
        <Stat label="SLA breached" value={d.slaBreachPct != null ? `${d.slaBreachPct}%` : '—'} tone={d.slaBreachPct > 20 ? 'bad' : 'default'} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard title="Tickets created" empty={!d.trend.length}><SimpleBar data={d.trend.map((m: R) => ({ ...m, month: month(m.month) }))} x="month" y="value" /></ChartCard>
        <ChartCard title="By category" empty={!d.byCategory.length}><Donut data={d.byCategory} name="category" value="count" /></ChartCard>
        <ChartCard title="By priority" empty={!d.byPriority.length}><SimpleBar data={d.byPriority.map((s: R) => ({ ...s, priority: titleCase(s.priority) }))} x="priority" y="count" /></ChartCard>
        <ChartCard title="By status" empty={!d.byStatus.length}><SimpleBar data={d.byStatus.map((s: R) => ({ ...s, status: titleCase(s.status) }))} x="status" y="count" /></ChartCard>
      </div>
    </>
  );
}

function SalesReport({ d }: { d: R }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <Stat label="Revenue (taxable)" value={inrCompact(d.revenueTrend.reduce((s: number, m: R) => s + m.value, 0))} />
        <Stat label="Quotations" value={d.quotations.reduce((s: number, q: R) => s + q.count, 0)} />
        <Stat label="Quote acceptance" value={d.quoteConversionPct != null ? `${d.quoteConversionPct}%` : '—'} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard title="Revenue by month" description="Taxable value of issued invoices" empty={!d.revenueTrend.length}><SimpleBar data={d.revenueTrend.map((m: R) => ({ ...m, month: month(m.month) }))} x="month" y="value" money /></ChartCard>
        <ChartCard title="Revenue by service" empty={!d.byService.length}><Donut data={d.byService} name="service" value="value" /></ChartCard>
        <ChartCard title="Top customers" empty={!d.topCustomers.length}><SimpleBar data={d.topCustomers} x="name" y="value" money horizontal /></ChartCard>
        <ChartCard title="Quotations by status" description="Value" empty={!d.quotations.length}><SimpleBar data={d.quotations.map((q: R) => ({ ...q, status: titleCase(q.status) }))} x="status" y="value" money /></ChartCard>
      </div>
    </>
  );
}

function FinancialReport({ d }: { d: R }) {
  const t = d.gstSummary.reduce((a: R, m: R) => ({ taxable: a.taxable + m.taxable, cgst: a.cgst + m.cgst, sgst: a.sgst + m.sgst, igst: a.igst + m.igst, total: a.total + m.total }), { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 });
  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Output GST" value={inr(t.cgst + t.sgst + t.igst)} hint="Before credit notes" />
        <Stat label="Credit notes" value={inr(d.creditNotes.total)} hint={`${d.creditNotes.count} issued`} />
        <Stat label="Collected" value={inr(d.collections.reduce((s: number, m: R) => s + m.value, 0))} tone="good" />
        <Stat label="Outstanding" value={inr(d.aging.reduce((s: number, a: R) => s + a.value, 0))} tone="warn" />
      </div>
      <Card>
        <CardHeader title="GST summary" description="Issued invoices by month. Use alongside your GSTR filings; review with your accountant." />
        <Table><THead><tr><TH>Month</TH><TH className="text-right">Taxable value</TH><TH className="text-right">CGST</TH><TH className="text-right">SGST</TH><TH className="text-right">IGST</TH><TH className="text-right">Invoice total</TH></tr></THead><TBody>
          {d.gstSummary.map((m: R) => <tr key={m.month}><TD>{month(m.month)}</TD><TD className="text-right tabular-nums">{inr(m.taxable)}</TD><TD className="text-right tabular-nums">{inr(m.cgst)}</TD><TD className="text-right tabular-nums">{inr(m.sgst)}</TD><TD className="text-right tabular-nums">{inr(m.igst)}</TD><TD className="text-right tabular-nums">{inr(m.total)}</TD></tr>)}
          <tr className="bg-slate-50 font-semibold"><TD>Total</TD><TD className="text-right tabular-nums">{inr(t.taxable)}</TD><TD className="text-right tabular-nums">{inr(t.cgst)}</TD><TD className="text-right tabular-nums">{inr(t.sgst)}</TD><TD className="text-right tabular-nums">{inr(t.igst)}</TD><TD className="text-right tabular-nums">{inr(t.total)}</TD></tr>
          {d.creditNotes.count > 0 && <tr className="text-red-700"><TD>Less: credit notes</TD><TD className="text-right tabular-nums">-{inr(d.creditNotes.taxableTotal)}</TD><TD className="text-right tabular-nums">-{inr(d.creditNotes.cgstTotal)}</TD><TD className="text-right tabular-nums">-{inr(d.creditNotes.sgstTotal)}</TD><TD className="text-right tabular-nums">-{inr(d.creditNotes.igstTotal)}</TD><TD className="text-right tabular-nums">-{inr(d.creditNotes.total)}</TD></tr>}
        </TBody></Table>
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard title="Receivables aging" description="Outstanding balance by days overdue" empty={!d.aging.some((a: R) => a.value)}><SimpleBar data={d.aging} x="bucket" y="value" money color={PALETTE[4]} /></ChartCard>
        <ChartCard title="Collections by month" empty={!d.collections.length}><SimpleBar data={d.collections.map((m: R) => ({ ...m, month: month(m.month) }))} x="month" y="value" money color={PALETTE[3]} /></ChartCard>
        <ChartCard title="Payment methods" empty={!d.byMethod.length}><Donut data={d.byMethod.map((m: R) => ({ ...m, method: titleCase(m.method) }))} name="method" value="value" /></ChartCard>
      </div>
    </>
  );
}

const REPORTS: Record<string, { title: string; description: string; C: (p: { d: R }) => ReactNode; ranged: boolean }> = {
  crm: { title: 'CRM reports', description: 'Pipeline health, sources and win rates.', C: CrmReport, ranged: true },
  feedback: { title: 'Feedback reports', description: 'Satisfaction, sentiment and improvement themes.', C: FeedbackReport, ranged: true },
  projects: { title: 'Project reports', description: 'Delivery status and team workload.', C: ProjectsReport, ranged: false },
  support: { title: 'Support reports', description: 'Ticket volume, resolution time and SLA.', C: SupportReport, ranged: true },
  sales: { title: 'Sales reports', description: 'Revenue, quotations and top customers.', C: SalesReport, ranged: true },
  financial: { title: 'Financial reports', description: 'GST summary, receivables and collections.', C: FinancialReport, ranged: true },
};

export function ReportsPage() {
  const { type = 'crm' } = useParams();
  const cfg = REPORTS[type] ?? REPORTS.crm;
  const [from, setFrom] = useState(toDateInput(new Date(Date.now() - 180 * 86_400_000)));
  const [to, setTo] = useState(toDateInput(new Date()));
  const q = useQuery({ queryKey: ['report', type, from, to], queryFn: () => api.get<R>(`/reports/${type}`, cfg.ranged ? { from, to: `${to}T23:59:59` } : undefined) });
  return (
    <div className="space-y-6">
      <PageHeader title={cfg.title} description={cfg.description}
        actions={cfg.ranged && <div className="flex items-center gap-2 text-sm"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" aria-label="From" /><span className="text-muted">to</span><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" aria-label="To" /></div>} />
      {q.isLoading ? <Card><LoadingBlock rows={8} /></Card> : q.error ? <Card><ErrorState error={q.error} onRetry={q.refetch} /></Card> : <cfg.C d={q.data} />}
    </div>
  );
}
