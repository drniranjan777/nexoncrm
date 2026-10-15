import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Mail, Pencil, Plus, RotateCcw, Trash2, Wallet } from 'lucide-react';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useCustomerOptions, useFinanceMeta, useList } from '@/lib/hooks';
import type { Payment } from '@/lib/types';
import { cn, fmtDate, money, num, titleCase, toDateInput } from '@/lib/utils';
import { Button, Card, CardHeader, ConfirmDialog, DescList, Dialog, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Pagination, SearchInput, Select, Table, TBody, TD, TH, THead, Toolbar, TR, Textarea, Badge } from '@/components/ui';
import { FileManager } from '@/components/shared';
import { MoreMenu } from './finance';

const METHODS = ['BANK_TRANSFER', 'UPI', 'CARD', 'CASH', 'CHEQUE', 'OTHER'];

interface OpenInvoice { id: string; number: string; issueDate: string; dueDate: string | null; total: string; balanceDue: string; status: string; currency: string; exchangeRate: string }

export function PaymentsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const list = useList<Payment>('/payments', { method: '', unused: '' }, { sort: 'paidAt' });
  const meta = useFinanceMeta();
  const base = meta.data?.baseCurrency ?? 'INR';
  const hasForeign = !!list.data?.items.some((p) => p.currency !== base);
  return (
    <>
      <PageHeader title="All Received Payments" actions={can('payments.record') && <Button onClick={() => navigate('/payments/new')}><Plus /> New</Button>} />
      <Card>
        <Toolbar>
          <SearchInput value={list.q} onChange={list.setQ} placeholder="Payment#, reference, invoice#, customer" className="w-full sm:w-80" />
          <Select value={list.filters.method} onChange={(e) => list.setFilter('method', e.target.value)} className="w-40"><option value="">All modes</option>{METHODS.map((m) => <option key={m} value={m}>{titleCase(m)}</option>)}</Select>
          <label className="flex items-center gap-2 text-[13px] text-slate-600"><input type="checkbox" checked={list.filters.unused === '1'} onChange={(e) => list.setFilter('unused', e.target.checked ? '1' : '')} /> With unused amount</label>
          {list.data && <span className="ml-auto text-sm text-muted">Total received <strong className="text-ink">{money(list.data.sum, base)}</strong>{hasForeign && ` (in ${base})`}</span>}
        </Toolbar>
        {list.isLoading ? <LoadingBlock /> : list.error ? <ErrorState error={list.error} /> : !list.data?.items.length ? <EmptyState icon={<Wallet />} title="No payments yet" /> : (
          <>
            <Table><THead><tr><TH>Date</TH><TH>Payment#</TH><TH>Reference number</TH><TH>Customer name</TH><TH>Invoice#</TH><TH>Mode</TH><TH className="text-right">Amount</TH><TH className="text-right">Unused amount</TH><TH>Status</TH></tr></THead><TBody>
              {list.data.items.map((p) => (
                <TR key={p.id} onClick={() => navigate(`/payments/${p.id}`)}>
                  <TD>{fmtDate(p.paidAt)}</TD><TD className="font-medium text-brand-700">{p.number}</TD><TD className="text-slate-600">{p.reference ?? ''}</TD>
                  <TD>{p.customer?.name}</TD><TD className="text-slate-600">{p.invoiceNumbers?.join(', ')}</TD><TD>{titleCase(p.method)}</TD>
                  <TD className="text-right tabular-nums">{money(p.amount, p.currency)}</TD><TD className="text-right tabular-nums">{money(p.unusedAmount, p.currency)}</TD>
                  <TD><span className={cn('text-xs font-semibold', num(p.unusedAmount) > 0 ? 'text-amber-600' : 'text-emerald-600')}>{num(p.unusedAmount) > 0 ? 'UNUSED CREDIT' : 'PAID'}</span></TD>
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

export function PaymentForm() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const customers = useCustomerOptions();
  const [customerId, setCustomerId] = useState(params.get('customerId') ?? '');
  const preselect = params.get('invoiceId');
  const nextNo = useQuery({ queryKey: ['payments', 'next-number'], queryFn: () => api.get<{ number: string }>('/payments/next-number') });
  const open = useQuery({ queryKey: ['open-invoices', customerId], enabled: !!customerId, queryFn: () => api.get<{ invoices: OpenInvoice[]; unusedCredits: number }>(`/customers/${customerId}/open-invoices`) });
  const [f, setF] = useState({ amount: '', bankCharges: '', taxDeductedOn: false, taxDeducted: '', paidAt: toDateInput(new Date()), method: 'BANK_TRANSFER', reference: '', notes: '' });
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const meta = useFinanceMeta();
  const base = meta.data?.baseCurrency ?? 'INR';
  // A payment is in one currency and pays invoices in that currency only.
  const invoiceCurrencies = [...new Set((open.data?.invoices ?? []).map((i) => i.currency))];
  const [currency, setCurrency] = useState('');
  const [rate, setRate] = useState('');
  const cur = currency || invoiceCurrencies[0] || meta.data?.defaultCurrency || base;
  const payable = (open.data?.invoices ?? []).filter((i) => i.currency === cur);

  // Pre-fill: paying a specific invoice puts its balance in the amount.
  useEffect(() => {
    if (!open.data) return;
    if (preselect) {
      const inv = open.data.invoices.find((i) => i.id === preselect);
      if (inv) { setCurrency(inv.currency); setAlloc({ [inv.id]: String(num(inv.balanceDue)) }); setF((x) => ({ ...x, amount: x.amount || String(num(inv.balanceDue)) })); }
    } else setAlloc({});
  }, [open.data, preselect]);
  // A foreign payment defaults to the rate of the invoice it pays; the actual rate received can be entered.
  useEffect(() => { setRate(cur !== base ? String(num(payable[0]?.exchangeRate) || '') : ''); }, [cur, base, open.data]);

  const received = (Number(f.amount) || 0) + (f.taxDeductedOn ? Number(f.taxDeducted) || 0 : 0);
  const applied = useMemo(() => Object.values(alloc).reduce((s, v) => s + (Number(v) || 0), 0), [alloc]);
  const excess = Math.round((received - applied) * 100) / 100;

  // Auto-apply the amount to the oldest invoices first.
  const autoApply = () => {
    let left = received;
    const next: Record<string, string> = {};
    for (const inv of payable) {
      if (left <= 0) break;
      const take = Math.min(left, num(inv.balanceDue));
      next[inv.id] = String(Math.round(take * 100) / 100);
      left -= take;
    }
    setAlloc(next);
  };

  const save = async () => {
    setError(null);
    if (!customerId) return setError('Select a customer.');
    if (!(Number(f.amount) > 0)) return setError('Enter the amount received.');
    if (excess < -0.001) return setError('Amounts applied to invoices exceed the amount received.');
    setSaving(true);
    try {
      const pay = await api.post<{ id: string }>('/payments', {
        customerId, amount: Number(f.amount), bankCharges: Number(f.bankCharges) || 0, taxDeducted: f.taxDeductedOn ? Number(f.taxDeducted) || 0 : 0,
        paidAt: new Date(f.paidAt).toISOString(), method: f.method, reference: f.reference || null, notes: f.notes || null,
        allocations: Object.entries(alloc).filter(([id, v]) => Number(v) > 0 && payable.some((i) => i.id === id)).map(([invoiceId, v]) => ({ invoiceId, amount: Number(v) })),
        currency: cur, exchangeRate: cur !== base ? Number(rate) || null : null,
      });
      toast.success(excess > 0 ? `Payment recorded. ${money(excess, cur)} kept as customer credit.` : 'Payment recorded');
      navigate(`/payments/${pay.id}`, { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-5xl">
      <PageHeader breadcrumb={<Link to="/payments" className="hover:underline">Payments Received</Link>} title="Record Payment" />
      {error && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{error}</div>}
      <Card className="mb-6 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={<span className="text-red-600">Customer Name*</span>} className="sm:col-span-2">
            <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}><option value="">Select customer</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.company ?? c.name}</option>)}</Select>
          </Field>
          <Field label="Currency" hint={invoiceCurrencies.length > 1 ? 'This customer has unpaid invoices in more than one currency. Record one payment per currency.' : undefined}>
            <div className="flex flex-wrap items-center gap-2">
              <Select className="w-44" value={cur} onChange={(e) => { setCurrency(e.target.value); setAlloc({}); }}>
                {[...new Set([...invoiceCurrencies, ...(meta.data?.currencies ?? []).map((c) => c.code)])].map((c) => <option key={c} value={c}>{c}{invoiceCurrencies.includes(c) ? ' · has unpaid invoices' : ''}</option>)}
              </Select>
              {cur !== base && <span className="flex items-center gap-1.5 text-sm text-slate-600">1 {cur} = <Input className="w-28 text-right" type="number" min={0} step="0.0001" value={rate} onChange={(e) => setRate(e.target.value)} aria-label="Exchange rate" /> {base}</span>}
            </div>
          </Field>
          <Field label={<span className="text-red-600">Amount Received ({cur})*</span>}><Input type="number" min={0} step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label="Bank Charges (if any)"><Input type="number" min={0} step="0.01" value={f.bankCharges} onChange={(e) => setF({ ...f, bankCharges: e.target.value })} /></Field>
          <Field label={<span className="text-red-600">Payment Date*</span>}><Input type="date" value={f.paidAt} onChange={(e) => setF({ ...f, paidAt: e.target.value })} /></Field>
          <Field label="Payment #"><Input value={nextNo.data?.number ?? ''} disabled /></Field>
          <Field label="Payment Mode"><Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{METHODS.map((m) => <option key={m} value={m}>{titleCase(m)}</option>)}</Select></Field>
          <Field label="Reference#"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="UTR, cheque number" /></Field>
          <Field label="Tax deducted?" className="sm:col-span-2">
            <div className="flex flex-wrap items-center gap-6 text-sm">
              <label className="flex items-center gap-2"><input type="radio" checked={!f.taxDeductedOn} onChange={() => setF({ ...f, taxDeductedOn: false })} /> No Tax deducted</label>
              <label className="flex items-center gap-2"><input type="radio" checked={f.taxDeductedOn} onChange={() => setF({ ...f, taxDeductedOn: true })} /> Yes, TDS (Income Tax)</label>
              {f.taxDeductedOn && <Input type="number" min={0} step="0.01" className="w-40" placeholder="TDS amount" value={f.taxDeducted} onChange={(e) => setF({ ...f, taxDeducted: e.target.value })} />}
            </div>
          </Field>
        </div>
      </Card>
      <Card className="mb-6">
        <CardHeader title="Unpaid Invoices" description={open.data?.unusedCredits ? `Customer also has ${money(open.data.unusedCredits, base)} of unused credit from earlier payments.` : undefined}
          actions={!!open.data?.invoices.length && <Button size="sm" variant="secondary" onClick={autoApply} disabled={!received}>Apply automatically</Button>} />
        {!customerId ? <EmptyState title="Select a customer to see unpaid invoices" /> : open.isLoading ? <LoadingBlock rows={3} /> : !payable.length ? <EmptyState title={`No unpaid ${cur} invoices`} description="The full amount will be saved as customer credit." /> : (
          <Table><THead><tr><TH>Date</TH><TH>Invoice#</TH><TH>Due date</TH><TH className="text-right">Invoice amount</TH><TH className="text-right">Amount due</TH><TH className="w-40 text-right">Payment</TH></tr></THead><TBody>
            {payable.map((i) => (
              <tr key={i.id}>
                <TD>{fmtDate(i.issueDate)}</TD><TD className="font-medium">{i.number}</TD><TD className={cn(i.status === 'OVERDUE' && 'text-red-600')}>{fmtDate(i.dueDate)}</TD>
                <TD className="text-right tabular-nums">{money(i.total, i.currency)}</TD><TD className="text-right tabular-nums">{money(i.balanceDue, i.currency)}</TD>
                <TD><Input type="number" min={0} max={num(i.balanceDue)} step="0.01" className="text-right" value={alloc[i.id] ?? ''} onChange={(e) => setAlloc({ ...alloc, [i.id]: e.target.value })} aria-label={`Payment for ${i.number}`} /></TD>
              </tr>
            ))}
          </TBody></Table>
        )}
        <div className="flex justify-end border-t border-line p-5">
          <div className="w-80 space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-slate-600">Amount received</span><span className="tabular-nums">{money(received, cur)}</span></div>
            <div className="flex justify-between"><span className="text-slate-600">Amount used for payments</span><span className="tabular-nums">{money(applied, cur)}</span></div>
            <div className={cn('flex justify-between font-semibold', excess < 0 ? 'text-red-600' : excess > 0 && 'text-amber-600')}><span>Amount in excess</span><span className="tabular-nums">{money(excess, cur)}</span></div>
            {excess > 0 && <p className="text-xs text-muted">The excess is kept as unused credit for this customer.</p>}
          </div>
        </div>
      </Card>
      <Card className="mb-6 p-5"><Field label="Notes (internal)"><Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field></Card>
      <div className="flex gap-2"><Button onClick={save} loading={saving}>Save</Button><Button variant="ghost" onClick={() => navigate(-1)}>Cancel</Button></div>
    </div>
  );
}

export function PaymentDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['payment', id], queryFn: () => api.get<Payment>(`/payments/${id}`) });
  const open = useQuery({ queryKey: ['open-invoices', q.data?.customerId], enabled: !!q.data?.customerId && num(q.data?.unusedAmount) > 0, queryFn: () => api.get<{ invoices: OpenInvoice[] }>(`/customers/${q.data!.customerId}/open-invoices`) });
  const [applyOpen, setApplyOpen] = useState(false);
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [refundOpen, setRefundOpen] = useState(false);
  const [refund, setRefund] = useState({ amount: '', refundedAt: toDateInput(new Date()), method: 'BANK_TRANSFER', reference: '' });
  const [del, setDel] = useState(false);
  const [edit, setEdit] = useState<{ amount: string; bankCharges: string; taxDeducted: string; paidAt: string; method: string; reference: string; notes: string } | null>(null);
  const inv = [['payment'], ['/payments'], ['invoice'], ['/invoices'], ['open-invoices']];
  const save = useAction(() => api.patch(`/payments/${id}`, {
    amount: Number(edit!.amount), bankCharges: Number(edit!.bankCharges) || 0, taxDeducted: Number(edit!.taxDeducted) || 0,
    paidAt: new Date(edit!.paidAt).toISOString(), method: edit!.method, reference: edit!.reference || null, notes: edit!.notes || null,
  }), { success: 'Payment updated', invalidate: inv, onSuccess: () => setEdit(null) });
  const apply = useAction(() => api.post(`/payments/${id}/apply`, { allocations: Object.entries(alloc).filter(([, v]) => Number(v) > 0).map(([invoiceId, v]) => ({ invoiceId, amount: Number(v) })) }), { success: 'Credit applied', invalidate: inv, onSuccess: () => { setApplyOpen(false); setAlloc({}); } });
  const doRefund = useAction(() => api.post(`/payments/${id}/refund`, { ...refund, amount: Number(refund.amount), refundedAt: new Date(refund.refundedAt).toISOString(), reference: refund.reference || null }), { success: 'Refund recorded', invalidate: inv, onSuccess: () => setRefundOpen(false) });
  const unapply = useAction((allocationId: string) => api.delete(`/payments/${id}/allocations/${allocationId}`), { success: 'Removed from invoice', invalidate: inv });
  const remove = useAction(() => api.delete(`/payments/${id}`), { success: 'Payment deleted', invalidate: inv, onSuccess: () => navigate('/payments') });
  if (q.isLoading) return <Card><LoadingBlock /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>;
  const p = q.data;
  const unused = num(p.unusedAmount);
  const committed = (p.allocations ?? []).reduce((sum, a) => sum + num(a.amount), 0) + num(p.refundedAmount);
  return (
    <>
      <PageHeader breadcrumb={<Link to="/payments" className="hover:underline">Payments Received</Link>}
        title={<span className="flex items-center gap-3">Payment {p.number}{unused > 0 ? <Badge tone="amber">Unused {money(unused, p.currency)}</Badge> : <Badge tone="green">Paid</Badge>}</span>}
        description={`${p.customer?.name ?? ''} · ${fmtDate(p.paidAt)}`}
        actions={<>
          {can('payments.record') && <Button variant="secondary" onClick={() => setEdit({
            amount: String(num(p.amount)), bankCharges: num(p.bankCharges) ? String(num(p.bankCharges)) : '', taxDeducted: num(p.taxDeducted) ? String(num(p.taxDeducted)) : '',
            paidAt: toDateInput(p.paidAt), method: p.method, reference: p.reference ?? '', notes: p.notes ?? '',
          })}><Pencil /> Edit</Button>}
          {can('payments.record') && <Button variant="secondary" onClick={() => navigate(`/email/payment/${p.id}`)}><Mail /> Send receipt</Button>}
          {can('payments.record') && unused > 0 && <Button onClick={() => setApplyOpen(true)}>Apply to invoices</Button>}
          <MoreMenu items={[
            { label: 'Refund', icon: RotateCcw, onSelect: () => { setRefund({ ...refund, amount: String(unused) }); setRefundOpen(true); }, hidden: !can('payments.record') || unused <= 0 },
            { label: 'Delete', icon: Trash2, onSelect: () => setDel(true), danger: true, hidden: !can('payments.record') },
          ]} />
        </>} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card className="p-6">
            <p className="text-center text-xs font-semibold uppercase tracking-widest text-muted">Payment Receipt</p>
            <div className="mx-auto mt-4 max-w-xs rounded-xl bg-emerald-50 p-4 text-center"><p className="text-xs text-emerald-700">Amount Received</p><p className="text-2xl font-semibold text-emerald-700">{money(p.amount, p.currency)}</p></div>
            <DescList className="mt-6" items={[['Payment date', fmtDate(p.paidAt)], ['Reference number', p.reference], ['Payment mode', titleCase(p.method)], ['Bank charges', num(p.bankCharges) ? money(p.bankCharges, p.currency) : null], ['TDS deducted', num(p.taxDeducted) ? money(p.taxDeducted, p.currency) : null], ['Refunded', num(p.refundedAmount) ? money(p.refundedAmount, p.currency) : null], ['Currency', num(p.exchangeRate) !== 1 ? `${p.currency} · 1 ${p.currency} = ${num(p.exchangeRate)}` : p.currency]]} />
          </Card>
          <Card>
            <CardHeader title="Payment for" />
            {!p.allocations?.length ? <EmptyState title="Not applied to any invoice" description="This amount is customer credit." /> : (
              <Table><THead><tr><TH>Invoice#</TH><TH>Invoice date</TH><TH className="text-right">Invoice amount</TH><TH className="text-right">Payment amount</TH><TH /></tr></THead><TBody>
                {p.allocations.map((a) => (
                  <tr key={a.id}><TD><Link to={`/invoices/${a.invoice.id}`} className="font-medium text-brand-700 hover:underline">{a.invoice.number}</Link></TD><TD>{fmtDate(a.invoice.issueDate)}</TD><TD className="text-right tabular-nums">{money(a.invoice.total, p.currency)}</TD><TD className="text-right tabular-nums">{money(a.amount, p.currency)}</TD>
                    <TD className="text-right">{can('payments.record') && <Button variant="ghost" size="sm" className="text-red-600" onClick={() => unapply.mutate(a.id)}>Remove</Button>}</TD></tr>
                ))}
              </TBody></Table>
            )}
          </Card>
          {!!p.refunds?.length && (
            <Card>
              <CardHeader title="Refunds" />
              <Table><THead><tr><TH>Date</TH><TH>Mode</TH><TH>Reference#</TH><TH className="text-right">Amount</TH></tr></THead><TBody>
                {p.refunds.map((r) => <tr key={r.id}><TD>{fmtDate(r.refundedAt)}</TD><TD>{titleCase(r.method)}</TD><TD>{r.reference ?? '—'}</TD><TD className="text-right tabular-nums">{money(r.amount, p.currency)}</TD></tr>)}
              </TBody></Table>
            </Card>
          )}
        </div>
        <div className="space-y-6">
          <Card className="p-5"><DescList className="sm:grid-cols-1" items={[['Customer', p.customer ? <Link to={`/customers/${p.customer.id}`} className="text-brand-700 hover:underline">{p.customer.name}</Link> : null], ['Notes', p.notes]]} /></Card>
          <Card className="p-5"><p className="mb-3 text-sm font-semibold">Attachments</p><FileManager entityType="payment" entityId={p.id} /></Card>
        </div>
      </div>

      <Dialog open={applyOpen} onOpenChange={setApplyOpen} title="Apply credit to invoices" description={`Available: ${money(unused, p.currency)}`} size="lg"
        footer={<><Button variant="secondary" onClick={() => setApplyOpen(false)}>Cancel</Button><Button onClick={() => apply.mutate()} loading={apply.isPending}>Apply</Button></>}>
        {!open.data?.invoices.length ? <EmptyState title="No unpaid invoices for this customer" /> : (
          <Table><THead><tr><TH>Invoice#</TH><TH>Date</TH><TH className="text-right">Balance due</TH><TH className="w-36 text-right">Apply</TH></tr></THead><TBody>
            {open.data.invoices.filter((i) => i.currency === p.currency).map((i) => <tr key={i.id}><TD className="font-medium">{i.number}</TD><TD>{fmtDate(i.issueDate)}</TD><TD className="text-right tabular-nums">{money(i.balanceDue, i.currency)}</TD><TD><Input type="number" min={0} step="0.01" className="text-right" value={alloc[i.id] ?? ''} onChange={(e) => setAlloc({ ...alloc, [i.id]: e.target.value })} /></TD></tr>)}
          </TBody></Table>
        )}
      </Dialog>
      <Dialog open={refundOpen} onOpenChange={setRefundOpen} title="Refund unused amount"
        footer={<><Button variant="secondary" onClick={() => setRefundOpen(false)}>Cancel</Button><Button onClick={() => doRefund.mutate()} loading={doRefund.isPending} disabled={!(Number(refund.amount) > 0)}>Save refund</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={`Amount (${p.currency})`} hint={`Up to ${money(unused, p.currency)}`}><Input type="number" min={0} max={unused} step="0.01" value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value })} /></Field>
          <Field label="Refunded on"><Input type="date" value={refund.refundedAt} onChange={(e) => setRefund({ ...refund, refundedAt: e.target.value })} /></Field>
          <Field label="Mode"><Select value={refund.method} onChange={(e) => setRefund({ ...refund, method: e.target.value })}>{METHODS.map((m) => <option key={m} value={m}>{titleCase(m)}</option>)}</Select></Field>
          <Field label="Reference#"><Input value={refund.reference} onChange={(e) => setRefund({ ...refund, reference: e.target.value })} /></Field>
        </div>
      </Dialog>
      <Dialog open={!!edit} onOpenChange={(v) => !v && setEdit(null)} title={`Edit payment ${p.number}`}
        description={committed > 0 ? `${money(committed, p.currency)} is applied to invoices or refunded, so the amount received cannot go below that.` : undefined}
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!edit || !(Number(edit.amount) > 0)}>Save</Button></>}>
        {edit && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={`Amount received (${p.currency})`} required><Input type="number" min={0} step="0.01" value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: e.target.value })} /></Field>
            <Field label="Payment date" required><Input type="date" value={edit.paidAt} onChange={(e) => setEdit({ ...edit, paidAt: e.target.value })} /></Field>
            <Field label="Bank charges (₹)"><Input type="number" min={0} step="0.01" value={edit.bankCharges} onChange={(e) => setEdit({ ...edit, bankCharges: e.target.value })} /></Field>
            <Field label="TDS deducted (₹)"><Input type="number" min={0} step="0.01" value={edit.taxDeducted} onChange={(e) => setEdit({ ...edit, taxDeducted: e.target.value })} /></Field>
            <Field label="Payment mode"><Select value={edit.method} onChange={(e) => setEdit({ ...edit, method: e.target.value })}>{METHODS.map((m) => <option key={m} value={m}>{titleCase(m)}</option>)}</Select></Field>
            <Field label="Reference#"><Input value={edit.reference} onChange={(e) => setEdit({ ...edit, reference: e.target.value })} /></Field>
            <Field label="Notes" className="sm:col-span-2"><Textarea rows={2} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
          </div>
        )}
      </Dialog>
      <ConfirmDialog open={del} onOpenChange={setDel} title="Delete this payment?" danger confirmLabel="Delete" loading={remove.isPending} onConfirm={() => remove.mutate()} description="Invoices it was applied to become unpaid again." />
    </>
  );
}
