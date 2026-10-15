import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { Building2, CheckCircle2, Circle, Download, Mail, Pencil, Phone, Plus, Star, Trash2 } from 'lucide-react';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useCustomerOptions, useFinanceMeta, useList, useMembers, memberName, termsLabel } from '@/lib/hooks';
import type { Activity, Contact, Customer } from '@/lib/types';
import { cn, fmtDate, inr, money, titleCase, toDateInput } from '@/lib/utils';
import {
  Badge, Button, Card, CardHeader, Checkbox, ConfirmDialog, DescList, Dialog, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Pagination,
  Progress, SearchInput, Select, StatusBadge, Table, TBody, TD, TH, THead, Toolbar, TR, Tabs, TabsContent, TabsList, TabsTrigger, Textarea,
} from '@/components/ui';
import { ActivityTimeline, AssigneeSelect, ExportButton, FileManager, LogActivityDialog } from '@/components/shared';
import { InvoiceUnbilledDialog } from './time';

type CustomerForm = Partial<Omit<Customer, 'id' | 'code' | 'createdAt' | '_count'>> & { enablePortal?: boolean };

const SALUTATIONS = ['Mr.', 'Mrs.', 'Ms.', 'Miss', 'Dr.'];
const REGISTERED = ['REGISTERED_REGULAR', 'REGISTERED_COMPOSITION', 'SEZ', 'DEEMED_EXPORT'];

export function CustomerFormDialog({ open, onOpenChange, customer, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; customer?: Customer & { contacts?: Contact[] }; onSaved?: (c: Customer) => void }) {
  const meta = useFinanceMeta();
  const [f, setF] = useState<CustomerForm>({});
  const [contacts, setContacts] = useState<Partial<Contact>[]>([]);
  const [custom, setCustom] = useState<[string, string][]>([]);
  const [serverErrors, setServerErrors] = useState<Record<string, string[]>>({});
  const [tab, setTab] = useState('other');
  useEffect(() => {
    if (!open) return;
    setF(customer ? { ...customer } : { customerType: 'BUSINESS', currency: 'INR', language: 'en', taxPreference: 'TAXABLE', paymentTerms: 'DUE_ON_RECEIPT', status: 'ACTIVE', country: 'India' });
    setContacts(customer?.contacts?.filter((c) => !c.isPrimary) ?? []);
    setCustom(Object.entries(customer?.customFields ?? {}));
    setServerErrors({});
    setTab('other');
  }, [open, customer]);
  const set = <K extends keyof CustomerForm>(k: K, v: CustomerForm[K]) => setF((x) => ({ ...x, [k]: v }));
  // Display name suggestions, as in "Select or type to add".
  const nameOptions = [...new Set([f.company, [f.salutation, f.firstName, f.lastName].filter(Boolean).join(' '), [f.firstName, f.lastName].filter(Boolean).join(' '), f.lastName && f.firstName ? `${f.lastName}, ${f.firstName}` : ''].filter((x): x is string => !!x && x.trim().length > 0))];
  useEffect(() => { if (open && !customer && !f.name && nameOptions[0]) set('name', nameOptions[0]); }, [f.company, f.firstName, f.lastName]); // eslint-disable-line react-hooks/exhaustive-deps
  const err = (k: string) => serverErrors[k]?.[0];
  const save = useAction(async () => {
    const { contacts: _c, onboarding: _o, projects: _p, activities: _a, finance: _f, receivables: _r, unusedCredits: _u, portalEnabled: _pe, _count: _cnt, ...rest } = f as Record<string, unknown>;
    const body = { ...rest, customFields: Object.fromEntries(custom.filter(([k]) => k.trim())), gstin: f.gstin || null };
    const saved = customer ? await api.patch<Customer & { portal?: { inviteLink?: string } | null }>(`/customers/${customer.id}`, body) : await api.post<Customer & { portal?: { inviteLink?: string } | null }>('/customers', body);
    for (const c of contacts.filter((x) => x.name?.trim())) {
      if (c.id) await api.patch(`/contacts/${c.id}`, { name: c.name, email: c.email || null, phone: c.phone || null, designation: c.designation || null });
      else await api.post('/contacts', { customerId: saved.id, name: c.name, email: c.email || null, phone: c.phone || null, designation: c.designation || null });
    }
    if (!customer && (f.firstName || f.lastName || f.email)) {
      await api.post('/contacts', { customerId: saved.id, name: [f.salutation, f.firstName, f.lastName].filter(Boolean).join(' ') || saved.name, email: f.email || null, phone: f.mobile || f.phone || null, isPrimary: true });
    }
    return saved;
  }, {
    success: customer ? 'Customer updated' : 'Customer created',
    invalidate: [['/customers'], ['customer'], ['customers-options'], ['/contacts']],
    onSuccess: (c) => {
      if (c.portal?.inviteLink) { navigator.clipboard?.writeText(c.portal.inviteLink).catch(() => {}); toast.info('Portal invitation created. Email is not configured, so the invite link was copied to your clipboard.'); }
      onOpenChange(false); onSaved?.(c);
    },
  });
  const submit = () => {
    setServerErrors({});
    save.mutate(undefined, { onError: (e) => { if (e instanceof ApiError) setServerErrors(e.details?.fieldErrors ?? {}); } });
  };
  const registered = REGISTERED.includes(f.gstTreatment ?? '');
  const Row = ({ label, required, children, hint }: { label: ReactNode; required?: boolean; children: ReactNode; hint?: string }) => (
    <div className="grid items-start gap-2 sm:grid-cols-[170px_1fr]">
      <label className={cn('pt-2 text-sm', required ? 'text-red-600' : 'text-slate-700')}>{label}{required && '*'}</label>
      <div>{children}{hint && <p className="mt-1 text-xs text-muted">{hint}</p>}</div>
    </div>
  );
  const addr = (prefix: 'billing' | 'shipping') => {
    const k = (s: string) => (prefix === 'billing' ? ({ attention: 'billingAttention', address: 'billingAddress', city: 'city', state: 'state', postal: 'postalCode', country: 'country' } as Record<string, keyof CustomerForm>)[s] : ({ attention: 'shippingAttention', address: 'shippingAddress', city: 'shippingCity', state: 'shippingState', postal: 'shippingPostalCode', country: 'shippingCountry' } as Record<string, keyof CustomerForm>)[s]);
    const v = (s: string) => (f[k(s)] as string | null | undefined) ?? '';
    return (
      <div className="space-y-3">
        <Field label="Attention"><Input value={v('attention')} onChange={(e) => set(k('attention'), e.target.value)} /></Field>
        <Field label="Country / Region"><Input value={v('country') || 'India'} onChange={(e) => set(k('country'), e.target.value)} /></Field>
        <Field label="Address"><Textarea rows={2} value={v('address')} onChange={(e) => set(k('address'), e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="City"><Input value={v('city')} onChange={(e) => set(k('city'), e.target.value)} /></Field>
          <Field label="State"><Input value={v('state')} onChange={(e) => set(k('state'), e.target.value)} /></Field>
        </div>
        <Field label="Pin code"><Input value={v('postal')} onChange={(e) => set(k('postal'), e.target.value)} /></Field>
      </div>
    );
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={customer ? 'Edit customer' : 'New Customer'} size="xl"
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={submit} loading={save.isPending} disabled={!f.name}>Save</Button></>}>
      <div className="space-y-4">
        {Object.keys(serverErrors).length > 0 && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{Object.entries(serverErrors).map(([k, v]) => `${k}: ${v[0]}`).join(' · ')}</div>}
        <Row label="Customer Type">
          <div className="flex gap-6 pt-2 text-sm">{[['BUSINESS', 'Business'], ['INDIVIDUAL', 'Individual']].map(([v, l]) => <label key={v} className="flex items-center gap-2"><input type="radio" checked={f.customerType === v} onChange={() => set('customerType', v)} /> {l}</label>)}</div>
        </Row>
        <Row label="Primary Contact">
          <div className="grid gap-2 sm:grid-cols-[120px_1fr_1fr]">
            <Select value={f.salutation ?? ''} onChange={(e) => set('salutation', e.target.value)} aria-label="Salutation"><option value="">Salutation</option>{SALUTATIONS.map((s) => <option key={s}>{s}</option>)}</Select>
            <Input placeholder="First Name" value={f.firstName ?? ''} onChange={(e) => set('firstName', e.target.value)} aria-label="First name" />
            <Input placeholder="Last Name" value={f.lastName ?? ''} onChange={(e) => set('lastName', e.target.value)} aria-label="Last name" />
          </div>
        </Row>
        <Row label="Company Name"><Input value={f.company ?? ''} onChange={(e) => set('company', e.target.value)} /></Row>
        <Row label="Display Name" required>
          <Input list="display-names" value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder="Select or type to add" aria-invalid={!!err('name')} />
          <datalist id="display-names">{nameOptions.map((n) => <option key={n} value={n} />)}</datalist>
        </Row>
        <Row label="Currency"><Select value={f.currency ?? meta.data?.defaultCurrency ?? 'INR'} onChange={(e) => set('currency', e.target.value)}>{(meta.data?.currencies ?? [{ code: 'INR', name: 'Indian Rupee', symbol: '₹' }]).map((c) => <option key={c.code} value={c.code}>{c.code} - {c.name}</option>)}{f.currency && !meta.data?.currencies.some((c) => c.code === f.currency) && <option value={f.currency}>{f.currency}</option>}</Select></Row>
        <Row label="Email Address"><Input type="email" value={f.email ?? ''} onChange={(e) => set('email', e.target.value)} aria-invalid={!!err('email')} /></Row>
        <Row label="Phone">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input placeholder="Work Phone (+91)" value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value)} aria-label="Work phone" />
            <Input placeholder="Mobile (+91)" value={f.mobile ?? ''} onChange={(e) => set('mobile', e.target.value)} aria-label="Mobile" />
          </div>
        </Row>
        <Row label="Customer Language"><Select value={f.language ?? 'en'} onChange={(e) => set('language', e.target.value)}><option value="en">English</option><option value="hi">Hindi</option><option value="te">Telugu</option><option value="ta">Tamil</option><option value="kn">Kannada</option><option value="mr">Marathi</option></Select></Row>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="other">Other Details</TabsTrigger><TabsTrigger value="address">Address</TabsTrigger><TabsTrigger value="contacts">Contact Persons</TabsTrigger>
            <TabsTrigger value="custom">Custom Fields</TabsTrigger><TabsTrigger value="remarks">Remarks</TabsTrigger>
          </TabsList>
          <TabsContent value="other" className="space-y-4">
            <Row label="GST Treatment" required>
              <Select value={f.gstTreatment ?? ''} onChange={(e) => set('gstTreatment', e.target.value || null)}><option value="">Select a GST treatment</option>{Object.entries(meta.data?.gstTreatments ?? {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
            </Row>
            {(registered || f.gstin) && <Row label="GSTIN / UIN" required={registered} hint="State and PAN are filled in from the GSTIN.">
              <Input className="uppercase" maxLength={15} value={f.gstin ?? ''} aria-invalid={!!err('gstin')}
                onChange={(e) => { const g = e.target.value.toUpperCase(); setF((x) => ({ ...x, gstin: g, ...(g.length >= 2 && /^\d{2}/.test(g) ? { stateCode: g.slice(0, 2), state: meta.data?.states[g.slice(0, 2)] ?? x.state } : {}), ...(g.length >= 12 ? { pan: g.slice(2, 12) } : {}) })); }} />
            </Row>}
            <Row label="Place of Supply" required>
              <Select value={f.stateCode ?? ''} onChange={(e) => setF((x) => ({ ...x, stateCode: e.target.value, state: meta.data?.states[e.target.value] ?? x.state }))}><option value="" />{(meta.data?.stateList ?? []).map(([c, n]) => <option key={c} value={c}>[{c}] - {n}</option>)}</Select>
            </Row>
            <Row label="PAN"><Input className="uppercase" maxLength={10} value={f.pan ?? ''} onChange={(e) => set('pan', e.target.value.toUpperCase())} aria-invalid={!!err('pan')} /></Row>
            <Row label="Tax Preference" required>
              <div className="flex gap-6 pt-2 text-sm">{[['TAXABLE', 'Taxable'], ['EXEMPT', 'Tax Exempt']].map(([v, l]) => <label key={v} className="flex items-center gap-2"><input type="radio" checked={f.taxPreference === v} onChange={() => set('taxPreference', v)} /> {l}</label>)}</div>
            </Row>
            {f.taxPreference === 'EXEMPT' && <Row label="Exemption Reason" required><Input value={f.exemptionReason ?? ''} onChange={(e) => set('exemptionReason', e.target.value)} /></Row>}
            <Row label="Payment Terms"><Select value={f.paymentTerms ?? 'DUE_ON_RECEIPT'} onChange={(e) => set('paymentTerms', e.target.value)}>{meta.data?.paymentTerms.filter((t) => t.code !== 'CUSTOM').map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}</Select></Row>
            <Row label="Enable Portal?">
              {customer?.portalEnabled ? <p className="pt-2 text-sm text-emerald-700">Portal access is enabled for this customer.</p> : (
                <label className="flex items-center gap-2 pt-2 text-sm"><Checkbox checked={!!f.enablePortal} onCheckedChange={(v) => set('enablePortal', v)} /> Allow portal access for this customer</label>
              )}
            </Row>
            <Row label="Website"><Input value={f.website ?? ''} onChange={(e) => set('website', e.target.value)} /></Row>
            <Row label="Status"><Select value={f.status ?? 'ACTIVE'} onChange={(e) => set('status', e.target.value)}><option value="ACTIVE">Active</option><option value="PROSPECT">Prospect</option><option value="INACTIVE">Inactive</option></Select></Row>
            <Row label="Customer Owner" hint="Assign a user as the customer owner."><AssigneeSelect value={f.ownerId} onChange={(v) => set('ownerId', v)} /></Row>
          </TabsContent>
          <TabsContent value="address">
            <div className="grid gap-8 sm:grid-cols-2">
              <div><p className="mb-3 text-sm font-semibold">Billing Address</p>{addr('billing')}</div>
              <div>
                <p className="mb-3 flex items-center justify-between text-sm font-semibold">Shipping Address
                  <button className="text-xs font-normal text-brand-700 hover:underline" onClick={() => setF((x) => ({ ...x, shippingAttention: x.billingAttention, shippingAddress: x.billingAddress, shippingCity: x.city, shippingState: x.state, shippingPostalCode: x.postalCode, shippingCountry: x.country }))}>Copy billing address</button>
                </p>
                {addr('shipping')}
              </div>
            </div>
          </TabsContent>
          <TabsContent value="contacts">
            <Table><THead><tr><TH>Name</TH><TH>Email</TH><TH>Phone</TH><TH>Designation</TH><TH /></tr></THead><TBody>
              {contacts.map((c, i) => (
                <tr key={i}>
                  {(['name', 'email', 'phone', 'designation'] as const).map((k) => <TD key={k}><Input value={(c[k] as string) ?? ''} onChange={(e) => setContacts(contacts.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))} aria-label={k} /></TD>)}
                  <TD>{!c.id && <Button variant="ghost" size="icon" className="size-8" onClick={() => setContacts(contacts.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 /></Button>}</TD>
                </tr>
              ))}
            </TBody></Table>
            <Button variant="secondary" size="sm" className="mt-3" onClick={() => setContacts([...contacts, {}])}><Plus /> Add Contact Person</Button>
          </TabsContent>
          <TabsContent value="custom">
            <div className="space-y-2">
              {custom.map(([k, v], i) => (
                <div key={i} className="flex gap-2"><Input placeholder="Field name" value={k} onChange={(e) => setCustom(custom.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} /><Input placeholder="Value" value={v} onChange={(e) => setCustom(custom.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} /><Button variant="ghost" size="icon" onClick={() => setCustom(custom.filter((_, j) => j !== i))} aria-label="Remove field"><Trash2 /></Button></div>
              ))}
              <Button variant="secondary" size="sm" onClick={() => setCustom([...custom, ['', '']])}><Plus /> Add field</Button>
            </div>
          </TabsContent>
          <TabsContent value="remarks"><Field label="Remarks (for internal use)"><Textarea rows={4} value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></Field></TabsContent>
        </Tabs>
      </div>
    </Dialog>
  );
}

export function CustomersList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const meta = useFinanceMeta();
  const list = useList<Customer>('/customers', { status: 'ACTIVE' }, { sort: 'createdAt' });
  const [creating, setCreating] = useState(params.get('new') === '1');
  return (
    <>
      <PageHeader title={<span>{list.filters.status === 'ACTIVE' ? 'Active Customers' : list.filters.status === 'INACTIVE' ? 'Inactive Customers' : 'All Customers'}</span>}
        actions={<>{can('customers.read') && <ExportButton path="/customers" filename="customers.csv" params={list.params} />}{can('customers.update') && <Button onClick={() => setCreating(true)}><Plus /> New</Button>}</>} />
      <Card>
        <Toolbar>
          <SearchInput value={list.q} onChange={list.setQ} placeholder="Search name, company, email, GSTIN" className="w-full sm:w-80" />
          <Select value={list.filters.status} onChange={(e) => list.setFilter('status', e.target.value)} className="w-44"><option value="ACTIVE">Active customers</option><option value="">All customers</option><option value="PROSPECT">Prospects</option><option value="INACTIVE">Inactive customers</option></Select>
        </Toolbar>
        {list.isLoading ? <LoadingBlock /> : list.error ? <ErrorState error={list.error} onRetry={list.refetch} /> : !list.data?.items.length ? (
          <EmptyState icon={<Building2 />} title={list.q ? 'No matching customers' : 'No customers yet'} action={can('customers.update') && !list.q ? <Button onClick={() => setCreating(true)}><Plus /> New customer</Button> : undefined} />
        ) : (
          <>
            <Table>
              <THead><tr><TH>Name</TH><TH>Company name</TH><TH>Email</TH><TH>Work phone</TH><TH>Place of supply</TH><TH className="text-right">Receivables</TH><TH className="text-right">Unused credits</TH></tr></THead>
              <TBody>
                {list.data.items.map((c) => (
                  <TR key={c.id} onClick={() => navigate(`/customers/${c.id}`)}>
                    <TD className="font-medium text-brand-700">{c.name}</TD><TD>{c.company ?? ''}</TD><TD className="text-slate-600">{c.email ?? ''}</TD><TD className="text-slate-600">{c.phone ?? ''}</TD>
                    <TD className="text-slate-600">{c.stateCode ? meta.data?.states[c.stateCode] ?? c.state : c.state ?? ''}</TD>
                    <TD className="text-right tabular-nums">{c.receivables !== undefined ? inr(c.receivables) : '—'}</TD>
                    <TD className="text-right tabular-nums">{c.unusedCredits !== undefined ? inr(c.unusedCredits) : '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={list.page} pages={list.data.pages} total={list.data.total} onPage={list.setPage} />
          </>
        )}
      </Card>
      <CustomerFormDialog open={creating} onOpenChange={(v) => { setCreating(v); if (!v && params.get('new')) setParams({}); }} onSaved={(c) => navigate(`/customers/${c.id}`)} />
    </>
  );
}

function CustomerTransactions({ customerId }: { customerId: string }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [bill, setBill] = useState(false);
  const q = useQuery({ queryKey: ['customer-tx', customerId], queryFn: () => api.get<{ invoices: { id: string; number: string; issueDate: string; dueDate: string | null; total: string; balanceDue: string; status: string; currency: string }[]; quotes: { id: string; number: string; issueDate: string; total: string; status: string; referenceNumber: string | null; currency: string }[]; payments: { id: string; number: string; paidAt: string; amount: string; unusedAmount: string; method: string; reference: string | null; currency: string }[]; recurring: { id: string; profileName: string; frequency: string; nextRunDate: string; status: string }[]; expenses: { id: string; date: string; total: string; billable: boolean; invoiceId: string | null; category: { name: string } | null }[] }>(`/customers/${customerId}/transactions`) });
  if (q.isLoading) return <Card><LoadingBlock /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>;
  const d = q.data;
  const Section = ({ title, newTo, children, count }: { title: string; newTo?: string; children: ReactNode; count: number }) => (
    <Card><CardHeader title={`${title} (${count})`} actions={newTo && <Button size="sm" variant="secondary" onClick={() => navigate(newTo)}><Plus /> New</Button>} />{count ? children : <EmptyState title={`No ${title.toLowerCase()}`} />}</Card>
  );
  return (
    <div className="space-y-6">
      {can('invoices.create') && <div className="flex justify-end"><Button variant="secondary" onClick={() => setBill(true)}>Invoice unbilled time & expenses</Button></div>}
      <Section title="Invoices" count={d.invoices.length} newTo={can('invoices.create') ? `/invoices/new?customerId=${customerId}` : undefined}>
        <Table><THead><tr><TH>Date</TH><TH>Invoice#</TH><TH>Due date</TH><TH>Status</TH><TH className="text-right">Amount</TH><TH className="text-right">Balance due</TH></tr></THead><TBody>
          {d.invoices.map((i) => <TR key={i.id} onClick={() => navigate(`/invoices/${i.id}`)}><TD>{fmtDate(i.issueDate)}</TD><TD className="font-medium text-brand-700">{i.number}</TD><TD>{fmtDate(i.dueDate)}</TD><TD><StatusBadge status={i.status} /></TD><TD className="text-right tabular-nums">{money(i.total, i.currency)}</TD><TD className="text-right tabular-nums">{money(i.balanceDue, i.currency)}</TD></TR>)}
        </TBody></Table>
      </Section>
      <Section title="Customer Payments" count={d.payments.length} newTo={can('payments.record') ? `/payments/new?customerId=${customerId}` : undefined}>
        <Table><THead><tr><TH>Date</TH><TH>Payment#</TH><TH>Reference#</TH><TH>Mode</TH><TH className="text-right">Amount</TH><TH className="text-right">Unused</TH></tr></THead><TBody>
          {d.payments.map((p) => <TR key={p.id} onClick={() => navigate(`/payments/${p.id}`)}><TD>{fmtDate(p.paidAt)}</TD><TD className="font-medium text-brand-700">{p.number}</TD><TD>{p.reference ?? ''}</TD><TD>{titleCase(p.method)}</TD><TD className="text-right tabular-nums">{money(p.amount, p.currency)}</TD><TD className="text-right tabular-nums">{money(p.unusedAmount, p.currency)}</TD></TR>)}
        </TBody></Table>
      </Section>
      <Section title="Quotes" count={d.quotes.length} newTo={can('quotations.create') ? `/quotations/new?customerId=${customerId}` : undefined}>
        <Table><THead><tr><TH>Date</TH><TH>Quote#</TH><TH>Reference#</TH><TH>Status</TH><TH className="text-right">Amount</TH></tr></THead><TBody>
          {d.quotes.map((x) => <TR key={x.id} onClick={() => navigate(`/quotations/${x.id}`)}><TD>{fmtDate(x.issueDate)}</TD><TD className="font-medium text-brand-700">{x.number}</TD><TD>{x.referenceNumber ?? ''}</TD><TD><StatusBadge status={x.status} /></TD><TD className="text-right tabular-nums">{money(x.total, x.currency)}</TD></TR>)}
        </TBody></Table>
      </Section>
      <Section title="Recurring Invoices" count={d.recurring.length} newTo={can('invoices.create') ? '/recurring-invoices/new' : undefined}>
        <Table><THead><tr><TH>Profile</TH><TH>Frequency</TH><TH>Next invoice</TH><TH>Status</TH></tr></THead><TBody>
          {d.recurring.map((r) => <TR key={r.id} onClick={() => navigate(`/recurring-invoices/${r.id}`)}><TD className="font-medium text-brand-700">{r.profileName}</TD><TD>{titleCase(r.frequency)}</TD><TD>{fmtDate(r.nextRunDate)}</TD><TD><StatusBadge status={r.status} /></TD></TR>)}
        </TBody></Table>
      </Section>
      <Section title="Expenses" count={d.expenses.length}>
        <Table><THead><tr><TH>Date</TH><TH>Category</TH><TH>Billing</TH><TH className="text-right">Amount</TH></tr></THead><TBody>
          {d.expenses.map((e) => <tr key={e.id}><TD>{fmtDate(e.date)}</TD><TD>{e.category?.name}</TD><TD>{e.invoiceId ? 'Invoiced' : e.billable ? 'Unbilled' : 'Non-billable'}</TD><TD className="text-right tabular-nums">{inr(e.total)}</TD></tr>)}
        </TBody></Table>
      </Section>
      <InvoiceUnbilledDialog open={bill} onOpenChange={setBill} customerId={customerId} onCreated={(id) => navigate(`/invoices/${id}/edit`)} />
    </div>
  );
}

function StatementPanel({ customer }: { customer: Customer }) {
  const now = new Date();
  const [from, setFrom] = useState(toDateInput(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(toDateInput(now));
  const [emailOpen, setEmailOpen] = useState(false);
  const [recipients, setRecipients] = useState(customer.email ?? '');
  const [currency, setCurrency] = useState('');
  // Statements are per currency; the server picks the customer's main currency unless one is chosen.
  const q = useQuery({ queryKey: ['statement', customer.id, from, to, currency], queryFn: () => api.get<{ currency: { code: string }; currencies: string[]; opening: number; closing: number; rows: { date: string; type: string; number: string; amount: number; payment: number; balance: number }[] }>(`/customers/${customer.id}/statement`, { from, to, ...(currency ? { currency } : {}) }) });
  const code = q.data?.currency.code ?? currency;
  const sm = (v: unknown) => money(v, code);
  const send = useAction(() => api.post<{ delivered: boolean }>(`/email/statement/${customer.id}`, { to: recipients.split(/[,;\s]+/).filter(Boolean), from, toDate: to, currency: code || undefined }), { success: (r) => (r.delivered ? 'Statement emailed' : 'Statement queued (SMTP not configured: logged on the server)'), onSuccess: () => setEmailOpen(false) });
  return (
    <Card>
      <Toolbar>
        <Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" /><span className="text-sm text-muted">to</span><Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        {(q.data?.currencies.length ?? 0) > 1 && <Select className="w-28" value={code} onChange={(e) => setCurrency(e.target.value)} aria-label="Statement currency">{q.data!.currencies.map((c) => <option key={c} value={c}>{c}</option>)}</Select>}
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={() => api.download(`/customers/${customer.id}/statement`, `statement-${customer.code}.pdf`, { from, to, format: 'pdf', ...(code ? { currency: code } : {}) }, true).catch((e) => toast.error(errorMessage(e)))}><Download /> PDF</Button>
          <Button onClick={() => setEmailOpen(true)}><Mail /> Send Email</Button>
        </div>
      </Toolbar>
      {q.isLoading ? <LoadingBlock /> : q.data && (
        <>
          <div className="grid grid-cols-2 gap-4 border-b border-line p-5 sm:grid-cols-4 text-sm">
            <div><p className="text-xs text-muted">Opening balance</p><p className="font-semibold tabular-nums">{sm(q.data.opening)}</p></div>
            <div><p className="text-xs text-muted">Invoiced amount</p><p className="font-semibold tabular-nums">{sm(q.data.rows.reduce((s, r) => s + r.amount, 0))}</p></div>
            <div><p className="text-xs text-muted">Amount received</p><p className="font-semibold tabular-nums">{sm(q.data.rows.reduce((s, r) => s + r.payment, 0))}</p></div>
            <div><p className="text-xs text-muted">Balance due</p><p className="font-semibold tabular-nums text-amber-600">{sm(q.data.closing)}</p></div>
          </div>
          <Table><THead><tr><TH>Date</TH><TH>Transactions</TH><TH>Details</TH><TH className="text-right">Amount</TH><TH className="text-right">Payments</TH><TH className="text-right">Balance</TH></tr></THead><TBody>
            <tr><TD>{fmtDate(from)}</TD><TD>***Opening Balance***</TD><TD /><TD className="text-right tabular-nums">{sm(q.data.opening)}</TD><TD /><TD className="text-right tabular-nums">{sm(q.data.opening)}</TD></tr>
            {q.data.rows.map((r, i) => <tr key={i}><TD>{fmtDate(r.date)}</TD><TD>{r.type}</TD><TD>{r.number}</TD><TD className="text-right tabular-nums">{r.amount ? sm(r.amount) : ''}</TD><TD className="text-right tabular-nums">{r.payment ? sm(r.payment) : ''}</TD><TD className="text-right tabular-nums">{sm(r.balance)}</TD></tr>)}
          </TBody></Table>
        </>
      )}
      <Dialog open={emailOpen} onOpenChange={setEmailOpen} title="Email statement" footer={<><Button variant="secondary" onClick={() => setEmailOpen(false)}>Cancel</Button><Button onClick={() => send.mutate()} loading={send.isPending} disabled={!recipients}>Send</Button></>}>
        <Field label="To" hint="Separate multiple emails with commas"><Input value={recipients} onChange={(e) => setRecipients(e.target.value)} /></Field>
      </Dialog>
    </Card>
  );
}

interface CustomerDetailData extends Customer {
  contacts: Contact[];
  onboarding: { id: string; title: string; doneAt: string | null }[];
  projects: { id: string; code: string; name: string; status: string; dueDate: string | null }[];
  activities: Activity[];
  _count: { tickets: number; feedback: number; invoices: number; quotations: number; projects: number };
  finance: { total: string | null; amountPaid: string | null; balanceDue: string | null } | null;
}

export function CustomerDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const members = useMembers();
  const q = useQuery({ queryKey: ['customer', id], queryFn: () => api.get<CustomerDetailData>(`/customers/${id}`) });
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState(params.get('edit') === '1');
  const meta = useFinanceMeta();
  const [logging, setLogging] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const del = useAction(() => api.delete<{ deactivated?: boolean }>(`/customers/${id}`), {
    success: (r) => (r.deactivated ? 'Customer has history, so it was marked inactive' : 'Customer deleted'),
    invalidate: [['/customers'], ['customers-options']], onSuccess: (r) => (r.deactivated ? setDeleting(false) : navigate('/customers')),
  });
  if (q.isLoading) return <Card><LoadingBlock rows={8} /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} onRetry={q.refetch} /></Card>;
  const c = q.data;
  const done = c.onboarding.filter((o) => o.doneAt).length;
  return (
    <>
      <PageHeader
        breadcrumb={<Link to="/customers" className="hover:underline">Customers</Link>}
        title={<span className="flex items-center gap-3">{c.company ?? c.name}<StatusBadge status={c.status} /></span>}
        description={`${c.code} · ${c.name}`}
        actions={can('customers.update') && <>
          <Button variant="secondary" onClick={() => setLogging(true)}>Log activity</Button>
          {can('quotations.create') && <Button variant="secondary" onClick={() => navigate(`/quotations/new?customerId=${c.id}`)}>New quotation</Button>}
          <Button variant="secondary" onClick={() => setEditing(true)}><Pencil /> Edit</Button>
          <Button variant="ghost" size="icon" aria-label="Delete customer" onClick={() => setDeleting(true)}><Trash2 /></Button>
        </>}
      />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card className="p-4"><p className="text-[13px] text-muted">Projects</p><p className="mt-1 text-xl font-semibold">{c.projects.length}</p></Card>
        <Card className="p-4"><p className="text-[13px] text-muted">Tickets</p><p className="mt-1 text-xl font-semibold">{c._count.tickets}</p></Card>
        {c.finance ? <>
          <Card className="p-4"><p className="text-[13px] text-muted">Outstanding receivables</p><p className="mt-1 text-xl font-semibold tabular-nums text-amber-600">{inr(c.receivables ?? c.finance.balanceDue)}</p></Card>
          <Card className="p-4"><p className="text-[13px] text-muted">Unused credits</p><p className="mt-1 text-xl font-semibold tabular-nums">{inr(c.unusedCredits ?? 0)}</p></Card>
        </> : <Card className="p-4"><p className="text-[13px] text-muted">Feedback</p><p className="mt-1 text-xl font-semibold">{c._count.feedback}</p></Card>}
      </div>
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {c.finance && <TabsTrigger value="transactions">Transactions</TabsTrigger>}
          {c.finance && <TabsTrigger value="statement">Statement</TabsTrigger>}
          <TabsTrigger value="contacts">Contacts ({c.contacts.length})</TabsTrigger>
          <TabsTrigger value="onboarding">Onboarding</TabsTrigger>
          <TabsTrigger value="projects">Projects</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Card className="p-5">
            <DescList items={[
              ['Customer type', titleCase(c.customerType)], ['Primary contact', [c.salutation, c.firstName, c.lastName].filter(Boolean).join(' ') || null],
              ['Email', c.email && <a href={`mailto:${c.email}`} className="text-brand-700 hover:underline">{c.email}</a>], ['Work phone', c.phone], ['Mobile', c.mobile],
              ['Website', c.website], ['GST treatment', c.gstTreatment ? meta.data?.gstTreatments[c.gstTreatment] : null], ['GSTIN', c.gstin], ['PAN', c.pan],
              ['Place of supply', c.state ? `${c.state} (${c.stateCode})` : null], ['Tax preference', c.taxPreference === 'EXEMPT' ? `Tax exempt (${c.exemptionReason ?? ''})` : 'Taxable'],
              ['Payment terms', termsLabel(meta.data, c.paymentTerms)], ['Currency', c.currency], ['Portal', c.portalEnabled ? 'Enabled' : 'Not enabled'],
              ['Billing address', [c.billingAttention, c.billingAddress, c.city, c.postalCode].filter(Boolean).join(', ') || null],
              ['Shipping address', [c.shippingAttention, c.shippingAddress, c.shippingCity, c.shippingPostalCode].filter(Boolean).join(', ') || null], ['Customer owner', memberName(members.data, c.ownerId)],
              ...Object.entries(c.customFields ?? {}).map(([k, v]) => [k, v] as [string, string]),
              ['Customer since', fmtDate(c.createdAt)], ['Onboarding', <StatusBadge status={c.onboardingStatus} />],
            ]} />
            {c.notes && <div className="mt-5 border-t border-line pt-4"><p className="text-xs font-medium text-muted">Notes</p><p className="mt-1 whitespace-pre-wrap text-sm">{c.notes}</p></div>}
          </Card>
        </TabsContent>
        {c.finance && <TabsContent value="transactions"><CustomerTransactions customerId={c.id} /></TabsContent>}
        {c.finance && <TabsContent value="statement"><StatementPanel customer={c} /></TabsContent>}
        <TabsContent value="contacts"><ContactsPanel customerId={c.id} contacts={c.contacts} /></TabsContent>
        <TabsContent value="onboarding">
          <Card>
            <CardHeader title="Onboarding checklist" description={c.onboarding.length ? `${done} of ${c.onboarding.length} complete` : 'Not started'} />
            <div className="p-5"><OnboardingChecklist customerId={c.id} items={c.onboarding} /></div>
          </Card>
        </TabsContent>
        <TabsContent value="projects">
          <Card>
            {c.projects.length === 0 ? <EmptyState title="No projects for this customer" /> : (
              <Table><THead><tr><TH>Project</TH><TH>Status</TH><TH>Due</TH></tr></THead><TBody>
                {c.projects.map((p) => <TR key={p.id} onClick={() => navigate(`/projects/${p.id}`)}><TD><p className="font-medium">{p.name}</p><p className="text-xs text-muted">{p.code}</p></TD><TD><StatusBadge status={p.status} /></TD><TD>{fmtDate(p.dueDate)}</TD></TR>)}
              </TBody></Table>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="activity"><Card className="p-5"><ActivityTimeline items={c.activities} /></Card></TabsContent>
        <TabsContent value="files"><Card className="p-5"><FileManager entityType="customer" entityId={c.id} allowCustomerVisibility /></Card></TabsContent>
      </Tabs>
      <CustomerFormDialog open={editing} onOpenChange={(v) => { setEditing(v); if (!v && params.get('edit')) setParams({}); }} customer={c} />
      <LogActivityDialog open={logging} onOpenChange={setLogging} customerId={c.id} />
      <ConfirmDialog open={deleting} onOpenChange={setDeleting} title="Delete this customer?" danger confirmLabel="Delete" loading={del.isPending} onConfirm={() => del.mutate()}
        description="Customers with invoices, quotations or projects are kept for your records and marked inactive instead." />
    </>
  );
}

function ContactsPanel({ customerId, contacts }: { customerId: string; contacts: Contact[] }) {
  const { can } = useAuth();
  const [edit, setEdit] = useState<Partial<Contact> | null>(null);
  const save = useAction((c: Partial<Contact>) => (c.id ? api.patch(`/contacts/${c.id}`, c) : api.post('/contacts', { ...c, customerId })), { success: 'Contact saved', invalidate: [['customer'], ['/contacts']], onSuccess: () => setEdit(null) });
  const remove = useAction((cid: string) => api.delete(`/contacts/${cid}`), { success: 'Contact removed', invalidate: [['customer'], ['/contacts']] });
  return (
    <Card>
      <CardHeader title="Contacts" actions={can('customers.update') && <Button size="sm" onClick={() => setEdit({})}><Plus /> Add contact</Button>} />
      {contacts.length === 0 ? <EmptyState title="No contacts" /> : (
        <ul className="divide-y divide-line">
          {contacts.map((ct) => (
            <li key={ct.id} className="flex flex-wrap items-center gap-4 px-5 py-3">
              <div className="min-w-48 flex-1">
                <p className="flex items-center gap-2 font-medium">{ct.name}{ct.isPrimary && <Badge tone="blue"><Star className="size-3" /> Primary</Badge>}</p>
                <p className="text-xs text-muted">{ct.designation ?? '—'}</p>
              </div>
              {ct.email && <a href={`mailto:${ct.email}`} className="flex items-center gap-1.5 text-sm text-slate-600 hover:text-brand-700"><Mail className="size-3.5" />{ct.email}</a>}
              {ct.phone && <a href={`tel:${ct.phone}`} className="flex items-center gap-1.5 text-sm text-slate-600 hover:text-brand-700"><Phone className="size-3.5" />{ct.phone}</a>}
              {can('customers.update') && <div className="flex gap-1"><Button variant="ghost" size="sm" onClick={() => setEdit(ct)}>Edit</Button><Button variant="ghost" size="sm" className="text-red-600" onClick={() => remove.mutate(ct.id)}>Remove</Button></div>}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={!!edit} onOpenChange={(v) => !v && setEdit(null)} title={edit?.id ? 'Edit contact' : 'Add contact'}
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={() => edit && save.mutate(edit)} loading={save.isPending} disabled={!edit?.name}>Save</Button></>}>
        {edit && <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required><Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Designation"><Input value={edit.designation ?? ''} onChange={(e) => setEdit({ ...edit, designation: e.target.value })} /></Field>
          <Field label="Email"><Input type="email" value={edit.email ?? ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
          <Field label="Phone"><Input value={edit.phone ?? ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!edit.isPrimary} onChange={(e) => setEdit({ ...edit, isPrimary: e.target.checked })} /> Primary contact</label>
        </div>}
      </Dialog>
    </Card>
  );
}

function OnboardingChecklist({ customerId, items }: { customerId: string; items: { id: string; title: string; doneAt: string | null }[] }) {
  const { can } = useAuth();
  const [newItem, setNewItem] = useState('');
  const start = useAction(() => api.post(`/customers/${customerId}/onboarding/start`), { success: 'Onboarding started', invalidate: [['customer'], ['/onboarding']] });
  const toggle = useAction(({ id, done }: { id: string; done: boolean }) => api.patch(`/onboarding-items/${id}`, { done }), { invalidate: [['customer'], ['/onboarding']] });
  const add = useAction(() => api.post(`/customers/${customerId}/onboarding`, { title: newItem }), { invalidate: [['customer']], onSuccess: () => setNewItem('') });
  const remove = useAction((id: string) => api.delete(`/onboarding-items/${id}`), { invalidate: [['customer']] });
  if (!items.length) return <EmptyState title="Onboarding not started" description="Start from your onboarding template (set in Settings)." action={can('customers.update') && <Button onClick={() => start.mutate()} loading={start.isPending}>Start onboarding</Button>} />;
  const done = items.filter((i) => i.doneAt).length;
  return (
    <div className="max-w-2xl">
      <Progress value={(done / items.length) * 100} className="mb-4" />
      <ul className="space-y-1">
        {items.map((i) => (
          <li key={i.id} className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-slate-50">
            <button disabled={!can('customers.update')} onClick={() => toggle.mutate({ id: i.id, done: !i.doneAt })} aria-label={i.doneAt ? 'Mark not done' : 'Mark done'}>
              {i.doneAt ? <CheckCircle2 className="size-5 text-emerald-600" /> : <Circle className="size-5 text-slate-300" />}
            </button>
            <span className={i.doneAt ? 'flex-1 text-sm text-muted line-through' : 'flex-1 text-sm'}>{i.title}</span>
            {i.doneAt && <span className="text-xs text-muted">{fmtDate(i.doneAt)}</span>}
            {can('customers.update') && <button className="invisible text-slate-400 hover:text-red-600 group-hover:visible" onClick={() => remove.mutate(i.id)} aria-label="Remove item"><Trash2 className="size-4" /></button>}
          </li>
        ))}
      </ul>
      {can('customers.update') && (
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (newItem) add.mutate(); }}>
          <Input value={newItem} onChange={(e) => setNewItem(e.target.value)} placeholder="Add a checklist item" />
          <Button type="submit" variant="secondary" disabled={!newItem}>Add</Button>
        </form>
      )}
    </div>
  );
}

export function ContactsPage() {
  const navigate = useNavigate();
  const list = useList<Contact>('/contacts', {}, { sort: 'createdAt' });
  return (
    <>
      <PageHeader title="Contacts" description="People at your customer companies." />
      <Card>
        <Toolbar><SearchInput value={list.q} onChange={list.setQ} placeholder="Search contacts" className="w-full sm:w-80" /></Toolbar>
        {list.isLoading ? <LoadingBlock /> : list.error ? <ErrorState error={list.error} /> : !list.data?.items.length ? <EmptyState title="No contacts found" description="Contacts are added from a customer's page." /> : (
          <>
            <Table><THead><tr><TH>Name</TH><TH>Customer</TH><TH>Email</TH><TH>Phone</TH></tr></THead><TBody>
              {list.data.items.map((c) => (
                <TR key={c.id} onClick={() => navigate(`/customers/${c.customerId}`)}>
                  <TD><p className="flex items-center gap-2 font-medium">{c.name}{c.isPrimary && <Badge tone="blue">Primary</Badge>}</p><p className="text-xs text-muted">{c.designation ?? ''}</p></TD>
                  <TD>{c.customer?.company ?? c.customer?.name}</TD><TD className="text-slate-600">{c.email ?? '—'}</TD><TD className="text-slate-600">{c.phone ?? '—'}</TD>
                </TR>
              ))}
            </TBody></Table>
            <Pagination page={list.page} pages={list.data.pages} total={list.data.total} onPage={list.setPage} />
          </>
        )}
      </Card>
    </>
  );
}

export function OnboardingPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const [starting, setStarting] = useState(false);
  const [pick, setPick] = useState('');
  const customers = useCustomerOptions(starting);
  const q = useQuery({ queryKey: ['/onboarding', status], queryFn: () => api.get<{ id: string; code: string; name: string; company: string | null; onboardingStatus: string; total: number; done: number; createdAt: string }[]>('/onboarding', { status }) });
  const start = useAction(() => api.post(`/customers/${pick}/onboarding/start`), { success: 'Onboarding started', invalidate: [['/onboarding']], onSuccess: () => { setStarting(false); navigate(`/customers/${pick}`); } });
  return (
    <>
      <PageHeader title="Customer onboarding" description="Track each new customer through your onboarding checklist."
        actions={can('customers.update') && <Button onClick={() => setStarting(true)}><Plus /> Start onboarding</Button>} />
      <Card>
        <Toolbar><Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-48"><option value="">In progress & completed</option><option value="IN_PROGRESS">In progress</option><option value="COMPLETED">Completed</option></Select></Toolbar>
        {q.isLoading ? <LoadingBlock /> : q.error ? <ErrorState error={q.error} /> : !q.data?.length ? <EmptyState title="No onboarding in progress" description="Onboarding starts automatically when a lead is converted, or start it manually." /> : (
          <Table><THead><tr><TH>Customer</TH><TH>Status</TH><TH className="w-64">Progress</TH></tr></THead><TBody>
            {q.data.map((c) => (
              <TR key={c.id} onClick={() => navigate(`/customers/${c.id}`)}>
                <TD><p className="font-medium">{c.company ?? c.name}</p><p className="text-xs text-muted">{c.code}</p></TD>
                <TD><StatusBadge status={c.onboardingStatus} /></TD>
                <TD><div className="flex items-center gap-3"><Progress value={c.total ? (c.done / c.total) * 100 : 0} /><span className="w-12 text-right text-xs tabular-nums text-muted">{c.done}/{c.total}</span></div></TD>
              </TR>
            ))}
          </TBody></Table>
        )}
      </Card>
      <Dialog open={starting} onOpenChange={setStarting} title="Start onboarding"
        footer={<><Button variant="secondary" onClick={() => setStarting(false)}>Cancel</Button><Button disabled={!pick} loading={start.isPending} onClick={() => start.mutate()}>Start</Button></>}>
        <Field label="Customer"><Select value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Select a customer</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.company ?? c.name}</option>)}</Select></Field>
      </Dialog>
    </>
  );
}
