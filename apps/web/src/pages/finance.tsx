import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { toast } from 'sonner';
import { ArrowRightLeft, Ban, CheckCircle2, Copy, Download, FileMinus, FileText, Mail, MoreHorizontal, Package, Pencil, Plus, Printer, Receipt, Send, Trash2, Undo2, Wallet, XCircle } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useFinanceMeta, useList, termsLabel } from '@/lib/hooks';
import type { CreditNote, Invoice, LineItem, Product, Proforma, Quotation } from '@/lib/types';
import { cn, fmtDate, fmtDateTime, inr, money, num, titleCase, toDateInput } from '@/lib/utils';
import {
  Badge, Button, Card, CardHeader, ConfirmDialog, DescList, Dialog, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Pagination,
  SearchInput, Select, Stat, StatusBadge, Switch, Table, TBody, TD, TH, THead, Toolbar, TR, Textarea,
} from '@/components/ui';
import { ExportButton, FileManager } from '@/components/shared';
import { DocEditor } from '@/components/DocEditor';

export const pdf = (path: string, name: string) => api.download(path, name, undefined, true).catch((e) => toast.error(errorMessage(e)));

export function MoreMenu({ items, compact }: { items: { label: string; icon?: typeof Copy; onSelect: () => void; danger?: boolean; hidden?: boolean }[]; compact?: boolean }) {
  const visible = items.filter((i) => !i.hidden);
  if (!visible.length) return null;
  return (
    // Stop clicks reaching a clickable table row (portal events bubble through the React tree).
    <span className="inline-flex" onClick={(e) => e.stopPropagation()}>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        {compact
          ? <Button variant="ghost" size="icon" className="size-8 text-slate-500" aria-label="Row actions"><MoreHorizontal /></Button>
          : <Button variant="secondary" size="icon" aria-label="More actions"><MoreHorizontal /></Button>}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-48 rounded-xl border border-line bg-surface p-1.5 shadow-lg">
          {visible.map((i) => (
            <DropdownMenu.Item key={i.label} onSelect={i.onSelect} className={cn('flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-slate-50', i.danger && 'text-red-600 data-[highlighted]:bg-red-50 data-[highlighted]:text-red-700')}>
              {i.icon && <i.icon className="size-4" />}{i.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    </span>
  );
}

// ───────────── Totals & items (detail views) ─────────────

export const currencyLabel = (d: { currency: string; exchangeRate: unknown }) => `${d.currency}${num(d.exchangeRate) !== 1 ? ` · rate ${num(d.exchangeRate)}` : ''}`;

export function TotalsBlock({ d, extra }: { d: Quotation | Invoice | Proforma; extra?: [string, unknown, boolean?][] }) {
  const meta = useFinanceMeta();
  const base = meta.data?.baseCurrency ?? 'INR';
  const Row = ({ label, value, strong, minus }: { label: string; value: unknown; strong?: boolean; minus?: boolean }) => (
    <div className={cn('flex justify-between py-1 text-sm', strong && 'border-t border-line pt-2 text-base font-semibold')}><span className={strong ? '' : 'text-slate-600'}>{label}</span><span className="tabular-nums">{minus ? '(-) ' : ''}{money(value, d.currency)}</span></div>
  );
  const tax = num(d.cgstTotal) + num(d.sgstTotal) + num(d.igstTotal);
  return (
    <div className="w-full max-w-sm">
      <Row label="Sub Total" value={d.subtotal} />
      {num(d.discountTotal) > 0 && <Row label={`Discount${d.discountType === 'PERCENT' && num(d.discountValue) ? ` (${num(d.discountValue)}%)` : ''}`} value={d.discountTotal} minus />}
      {d.taxBreakdown?.length
        ? <><Row label="Taxable amount" value={d.taxableTotal} />{d.taxBreakdown.map((t) => <Row key={`${t.name}-${t.rate}`} label={`${t.name} @ ${t.rate}%`} value={t.amount} />)}</>
        : d.isInterState ? <Row label="IGST" value={d.igstTotal} /> : tax > 0 && <><Row label="CGST" value={d.cgstTotal} /><Row label="SGST" value={d.sgstTotal} /></>}
      {num(d.withholdingAmount) !== 0 && <Row label={`${d.withholdingType} (${num(d.withholdingRate)}%)`} value={Math.abs(num(d.withholdingAmount))} minus={num(d.withholdingAmount) < 0} />}
      {num(d.adjustment) !== 0 && <Row label={d.adjustmentLabel || 'Adjustment'} value={d.adjustment} />}
      {num(d.roundOff) !== 0 && <Row label="Round Off" value={d.roundOff} />}
      <Row label={`Total (${d.currency})`} value={d.total} strong />
      {d.currency !== base && <p className="-mt-0.5 text-right text-xs text-muted">≈ {money(num(d.total) * num(d.exchangeRate), base)} at 1 {d.currency} = {num(d.exchangeRate)} {base}</p>}
      {extra?.map(([l, v, s]) => <Row key={l} label={l} value={v} strong={s} minus={!s} />)}
    </div>
  );
}

export function ItemsTable({ items, currency }: { items: LineItem[]; currency: string }) {
  return (
    <Table><THead><tr><TH>#</TH><TH>Item & Description</TH><TH>HSN/SAC</TH><TH className="text-right">Qty</TH><TH className="text-right">Rate ({currency})</TH><TH className="text-right">Disc</TH><TH className="text-right">Tax</TH><TH className="text-right">Amount</TH></tr></THead><TBody>
      {items.map((it, i) => (
        <tr key={it.id ?? i}><TD className="text-muted">{i + 1}</TD><TD><p className="whitespace-pre-line font-medium">{it.description}</p></TD><TD className="text-slate-600">{it.hsnSac ?? '—'}</TD>
          <TD className="text-right tabular-nums">{num(it.quantity)} {it.unit}</TD><TD className="text-right tabular-nums">{money(it.rate, currency)}</TD><TD className="text-right tabular-nums">{num(it.discountAmount) ? money(it.discountAmount, currency) : num(it.discountPct) ? `${num(it.discountPct)}%` : '—'}</TD>
          <TD className="text-right tabular-nums">{num(it.taxRate)}%{it.taxName && <span className="block text-[11px] text-muted">{it.taxName}</span>}</TD><TD className="text-right font-medium tabular-nums">{money(it.amount, currency)}</TD></tr>
      ))}
    </TBody></Table>
  );
}

/** Server-side currency conversion of a saved quote or draft invoice, with an explicit rate and confirmation. */
function ConvertCurrencyDialog({ open, onOpenChange, path, from, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; path: string; from: string; onDone: () => void }) {
  const meta = useFinanceMeta();
  const [to, setTo] = useState('');
  const [rate, setRate] = useState('');
  const [date, setDate] = useState(toDateInput(new Date()));
  const [ok, setOk] = useState(false);
  const choices = (meta.data?.currencies ?? []).filter((c) => c.code !== from);
  const target = to || choices[0]?.code || '';
  const run = useAction(() => api.post(`${path}/convert-currency`, { to: target, rate: Number(rate), rateDate: date, confirm: true }), {
    success: 'Amounts converted', onSuccess: () => { onOpenChange(false); setOk(false); setRate(''); onDone(); },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Convert currency" description="Prices, amount discounts and adjustments are multiplied by the rate. Tax is recalculated. This cannot be undone automatically."
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={() => run.mutate()} loading={run.isPending} disabled={!ok || !(Number(rate) > 0) || !target}><ArrowRightLeft /> Convert</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="From"><Input value={from} disabled /></Field>
        <Field label="To" required><Select value={target} onChange={(e) => setTo(e.target.value)}>{choices.map((c) => <option key={c.code} value={c.code}>{c.code} ({c.symbol}) · {c.name}</option>)}</Select></Field>
        <Field label={`1 ${from} = ? ${target}`} required><Input type="number" min={0} step="0.000001" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
        <Field label="Conversion date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" className="mt-0.5" checked={ok} onChange={(e) => setOk(e.target.checked)} /> I confirm the amounts on this document should change.</label>
      </div>
    </Dialog>
  );
}

export const QuotationEditor = () => <DocEditor kind="quotation" />;
export const InvoiceEditor = () => <DocEditor kind="invoice" />;

// ───────────── Quotes ─────────────

const STATUS_TABS = (statuses: string[]) => [['', 'All'], ...statuses.map((s) => [s, titleCase(s)])];

export function QuotationsList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const list = useList<Quotation>('/quotations', { status: '' }, { sort: 'issueDate' });
  const [del, setDel] = useState<Quotation | null>(null);
  const remove = useAction((q: Quotation) => api.delete(`/quotations/${q.id}`), { success: 'Quote deleted', invalidate: [['/quotations'], ['lead']], onSuccess: () => setDel(null) });
  return (
    <>
      <PageHeader title="Quotes" actions={can('quotations.create') && <Button onClick={() => navigate('/quotations/new')}><Plus /> New</Button>} />
      <StatusTabs value={list.filters.status} onChange={(v) => list.setFilter('status', v)} tabs={STATUS_TABS(['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CONVERTED'])} />
      <Card>
        <Toolbar><SearchInput value={list.q} onChange={list.setQ} placeholder="Search quote#, reference, customer" className="w-full sm:w-80" /></Toolbar>
        {list.isLoading ? <LoadingBlock /> : list.error ? <ErrorState error={list.error} /> : !list.data?.items.length ? <EmptyState icon={<FileText />} title="No quotes" action={can('quotations.create') && <Button onClick={() => navigate('/quotations/new')}><Plus /> New quote</Button>} /> : (
          <>
            <Table><THead><tr><TH>Date</TH><TH>Quote#</TH><TH>Reference#</TH><TH>Customer name</TH><TH>Status</TH><TH className="text-right">Amount</TH><TH className="w-10" /></tr></THead><TBody>
              {list.data.items.map((q) => (
                <TR key={q.id} onClick={() => navigate(`/quotations/${q.id}`)}>
                  <TD className="text-slate-600">{fmtDate(q.issueDate)}</TD><TD className="font-medium text-brand-700">{q.number}</TD><TD className="text-slate-600">{q.referenceNumber ?? ''}</TD>
                  <TD>{q.customer ? (q.customer.company ?? q.customer.name) : q.lead ? <span>{q.lead.name} <Badge>Lead</Badge></span> : '—'}</TD>
                  <TD><StatusBadge status={q.status} /></TD><TD className="text-right font-medium tabular-nums">{money(q.total, q.currency)}</TD>
                  <TD className="py-1 text-right">
                    <MoreMenu compact items={[
                      { label: 'Edit', icon: Pencil, onSelect: () => navigate(`/quotations/${q.id}/edit`), hidden: !can('quotations.create') || q.status === 'CONVERTED' },
                      { label: 'Download PDF', icon: Download, onSelect: () => pdf(`/quotations/${q.id}/pdf`, `${q.number}.pdf`) },
                      { label: 'Delete', icon: Trash2, onSelect: () => setDel(q), danger: true, hidden: !can('quotations.create') || q.status === 'CONVERTED' },
                    ]} />
                  </TD>
                </TR>
              ))}
            </TBody></Table>
            <Pagination page={list.page} pages={list.data.pages} total={list.data.total} onPage={list.setPage} />
          </>
        )}
      </Card>
      <ConfirmDialog open={!!del} onOpenChange={(v) => !v && setDel(null)} title={`Delete quote ${del?.number ?? ''}?`} danger confirmLabel="Delete" loading={remove.isPending} onConfirm={() => del && remove.mutate(del)}
        description="The quote and its attachments are removed permanently." />
    </>
  );
}

export function StatusTabs({ value, onChange, tabs }: { value: string; onChange: (v: string) => void; tabs: string[][] }) {
  return (
    <div className="scrollbar-thin mb-4 flex gap-2 overflow-x-auto">
      {tabs.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)} className={cn('whitespace-nowrap rounded-full border px-3 py-1 text-[13px] font-medium', value === v ? 'border-primary bg-primary text-white' : 'border-line bg-surface text-slate-600 hover:bg-slate-50')}>{label}</button>
      ))}
    </div>
  );
}

export function QuotationDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['quotation', id], queryFn: () => api.get<Quotation>(`/quotations/${id}`) });
  const [del, setDel] = useState(false);
  const inv = [['quotation'], ['/quotations'], ['lead']];
  const status = useAction((s: string) => api.post(`/quotations/${id}/status`, { status: s }), { success: 'Quote updated', invalidate: inv });
  const convert = useAction(() => api.post<{ id: string }>(`/quotations/${id}/convert`), { success: 'Draft invoice created', invalidate: [...inv, ['/invoices']], onSuccess: (r) => navigate(`/invoices/${r.id}/edit`) });
  const clone = useAction(() => api.post<{ id: string }>(`/quotations/${id}/clone`), { success: 'Quote cloned', invalidate: inv, onSuccess: (r) => navigate(`/quotations/${r.id}/edit`) });
  const remove = useAction(() => api.delete(`/quotations/${id}`), { success: 'Quote deleted', invalidate: inv, onSuccess: () => navigate('/quotations') });
  const [convOpen, setConvOpen] = useState(false);
  const qc = useQueryClient();
  if (q.isLoading) return <Card><LoadingBlock rows={8} /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>;
  const d = q.data;
  const c = d.customer as { id: string; name: string; company: string | null; gstin?: string | null } | null;
  const editable = d.status !== 'CONVERTED';
  return (
    <>
      <PageHeader breadcrumb={<Link to="/quotations" className="hover:underline">Quotes</Link>} title={<span className="flex items-center gap-3">{d.number}<StatusBadge status={d.status} /></span>}
        description={`${c ? (c.company ?? c.name) : d.lead?.name ?? ''} · ${fmtDate(d.issueDate)}`}
        actions={<>
          {can('quotations.create') && editable && <Button variant="secondary" onClick={() => navigate(`/quotations/${d.id}/edit`)}><Pencil /> Edit</Button>}
          {can('quotations.send') && <Button variant="secondary" onClick={() => navigate(`/email/quote/${d.id}`)}><Mail /> Send email</Button>}
          <Button variant="secondary" onClick={() => pdf(`/quotations/${d.id}/pdf`, `${d.number}.pdf`)}><Download /> PDF / Print</Button>
          {can('quotations.convert') && ['DRAFT', 'SENT', 'ACCEPTED'].includes(d.status) && <Button onClick={() => convert.mutate()} loading={convert.isPending}><ArrowRightLeft /> Convert to Invoice</Button>}
          {d.convertedInvoiceId && <Button onClick={() => navigate(`/invoices/${d.convertedInvoiceId}`)}>View invoice</Button>}
          <MoreMenu items={[
            { label: 'Mark as Sent', icon: Send, onSelect: () => status.mutate('SENT'), hidden: !can('quotations.send') || d.status !== 'DRAFT' },
            { label: 'Mark as Accepted', icon: CheckCircle2, onSelect: () => status.mutate('ACCEPTED'), hidden: !can('quotations.send') || !['DRAFT', 'SENT', 'REJECTED', 'EXPIRED'].includes(d.status) },
            { label: 'Mark as Declined', icon: XCircle, onSelect: () => status.mutate('REJECTED'), hidden: !can('quotations.send') || !['DRAFT', 'SENT', 'ACCEPTED'].includes(d.status) },
            { label: 'Clone', icon: Copy, onSelect: () => clone.mutate(), hidden: !can('quotations.create') },
            { label: 'Convert currency', icon: ArrowRightLeft, onSelect: () => setConvOpen(true), hidden: !can('quotations.create') || d.status === 'CONVERTED' },
            { label: 'Delete', icon: Trash2, onSelect: () => setDel(true), danger: true, hidden: !can('quotations.create') || d.status === 'CONVERTED' },
          ]} />
        </>} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="min-w-0 space-y-6 xl:col-span-2">
          {d.subject && <Card className="p-5 text-sm"><p className="text-xs font-medium text-muted">Subject</p><p className="mt-1 whitespace-pre-wrap">{d.subject}</p></Card>}
          <Card>
            <ItemsTable items={d.items ?? []} currency={d.currency} />
            <div className="flex justify-end border-t border-line p-5"><TotalsBlock d={d} /></div>
          </Card>
          {(d.notes || d.terms) && <Card className="space-y-3 p-5 text-sm">{d.notes && <div><p className="text-xs font-medium text-muted">Customer notes</p><p className="whitespace-pre-wrap">{d.notes}</p></div>}{d.terms && <div><p className="text-xs font-medium text-muted">Terms & conditions</p><p className="whitespace-pre-wrap">{d.terms}</p></div>}</Card>}
        </div>
        <div className="min-w-0 space-y-6">
          <Card className="p-5"><DescList className="sm:grid-cols-1" items={[
            ['Customer', c ? <Link to={`/customers/${c.id}`} className="text-brand-700 hover:underline">{c.company ?? c.name}</Link> : d.lead ? <Link to={`/leads/${d.lead.id}`} className="text-brand-700 hover:underline">{d.lead.name} (lead)</Link> : null],
            ['Currency', currencyLabel(d)], ['Reference#', d.referenceNumber], ['Quote date', fmtDate(d.issueDate)], ['Expiry date', fmtDate(d.validUntil)], ['Salesperson', d.salespersonName],
            ['Project', d.project ? `${d.project.code} · ${d.project.name}` : null], ['Place of supply', d.placeOfSupply], ['Tax', d.isInterState ? 'IGST (inter-state)' : 'CGST + SGST (intra-state)'],
          ]} /></Card>
          <Card className="p-5"><p className="mb-3 text-sm font-semibold">Attachments</p><FileManager entityType="quotation" entityId={d.id} /></Card>
        </div>
      </div>
      <ConvertCurrencyDialog open={convOpen} onOpenChange={setConvOpen} path={`/quotations/${d.id}`} from={d.currency} onDone={() => inv.forEach((k) => qc.invalidateQueries({ queryKey: k }))} />
      <ConfirmDialog open={del} onOpenChange={setDel} title={`Delete quote ${d.number}?`} danger confirmLabel="Delete" loading={remove.isPending} onConfirm={() => remove.mutate()} description="The quote and its attachments are removed permanently." />
    </>
  );
}

// ───────────── Invoices ─────────────

export function InvoicesList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const list = useList<Invoice>('/invoices', { status: '', from: '', to: '' }, { sort: 'issueDate' });
  const [del, setDel] = useState<Invoice | null>(null);
  const remove = useAction((i: Invoice) => api.delete(`/invoices/${i.id}`), { success: 'Invoice deleted', invalidate: [['/invoices'], ['dashboard'], ['billing-home']], onSuccess: () => setDel(null) });
  const meta = useFinanceMeta();
  const base = meta.data?.baseCurrency ?? 'INR';
  const hasForeign = !!list.data?.items.some((i) => i.currency !== base);
  const sums = list.data?.sums as { total: string | null; amountPaid: string | null; balanceDue: string | null } | undefined;
  return (
    <>
      <PageHeader title="Invoices"
        actions={<><ExportButton path="/invoices" filename="invoices.csv" params={list.params} />{can('invoices.create') && <Button onClick={() => navigate('/invoices/new')}><Plus /> New</Button>}</>} />
      {sums && <div className="mb-4 grid grid-cols-3 gap-4"><Stat label={`Invoiced (${base})`} value={money(sums.total, base)} /><Stat label={`Received (${base})`} value={money(sums.amountPaid, base)} tone="good" /><Stat label={`Outstanding (${base})`} value={money(sums.balanceDue, base)} tone={num(sums.balanceDue) > 0 ? 'warn' : 'default'} hint={hasForeign ? 'Other currencies converted at each invoice rate' : undefined} /></div>}
      <StatusTabs value={list.filters.status} onChange={(v) => list.setFilter('status', v)} tabs={[['', 'All'], ['DRAFT', 'Draft'], ['unpaid', 'Unpaid'], ['OVERDUE', 'Overdue'], ['PARTIALLY_PAID', 'Partially Paid'], ['PAID', 'Paid'], ['WRITTEN_OFF', 'Written Off'], ['CANCELLED', 'Void']]} />
      <Card>
        <Toolbar>
          <SearchInput value={list.q} onChange={list.setQ} placeholder="Search invoice#, order#, customer" className="w-full sm:w-72" />
          <Input type="date" className="w-36" value={list.filters.from} onChange={(e) => list.setFilter('from', e.target.value)} aria-label="From" />
          <Input type="date" className="w-36" value={list.filters.to} onChange={(e) => list.setFilter('to', e.target.value)} aria-label="To" />
        </Toolbar>
        {list.isLoading ? <LoadingBlock /> : list.error ? <ErrorState error={list.error} /> : !list.data?.items.length ? <EmptyState icon={<Receipt />} title="No invoices" action={can('invoices.create') && <Button onClick={() => navigate('/invoices/new')}><Plus /> New invoice</Button>} /> : (
          <>
            <Table><THead><tr><TH>Date</TH><TH>Invoice#</TH><TH>Order number</TH><TH>Customer name</TH><TH>Status</TH><TH>Due date</TH><TH className="text-right">Amount</TH><TH className="text-right">Balance due</TH><TH className="w-10" /></tr></THead><TBody>
              {list.data.items.map((i) => {
                const overdueDays = i.status === 'OVERDUE' && i.dueDate ? Math.floor((Date.now() - new Date(i.dueDate).getTime()) / 86_400_000) : 0;
                return (
                  <TR key={i.id} onClick={() => navigate(`/invoices/${i.id}`)}>
                    <TD className="text-slate-600">{fmtDate(i.issueDate)}</TD><TD className="font-medium text-brand-700">{i.number}</TD><TD className="text-slate-600">{i.orderNumber ?? ''}</TD>
                    <TD>{i.customer?.company ?? i.customer?.name}</TD>
                    <TD>{overdueDays > 0 ? <Badge tone="red">Overdue by {overdueDays} days</Badge> : <StatusBadge status={i.status === 'CANCELLED' ? 'VOID' : i.status} />}</TD>
                    <TD className="text-slate-600">{fmtDate(i.dueDate)}</TD><TD className="text-right tabular-nums">{money(i.total, i.currency)}</TD>
                    <TD className={cn('text-right font-medium tabular-nums', num(i.balanceDue) > 0 && !['DRAFT', 'CANCELLED'].includes(i.status) && 'text-amber-700')}>{['DRAFT', 'CANCELLED'].includes(i.status) ? '—' : money(i.balanceDue, i.currency)}</TD>
                    <TD className="py-1 text-right">
                      <MoreMenu compact items={[
                        { label: 'Edit', icon: Pencil, onSelect: () => navigate(`/invoices/${i.id}/edit`), hidden: !invoiceEditable(i) || !can('invoices.create') },
                        { label: 'Download PDF', icon: Download, onSelect: () => pdf(`/invoices/${i.id}/pdf`, `${i.number}.pdf`) },
                        { label: 'Record Payment', icon: Wallet, onSelect: () => navigate(`/payments/new?customerId=${i.customerId}&invoiceId=${i.id}`), hidden: !can('payments.record') || !['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'].includes(i.status) },
                        { label: 'Delete', icon: Trash2, onSelect: () => setDel(i), danger: true, hidden: !(i.status === 'DRAFT' ? can('invoices.create', 'invoices.cancel') : can('invoices.cancel') && num(i.amountPaid) === 0 && num(i.creditedTotal) === 0) },
                      ]} />
                    </TD>
                  </TR>
                );
              })}
            </TBody></Table>
            <Pagination page={list.page} pages={list.data.pages} total={list.data.total} onPage={list.setPage} />
          </>
        )}
      </Card>
      <ConfirmDialog open={!!del} onOpenChange={(v) => !v && setDel(null)} title={`Delete invoice ${del?.number ?? ''}?`} danger confirmLabel="Delete" loading={remove.isPending} onConfirm={() => del && remove.mutate(del)}
        description={del?.status === 'DRAFT' ? 'The draft is removed permanently.' : deleteSentWarning} />
    </>
  );
}

/** Sent invoices can still be corrected unless they are void or written off. */
const invoiceEditable = (i: Pick<Invoice, 'status' | 'writeOffAmount'>) => i.status !== 'CANCELLED' && !num(i.writeOffAmount);
const deleteSentWarning = 'This invoice has already been sent. Deleting it removes it permanently and leaves a gap in your invoice numbering, which your GST returns must explain. Void it instead if you only need to cancel it.';

export function InvoiceDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const meta = useFinanceMeta();
  const q = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<Invoice & { customer: { id: string; name: string; company: string | null; gstin: string | null; email: string | null } }>(`/invoices/${id}`) });
  const [cnOpen, setCnOpen] = useState(false);
  const [cn, setCn] = useState({ reason: '', taxableAmount: '' });
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [delOpen, setDelOpen] = useState(false);
  const [woOpen, setWoOpen] = useState(false);
  const inv = [['invoice'], ['/invoices'], ['/payments'], ['/credit-notes'], ['dashboard'], ['billing-home']];
  const issue = useAction(() => api.post<Invoice>(`/invoices/${id}/issue`), { success: 'Invoice marked as sent', invalidate: inv });
  const credit = useAction(() => api.post('/credit-notes', { invoiceId: id, reason: cn.reason, taxableAmount: Number(cn.taxableAmount) }), { success: 'Credit note issued', invalidate: inv, onSuccess: () => { setCnOpen(false); setCn({ reason: '', taxableAmount: '' }); } });
  const voidInv = useAction(() => api.post(`/invoices/${id}/void`, { reason: voidReason }), { success: 'Invoice voided', invalidate: inv, onSuccess: () => setVoidOpen(false) });
  const del = useAction(() => api.delete(`/invoices/${id}`), { success: 'Invoice deleted', invalidate: inv, onSuccess: () => navigate('/invoices') });
  const writeOff = useAction(() => api.post(`/invoices/${id}/write-off`, {}), { success: 'Invoice written off', invalidate: inv, onSuccess: () => setWoOpen(false) });
  const undoWriteOff = useAction(() => api.post(`/invoices/${id}/cancel-write-off`), { success: 'Write-off cancelled', invalidate: inv });
  const clone = useAction(() => api.post<{ id: string }>(`/invoices/${id}/clone`), { success: 'Invoice cloned', invalidate: inv, onSuccess: (r) => navigate(`/invoices/${r.id}/edit`) });
  const [convOpen, setConvOpen] = useState(false);
  const qc = useQueryClient();
  const unapply = useAction(({ paymentId, allocationId }: { paymentId: string; allocationId: string }) => api.delete(`/payments/${paymentId}/allocations/${allocationId}`), { success: 'Payment removed from invoice', invalidate: inv });
  if (q.isLoading) return <Card><LoadingBlock rows={8} /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>;
  const d = q.data;
  const c = d.customer;
  const open = ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'].includes(d.status);
  return (
    <>
      <PageHeader breadcrumb={<Link to="/invoices" className="hover:underline">Invoices</Link>}
        title={<span className="flex items-center gap-3">{d.number}<StatusBadge status={d.status === 'CANCELLED' ? 'VOID' : d.status} /></span>}
        description={`${c.company ?? c.name} · ${fmtDate(d.issueDate)}${d.quotation ? ` · from ${d.quotation.number}` : ''}${d.proforma ? ` · from proforma ${d.proforma.number}` : ''}${d.recurringProfile ? ` · recurring: ${d.recurringProfile.profileName}` : ''}`}
        actions={<>
          {invoiceEditable(d) && can('invoices.create') && <Button variant="secondary" onClick={() => navigate(`/invoices/${d.id}/edit`)}><Pencil /> Edit</Button>}
          {can('invoices.issue') && d.status !== 'CANCELLED' && <Button variant="secondary" onClick={() => navigate(`/email/invoice/${d.id}`)}><Mail /> Send</Button>}
          <Button variant="secondary" onClick={() => pdf(`/invoices/${d.id}/pdf`, `${d.number}.pdf`)}><Printer /> PDF / Print</Button>
          {open && can('payments.record') && <Button onClick={() => navigate(`/payments/new?customerId=${c.id}&invoiceId=${d.id}`)}><Wallet /> Record Payment</Button>}
          {d.status === 'DRAFT' && can('invoices.issue') && <Button onClick={() => issue.mutate()} loading={issue.isPending}><Send /> Mark as Sent</Button>}
          <MoreMenu items={[
            { label: 'Clone', icon: Copy, onSelect: () => clone.mutate(), hidden: !can('invoices.create') },
            { label: 'Convert currency', icon: ArrowRightLeft, onSelect: () => setConvOpen(true), hidden: !can('invoices.create') || d.status !== 'DRAFT' },
            { label: 'Create Credit Note', icon: FileMinus, onSelect: () => setCnOpen(true), hidden: !can('creditnotes.create') || ['DRAFT', 'CANCELLED'].includes(d.status) },
            { label: 'Write Off', icon: Ban, onSelect: () => setWoOpen(true), hidden: !can('invoices.cancel') || !open },
            { label: 'Cancel Write Off', icon: Undo2, onSelect: () => undoWriteOff.mutate(), hidden: !can('invoices.cancel') || !num(d.writeOffAmount) },
            { label: 'Void', icon: XCircle, onSelect: () => setVoidOpen(true), danger: true, hidden: !can('invoices.cancel') || d.status === 'DRAFT' || d.status === 'CANCELLED' || !!d.allocations?.length },
            { label: 'Delete', icon: Trash2, onSelect: () => setDelOpen(true), danger: true, hidden: !(d.status === 'DRAFT' ? can('invoices.cancel', 'invoices.create') : can('invoices.cancel') && !d.allocations?.length && !d.creditNotes?.length) },
          ]} />
        </>} />
      {d.status === 'CANCELLED' && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">Void: {d.cancelReason}</div>}
      {d.status === 'DRAFT' && <div className="mb-4 rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-700">This invoice is a draft. Send it, or mark it as sent, to start tracking payment.</div>}
      {d.lastEmailedAt && <p className="mb-4 text-xs text-muted">Last emailed {fmtDateTime(d.lastEmailedAt)} to {d.emailRecipients.join(', ')}</p>}
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="min-w-0 space-y-6 xl:col-span-2">
          {d.subject && <Card className="p-5 text-sm"><p className="text-xs font-medium text-muted">Subject</p><p className="mt-1 whitespace-pre-wrap">{d.subject}</p></Card>}
          <Card>
            <ItemsTable items={d.items ?? []} currency={d.currency} />
            <div className="flex justify-end border-t border-line p-5">
              <TotalsBlock d={d} extra={d.status !== 'DRAFT' ? [['Payment Made', d.amountPaid], ...(num(d.creditedTotal) ? [['Credits Applied', d.creditedTotal] as [string, unknown]] : []), ...(num(d.writeOffAmount) ? [['Written Off', d.writeOffAmount] as [string, unknown]] : []), ['Balance Due', d.balanceDue, true]] : undefined} />
            </div>
          </Card>
          <Card>
            <CardHeader title="Payments Received" />
            {!d.allocations?.length ? <EmptyState title="No payments recorded" /> : (
              <Table><THead><tr><TH>Date</TH><TH>Payment#</TH><TH>Reference#</TH><TH>Mode</TH><TH className="text-right">Amount</TH><TH /></tr></THead><TBody>
                {d.allocations.map((a) => (
                  <tr key={a.id}><TD>{fmtDate(a.payment.paidAt)}</TD><TD><Link to={`/payments/${a.payment.id}`} className="font-medium text-brand-700 hover:underline">{a.payment.number}</Link></TD><TD className="text-slate-600">{a.payment.reference ?? '—'}</TD><TD>{titleCase(a.payment.method)}</TD><TD className="text-right tabular-nums">{money(a.amount, d.currency)}</TD>
                    <TD className="text-right">{can('payments.record') && <Button variant="ghost" size="sm" className="text-red-600" onClick={() => { if (confirm('Remove this payment from the invoice? The amount becomes unused credit on the payment.')) unapply.mutate({ paymentId: a.payment.id, allocationId: a.id }); }}>Remove</Button>}</TD></tr>
                ))}
              </TBody></Table>
            )}
          </Card>
          {!!d.creditNotes?.length && (
            <Card>
              <CardHeader title="Credit notes" />
              <Table><THead><tr><TH>Number</TH><TH>Date</TH><TH>Reason</TH><TH>Status</TH><TH className="text-right">Total</TH><TH /></tr></THead><TBody>
                {d.creditNotes.map((n) => (
                  <tr key={n.id}><TD className="font-medium">{n.number}</TD><TD>{fmtDate(n.issueDate)}</TD><TD className="text-slate-600">{n.reason}</TD><TD><StatusBadge status={n.status} /></TD><TD className="text-right tabular-nums">{money(n.total, d.currency)}</TD>
                    <TD className="text-right"><Button variant="ghost" size="sm" onClick={() => pdf(`/credit-notes/${n.id}/pdf`, `${n.number}.pdf`)}>PDF</Button></TD></tr>
                ))}
              </TBody></Table>
            </Card>
          )}
          {(d.notes || d.terms) && <Card className="space-y-3 p-5 text-sm">{d.notes && <div><p className="text-xs font-medium text-muted">Customer notes</p><p className="whitespace-pre-wrap">{d.notes}</p></div>}{d.terms && <div><p className="text-xs font-medium text-muted">Terms & conditions</p><p className="whitespace-pre-wrap">{d.terms}</p></div>}</Card>}
        </div>
        <div className="min-w-0 space-y-6">
          <Card className="p-5"><DescList className="sm:grid-cols-1" items={[
            ['Bill to', <Link to={`/customers/${c.id}`} className="text-brand-700 hover:underline">{c.company ?? c.name}</Link>], ['Customer GSTIN', c.gstin ?? 'Unregistered'], ['Currency', currencyLabel(d)],
            ['Invoice date', fmtDate(d.issueDate)], ['Terms', termsLabel(meta.data, d.paymentTerms)], ['Due date', fmtDate(d.dueDate)], ['Order number', d.orderNumber],
            ['Salesperson', d.salespersonName], ['Place of supply', d.placeOfSupply], ['Tax', d.isInterState ? 'IGST (inter-state)' : 'CGST + SGST (intra-state)'],
            ['Project', d.project ? <Link to={`/projects/${d.project.id}`} className="text-brand-700 hover:underline">{d.project.code} · {d.project.name}</Link> : null],
          ]} /></Card>
          <Card className="p-5"><p className="mb-3 text-sm font-semibold">Attachments</p><FileManager entityType="invoice" entityId={d.id} /></Card>
        </div>
      </div>

      <Dialog open={cnOpen} onOpenChange={setCnOpen} title="Create credit note" description="Enter the taxable value to credit. GST is reversed in the same proportion as the original invoice."
        footer={<><Button variant="secondary" onClick={() => setCnOpen(false)}>Cancel</Button><Button onClick={() => credit.mutate()} loading={credit.isPending} disabled={!cn.reason || !Number(cn.taxableAmount)}>Issue credit note</Button></>}>
        <div className="space-y-4">
          <Field label={`Taxable amount to credit (${d.currency})`} hint={`Invoice taxable value ${money(d.taxableTotal, d.currency)}`}><Input type="number" min={0} step="0.01" value={cn.taxableAmount} onChange={(e) => setCn({ ...cn, taxableAmount: e.target.value })} /></Field>
          <Field label="Reason" required><Textarea rows={2} value={cn.reason} onChange={(e) => setCn({ ...cn, reason: e.target.value })} /></Field>
        </div>
      </Dialog>
      <Dialog open={voidOpen} onOpenChange={setVoidOpen} title="Void invoice" description="A void invoice keeps its number for your records but no longer counts as receivable."
        footer={<><Button variant="secondary" onClick={() => setVoidOpen(false)}>Back</Button><Button variant="danger" onClick={() => voidInv.mutate()} loading={voidInv.isPending} disabled={voidReason.length < 3}>Void</Button></>}>
        <Field label="Reason" required><Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} /></Field>
      </Dialog>
      <ConfirmDialog open={woOpen} onOpenChange={setWoOpen} title="Write off this invoice?" confirmLabel="Write off" danger loading={writeOff.isPending} onConfirm={() => writeOff.mutate()}
        description={`The balance of ${money(d.balanceDue, d.currency)} will be recorded as a bad debt. You can cancel the write-off later.`} />
      <ConvertCurrencyDialog open={convOpen} onOpenChange={setConvOpen} path={`/invoices/${d.id}`} from={d.currency} onDone={() => inv.forEach((k) => qc.invalidateQueries({ queryKey: k }))} />
      <ConfirmDialog open={delOpen} onOpenChange={setDelOpen} title={`Delete invoice ${d.number}?`} confirmLabel="Delete" danger loading={del.isPending} onConfirm={() => del.mutate()}
        description={d.status === 'DRAFT' ? 'The draft is removed permanently.' : deleteSentWarning} />
    </>
  );
}

// ───────────── Credit notes ─────────────

export function CreditNotesPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const list = useList<CreditNote>('/credit-notes', {}, { sort: 'issueDate' });
  const [confirmAct, setConfirmAct] = useState<{ kind: 'cancel' | 'delete'; note: CreditNote } | null>(null);
  const cnInv = [['/credit-notes'], ['invoice'], ['/invoices']];
  const cancel = useAction((cid: string) => api.post(`/credit-notes/${cid}/cancel`), { success: 'Credit note cancelled', invalidate: cnInv, onSuccess: () => setConfirmAct(null) });
  const remove = useAction((cid: string) => api.delete(`/credit-notes/${cid}`), { success: 'Credit note deleted', invalidate: cnInv, onSuccess: () => setConfirmAct(null) });
  return (
    <>
      <PageHeader title="Credit Notes" description="Corrections against issued invoices. Create them from an invoice." />
      <Card>
        <Toolbar><SearchInput value={list.q} onChange={list.setQ} placeholder="Number, invoice or reason" className="w-full sm:w-72" /></Toolbar>
        {list.isLoading ? <LoadingBlock /> : list.error ? <ErrorState error={list.error} /> : !list.data?.items.length ? <EmptyState icon={<FileMinus />} title="No credit notes" /> : (
          <>
            <Table><THead><tr><TH>Date</TH><TH>Credit note#</TH><TH>Invoice#</TH><TH>Customer</TH><TH>Reason</TH><TH>Status</TH><TH className="text-right">Amount</TH><TH /></tr></THead><TBody>
              {list.data.items.map((n) => (
                <TR key={n.id}>
                  <TD>{fmtDate(n.issueDate)}</TD><TD className="font-medium">{n.number}</TD>
                  <TD><button className="text-brand-700 hover:underline" onClick={() => navigate(`/invoices/${n.invoiceId}`)}>{n.invoice?.number}</button></TD>
                  <TD>{n.invoice?.customer.name}</TD><TD className="max-w-xs truncate text-slate-600">{n.reason}</TD><TD><StatusBadge status={n.status} /></TD>
                  <TD className="text-right tabular-nums">{money(n.total, n.currency)}</TD>
                  <TD className="whitespace-nowrap text-right">
                    <MoreMenu compact items={[
                      { label: 'Download PDF', icon: Download, onSelect: () => pdf(`/credit-notes/${n.id}/pdf`, `${n.number}.pdf`) },
                      { label: 'Cancel', icon: Ban, onSelect: () => setConfirmAct({ kind: 'cancel', note: n }), hidden: !can('creditnotes.create') || n.status !== 'ISSUED' },
                      { label: 'Delete', icon: Trash2, danger: true, onSelect: () => setConfirmAct({ kind: 'delete', note: n }), hidden: !can('creditnotes.create') },
                    ]} />
                  </TD>
                </TR>
              ))}
            </TBody></Table>
            <Pagination page={list.page} pages={list.data.pages} total={list.data.total} onPage={list.setPage} />
          </>
        )}
      </Card>
      <ConfirmDialog open={!!confirmAct} onOpenChange={(v) => !v && setConfirmAct(null)} danger
        title={confirmAct?.kind === 'delete' ? `Delete credit note ${confirmAct.note.number}?` : `Cancel credit note ${confirmAct?.note.number ?? ''}?`}
        confirmLabel={confirmAct?.kind === 'delete' ? 'Delete' : 'Cancel credit note'}
        description={confirmAct?.kind === 'delete' ? 'It is removed permanently and the invoice balance goes back up. Cancelling keeps a record instead.' : 'The credit note stays on record as cancelled and the invoice balance goes back up.'}
        loading={cancel.isPending || remove.isPending}
        onConfirm={() => confirmAct && (confirmAct.kind === 'delete' ? remove.mutate(confirmAct.note.id) : cancel.mutate(confirmAct.note.id))} />
    </>
  );
}

// ───────────── Items ─────────────

export function ProductsPage() {
  const meta = useFinanceMeta();
  const list = useList<Product>('/products', { active: '1', type: '' }, { sort: 'name', dir: 'asc' });
  const [edit, setEdit] = useState<Partial<Product> | null>(null);
  const save = useAction(() => {
    const body = { name: edit!.name, description: edit!.description || null, type: edit!.type ?? 'SERVICE', sku: edit!.sku || null, hsnSac: edit!.hsnSac || null, unit: edit!.unit || 'Nos', rate: Number(edit!.rate), taxPreference: edit!.taxPreference ?? 'TAXABLE', taxRate: Number(edit!.taxRate ?? 18), active: edit!.active ?? true };
    return edit!.id ? api.patch(`/products/${edit!.id}`, body) : api.post('/products', body);
  }, { success: 'Item saved', invalidate: [['/products']], onSuccess: () => setEdit(null) });
  return (
    <>
      <PageHeader title="Items" description="Goods and services you sell, with HSN/SAC codes and GST rates." actions={<Button onClick={() => setEdit({ type: 'SERVICE', taxRate: '18', unit: 'Nos', active: true, taxPreference: 'TAXABLE' })}><Plus /> New</Button>} />
      <Card>
        <Toolbar>
          <SearchInput value={list.q} onChange={list.setQ} placeholder="Search name, SKU, HSN/SAC" className="w-full sm:w-72" />
          <Select value={list.filters.active} onChange={(e) => list.setFilter('active', e.target.value)} className="w-36"><option value="1">Active</option><option value="0">Inactive</option><option value="">All</option></Select>
          <Select value={list.filters.type} onChange={(e) => list.setFilter('type', e.target.value)} className="w-36"><option value="">All types</option><option value="SERVICE">Services</option><option value="GOODS">Goods</option></Select>
        </Toolbar>
        {list.isLoading ? <LoadingBlock /> : !list.data?.items.length ? <EmptyState icon={<Package />} title="No items" /> : (
          <>
            <Table><THead><tr><TH>Name</TH><TH>Type</TH><TH>SKU</TH><TH>HSN/SAC</TH><TH>Unit</TH><TH className="text-right">Rate</TH><TH className="text-right">Tax</TH><TH>Status</TH></tr></THead><TBody>
              {list.data.items.map((p) => (
                <TR key={p.id} onClick={() => setEdit({ ...p, rate: String(num(p.rate)), taxRate: String(num(p.taxRate)) })}>
                  <TD><p className="font-medium">{p.name}</p>{p.description && <p className="max-w-sm truncate text-xs text-muted">{p.description}</p>}</TD>
                  <TD>{p.type === 'GOODS' ? 'Goods' : 'Service'}</TD><TD className="text-slate-600">{p.sku ?? '—'}</TD><TD className="text-slate-600">{p.hsnSac ?? '—'}</TD><TD>{p.unit}</TD><TD className="text-right tabular-nums">{inr(p.rate)}</TD>
                  <TD className="text-right">{p.taxPreference === 'EXEMPT' ? 'Exempt' : `GST ${num(p.taxRate)}%`}</TD>
                  <TD><StatusBadge status={p.active ? 'ACTIVE' : 'INACTIVE'} /></TD>
                </TR>
              ))}
            </TBody></Table>
            <Pagination page={list.page} pages={list.data.pages} total={list.data.total} onPage={list.setPage} />
          </>
        )}
      </Card>
      <Dialog open={!!edit} onOpenChange={(v) => !v && setEdit(null)} title={edit?.id ? 'Edit item' : 'New item'} size="lg"
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!edit?.name || edit?.rate === '' || edit?.rate === undefined}>Save</Button></>}>
        {edit && <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type" className="sm:col-span-2">
            <div className="flex gap-6 text-sm">{[['GOODS', 'Goods'], ['SERVICE', 'Service']].map(([v, l]) => <label key={v} className="flex items-center gap-2"><input type="radio" checked={edit.type === v} onChange={() => setEdit({ ...edit, type: v })} /> {l}</label>)}</div>
          </Field>
          <Field label="Name" required><Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="SKU"><Input value={edit.sku ?? ''} onChange={(e) => setEdit({ ...edit, sku: e.target.value })} /></Field>
          <Field label="Unit"><Input value={edit.unit ?? ''} onChange={(e) => setEdit({ ...edit, unit: e.target.value })} placeholder="Nos, hrs, months" /></Field>
          <Field label={edit.type === 'GOODS' ? 'HSN code' : 'SAC code'}><Input value={edit.hsnSac ?? ''} onChange={(e) => setEdit({ ...edit, hsnSac: e.target.value })} /></Field>
          <Field label="Tax preference">
            <Select value={edit.taxPreference ?? 'TAXABLE'} onChange={(e) => setEdit({ ...edit, taxPreference: e.target.value })}><option value="TAXABLE">Taxable</option><option value="EXEMPT">Non-taxable / exempt</option></Select>
          </Field>
          {edit.taxPreference !== 'EXEMPT' && <Field label="GST rate (intra: CGST+SGST, inter: IGST)"><Select value={String(edit.taxRate)} onChange={(e) => setEdit({ ...edit, taxRate: e.target.value })}>{(meta.data?.gstRates ?? [0, 5, 12, 18, 28]).map((r) => <option key={r} value={r}>{r}%</option>)}</Select></Field>}
          <Field label="Selling price (₹)" required><Input type="number" min={0} step="0.01" value={(edit.rate as string) ?? ''} onChange={(e) => setEdit({ ...edit, rate: e.target.value })} /></Field>
          <Field label="Description" className="sm:col-span-2"><Textarea rows={2} value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-sm"><Switch checked={edit.active ?? true} onCheckedChange={(v) => setEdit({ ...edit, active: v })} /> Active</label>
        </div>}
      </Dialog>
    </>
  );
}
