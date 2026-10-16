import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Pause, Pencil, Play, Plus, ReceiptIndianRupee, Repeat, Settings2, Trash2, Zap } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useCustomerOptions, useFinanceMeta, useList, useProjectOptions, termsLabel } from '@/lib/hooks';
import type { Expense, RecurringProfile } from '@/lib/types';
import { fmtDate, inr, money, num, titleCase, toDateInput } from '@/lib/utils';
import { Button, Card, CardHeader, ConfirmDialog, DescList, Dialog, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Pagination, SearchInput, Select, StatusBadge, Switch, Table, TBody, TD, TH, THead, Toolbar, TR, Textarea } from '@/components/ui';
import { ExportButton, FileManager } from '@/components/shared';
import { DocEditor } from '@/components/DocEditor';
import { MoreMenu, StatusTabs } from './finance';

const FREQ_LABEL: Record<string, string> = { WEEK: 'Weekly', TWO_WEEKS: 'Every 2 weeks', MONTH: 'Monthly', TWO_MONTHS: 'Every 2 months', THREE_MONTHS: 'Quarterly', SIX_MONTHS: 'Half-yearly', YEAR: 'Yearly', TWO_YEARS: 'Every 2 years', THREE_YEARS: 'Every 3 years' };

export const RecurringEditor = () => <DocEditor kind="recurring" />;

export function RecurringList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const list = useList<RecurringProfile>('/recurring-invoices', { status: '' }, { sort: 'createdAt' });
  const [del, setDel] = useState<RecurringProfile | null>(null);
  const remove = useAction((r: RecurringProfile) => api.delete(`/recurring-invoices/${r.id}`), { success: 'Profile deleted', invalidate: [['/recurring-invoices']], onSuccess: () => setDel(null) });
  return (
    <>
      <PageHeader title="Recurring Invoices" description="Invoices created automatically on a schedule." actions={can('invoices.create') && <Button onClick={() => navigate('/recurring-invoices/new')}><Plus /> New</Button>} />
      <StatusTabs value={list.filters.status} onChange={(v) => list.setFilter('status', v)} tabs={[['', 'All'], ['ACTIVE', 'Active'], ['STOPPED', 'Stopped'], ['EXPIRED', 'Expired']]} />
      <Card>
        <Toolbar><SearchInput value={list.q} onChange={list.setQ} placeholder="Profile or customer name" className="w-full sm:w-72" /></Toolbar>
        {list.isLoading ? <LoadingBlock /> : list.error ? <ErrorState error={list.error} /> : !list.data?.items.length ? <EmptyState icon={<Repeat />} title="No recurring invoices" description="Bill retainers, AMCs and subscriptions automatically." action={can('invoices.create') && <Button onClick={() => navigate('/recurring-invoices/new')}><Plus /> New recurring invoice</Button>} /> : (
          <>
            <Table><THead><tr><TH>Customer name</TH><TH>Profile name</TH><TH>Frequency</TH><TH>Last invoice date</TH><TH>Next invoice date</TH><TH>Status</TH><TH className="text-right">Amount</TH><TH className="w-10" /></tr></THead><TBody>
              {list.data.items.map((r) => (
                <TR key={r.id} onClick={() => navigate(`/recurring-invoices/${r.id}`)}>
                  <TD>{r.customer?.name}</TD><TD className="font-medium text-brand-700">{r.profileName}</TD><TD>{FREQ_LABEL[r.frequency]}</TD>
                  <TD className="text-slate-600">{fmtDate(r.lastRunDate)}</TD><TD className="text-slate-600">{r.status === 'ACTIVE' ? fmtDate(r.nextRunDate) : '—'}</TD>
                  <TD><StatusBadge status={r.status} /></TD><TD className="text-right tabular-nums">{money(r.amount, r.currency)}</TD>
                  <TD className="py-1 text-right">
                    <MoreMenu compact items={[
                      { label: 'Edit', icon: Pencil, onSelect: () => navigate(`/recurring-invoices/${r.id}/edit`), hidden: !can('invoices.create') },
                      { label: 'Delete', icon: Trash2, danger: true, onSelect: () => setDel(r), hidden: !can('invoices.create') },
                    ]} />
                  </TD>
                </TR>
              ))}
            </TBody></Table>
            <Pagination page={list.page} pages={list.data.pages} total={list.data.total} onPage={list.setPage} />
          </>
        )}
      </Card>
      <ConfirmDialog open={!!del} onOpenChange={(v) => !v && setDel(null)} title={`Delete "${del?.profileName ?? ''}"?`} danger confirmLabel="Delete" loading={remove.isPending}
        onConfirm={() => del && remove.mutate(del)} description="No more invoices are created from it. Invoices already created are kept." />
    </>
  );
}

export function RecurringDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const meta = useFinanceMeta();
  const q = useQuery({ queryKey: ['recurring', id], queryFn: () => api.get<RecurringProfile & { invoices: { id: string; number: string; issueDate: string; total: string; balanceDue: string; status: string }[]; upcoming: string[]; project?: { id: string; name: string } | null }>(`/recurring-invoices/${id}`) });
  const [del, setDel] = useState(false);
  const inv = [['recurring'], ['/recurring-invoices'], ['/invoices']];
  const act = useAction((a: 'stop' | 'resume' | 'run') => api.post<{ invoice?: { id: string; number: string } | null }>(`/recurring-invoices/${id}/${a}`), {
    success: (r) => (r.invoice ? `Invoice ${r.invoice.number} created` : 'Updated'), invalidate: inv,
  });
  const remove = useAction(() => api.delete(`/recurring-invoices/${id}`), { success: 'Profile deleted', invalidate: inv, onSuccess: () => navigate('/recurring-invoices') });
  if (q.isLoading) return <Card><LoadingBlock /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>;
  const r = q.data;
  return (
    <>
      <PageHeader breadcrumb={<Link to="/recurring-invoices" className="hover:underline">Recurring Invoices</Link>} title={<span className="flex items-center gap-3">{r.profileName}<StatusBadge status={r.status} /></span>}
        description={`${r.customer?.name} · ${FREQ_LABEL[r.frequency]}`}
        actions={can('invoices.create') && <>
          <Button variant="secondary" onClick={() => navigate(`/recurring-invoices/${r.id}/edit`)}><Pencil /> Edit</Button>
          {r.status === 'ACTIVE' ? <Button variant="secondary" onClick={() => act.mutate('stop')}><Pause /> Stop</Button> : <Button variant="secondary" onClick={() => act.mutate('resume')}><Play /> Resume</Button>}
          <Button onClick={() => act.mutate('run')} loading={act.isPending && act.variables === 'run'}><Zap /> Create invoice now</Button>
          <MoreMenu items={[{ label: 'Delete', icon: Trash2, onSelect: () => setDel(true), danger: true }]} />
        </>} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card>
            <CardHeader title="Child invoices" />
            {!r.invoices.length ? <EmptyState title="No invoices created yet" /> : (
              <Table><THead><tr><TH>Date</TH><TH>Invoice#</TH><TH>Status</TH><TH className="text-right">Amount</TH><TH className="text-right">Balance due</TH></tr></THead><TBody>
                {r.invoices.map((i) => <TR key={i.id} onClick={() => navigate(`/invoices/${i.id}`)}><TD>{fmtDate(i.issueDate)}</TD><TD className="font-medium text-brand-700">{i.number}</TD><TD><StatusBadge status={i.status} /></TD><TD className="text-right tabular-nums">{money(i.total, r.currency)}</TD><TD className="text-right tabular-nums">{money(i.balanceDue, r.currency)}</TD></TR>)}
              </TBody></Table>
            )}
          </Card>
          <Card>
            <CardHeader title="Items" />
            <Table><THead><tr><TH>Item</TH><TH className="text-right">Qty</TH><TH className="text-right">Rate</TH><TH className="text-right">GST</TH></tr></THead><TBody>
              {r.items.map((it, i) => <tr key={i}><TD className="whitespace-pre-line">{it.description}</TD><TD className="text-right">{num(it.quantity)}</TD><TD className="text-right tabular-nums">{money(it.rate, r.currency)}</TD><TD className="text-right">{num(it.taxRate)}%</TD></tr>)}
            </TBody></Table>
          </Card>
        </div>
        <Card className="p-5">
          <DescList className="sm:grid-cols-1" items={[
            ['Customer', <Link to={`/customers/${r.customerId}`} className="text-brand-700 hover:underline">{r.customer?.name}</Link>], ['Repeats', FREQ_LABEL[r.frequency]],
            ['Starts on', fmtDate(r.startDate)], ['Ends on', r.endDate ? fmtDate(r.endDate) : 'Never expires'], ['Payment terms', termsLabel(meta.data, r.paymentTerms)],
            ['Invoices are created', r.createAs === 'SEND' ? 'As sent' : 'As drafts'], ['Amount per invoice', money(r.amount ?? 0, r.currency)], ['Currency', r.currency], ['Project', r.project?.name],
            ['Upcoming', r.upcoming.length ? r.upcoming.map((d) => fmtDate(d)).join(', ') : '—'],
          ]} />
        </Card>
      </div>
      <ConfirmDialog open={del} onOpenChange={setDel} title="Delete this recurring profile?" danger confirmLabel="Delete" loading={remove.isPending} onConfirm={() => remove.mutate()} description="Invoices already created are kept." />
    </>
  );
}

// ───────────── Expenses ─────────────

type ExpenseForm = { date: string; categoryId: string; amount: string; amountIncludesTax: boolean; taxRate: string; paidThrough: string; vendor: string; reference: string; notes: string; customerId: string; projectId: string; billable: boolean; markupPct: string };
const blankExpense = (): ExpenseForm => ({ date: toDateInput(new Date()), categoryId: '', amount: '', amountIncludesTax: false, taxRate: '0', paidThrough: 'BANK', vendor: '', reference: '', notes: '', customerId: '', projectId: '', billable: false, markupPct: '0' });

export function ExpensesPage() {
  const { can } = useAuth();
  const meta = useFinanceMeta();
  const customers = useCustomerOptions();
  const projects = useProjectOptions();
  const cats = useQuery({ queryKey: ['expense-categories'], queryFn: () => api.get<{ id: string; name: string }[]>('/expense-categories') });
  const list = useList<Expense>('/expenses', { status: '', categoryId: '', from: '', to: '' }, { sort: 'date' });
  const [edit, setEdit] = useState<(ExpenseForm & { id?: string }) | null>(null);
  const [view, setView] = useState<Expense | null>(null);
  const [newCat, setNewCat] = useState('');
  useEffect(() => { if (edit && !edit.categoryId && cats.data?.length) setEdit((e) => (e ? { ...e, categoryId: cats.data![0].id } : e)); }, [edit, cats.data]);
  const save = useAction(() => {
    const e = edit!;
    const body = { date: e.date, categoryId: e.categoryId || null, amount: Number(e.amount), amountIncludesTax: e.amountIncludesTax, taxRate: Number(e.taxRate), paidThrough: e.paidThrough, vendor: e.vendor || null, reference: e.reference || null, notes: e.notes || null, customerId: e.customerId || null, projectId: e.projectId || null, billable: e.billable, markupPct: Number(e.markupPct) || 0 };
    return e.id ? api.patch(`/expenses/${e.id}`, body) : api.post('/expenses', body);
  }, { success: 'Expense saved', invalidate: [['/expenses'], ['billing-home']], onSuccess: () => setEdit(null) });
  const addCat = useAction(() => api.post<{ id: string }>('/expense-categories', { name: newCat }), { invalidate: [['expense-categories']], onSuccess: (c) => { setNewCat(''); setEdit((e) => (e ? { ...e, categoryId: c.id } : e)); } });
  const remove = useAction((xid: string) => api.delete(`/expenses/${xid}`), { success: 'Expense deleted', invalidate: [['/expenses'], ['billing-home']], onSuccess: () => { setView(null); setDelExp(null); } });
  const [delExp, setDelExp] = useState<Expense | null>(null);
  const [catsOpen, setCatsOpen] = useState(false);
  const [catEdit, setCatEdit] = useState<{ id: string; name: string } | null>(null);
  const renameCat = useAction(() => api.patch(`/expense-categories/${catEdit!.id}`, { name: catEdit!.name }), { success: 'Category renamed', invalidate: [['expense-categories'], ['/expenses']], onSuccess: () => setCatEdit(null) });
  const deleteCat = useAction((cid: string) => api.delete(`/expense-categories/${cid}`), { success: 'Category deleted', invalidate: [['expense-categories']] });
  const addCatInline = useAction(() => api.post('/expense-categories', { name: newCat }), { success: 'Category added', invalidate: [['expense-categories']], onSuccess: () => setNewCat('') });
  const toForm = (x: Expense): ExpenseForm & { id: string } => ({ id: x.id, date: toDateInput(x.date), categoryId: x.categoryId ?? '', amount: String(num(x.amount)), amountIncludesTax: false, taxRate: String(num(x.taxRate)), paidThrough: x.paidThrough, vendor: x.vendor ?? '', reference: x.reference ?? '', notes: x.notes ?? '', customerId: x.customerId ?? '', projectId: x.projectId ?? '', billable: x.billable, markupPct: String(num(x.markupPct)) });
  return (
    <>
      <PageHeader title="Expenses" description="Business expenses, with billable expenses you can add to customer invoices."
        actions={<><ExportButton path="/expenses" filename="expenses.csv" params={list.params} />{can('invoices.create') && <Button variant="secondary" onClick={() => setCatsOpen(true)}><Settings2 /> Categories</Button>}{can('invoices.create') && <Button onClick={() => setEdit(blankExpense())}><Plus /> Record Expense</Button>}</>} />
      <StatusTabs value={list.filters.status} onChange={(v) => list.setFilter('status', v)} tabs={[['', 'All'], ['unbilled', 'Unbilled'], ['invoiced', 'Invoiced'], ['nonbillable', 'Non-billable']]} />
      <Card>
        <Toolbar>
          <SearchInput value={list.q} onChange={list.setQ} placeholder="Vendor, reference, notes" className="w-full sm:w-64" />
          <Select value={list.filters.categoryId} onChange={(e) => list.setFilter('categoryId', e.target.value)} className="w-52"><option value="">All categories</option>{cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
          <Input type="date" className="w-36" value={list.filters.from} onChange={(e) => list.setFilter('from', e.target.value)} aria-label="From" />
          <Input type="date" className="w-36" value={list.filters.to} onChange={(e) => list.setFilter('to', e.target.value)} aria-label="To" />
          {list.data && <span className="ml-auto text-sm text-muted">Total <strong className="text-ink">{inr(list.data.sum)}</strong></span>}
        </Toolbar>
        {list.isLoading ? <LoadingBlock /> : list.error ? <ErrorState error={list.error} /> : !list.data?.items.length ? <EmptyState icon={<ReceiptIndianRupee />} title="No expenses recorded" /> : (
          <>
            <Table><THead><tr><TH>Date</TH><TH>Expense account</TH><TH>Reference#</TH><TH>Vendor</TH><TH>Paid through</TH><TH>Customer</TH><TH>Status</TH><TH className="text-right">Amount</TH><TH className="w-10" /></tr></THead><TBody>
              {list.data.items.map((e) => (
                <TR key={e.id} onClick={() => setView(e)}>
                  <TD>{fmtDate(e.date)}</TD><TD className="font-medium">{e.category?.name ?? 'Uncategorised'}</TD><TD className="text-slate-600">{e.reference ?? ''}</TD><TD>{e.vendor ?? ''}</TD><TD>{titleCase(e.paidThrough)}</TD><TD>{e.customer?.name ?? ''}</TD>
                  <TD>{e.invoice ? <span className="text-xs font-semibold text-emerald-700">INVOICED</span> : e.billable ? <span className="text-xs font-semibold text-amber-700">UNBILLED</span> : <span className="text-xs text-muted">NON-BILLABLE</span>}</TD>
                  <TD className="text-right tabular-nums">{inr(e.total)}</TD>
                  <TD className="py-1 text-right">
                    <MoreMenu compact items={[
                      { label: 'Edit', icon: Pencil, onSelect: () => setEdit(toForm(e)), hidden: !can('invoices.create') || !!e.invoiceId },
                      { label: 'Delete', icon: Trash2, danger: true, onSelect: () => setDelExp(e), hidden: !can('invoices.create') || !!e.invoiceId },
                    ]} />
                  </TD>
                </TR>
              ))}
            </TBody></Table>
            <Pagination page={list.page} pages={list.data.pages} total={list.data.total} onPage={list.setPage} />
          </>
        )}
      </Card>

      <Dialog open={!!edit} onOpenChange={(v) => !v && setEdit(null)} title={edit?.id ? 'Edit expense' : 'Record expense'} size="lg"
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!edit || !(Number(edit.amount) > 0)}>Save</Button></>}>
        {edit && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={<span className="text-red-600">Date*</span>}><Input type="date" value={edit.date} onChange={(e) => setEdit({ ...edit, date: e.target.value })} /></Field>
            <Field label={<span className="text-red-600">Expense account*</span>}>
              <Select value={edit.categoryId} onChange={(e) => setEdit({ ...edit, categoryId: e.target.value })}>{cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
              <div className="mt-1 flex gap-1"><Input className="h-8" placeholder="New category" value={newCat} onChange={(e) => setNewCat(e.target.value)} /><Button size="sm" variant="secondary" disabled={!newCat} onClick={() => addCat.mutate()}>Add</Button></div>
            </Field>
            <Field label={<span className="text-red-600">Amount (₹)*</span>}><Input type="number" min={0} step="0.01" value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: e.target.value })} /></Field>
            <Field label="GST on expense">
              <Select value={edit.taxRate} onChange={(e) => setEdit({ ...edit, taxRate: e.target.value })}><option value="0">No tax</option>{meta.data?.gstRates.filter((r) => r > 0).map((r) => <option key={r} value={r}>GST {r}%</option>)}</Select>
              {edit.taxRate !== '0' && <label className="mt-1 flex items-center gap-2 text-xs"><input type="checkbox" checked={edit.amountIncludesTax} onChange={(e) => setEdit({ ...edit, amountIncludesTax: e.target.checked })} /> Amount is tax inclusive</label>}
            </Field>
            <Field label="Paid through"><Select value={edit.paidThrough} onChange={(e) => setEdit({ ...edit, paidThrough: e.target.value })}>{['CASH', 'BANK', 'CARD', 'UPI', 'OTHER'].map((m) => <option key={m} value={m}>{titleCase(m)}</option>)}</Select></Field>
            <Field label="Vendor"><Input value={edit.vendor} onChange={(e) => setEdit({ ...edit, vendor: e.target.value })} /></Field>
            <Field label="Reference#"><Input value={edit.reference} onChange={(e) => setEdit({ ...edit, reference: e.target.value })} /></Field>
            <Field label="Customer"><Select value={edit.customerId} onChange={(e) => setEdit({ ...edit, customerId: e.target.value })}><option value="">—</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.company ?? c.name}</option>)}</Select></Field>
            <Field label="Project"><Select value={edit.projectId} onChange={(e) => setEdit({ ...edit, projectId: e.target.value })}><option value="">—</option>{projects.data?.filter((p) => !edit.customerId || p.customerId === edit.customerId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
            <div className="flex items-end gap-4">
              <label className="flex items-center gap-2 pb-2 text-sm"><Switch checked={edit.billable} onCheckedChange={(v) => setEdit({ ...edit, billable: v })} disabled={!edit.customerId} /> Billable</label>
              {edit.billable && <Field label="Mark up %"><Input type="number" min={0} className="w-24" value={edit.markupPct} onChange={(e) => setEdit({ ...edit, markupPct: e.target.value })} /></Field>}
            </div>
            <Field label="Notes" className="sm:col-span-2"><Textarea rows={2} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
          </div>
        )}
      </Dialog>

      <Dialog open={!!view} onOpenChange={(v) => !v && setView(null)} title={view ? `${view.category?.name ?? 'Expense'} · ${inr(view.total)}` : ''} size="lg"
        footer={view && !view.invoiceId && can('invoices.create') ? <>
          <Button variant="ghost" className="mr-auto text-red-600" onClick={() => setDelExp(view)}>Delete</Button>
          <Button variant="secondary" onClick={() => { setEdit(toForm(view)); setView(null); }}><Pencil /> Edit</Button>
        </> : undefined}>
        {view && (
          <div className="space-y-5">
            <DescList items={[['Date', fmtDate(view.date)], ['Vendor', view.vendor], ['Reference#', view.reference], ['Paid through', titleCase(view.paidThrough)], ['Amount', inr(view.amount)], ['Tax', `${inr(view.taxAmount)} (${num(view.taxRate)}%)`], ['Customer', view.customer?.name], ['Project', view.project?.name], ['Billing', view.invoice ? <Link className="text-brand-700 hover:underline" to={`/invoices/${view.invoice.id}`}>Invoiced on {view.invoice.number}</Link> : view.billable ? 'Unbilled' : 'Non-billable'], ['Notes', view.notes]]} />
            <div><p className="mb-2 text-sm font-semibold">Receipts</p><FileManager entityType="expense" entityId={view.id} /></div>
            {view.invoiceId && <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-muted">This expense is billed on an invoice. Remove it from that invoice (or void the invoice) to edit or delete it.</p>}
          </div>
        )}
      </Dialog>

      <ConfirmDialog open={!!delExp} onOpenChange={(v) => !v && setDelExp(null)} title="Delete this expense?" danger confirmLabel="Delete" loading={remove.isPending}
        description={delExp ? `${delExp.category?.name ?? 'Expense'} of ${inr(delExp.total)} on ${fmtDate(delExp.date)} is removed permanently.` : undefined}
        onConfirm={() => delExp && remove.mutate(delExp.id)} />

      <Dialog open={catsOpen} onOpenChange={setCatsOpen} title="Expense categories" description="Rename or remove categories. A category in use cannot be deleted."
        footer={<Button variant="secondary" onClick={() => setCatsOpen(false)}>Done</Button>}>
        <div className="mb-3 flex gap-2"><Input placeholder="New category" value={newCat} onChange={(e) => setNewCat(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && newCat.trim()) addCatInline.mutate(); }} /><Button variant="secondary" disabled={!newCat.trim()} loading={addCatInline.isPending} onClick={() => addCatInline.mutate()}><Plus /> Add</Button></div>
        <ul className="max-h-80 divide-y divide-line overflow-auto rounded-lg border border-line">
          {cats.data?.map((c) => (
            <li key={c.id} className="flex items-center gap-2 px-3 py-2">
              {catEdit?.id === c.id ? (
                <>
                  <Input autoFocus className="h-8" value={catEdit.name} onChange={(e) => setCatEdit({ ...catEdit, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && catEdit.name.trim()) renameCat.mutate(); if (e.key === 'Escape') setCatEdit(null); }} />
                  <Button size="sm" onClick={() => renameCat.mutate()} loading={renameCat.isPending} disabled={!catEdit.name.trim()}>Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setCatEdit(null)}>Cancel</Button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-sm">{c.name}</span>
                  <Button size="icon" variant="ghost" className="size-8 text-slate-500" aria-label={`Rename ${c.name}`} onClick={() => setCatEdit({ id: c.id, name: c.name })}><Pencil /></Button>
                  <Button size="icon" variant="ghost" className="size-8 text-slate-400 hover:text-red-600" aria-label={`Delete ${c.name}`} onClick={() => { if (confirm(`Delete the category "${c.name}"?`)) deleteCat.mutate(c.id); }}><Trash2 /></Button>
                </>
              )}
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}
