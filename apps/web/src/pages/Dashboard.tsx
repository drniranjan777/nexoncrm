import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, ArrowRight, Briefcase, CircleDollarSign, Clock, LifeBuoy, MessageSquareHeart, Target, TrendingUp } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, inr, inrCompact, timeAgo } from '@/lib/utils';
import { Badge, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, PageHeader, Stat, Stars, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { BillingHome, RecentUpdates } from '@/components/BillingHome';

interface DashboardData {
  myTasks: { id: string; title: string; dueDate: string | null; priority: string; status: string; type: string }[];
  crm?: { openLeads: number; wonThisMonth: number; pipelineValue: number; hotLeads: { id: string; name: string; company: string | null; score: number; stage: string; nextFollowUpAt: string | null }[] };
  feedback?: { new: number; urgentOpen: number; avgRating90d: number | null; recent: { id: string; referenceNo: string; name: string; ratingOverall: number; status: string; isUrgent: boolean; createdAt: string }[] };
  projects?: { active: number; overdue: number };
  support?: { open: number; overdue: number; assignedToMe: number };
  finance?: { invoicedThisMonth: number; collectedThisMonth: number; outstanding: number; overdue: number; overdueCount: number; collectionsTrend: { month: string; value: number }[] };
}

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

export function Dashboard() {
  const { me, membership, can, hasModule } = useAuth();
  const billing = hasModule('finance') && can('invoices.read', 'reports.financial');
  return (
    <div>
      <div className="mb-6 flex items-center gap-4">
        {membership && <span className="flex size-12 items-center justify-center overflow-hidden rounded-lg border border-line bg-white">{membership.tenant.logoFileId ? <img src={`/api/v1/public/tenants/${membership.tenant.slug}/logo?v=${membership.tenant.logoFileId}`} alt="" className="max-h-10 max-w-10 object-contain object-left" /> : <span className="text-lg font-bold" style={{ color: membership.tenant.brandColor }}>{membership.tenant.name[0]}</span>}</span>}
        <div><h1 className="text-[22px] font-semibold tracking-tight">Hello, {me?.name}</h1><p className="text-sm text-muted">{membership?.tenant.name}</p></div>
      </div>
      <Tabs defaultValue="dashboard">
        <TabsList><TabsTrigger value="dashboard">Dashboard</TabsTrigger>{can('audit.read') && <TabsTrigger value="updates">Recent Updates</TabsTrigger>}</TabsList>
        <TabsContent value="dashboard" className="space-y-8">
          {/* Members without billing access still need a useful landing page. */}
          {billing ? <BillingHome /> : <Overview />}
        </TabsContent>
        {can('audit.read') && <TabsContent value="updates"><RecentUpdates /></TabsContent>}
      </Tabs>
    </div>
  );
}

/** Work overview across CRM, feedback, projects and support. */
export function CrmDashboard() {
  return <Overview />;
}

function Overview() {
  const { me, membership } = useAuth();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<DashboardData>('/dashboard') });
  if (isLoading) return <Card><LoadingBlock rows={8} /></Card>;
  if (error || !data) return <Card><ErrorState error={error} onRetry={refetch} /></Card>;

  const monthLabel = (m: string) => new Date(`${m}-01`).toLocaleDateString('en-IN', { month: 'short' });

  return (
    <div className="space-y-6">
      <PageHeader title={`${greeting()}, ${me?.name.split(' ')[0]}`} description={`Work across ${membership?.tenant.name} today.`} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {data.crm && <Stat label="Open leads" value={data.crm.openLeads} hint={`${inrCompact(data.crm.pipelineValue)} in pipeline`} icon={<Target />} />}
        {data.crm && <Stat label="Won this month" value={data.crm.wonThisMonth} icon={<TrendingUp />} tone={data.crm.wonThisMonth ? 'good' : 'default'} />}
        {data.feedback && <Stat label="New feedback" value={data.feedback.new} hint={data.feedback.avgRating90d ? `Avg ${data.feedback.avgRating90d.toFixed(1)}/5 over 90 days` : undefined} icon={<MessageSquareHeart />} />}
        {data.feedback && <Stat label="Urgent issues open" value={data.feedback.urgentOpen} icon={<AlertTriangle />} tone={data.feedback.urgentOpen ? 'bad' : 'default'} />}
        {data.projects && <Stat label="Active projects" value={data.projects.active} hint={data.projects.overdue ? `${data.projects.overdue} past due date` : 'None overdue'} icon={<Briefcase />} tone={data.projects.overdue ? 'warn' : 'default'} />}
        {data.support && <Stat label="Open tickets" value={data.support.open} hint={`${data.support.assignedToMe} assigned to you`} icon={<LifeBuoy />} />}
        {data.support && <Stat label="Tickets past SLA" value={data.support.overdue} icon={<Clock />} tone={data.support.overdue ? 'bad' : 'default'} />}
        {data.finance && <Stat label="Outstanding" value={inrCompact(data.finance.outstanding)} hint={data.finance.overdueCount ? `${inrCompact(data.finance.overdue)} overdue (${data.finance.overdueCount})` : 'Nothing overdue'} icon={<CircleDollarSign />} tone={data.finance.overdue ? 'warn' : 'default'} />}
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="My open tasks" actions={<Link to="/tasks" className="flex items-center gap-1 text-[13px] font-medium text-brand-700 hover:underline">All tasks <ArrowRight className="size-3.5" /></Link>} />
          {data.myTasks.length === 0 ? <EmptyState title="No open tasks" description="You're all caught up." /> : (
            <ul className="divide-y divide-line">
              {data.myTasks.map((t) => {
                const overdue = t.dueDate && new Date(t.dueDate) < new Date();
                return (
                  <li key={t.id}>
                    <Link to={`/tasks?open=${t.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50">
                      <StatusBadge status={t.priority} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.title}</span>
                      {t.type === 'FOLLOW_UP' && <Badge tone="violet">Follow-up</Badge>}
                      <span className={overdue ? 'text-xs font-medium text-red-600' : 'text-xs text-muted'}>{t.dueDate ? fmtDate(t.dueDate, { day: '2-digit', month: 'short' }) : 'No date'}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {data.crm && (
          <Card>
            <CardHeader title="Highest-scoring leads" description="Heuristic score" actions={<Link to="/pipeline" className="text-[13px] font-medium text-brand-700 hover:underline">Pipeline</Link>} />
            {data.crm.hotLeads.length === 0 ? <EmptyState title="No open leads" /> : (
              <ul className="divide-y divide-line">
                {data.crm.hotLeads.map((l) => (
                  <li key={l.id}>
                    <Link to={`/leads/${l.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-sm font-semibold tabular-nums text-brand-800">{l.score}</span>
                      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{l.name}</span><span className="block truncate text-xs text-muted">{l.company ?? '—'}</span></span>
                      <StatusBadge status={l.stage} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {data.finance && (
          <Card className="xl:col-span-2">
            <CardHeader title="Collections" description={`${inr(data.finance.collectedThisMonth)} collected · ${inr(data.finance.invoicedThisMonth)} invoiced this month`} />
            <div className="h-64 p-4">
              {data.finance.collectionsTrend.length === 0 ? <EmptyState title="No payments recorded yet" /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.finance.collectionsTrend.map((d) => ({ ...d, label: monthLabel(d.month) }))} margin={{ left: 8, right: 8 }}>
                    <CartesianGrid vertical={false} stroke="#eef0f3" />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} stroke="#64748b" />
                    <YAxis tickLine={false} axisLine={false} fontSize={12} stroke="#64748b" tickFormatter={(v) => inrCompact(v)} width={64} />
                    <Tooltip formatter={(v) => [inr(v), 'Collected']} cursor={{ fill: '#f1f5f9' }} contentStyle={{ borderRadius: 8, borderColor: '#e6e8ec', fontSize: 13 }} />
                    <Bar dataKey="value" fill="#1d42b8" radius={[4, 4, 0, 0]} maxBarSize={40} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </Card>
        )}

        {data.feedback && (
          <Card>
            <CardHeader title="Recent feedback" actions={<Link to="/feedback" className="text-[13px] font-medium text-brand-700 hover:underline">View all</Link>} />
            {data.feedback.recent.length === 0 ? <EmptyState title="No feedback yet" description="Share a feedback link from a project to start collecting." /> : (
              <ul className="divide-y divide-line">
                {data.feedback.recent.map((f) => (
                  <li key={f.id}>
                    <Link to={`/feedback/${f.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50">
                      <Stars value={f.ratingOverall} />
                      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{f.name}</span><span className="block text-xs text-muted">{f.referenceNo} · {timeAgo(f.createdAt)}</span></span>
                      {f.isUrgent ? <Badge tone="red">Urgent</Badge> : <StatusBadge status={f.status} />}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
