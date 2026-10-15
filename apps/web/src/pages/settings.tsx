import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, Copy, Plus, Upload, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useCustomerOptions, useFinanceMeta, useList } from '@/lib/hooks';
import type { AuditLog } from '@/lib/types';
import { AuthorizationSettings } from './financeSettings';
import { TaxRatesManager } from './taxRates';
import { cn, fmtDate, fmtDateTime, inr, titleCase } from '@/lib/utils';
import {
  Avatar, Badge, Button, Card, CardHeader, Checkbox, Dialog, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Pagination,
  Progress, Select, StatusBadge, Switch, Table, TBody, TD, TH, THead, Toolbar, TR, Textarea,
} from '@/components/ui';

interface Company {
  id: string; name: string; slug: string; legalName: string | null; email: string | null; phone: string | null; website: string | null;
  addressLine1: string | null; addressLine2: string | null; city: string | null; state: string | null; stateCode: string | null; postalCode: string | null;
  gstin: string | null; pan: string | null; brandColor: string; logoFileId: string | null;
}

export function CompanySettings() {
  const qc = useQueryClient();
  const meta = useFinanceMeta();
  const q = useQuery({ queryKey: ['company'], queryFn: () => api.get<Company>('/settings/company') });
  const [f, setF] = useState<Partial<Company>>({});
  const logoInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (q.data) setF(q.data); }, [q.data]);
  const save = useAction(() => {
    const { id: _i, slug: _s, ...rest } = f as Company;
    const allowed = ['name', 'legalName', 'email', 'phone', 'website', 'addressLine1', 'addressLine2', 'city', 'state', 'stateCode', 'postalCode', 'gstin', 'pan', 'brandColor', 'logoFileId'];
    return api.patch('/settings/company', Object.fromEntries(Object.entries(rest).filter(([k]) => allowed.includes(k))));
  }, { success: 'Company profile saved', invalidate: [['company'], ['me']] });
  const uploadLogo = useAction(async (file: File) => {
    const fd = new FormData(); fd.append('files', file); fd.append('entityType', 'branding');
    const [stored] = await api.post<{ id: string }[]>('/files', fd);
    await api.patch('/settings/company', { logoFileId: stored.id });
    return stored;
  }, { success: 'Logo updated', onSuccess: () => { qc.invalidateQueries({ queryKey: ['company'] }); qc.invalidateQueries({ queryKey: ['me'] }); } });
  if (q.isLoading) return <Card><LoadingBlock rows={8} /></Card>;
  if (q.error) return <Card><ErrorState error={q.error} /></Card>;
  const set = (k: keyof Company) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Company profile" description="Shown on quotations, invoices, the feedback portal and emails." actions={<Button onClick={() => save.mutate()} loading={save.isPending}>Save changes</Button>} />
      <Card>
        <CardHeader title="Branding" />
        <div className="flex flex-wrap items-center gap-6 p-5">
          <div className="flex size-20 items-center justify-center overflow-hidden rounded-xl border border-line bg-slate-50">
            {f.logoFileId ? <img src={`/api/v1/public/tenants/${q.data!.slug}/logo?v=${f.logoFileId}`} alt="Logo" className="max-h-full max-w-full object-contain" /> : <span className="text-2xl font-bold" style={{ color: f.brandColor }}>{f.name?.[0]}</span>}
          </div>
          <div className="space-y-2">
            <input ref={logoInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) uploadLogo.mutate(file); e.target.value = ''; }} />
            <Button variant="secondary" onClick={() => logoInput.current?.click()} loading={uploadLogo.isPending}><Upload /> Upload logo</Button>
            <p className="text-xs text-muted">PNG, JPG or WebP. Shown on the public feedback portal.</p>
          </div>
          <Field label="Brand colour" className="ml-auto"><div className="flex items-center gap-2"><input type="color" value={f.brandColor ?? '#1e3a8a'} onChange={set('brandColor')} className="h-9 w-12 cursor-pointer rounded border border-line" /><Input value={f.brandColor ?? ''} onChange={set('brandColor')} className="w-28" /></div></Field>
        </div>
      </Card>
      <AuthorizationSettings />
      <Card>
        <CardHeader title="Business details" />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Display name" required><Input value={f.name ?? ''} onChange={set('name')} /></Field>
          <Field label="Legal name" hint="As registered for GST"><Input value={f.legalName ?? ''} onChange={set('legalName')} /></Field>
          <Field label="Email"><Input type="email" value={f.email ?? ''} onChange={set('email')} /></Field>
          <Field label="Phone"><Input value={f.phone ?? ''} onChange={set('phone')} /></Field>
          <Field label="Website" className="sm:col-span-2"><Input value={f.website ?? ''} onChange={set('website')} /></Field>
          <Field label="Address line 1"><Input value={f.addressLine1 ?? ''} onChange={set('addressLine1')} /></Field>
          <Field label="Address line 2"><Input value={f.addressLine2 ?? ''} onChange={set('addressLine2')} /></Field>
          <Field label="City"><Input value={f.city ?? ''} onChange={set('city')} /></Field>
          <Field label="Postal code"><Input value={f.postalCode ?? ''} onChange={set('postalCode')} /></Field>
        </div>
      </Card>
      <Card>
        <CardHeader title="Tax registration" description="Required before issuing GST invoices." />
        <div className="grid gap-4 p-5 sm:grid-cols-3">
          <Field label="State" required>
            <Select value={f.stateCode ?? ''} onChange={(e) => setF({ ...f, stateCode: e.target.value, state: meta.data?.states[e.target.value] ?? '' })}>
              <option value="">Select state</option>{(meta.data?.stateList ?? []).map(([c, n]) => <option key={c} value={c}>{n} ({c})</option>)}
            </Select>
          </Field>
          <Field label="GSTIN" hint="First two digits must match the state code"><Input className="uppercase" value={f.gstin ?? ''} onChange={set('gstin')} maxLength={15} /></Field>
          <Field label="PAN"><Input className="uppercase" value={f.pan ?? ''} onChange={set('pan')} maxLength={10} /></Field>
        </div>
      </Card>
    </div>
  );
}

interface Role { id: string; key: string; name: string; description: string | null; permissions: string[]; isSystem: boolean; _count: { memberships: number } }
interface MemberRow { id: string; status: string; customerId: string | null; title: string | null; createdAt: string; user: { id: string; name: string; email: string; lastLoginAt: string | null }; role: { id: string; key: string; name: string } }

export function UsersSettings() {
  const { me, can } = useAuth();
  const members = useQuery({ queryKey: ['members'], queryFn: () => api.get<{ members: MemberRow[]; invitations: { id: string; email: string; expiresAt: string; role: { name: string } }[] }>('/members') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ roles: Role[]; catalog: { key: string; label: string }[] }>('/roles') });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invite, setInvite] = useState({ email: '', roleId: '', customerId: '' });
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [roleEdit, setRoleEdit] = useState<Partial<Role> | null>(null);
  const customers = useCustomerOptions(inviteOpen);
  const selectedRole = roles.data?.roles.find((r) => r.id === invite.roleId);
  const sendInvite = useAction(() => api.post<{ inviteLink?: string }>('/invitations', { email: invite.email, roleId: invite.roleId, customerId: invite.customerId || null }), {
    success: 'Invitation created', invalidate: [['members']],
    onSuccess: (r) => { if (r.inviteLink) setInviteLink(r.inviteLink); else setInviteOpen(false); setInvite({ email: '', roleId: '', customerId: '' }); },
  });
  const revoke = useAction((id: string) => api.delete(`/invitations/${id}`), { success: 'Invitation revoked', invalidate: [['members']] });
  const updateMember = useAction(({ id, ...b }: { id: string; roleId?: string; status?: string }) => api.patch(`/members/${id}`, b), { success: 'Member updated', invalidate: [['members'], ['members-options']] });
  const saveRole = useAction(() => (roleEdit!.id ? api.patch(`/roles/${roleEdit!.id}`, { name: roleEdit!.name, description: roleEdit!.description, permissions: roleEdit!.permissions }) : api.post('/roles', { name: roleEdit!.name, description: roleEdit!.description, permissions: roleEdit!.permissions ?? [] })), { success: 'Role saved', invalidate: [['roles']], onSuccess: () => setRoleEdit(null) });
  const delRole = useAction((id: string) => api.delete(`/roles/${id}`), { success: 'Role deleted', invalidate: [['roles']] });
  if (members.isLoading || roles.isLoading) return <Card><LoadingBlock rows={8} /></Card>;
  if (members.error) return <Card><ErrorState error={members.error} /></Card>;
  return (
    <div className="space-y-6">
      <PageHeader title="Users & roles" description="Invite your team and customers, and control what each role can access."
        actions={<Button onClick={() => { setInviteLink(null); setInviteOpen(true); }}><Plus /> Invite user</Button>} />
      <Card>
        <CardHeader title="Members" />
        <Table><THead><tr><TH>User</TH><TH>Role</TH><TH>Status</TH><TH>Last sign-in</TH><TH /></tr></THead><TBody>
          {members.data!.members.map((m) => (
            <tr key={m.id}>
              <TD><div className="flex items-center gap-3"><Avatar name={m.user.name} /><div><p className="font-medium">{m.user.name}{m.user.id === me?.id && <span className="ml-1 text-xs text-muted">(you)</span>}</p><p className="text-xs text-muted">{m.user.email}</p></div></div></TD>
              <TD>
                <Select value={m.role.id} disabled={m.user.id === me?.id} className="w-48" onChange={(e) => updateMember.mutate({ id: m.id, roleId: e.target.value })}>
                  {roles.data!.roles.filter((r) => r.key !== 'customer' || m.role.key === 'customer').map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </Select>
              </TD>
              <TD><StatusBadge status={m.status} /></TD>
              <TD className="text-slate-600">{m.user.lastLoginAt ? fmtDateTime(m.user.lastLoginAt) : 'Never'}</TD>
              <TD className="text-right">{m.user.id !== me?.id && <Button variant="ghost" size="sm" onClick={() => updateMember.mutate({ id: m.id, status: m.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' })}>{m.status === 'ACTIVE' ? 'Disable' : 'Enable'}</Button>}</TD>
            </tr>
          ))}
        </TBody></Table>
      </Card>
      {members.data!.invitations.length > 0 && (
        <Card>
          <CardHeader title="Pending invitations" />
          <ul className="divide-y divide-line">{members.data!.invitations.map((i) => (
            <li key={i.id} className="flex items-center gap-3 px-5 py-3 text-sm"><span className="flex-1 font-medium">{i.email}</span><Badge>{i.role.name}</Badge><span className="text-xs text-muted">expires {fmtDate(i.expiresAt)}</span><Button variant="ghost" size="sm" className="text-red-600" onClick={() => revoke.mutate(i.id)}>Revoke</Button></li>
          ))}</ul>
        </Card>
      )}
      <Card>
        <CardHeader title="Roles" description="System roles can be adjusted; create custom roles for special cases." actions={<Button size="sm" variant="secondary" onClick={() => setRoleEdit({ permissions: [] })}><Plus /> Custom role</Button>} />
        <Table><THead><tr><TH>Role</TH><TH>Permissions</TH><TH className="text-right">Members</TH><TH /></tr></THead><TBody>
          {roles.data!.roles.map((r) => (
            <tr key={r.id}>
              <TD><p className="font-medium">{r.name}</p><p className="text-xs text-muted">{r.description}</p></TD>
              <TD className="text-slate-600">{r.permissions.length} permissions</TD>
              <TD className="text-right tabular-nums">{r._count.memberships}</TD>
              <TD className="whitespace-nowrap text-right">
                {r.key !== 'owner' && <Button variant="ghost" size="sm" onClick={() => setRoleEdit(r)}>Edit</Button>}
                {!r.isSystem && <Button variant="ghost" size="sm" className="text-red-600" onClick={() => delRole.mutate(r.id)}>Delete</Button>}
              </TD>
            </tr>
          ))}
        </TBody></Table>
      </Card>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen} title="Invite user"
        footer={inviteLink ? <Button onClick={() => setInviteOpen(false)}>Done</Button> : <><Button variant="secondary" onClick={() => setInviteOpen(false)}>Cancel</Button><Button onClick={() => sendInvite.mutate()} loading={sendInvite.isPending} disabled={!invite.email || !invite.roleId || (selectedRole?.key === 'customer' && !invite.customerId)}>Send invitation</Button></>}>
        {inviteLink ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">Email is not configured on the server, so share this one-time link with the person directly. It expires in 7 days.</p>
            <div className="flex gap-2"><Input readOnly value={inviteLink} onFocus={(e) => e.target.select()} /><Button variant="secondary" onClick={() => { navigator.clipboard.writeText(inviteLink); toast.success('Copied'); }}><Copy /></Button></div>
          </div>
        ) : (
          <div className="space-y-4">
            <Field label="Email"><Input type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></Field>
            <Field label="Role"><Select value={invite.roleId} onChange={(e) => setInvite({ ...invite, roleId: e.target.value })}><option value="">Select role</option>{roles.data!.roles.filter((r) => r.key !== 'owner' || can('subscription.manage')).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>
            {selectedRole?.key === 'customer' && <Field label="Customer account" hint="The portal user can only see this customer's records"><Select value={invite.customerId} onChange={(e) => setInvite({ ...invite, customerId: e.target.value })}><option value="">Select customer</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.company ?? c.name}</option>)}</Select></Field>}
            {selectedRole && <p className="text-xs text-muted">{selectedRole.description}</p>}
          </div>
        )}
      </Dialog>

      <Dialog open={!!roleEdit} onOpenChange={(v) => !v && setRoleEdit(null)} title={roleEdit?.id ? `Edit role: ${roleEdit.name}` : 'New custom role'} size="lg"
        footer={<><Button variant="secondary" onClick={() => setRoleEdit(null)}>Cancel</Button><Button onClick={() => saveRole.mutate()} loading={saveRole.isPending} disabled={!roleEdit?.name}>Save role</Button></>}>
        {roleEdit && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name"><Input value={roleEdit.name ?? ''} onChange={(e) => setRoleEdit({ ...roleEdit, name: e.target.value })} disabled={roleEdit.isSystem} /></Field>
              <Field label="Description"><Input value={roleEdit.description ?? ''} onChange={(e) => setRoleEdit({ ...roleEdit, description: e.target.value })} /></Field>
            </div>
            <p className="text-xs text-muted">You can only grant permissions you hold yourself. Enforcement happens on the server.</p>
            <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {roles.data!.catalog.map((p) => {
                const checked = roleEdit.permissions?.includes(p.key) ?? false;
                return (
                  <label key={p.key} className={cn('flex items-start gap-2.5 rounded-md p-1.5 text-sm hover:bg-slate-50', !can(p.key) && 'opacity-50')}>
                    <Checkbox checked={checked} onCheckedChange={(v) => setRoleEdit({ ...roleEdit, permissions: v ? [...(roleEdit.permissions ?? []), p.key] : (roleEdit.permissions ?? []).filter((x) => x !== p.key) })} />
                    <span><span className="block font-mono text-xs">{p.key}</span><span className="text-xs text-muted">{p.label}</span></span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

interface Preferences {
  documents: {
    quotationTerms: string; invoiceTerms: string; invoiceNotes: string; defaultDueDays: number; quotationValidityDays: number; bankDetails: string; footer: string;
    proformaTerms: string; proformaValidityDays: number; proformaLabel: string;
  };
  tax: { defaultTaxRate: number; pricesIncludeTax: boolean; sacDefault: string; roundOff?: boolean };
  crm: { autoFollowUpTasks: boolean; followUpDaysAfterContact: number; coreServices: string[] };
  notifications: { emailOnNewFeedback: boolean; emailOnTicketAssigned: boolean; emailCustomerOnFeedback: boolean };
  onboardingTemplate: string[];
  sequences: { type: string; prefix: string; next: number; padding: number }[];
}

function usePrefs() {
  return useQuery({ queryKey: ['preferences'], queryFn: () => api.get<Preferences>('/settings/preferences') });
}
function useSaveSection(section: string) {
  return useAction((body: unknown) => api.patch(`/settings/preferences/${section}`, body), { success: 'Settings saved', invalidate: [['preferences']] });
}

export function TaxSettings() {
  const prefs = usePrefs();
  const meta = useFinanceMeta();
  const save = useSaveSection('tax');
  const [t, setT] = useState<Preferences['tax'] | null>(null);
  useEffect(() => { if (prefs.data) setT(prefs.data.tax); }, [prefs.data]);
  if (!t) return <Card><LoadingBlock /></Card>;
  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader title="Tax settings" description="Tax rates offered on documents, and GST defaults." />
      <TaxRatesManager />
      <Card className="space-y-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold">Defaults</p><Button size="sm" onClick={() => save.mutate(t)} loading={save.isPending}>Save defaults</Button></div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Default GST rate" hint="New lines start with the active GST tax at this rate"><Select value={t.defaultTaxRate} onChange={(e) => setT({ ...t, defaultTaxRate: Number(e.target.value) })}>{(meta.data?.gstRates ?? []).map((r) => <option key={r} value={r}>{r}%</option>)}</Select></Field>
          <Field label="Default SAC code" hint="998314: IT design and development services"><Input value={t.sacDefault} onChange={(e) => setT({ ...t, sacDefault: e.target.value })} /></Field>
        </div>
        <label className="flex items-center gap-3 text-sm"><Switch checked={!!t.roundOff} onCheckedChange={(v) => setT({ ...t, roundOff: v })} /> Round off totals to the nearest rupee on quotes and invoices</label>
        <div className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600">
          <p className="font-medium text-ink">How tax is applied</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>When the place of supply matches your company state: CGST + SGST, each half the rate.</li>
            <li>When it differs: IGST at the full rate.</li>
            <li>Place of supply defaults to the customer's state and can be overridden per document.</li>
            <li>Each tax rate defines its components for both cases; a line uses the set that matches the place of supply.</li>
            <li>Exempt customers and exports / SEZ supplies (zero rated under LUT) are billed without tax, whatever rate is selected.</li>
            <li>Amounts are calculated per line and component, and rounded to the nearest paisa.</li>
          </ul>
          <p className="mt-2 text-xs">This software calculates tax from the rates you configure; it does not decide which rate applies to a supply. Have your accountant review your tax settings. E-invoicing (IRN) and e-way bills are not generated by this system.</p>
        </div>
      </Card>
    </div>
  );
}

export function DocumentSettings() {
  const prefs = usePrefs();
  const saveDocs = useSaveSection('documents');
  const saveOnboarding = useSaveSection('onboardingTemplate');
  const [d, setD] = useState<Preferences['documents'] | null>(null);
  const [tpl, setTpl] = useState('');
  useEffect(() => { if (prefs.data) { setD(prefs.data.documents); setTpl(prefs.data.onboardingTemplate.join('\n')); } }, [prefs.data]);
  const saveSeq = useAction((s: { type: string; prefix: string; next: number; padding: number }) => api.patch(`/settings/sequences/${s.type}`, { prefix: s.prefix, next: s.next, padding: s.padding }), { success: 'Numbering saved', invalidate: [['preferences']] });
  const [seqs, setSeqs] = useState<Preferences['sequences']>([]);
  useEffect(() => { if (prefs.data) setSeqs(prefs.data.sequences); }, [prefs.data]);
  if (!d) return <Card><LoadingBlock /></Card>;
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Document settings" description="Defaults for quotations, proforma invoices and invoices, numbering, and onboarding." actions={<Button onClick={() => saveDocs.mutate(d)} loading={saveDocs.isPending}>Save defaults</Button>} />
      <Card className="grid gap-4 p-5 sm:grid-cols-2">
        <Field label="Invoice payment terms (days)"><Input type="number" min={0} value={d.defaultDueDays} onChange={(e) => setD({ ...d, defaultDueDays: Number(e.target.value) })} /></Field>
        <Field label="Quotation validity (days)"><Input type="number" min={1} value={d.quotationValidityDays} onChange={(e) => setD({ ...d, quotationValidityDays: Number(e.target.value) })} /></Field>
        <Field label="Default invoice terms"><Textarea rows={4} value={d.invoiceTerms} onChange={(e) => setD({ ...d, invoiceTerms: e.target.value })} /></Field>
        <Field label="Default quotation terms"><Textarea rows={4} value={d.quotationTerms} onChange={(e) => setD({ ...d, quotationTerms: e.target.value })} /></Field>
        <Field label="Proforma invoice validity (days)"><Input type="number" min={1} value={d.proformaValidityDays} onChange={(e) => setD({ ...d, proformaValidityDays: Number(e.target.value) })} /></Field>
        <Field label="Proforma short label" hint="Used in compact labels, e.g. PI. The PDF heading is always PROFORMA INVOICE; set the number prefix under Numbering."><Input value={d.proformaLabel} onChange={(e) => setD({ ...d, proformaLabel: e.target.value })} maxLength={30} /></Field>
        <Field label="Default proforma terms" className="sm:col-span-2"><Textarea rows={3} value={d.proformaTerms} onChange={(e) => setD({ ...d, proformaTerms: e.target.value })} /></Field>
        <Field label="Default invoice notes"><Textarea rows={2} value={d.invoiceNotes} onChange={(e) => setD({ ...d, invoiceNotes: e.target.value })} /></Field>
        <Field label="Bank details (printed on invoices)"><Textarea rows={2} value={d.bankDetails} onChange={(e) => setD({ ...d, bankDetails: e.target.value })} placeholder="Bank, account number, IFSC, UPI ID" /></Field>
        <Field label="Document footer" className="sm:col-span-2"><Input value={d.footer} onChange={(e) => setD({ ...d, footer: e.target.value })} /></Field>
      </Card>
      <Card>
        <CardHeader title="Numbering" description="Prefixes and next numbers. Numbers can only move forward." />
        <Table><THead><tr><TH>Document</TH><TH>Prefix</TH><TH>Next number</TH><TH>Digits</TH><TH>Preview</TH><TH /></tr></THead><TBody>
          {seqs.map((s, i) => (
            <tr key={s.type}>
              <TD className="font-medium">{titleCase(s.type)}</TD>
              <TD><Input className="w-28" value={s.prefix} onChange={(e) => setSeqs(seqs.map((x, j) => (j === i ? { ...x, prefix: e.target.value } : x)))} /></TD>
              <TD><Input type="number" className="w-28" min={1} value={s.next} onChange={(e) => setSeqs(seqs.map((x, j) => (j === i ? { ...x, next: Number(e.target.value) } : x)))} /></TD>
              <TD><Input type="number" className="w-20" min={1} max={10} value={s.padding} onChange={(e) => setSeqs(seqs.map((x, j) => (j === i ? { ...x, padding: Number(e.target.value) } : x)))} /></TD>
              <TD className="font-mono text-xs">{s.prefix}{String(s.next).padStart(s.padding, '0')}</TD>
              <TD><Button variant="ghost" size="sm" onClick={() => saveSeq.mutate(s)}>Save</Button></TD>
            </tr>
          ))}
        </TBody></Table>
      </Card>
      <Card>
        <CardHeader title="Onboarding checklist template" description="One item per line. Applied when onboarding starts for a customer." actions={<Button size="sm" onClick={() => saveOnboarding.mutate(tpl.split('\n').map((s) => s.trim()).filter(Boolean))} loading={saveOnboarding.isPending}>Save template</Button>} />
        <div className="p-5"><Textarea rows={8} value={tpl} onChange={(e) => setTpl(e.target.value)} /></div>
      </Card>
    </div>
  );
}

export function NotificationSettings() {
  const prefs = usePrefs();
  const saveN = useSaveSection('notifications');
  const saveCrm = useSaveSection('crm');
  const [n, setN] = useState<Preferences['notifications'] | null>(null);
  const [crm, setCrm] = useState<Preferences['crm'] | null>(null);
  useEffect(() => { if (prefs.data) { setN(prefs.data.notifications); setCrm(prefs.data.crm); } }, [prefs.data]);
  if (!n || !crm) return <Card><LoadingBlock /></Card>;
  const Toggle = ({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) => (
    <label className="flex items-start justify-between gap-6 py-3"><span><span className="block text-sm font-medium">{label}</span>{hint && <span className="text-xs text-muted">{hint}</span>}</span><Switch checked={checked} onCheckedChange={onChange} /></label>
  );
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Notifications & automation" />
      <Card>
        <CardHeader title="Email notifications" actions={<Button size="sm" onClick={() => saveN.mutate(n)} loading={saveN.isPending}>Save</Button>} />
        <div className="divide-y divide-line px-5">
          <Toggle label="Confirmation email to customers on feedback submission" hint="Includes their reference number and private tracking link" checked={n.emailCustomerOnFeedback} onChange={(v) => setN({ ...n, emailCustomerOnFeedback: v })} />
          <Toggle label="Notify team about new feedback" checked={n.emailOnNewFeedback} onChange={(v) => setN({ ...n, emailOnNewFeedback: v })} />
          <Toggle label="Notify agents when a ticket is assigned" checked={n.emailOnTicketAssigned} onChange={(v) => setN({ ...n, emailOnTicketAssigned: v })} />
        </div>
      </Card>
      <Card>
        <CardHeader title="CRM automation" description="Creates internal tasks only. No message is ever sent to a customer automatically." actions={<Button size="sm" onClick={() => saveCrm.mutate(crm)} loading={saveCrm.isPending}>Save</Button>} />
        <div className="divide-y divide-line px-5">
          <Toggle label="Create follow-up tasks automatically" hint="When leads are created and after each logged call, email or meeting" checked={crm.autoFollowUpTasks} onChange={(v) => setCrm({ ...crm, autoFollowUpTasks: v })} />
          <div className="flex items-center justify-between py-3"><span className="text-sm font-medium">Days until follow-up after contact</span><Input type="number" min={1} max={60} className="w-24" value={crm.followUpDaysAfterContact} onChange={(e) => setCrm({ ...crm, followUpDaysAfterContact: Number(e.target.value) })} /></div>
          <div className="py-3"><Field label="Core services" hint="Comma-separated. Leads interested in these score higher for service fit. Leave blank to treat all services equally."><Input value={crm.coreServices.join(', ')} onChange={(e) => setCrm({ ...crm, coreServices: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></Field></div>
        </div>
      </Card>
    </div>
  );
}

export function SubscriptionSettings() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['subscription'], queryFn: () => api.get<{ status: string; trialEndsAt: string | null; currentPeriodEnd: string | null; plan: { name: string; code: string; priceMonthly: string } | null; plans: { id: string; code: string; name: string; priceMonthly: string; maxUsers: number; maxCustomers: number; storageMb: number; aiRequests: number; modules: string[] }[]; usage: Record<string, { used: number; limit: number | null }> }>('/settings/subscription') });
  const request = useAction((planCode: string) => api.post<{ message: string }>('/settings/subscription/request-change', { planCode }), { success: (r) => r.message });
  if (q.isLoading) return <Card><LoadingBlock /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>;
  const d = q.data;
  const labels: Record<string, string> = { users: 'Team members', customers: 'Customers', storageMb: 'Storage (MB)', aiRequests: 'AI requests this month' };
  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader title="Subscription" description="Your plan, usage and limits." />
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-4">
          <div><p className="text-sm text-muted">Current plan</p><p className="text-xl font-semibold">{d.plan?.name ?? 'No plan'}</p></div>
          <StatusBadge status={d.status} />
          {d.trialEndsAt && d.status === 'TRIAL' && <span className="text-sm text-muted">Trial ends {fmtDate(d.trialEndsAt)}</span>}
        </div>
        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          {Object.entries(d.usage).map(([k, u]) => (
            <div key={k}><div className="mb-1.5 flex justify-between text-sm"><span>{labels[k] ?? k}</span><span className="tabular-nums text-muted">{u.used.toLocaleString('en-IN')} / {u.limit?.toLocaleString('en-IN') ?? '∞'}</span></div><Progress value={u.limit ? (u.used / u.limit) * 100 : 0} /></div>
          ))}
        </div>
      </Card>
      <div className="grid gap-4 md:grid-cols-3">
        {d.plans.map((p) => (
          <Card key={p.id} className={cn('flex flex-col p-5', d.plan?.code === p.code && 'ring-2 ring-brand-600')}>
            <p className="font-semibold">{p.name}</p>
            <p className="mt-2 text-2xl font-semibold">{inr(p.priceMonthly)}<span className="text-sm font-normal text-muted">/month</span></p>
            <ul className="mt-4 flex-1 space-y-1.5 text-sm text-slate-600">
              <li>{p.maxUsers} team members</li><li>{p.maxCustomers.toLocaleString('en-IN')} customers</li><li>{(p.storageMb / 1024).toFixed(0)} GB storage</li><li>{p.aiRequests.toLocaleString('en-IN')} AI requests / month</li>
              <li>{p.modules.length ? `Modules: ${p.modules.join(', ')}` : 'All modules'}</li>
            </ul>
            {d.plan?.code === p.code ? <Badge tone="blue" className="mt-4 justify-center py-1.5">Current plan</Badge> : can('subscription.manage') && <Button variant="secondary" className="mt-4" onClick={() => request.mutate(p.code)}>Request change</Button>}
          </Card>
        ))}
      </div>
      <p className="text-xs text-muted">Online billing is not connected yet. Plan change requests go to the platform administrator.</p>
    </div>
  );
}

export function IntegrationsSettings() {
  const q = useQuery({ queryKey: ['integrations'], queryFn: () => api.get<{ key: string; name: string; connected: boolean; detail: string }[]>('/settings/integrations') });
  return (
    <div className="max-w-3xl">
      <PageHeader title="Integrations" description="Credentials are configured as server environment variables and are never shown in the app." />
      <Card>
        {q.isLoading ? <LoadingBlock /> : (
          <ul className="divide-y divide-line">
            {q.data?.map((i) => (
              <li key={i.key} className="flex items-center gap-4 px-5 py-4">
                {i.connected ? <CheckCircle2 className="size-5 text-emerald-600" /> : <XCircle className="size-5 text-slate-300" />}
                <div className="flex-1"><p className="font-medium">{i.name}</p><p className="text-sm text-muted">{i.detail}</p></div>
                <Badge tone={i.connected ? 'green' : 'gray'}>{i.connected ? 'Connected' : 'Not connected'}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export function AuditLogsPage() {
  const list = useList<AuditLog>('/audit-logs', { action: '' });
  return (
    <>
      <PageHeader title="Audit logs" description="Security-relevant and business-critical actions in this workspace." />
      <AuditTable list={list} />
    </>
  );
}

export function AuditTable({ list, showTenant }: { list: ReturnType<typeof useList<AuditLog>>; showTenant?: boolean }) {
  return (
    <Card>
      <Toolbar><Input placeholder="Filter by action prefix, e.g. invoices." value={list.filters.action} onChange={(e) => list.setFilter('action', e.target.value)} className="w-72" /></Toolbar>
      {list.isLoading ? <LoadingBlock /> : list.error ? <ErrorState error={list.error} /> : !list.data?.items.length ? <EmptyState title="No audit entries" /> : (
        <>
          <Table><THead><tr><TH>When</TH>{showTenant && <TH>Tenant</TH>}<TH>Actor</TH><TH>Action</TH><TH>Entity</TH><TH>Details</TH><TH>IP</TH></tr></THead><TBody>
            {list.data.items.map((a) => (
              <TR key={a.id}>
                <TD className="whitespace-nowrap text-slate-600">{fmtDateTime(a.createdAt)}</TD>
                {showTenant && <TD>{a.tenant?.name ?? 'Platform'}</TD>}
                <TD>{a.actorEmail ?? 'System'}</TD>
                <TD><code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{a.action}</code></TD>
                <TD className="text-slate-600">{a.entityType ? `${a.entityType}` : '—'}</TD>
                <TD className="max-w-xs truncate font-mono text-xs text-muted" title={JSON.stringify(a.meta)}>{Object.keys(a.meta ?? {}).length ? JSON.stringify(a.meta) : ''}</TD>
                <TD className="text-xs text-muted">{a.ip}</TD>
              </TR>
            ))}
          </TBody></Table>
          <Pagination page={list.page} pages={list.data.pages} total={list.data.total} onPage={list.setPage} />
        </>
      )}
    </Card>
  );
}
