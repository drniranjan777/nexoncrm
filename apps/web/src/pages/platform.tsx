import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Building2, Copy, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction, useList } from '@/lib/hooks';
import type { AuditLog } from '@/lib/types';
import { fmtDate, fmtDateTime, inr, toDateInput } from '@/lib/utils';
import {
  Badge, Button, Card, CardHeader, Checkbox, DescList, Dialog, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Pagination,
  SearchInput, Select, Stat, StatusBadge, Switch, Table, TBody, TD, TH, THead, Toolbar, TR,
} from '@/components/ui';
import { AuditTable } from './settings';

interface Plan { id: string; code: string; name: string; priceMonthly: string; maxUsers: number; maxCustomers: number; storageMb: number; aiRequests: number; modules: string[]; active: boolean; _count?: { tenants: number } }
interface TenantRow { id: string; name: string; slug: string; status: string; trialEndsAt: string | null; currentPeriodEnd: string | null; createdAt: string; storageUsedBytes: number; plan: { id: string; name: string; code: string } | null; _count: { memberships: number; customers: number; invoices: number } }

export function PlatformOverview() {
  const q = useQuery({ queryKey: ['platform-overview'], queryFn: () => api.get<{ tenantsByStatus: { status: string; count: number }[]; tenantsByPlan: { plan: string; count: number }[]; activeUsers: number; newTenantsThisMonth: number; storageUsedMb: number; aiRequestsThisMonth: number; feedbackThisMonth: number; invoicesIssuedThisMonth: number; estimatedMrr: number }>('/platform/overview') });
  if (q.isLoading) return <Card><LoadingBlock /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>;
  const d = q.data;
  const total = d.tenantsByStatus.reduce((s, x) => s + x.count, 0);
  return (
    <div className="space-y-6">
      <PageHeader title="Platform overview" description="Usage across all tenants. Tenant business data is not visible here." />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Tenants" value={total} hint={`${d.newTenantsThisMonth} new this month`} />
        <Stat label="Active users" value={d.activeUsers} />
        <Stat label="Estimated MRR" value={inr(d.estimatedMrr)} hint="List price × plan assignments" />
        <Stat label="Storage used" value={`${d.storageUsedMb} MB`} />
        <Stat label="AI requests (month)" value={d.aiRequestsThisMonth} />
        <Stat label="Feedback (month)" value={d.feedbackThisMonth} />
        <Stat label="Invoices issued (month)" value={d.invoicesIssuedThisMonth} />
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <Card><CardHeader title="Tenants by status" /><ul className="divide-y divide-line">{d.tenantsByStatus.map((s) => <li key={s.status} className="flex justify-between px-5 py-3 text-sm"><StatusBadge status={s.status} /><span className="tabular-nums">{s.count}</span></li>)}</ul></Card>
        <Card><CardHeader title="Tenants by plan" /><ul className="divide-y divide-line">{d.tenantsByPlan.map((s) => <li key={s.plan} className="flex justify-between px-5 py-3 text-sm"><span>{s.plan}</span><span className="tabular-nums">{s.count}</span></li>)}</ul></Card>
      </div>
    </div>
  );
}

export function PlatformTenants() {
  const navigate = useNavigate();
  const list = useList<TenantRow>('/platform/tenants', { status: '' });
  const plans = useQuery({ queryKey: ['platform-plans'], queryFn: () => api.get<{ plans: Plan[]; modules: string[] }>('/platform/plans') });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', slug: '', ownerEmail: '', planCode: 'starter', trialDays: '14', activate: false });
  const [link, setLink] = useState<string | null>(null);
  const create = useAction(() => api.post<{ tenant: { id: string }; inviteLink?: string }>('/platform/tenants', { ...f, slug: f.slug || undefined, trialDays: Number(f.trialDays) }), {
    success: 'Tenant created', invalidate: [['/platform/tenants']], onSuccess: (r) => { if (r.inviteLink) setLink(r.inviteLink); else { setOpen(false); navigate(`/platform/tenants/${r.tenant.id}`); } },
  });
  return (
    <>
      <PageHeader title="Tenants" actions={<Button onClick={() => { setLink(null); setOpen(true); }}><Plus /> New tenant</Button>} />
      <Card>
        <Toolbar>
          <SearchInput value={list.q} onChange={list.setQ} placeholder="Search tenants" className="w-72" />
          <Select value={list.filters.status} onChange={(e) => list.setFilter('status', e.target.value)} className="w-40"><option value="">All statuses</option>{['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'].map((s) => <option key={s} value={s}>{s}</option>)}</Select>
        </Toolbar>
        {list.isLoading ? <LoadingBlock /> : !list.data?.items.length ? <EmptyState icon={<Building2 />} title="No tenants" /> : (
          <>
            <Table><THead><tr><TH>Tenant</TH><TH>Plan</TH><TH>Status</TH><TH className="text-right">Members</TH><TH className="text-right">Customers</TH><TH className="text-right">Storage</TH><TH>Created</TH></tr></THead><TBody>
              {list.data.items.map((t) => (
                <TR key={t.id} onClick={() => navigate(`/platform/tenants/${t.id}`)}>
                  <TD><p className="font-medium">{t.name}</p><p className="text-xs text-muted">{t.slug}</p></TD><TD>{t.plan?.name ?? '—'}</TD>
                  <TD><StatusBadge status={t.status} />{t.status === 'TRIAL' && t.trialEndsAt && <span className="ml-2 text-xs text-muted">until {fmtDate(t.trialEndsAt)}</span>}</TD>
                  <TD className="text-right tabular-nums">{t._count.memberships}</TD><TD className="text-right tabular-nums">{t._count.customers}</TD>
                  <TD className="text-right tabular-nums">{(Number(t.storageUsedBytes) / 1048576).toFixed(1)} MB</TD><TD className="text-slate-600">{fmtDate(t.createdAt)}</TD>
                </TR>
              ))}
            </TBody></Table>
            <Pagination page={list.page} pages={list.data.pages} total={list.data.total} onPage={list.setPage} />
          </>
        )}
      </Card>
      <Dialog open={open} onOpenChange={setOpen} title="Create tenant"
        footer={link ? <Button onClick={() => setOpen(false)}>Done</Button> : <><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => create.mutate()} loading={create.isPending} disabled={!f.name || !f.ownerEmail}>Create</Button></>}>
        {link ? (
          <div className="space-y-3"><p className="text-sm text-slate-600">Email is not configured. Send this owner invitation link to the tenant owner:</p><div className="flex gap-2"><Input readOnly value={link} /><Button variant="secondary" onClick={() => { navigator.clipboard.writeText(link); toast.success('Copied'); }}><Copy /></Button></div></div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Company name" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Slug" hint="Lowercase, used in public links"><Input value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase() })} /></Field>
            <Field label="Owner email" required className="sm:col-span-2"><Input type="email" value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} /></Field>
            <Field label="Plan"><Select value={f.planCode} onChange={(e) => setF({ ...f, planCode: e.target.value })}>{plans.data?.plans.map((p) => <option key={p.id} value={p.code}>{p.name}</option>)}</Select></Field>
            <Field label="Trial days"><Input type="number" min={0} value={f.trialDays} onChange={(e) => setF({ ...f, trialDays: e.target.value })} disabled={f.activate} /></Field>
            <label className="flex items-center gap-2 text-sm"><Switch checked={f.activate} onCheckedChange={(v) => setF({ ...f, activate: v })} /> Activate immediately (skip trial)</label>
          </div>
        )}
      </Dialog>
    </>
  );
}

export function PlatformTenantDetail() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['platform-tenant', id], queryFn: () => api.get<{ tenant: TenantRow & { plan: Plan | null }; admins: { id: string; status: string; role: { key: string; name: string }; user: { id: string; name: string; email: string; lastLoginAt: string | null } }[]; pendingInvites: { id: string; email: string; expiresAt: string; role: { name: string } }[]; usage: Record<string, number> }>(`/platform/tenants/${id}`) });
  const plans = useQuery({ queryKey: ['platform-plans'], queryFn: () => api.get<{ plans: Plan[] }>('/platform/plans') });
  const [f, setF] = useState({ status: '', planId: '', trialEndsAt: '', reason: '' });
  const [adminEmail, setAdminEmail] = useState('');
  useEffect(() => { if (q.data) setF({ status: q.data.tenant.status, planId: q.data.tenant.plan?.id ?? '', trialEndsAt: toDateInput(q.data.tenant.trialEndsAt), reason: '' }); }, [q.data]);
  const save = useAction(() => api.patch(`/platform/tenants/${id}`, { status: f.status, planId: f.planId || null, trialEndsAt: f.trialEndsAt || null, reason: f.reason || undefined }), { success: 'Tenant updated', invalidate: [['platform-tenant'], ['/platform/tenants']] });
  const invite = useAction(() => api.post<{ inviteLink?: string }>(`/platform/tenants/${id}/admins`, { email: adminEmail, role: 'admin' }), { invalidate: [['platform-tenant']], onSuccess: (r) => { setAdminEmail(''); if (r.inviteLink) { navigator.clipboard.writeText(r.inviteLink); toast.success('Invitation created. Link copied to clipboard.'); } else toast.success('Invitation emailed'); } });
  const adminStatus = useAction(({ mid, status }: { mid: string; status: string }) => api.patch(`/platform/tenants/${id}/admins/${mid}`, { status }), { success: 'Updated', invalidate: [['platform-tenant']] });
  if (q.isLoading) return <Card><LoadingBlock /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>;
  const { tenant, admins, pendingInvites, usage } = q.data;
  return (
    <div className="space-y-6">
      <PageHeader breadcrumb={<Link to="/platform/tenants" className="hover:underline">Tenants</Link>} title={<span className="flex items-center gap-3">{tenant.name}<StatusBadge status={tenant.status} /></span>} description={`${tenant.slug} · created ${fmtDate(tenant.createdAt)}`} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Object.entries(usage).map(([k, v]) => <Stat key={k} label={k.replace(/([A-Z])/g, ' $1').toLowerCase()} value={v} />)}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Subscription & status" actions={<Button size="sm" onClick={() => save.mutate()} loading={save.isPending}>Save</Button>} />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Field label="Status"><Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'].map((s) => <option key={s} value={s}>{s}</option>)}</Select></Field>
            <Field label="Plan"><Select value={f.planId} onChange={(e) => setF({ ...f, planId: e.target.value })}><option value="">No plan</option>{plans.data?.plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
            <Field label="Trial ends"><Input type="date" value={f.trialEndsAt} onChange={(e) => setF({ ...f, trialEndsAt: e.target.value })} /></Field>
            <Field label="Reason (sent to owners on suspension)"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
          </div>
          <p className="px-5 pb-4 text-xs text-muted">Suspended and cancelled tenants are blocked from all workspace APIs immediately. Data is retained.</p>
        </Card>
        <Card>
          <CardHeader title="Administrators" />
          <ul className="divide-y divide-line">
            {admins.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                <div className="min-w-0 flex-1"><p className="font-medium">{a.user.name}</p><p className="text-xs text-muted">{a.user.email} · last sign-in {a.user.lastLoginAt ? fmtDateTime(a.user.lastLoginAt) : 'never'}</p></div>
                <Badge>{a.role.name}</Badge><StatusBadge status={a.status} />
                <Button variant="ghost" size="sm" onClick={() => adminStatus.mutate({ mid: a.id, status: a.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' })}>{a.status === 'ACTIVE' ? 'Disable' : 'Enable'}</Button>
              </li>
            ))}
            {pendingInvites.map((i) => <li key={i.id} className="flex items-center gap-3 px-5 py-3 text-sm text-muted"><span className="flex-1">{i.email}</span><Badge tone="amber">Invited · {i.role.name}</Badge></li>)}
          </ul>
          <form className="flex gap-2 border-t border-line p-4" onSubmit={(e) => { e.preventDefault(); invite.mutate(); }}>
            <Input type="email" placeholder="admin@company.com" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
            <Button type="submit" disabled={!adminEmail} loading={invite.isPending}>Invite admin</Button>
          </form>
        </Card>
      </div>
      <Card className="p-5"><DescList items={[['Plan', tenant.plan?.name], ['Users limit', tenant.plan?.maxUsers], ['Storage limit', tenant.plan ? `${tenant.plan.storageMb} MB` : null], ['Modules', tenant.plan?.modules.length ? tenant.plan.modules.join(', ') : 'All']]} /></Card>
    </div>
  );
}

export function PlatformPlans() {
  const q = useQuery({ queryKey: ['platform-plans'], queryFn: () => api.get<{ plans: Plan[]; modules: string[] }>('/platform/plans') });
  const [edit, setEdit] = useState<Partial<Plan> | null>(null);
  const save = useAction(() => {
    const body = { code: edit!.code, name: edit!.name, priceMonthly: Number(edit!.priceMonthly), maxUsers: Number(edit!.maxUsers), maxCustomers: Number(edit!.maxCustomers), storageMb: Number(edit!.storageMb), aiRequests: Number(edit!.aiRequests), modules: edit!.modules ?? [], active: edit!.active ?? true };
    return edit!.id ? api.patch(`/platform/plans/${edit!.id}`, body) : api.post('/platform/plans', body);
  }, { success: 'Plan saved', invalidate: [['platform-plans']], onSuccess: () => setEdit(null) });
  return (
    <>
      <PageHeader title="Subscription plans" description="Limits and module entitlements. An empty module list includes every module." actions={<Button onClick={() => setEdit({ modules: [], active: true, priceMonthly: '0', maxUsers: 5, maxCustomers: 500, storageMb: 1024, aiRequests: 100 })}><Plus /> New plan</Button>} />
      <Card>
        {q.isLoading ? <LoadingBlock /> : (
          <Table><THead><tr><TH>Plan</TH><TH className="text-right">Price / month</TH><TH className="text-right">Users</TH><TH className="text-right">Customers</TH><TH className="text-right">Storage</TH><TH className="text-right">AI / month</TH><TH>Modules</TH><TH className="text-right">Tenants</TH></tr></THead><TBody>
            {q.data?.plans.map((p) => (
              <TR key={p.id} onClick={() => setEdit(p)}>
                <TD><p className="font-medium">{p.name}</p><p className="text-xs text-muted">{p.code}{!p.active && ' · inactive'}</p></TD>
                <TD className="text-right tabular-nums">{inr(p.priceMonthly)}</TD><TD className="text-right">{p.maxUsers}</TD><TD className="text-right">{p.maxCustomers}</TD><TD className="text-right">{p.storageMb} MB</TD><TD className="text-right">{p.aiRequests}</TD>
                <TD className="text-slate-600">{p.modules.length ? p.modules.join(', ') : 'All'}</TD><TD className="text-right">{p._count?.tenants ?? 0}</TD>
              </TR>
            ))}
          </TBody></Table>
        )}
      </Card>
      <Dialog open={!!edit} onOpenChange={(v) => !v && setEdit(null)} title={edit?.id ? 'Edit plan' : 'New plan'} size="lg"
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!edit?.code || !edit?.name}>Save</Button></>}>
        {edit && (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Code"><Input value={edit.code ?? ''} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, code: e.target.value })} /></Field>
            <Field label="Name"><Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Price / month (₹)"><Input type="number" value={edit.priceMonthly ?? ''} onChange={(e) => setEdit({ ...edit, priceMonthly: e.target.value })} /></Field>
            <Field label="Max users"><Input type="number" value={edit.maxUsers ?? ''} onChange={(e) => setEdit({ ...edit, maxUsers: Number(e.target.value) })} /></Field>
            <Field label="Max customers"><Input type="number" value={edit.maxCustomers ?? ''} onChange={(e) => setEdit({ ...edit, maxCustomers: Number(e.target.value) })} /></Field>
            <Field label="Storage (MB)"><Input type="number" value={edit.storageMb ?? ''} onChange={(e) => setEdit({ ...edit, storageMb: Number(e.target.value) })} /></Field>
            <Field label="AI requests / month"><Input type="number" value={edit.aiRequests ?? ''} onChange={(e) => setEdit({ ...edit, aiRequests: Number(e.target.value) })} /></Field>
            <label className="flex items-end gap-2 pb-2 text-sm"><Switch checked={edit.active ?? true} onCheckedChange={(v) => setEdit({ ...edit, active: v })} /> Active</label>
            <div className="sm:col-span-3">
              <p className="mb-2 text-[13px] font-medium text-slate-700">Modules (none selected = all)</p>
              <div className="flex flex-wrap gap-4">{q.data?.modules.map((m) => (
                <label key={m} className="flex items-center gap-2 text-sm"><Checkbox checked={edit.modules?.includes(m) ?? false} onCheckedChange={(v) => setEdit({ ...edit, modules: v ? [...(edit.modules ?? []), m] : (edit.modules ?? []).filter((x) => x !== m) })} />{m}</label>
              ))}</div>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}

export function PlatformSettings() {
  const q = useQuery({ queryKey: ['platform-settings'], queryFn: () => api.get<{ defaultFeedbackTenant: string | null; defaultTrialDays: number | null; signupEnabled: boolean | null; supportEmail: string | null }>('/platform/settings') });
  const integrations = useQuery({ queryKey: ['platform-integrations'], queryFn: () => api.get<Record<string, string>>('/platform/integrations') });
  const [f, setF] = useState({ defaultFeedbackTenant: '', defaultTrialDays: 14, signupEnabled: true, supportEmail: '' });
  useEffect(() => { if (q.data) setF({ defaultFeedbackTenant: q.data.defaultFeedbackTenant ?? '', defaultTrialDays: q.data.defaultTrialDays ?? 14, signupEnabled: q.data.signupEnabled ?? true, supportEmail: q.data.supportEmail ?? '' }); }, [q.data]);
  const save = useAction(() => api.patch('/platform/settings', { ...f, defaultFeedbackTenant: f.defaultFeedbackTenant || undefined, supportEmail: f.supportEmail || undefined }), { success: 'Settings saved', invalidate: [['platform-settings']] });
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Platform settings" actions={<Button onClick={() => save.mutate()} loading={save.isPending}>Save</Button>} />
      <Card className="space-y-4 p-5">
        <Field label="Default feedback tenant" hint="Tenant slug served at the root of feedback.nexonweb.com"><Input value={f.defaultFeedbackTenant} onChange={(e) => setF({ ...f, defaultFeedbackTenant: e.target.value })} /></Field>
        <Field label="Support email"><Input type="email" value={f.supportEmail} onChange={(e) => setF({ ...f, supportEmail: e.target.value })} /></Field>
        <label className="flex items-center gap-3 text-sm"><Switch checked={f.signupEnabled} onCheckedChange={(v) => setF({ ...f, signupEnabled: v })} /> Allow self-service workspace signup</label>
      </Card>
      <Card>
        <CardHeader title="Integrations" description="Configured through server environment variables." />
        <div className="p-5">{integrations.data && <DescList items={Object.entries(integrations.data).map(([k, v]) => [k, <code className="text-xs">{v}</code>])} />}</div>
      </Card>
    </div>
  );
}

export function PlatformAudit() {
  const list = useList<AuditLog>('/platform/audit-logs', { action: '' });
  return (
    <>
      <PageHeader title="Platform audit log" description="All audited actions across tenants, including platform administration." />
      <AuditTable list={list} showTenant />
    </>
  );
}
