import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Copy, MoreVertical, Plus } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { api, errorMessage } from '@/lib/api';
import { useAuth, type Me } from '@/lib/auth';
import { useFinanceMeta } from '@/lib/hooks';
import { fmtDate } from '@/lib/utils';
import { Button, Card, Dialog, Field, Input, PageHeader, Select } from '@/components/ui';
import { TenantLogo } from '@/components/brand';

export function OrganizationsPage() {
  const { me, membership, switchTenant, setMe } = useAuth();
  const navigate = useNavigate();
  const meta = useFinanceMeta();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', stateCode: '', gstin: '' });
  const [busy, setBusy] = useState(false);
  if (!me) return null;
  const go = (tenantId: string, roleKey: string) => { switchTenant(tenantId); navigate(roleKey === 'customer' ? '/portal' : '/'); };
  const makeDefault = async (tenantId: string) => {
    try { setMe(await api.post<Me>(`/auth/organizations/${tenantId}/default`)); toast.success('Default organization updated'); } catch (e) { toast.error(errorMessage(e)); }
  };
  const create = async () => {
    setBusy(true);
    try {
      const updated = await api.post<Me>('/auth/organizations', { name: f.name, stateCode: f.stateCode || null, gstin: f.gstin || null });
      setMe(updated);
      const created = updated.memberships.find((m) => !me.memberships.some((x) => x.tenant.id === m.tenant.id));
      toast.success(`${f.name} created`);
      setOpen(false);
      if (created) { switchTenant(created.tenant.id); navigate('/settings/company'); }
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={`Hi, ${me.name}!`} description="You are a part of the following organizations. Go to the organization you wish to access now."
        actions={<Button onClick={() => setOpen(true)}><Plus /> New Organization</Button>} />
      <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold">My Organizations <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{me.memberships.length}</span></h2>
      <div className="space-y-4">
        {me.memberships.map((m) => {
          const isDefault = me.defaultTenantId === m.tenant.id || (!me.defaultTenantId && m === me.memberships[0]);
          const t = m.tenant as typeof m.tenant & { orgCode?: string | null; createdAt?: string };
          return (
            <Card key={m.id} className="relative flex flex-wrap items-center gap-6 overflow-hidden p-5">
              {isDefault && <span className="absolute -left-8 top-3 w-28 -rotate-45 bg-[#047857] py-0.5 text-center text-[10px] font-semibold uppercase text-white">Default</span>}
              <div className="flex size-28 items-center justify-center rounded-lg bg-slate-50"><TenantLogo tenant={t} className="max-h-16 max-w-24" /></div>
              <div className="min-w-0 flex-1 space-y-1 text-sm">
                <p className="text-base font-semibold">{t.name}</p>
                {t.createdAt && <p className="italic text-muted">Organization created on {fmtDate(t.createdAt)}</p>}
                {t.orgCode && <p className="flex items-center gap-1.5 text-muted">Organization ID: <span className="text-ink">{t.orgCode}</span><button onClick={() => { navigator.clipboard.writeText(t.orgCode!); toast.success('Copied'); }} aria-label="Copy organization ID"><Copy className="size-3.5" /></button></p>}
                <p className="text-muted">Plan: <span className="text-ink">{t.plan?.name ?? '—'}</span></p>
                <p>You are {/^[aeiou]/i.test(m.role.name) ? 'an' : 'a'} <strong>{m.role.name}</strong> in this organization</p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant={membership?.tenant.id === t.id ? 'secondary' : 'primary'} onClick={() => go(t.id, m.role.key)}>{membership?.tenant.id === t.id ? 'Current' : 'Go to Organization'}</Button>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild><Button variant="secondary" size="icon" aria-label="Organization actions"><MoreVertical /></Button></DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-44 rounded-xl border border-line bg-surface p-1.5 shadow-lg">
                      <DropdownMenu.Item disabled={isDefault} onSelect={() => makeDefault(t.id)} className="cursor-pointer rounded-lg px-2.5 py-1.5 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-slate-50">Mark as default</DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            </Card>
          );
        })}
      </div>
      <Dialog open={open} onOpenChange={setOpen} title="New organization" description="You become the owner. Each organization has its own customers, invoices and settings."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={create} loading={busy} disabled={f.name.trim().length < 2}>Create organization</Button></>}>
        <div className="space-y-4">
          <Field label="Organization name" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="GSTIN" hint="Optional. The state is taken from it."><Input className="uppercase" value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} maxLength={15} /></Field>
          {!f.gstin && <Field label="State"><Select value={f.stateCode} onChange={(e) => setF({ ...f, stateCode: e.target.value })}><option value="">Select state</option>{(meta.data?.stateList ?? []).map(([c, n]) => <option key={c} value={c}>{n}</option>)}</Select></Field>}
        </div>
      </Dialog>
    </div>
  );
}
