import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDown, ArrowRightLeft, ArrowUp, CheckCircle2, Copy, Download, FileCheck2, Mail, Pencil, Plus, Printer, Send, XCircle } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useFinanceMeta, useList, termsLabel } from '@/lib/hooks';
import type { EmailLogEntry, Proforma } from '@/lib/types';
import { fmtDate, fmtDateTime, money, num } from '@/lib/utils';
import {
  Button, Card, CardHeader, ConfirmDialog, DescList, Dialog, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Pagination,
  SearchInput, StatusBadge, Table, TBody, TD, TH, THead, Toolbar, TR,
} from '@/components/ui';
import { FileManager } from '@/components/shared';
import { DocEditor } from '@/components/DocEditor';
import { currencyLabel, ItemsTable, MoreMenu, StatusTabs, TotalsBlock } from './finance';

export const ProformaEditor = () => <DocEditor kind="proforma" />;

const STATUSES = ['DRAFT', 'SENT', 'VIEWED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CONVERTED', 'CANCELLED'];
const CONVERTIBLE = ['DRAFT', 'SENT', 'VIEWED', 'ACCEPTED', 'EXPIRED'];
const taxOf = (p: Pick<Proforma, 'cgstTotal' | 'sgstTotal' | 'igstTotal' | 'otherTaxTotal'>) => num(p.cgstTotal) + num(p.sgstTotal) + num(p.igstTotal) + num(p.otherTaxTotal);
/** Value before tax: total less tax, adjustment, withholding and round-off. */
const subtotalOf = (p: Proforma) => num(p.taxableTotal);

const download = (p: Pick<Proforma, 'id' | 'number'>, inline: boolean) =>
  api.download(`/proforma-invoices/${p.id}/pdf`, `${p.number}.pdf`, undefined, inline).catch((e) => toast.error(errorMessage(e)));

/** Shared actions for the list and detail pages. */
function useProformaActions(onDone?: () => void) {
  const navigate = useNavigate();
  const invalidate = [['/proforma-invoices'], ['proforma'], ['proforma-emails']];
  const duplicate = useAction((id: string) => api.post<{ id: string }>(`/proforma-invoices/${id}/duplicate`), { success: 'Duplicated as a new draft', invalidate, onSuccess: (r) => navigate(`/proforma-invoices/${r.id}/edit`) });
  const convert = useAction((id: string) => api.post<{ id: string; number: string }>(`/proforma-invoices/${id}/convert`), {
    success: (r) => `Draft invoice ${r.number} created`, invalidate: [...invalidate, ['/invoices']], onSuccess: (r) => { onDone?.(); navigate(`/invoices/${r.id}`); },
  });
  const status = useAction(({ id, status }: { id: string; status: string }) => api.post(`/proforma-invoices/${id}/status`, { status }), { success: 'Status updated', invalidate });
  const cancel = useAction(({ id, reason }: { id: string; reason: string }) => api.post(`/proforma-invoices/${id}/cancel`, { reason }), { success: 'Proforma invoice cancelled', invalidate, onSuccess: () => onDone?.() });
  return { duplicate, convert, status, cancel };
}

function ConvertDialog({ p, open, onOpenChange, onConfirm, loading }: { p: Proforma | null; open: boolean; onOpenChange: (v: boolean) => void; onConfirm: () => void; loading: boolean }) {
  return (
    <ConfirmDialog open={open} onOpenChange={onOpenChange} title={`Convert ${p?.number ?? ''} to an invoice?`} confirmLabel="Create draft invoice" loading={loading} onConfirm={onConfirm}
      description={
        <span className="space-y-2">
          <span className="block">A draft invoice is created with the same customer, items, discounts, currency and taxes, numbered from your invoice series. Totals are recalculated.</span>
          <span className="block">No payment is recorded and the invoice is not issued: review it, then issue it as usual. This proforma will be marked as converted and cannot be converted again.</span>
        </span>
      } />
  );
}

function CancelDialog({ p, open, onOpenChange, onConfirm, loading }: { p: Proforma | null; open: boolean; onOpenChange: (v: boolean) => void; onConfirm: (reason: string) => void; loading: boolean }) {
  const [reason, setReason] = useState('');
  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setReason(''); }} title={`Cancel ${p?.number ?? ''}?`} description="The proforma invoice keeps its number for your records but can no longer be sent or converted."
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Back</Button><Button variant="danger" loading={loading} disabled={reason.trim().length < 3} onClick={() => onConfirm(reason.trim())}>Cancel proforma</Button></>}>
      <Field label="Reason" required><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Client postponed the project" autoFocus /></Field>
    </Dialog>
  );
}

// ───────────── List ─────────────

export function ProformaList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const list = useList<Proforma>('/proforma-invoices', { status: '', from: '', to: '' }, { sort: 'issueDate' });
  const actions = useProformaActions();
  const [converting, setConverting] = useState<Proforma | null>(null);
  const [cancelling, setCancelling] = useState<Proforma | null>(null);
  const SortTH = ({ k, label, right }: { k: string; label: string; right?: boolean }) => (
    <TH className={right ? 'text-right' : undefined}>
      <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => list.toggleSort(k)}>
        {label}{list.sort.sort === k && (list.sort.dir === 'desc' ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
      </button>
    </TH>
  );
  return (
    <>
      <PageHeader title="Proforma Invoices" description="Request payment or confirm an order before supply. Convert to an invoice when you supply."
        actions={can('proforma.create') && <Button onClick={() => navigate('/proforma-invoices/new')}><Plus /> New</Button>} />
      <StatusTabs value={list.filters.status} onChange={(v) => list.setFilter('status', v)} tabs={[['', 'All'], ...STATUSES.map((s) => [s, s === 'CONVERTED' ? 'Converted to Invoice' : s.charAt(0) + s.slice(1).toLowerCase()])]} />
      <Card>
        <Toolbar>
          <SearchInput value={list.q} onChange={list.setQ} placeholder="Search number, PO / reference, client" className="w-full sm:w-80" />
          <label className="flex items-center gap-2 text-xs text-muted">From <Input type="date" className="w-36" value={list.filters.from} onChange={(e) => list.setFilter('from', e.target.value)} aria-label="Issued from" /></label>
          <label className="flex items-center gap-2 text-xs text-muted">To <Input type="date" className="w-36" value={list.filters.to} onChange={(e) => list.setFilter('to', e.target.value)} aria-label="Issued to" /></label>
          {(list.filters.from || list.filters.to) && <Button variant="ghost" size="sm" onClick={() => { list.setFilter('from', ''); list.setFilter('to', ''); }}>Clear dates</Button>}
        </Toolbar>
        {list.isLoading ? <LoadingBlock /> : list.error ? <ErrorState error={list.error} /> : !list.data?.items.length ? (
          <EmptyState icon={<FileCheck2 />} title={list.q || list.filters.status || list.filters.from || list.filters.to ? 'No proforma invoices match' : 'No proforma invoices yet'}
            description="Create one to request an advance payment or confirm an order with a client."
            action={can('proforma.create') && <Button onClick={() => navigate('/proforma-invoices/new')}><Plus /> New proforma invoice</Button>} />
        ) : (
          <>
            <div className="scrollbar-thin overflow-x-auto">
              <Table><THead><tr>
                <SortTH k="number" label="Proforma#" /><TH>Client</TH><SortTH k="issueDate" label="Issue date" /><SortTH k="validUntil" label="Valid until" /><TH>Currency</TH>
                <TH className="text-right">Subtotal</TH><TH className="text-right">Tax</TH><SortTH k="total" label="Grand total" right /><TH>Status</TH><TH className="w-10" />
              </tr></THead><TBody>
                {list.data.items.map((p) => (
                  <TR key={p.id} onClick={() => navigate(`/proforma-invoices/${p.id}`)}>
                    <TD className="whitespace-nowrap font-medium text-brand-700">{p.number}{p.referenceNumber && <span className="block text-xs font-normal text-muted">PO {p.referenceNumber}</span>}</TD>
                    <TD>{p.customer?.company ?? p.customer?.name}</TD>
                    <TD className="text-slate-600">{fmtDate(p.issueDate)}</TD><TD className="text-slate-600">{fmtDate(p.validUntil)}</TD><TD className="text-slate-600">{p.currency}</TD>
                    <TD className="text-right tabular-nums">{money(subtotalOf(p), p.currency)}</TD><TD className="text-right tabular-nums">{money(taxOf(p), p.currency)}</TD>
                    <TD className="text-right font-medium tabular-nums">{money(p.total, p.currency)}</TD>
                    <TD><StatusBadge status={p.status} /></TD>
                    <TD className="py-1 text-right">
                      <MoreMenu compact items={[
                        { label: 'View', icon: FileCheck2, onSelect: () => navigate(`/proforma-invoices/${p.id}`) },
                        { label: 'Edit', icon: Pencil, onSelect: () => navigate(`/proforma-invoices/${p.id}/edit`), hidden: !can('proforma.create') || p.status !== 'DRAFT' },
                        { label: 'Duplicate', icon: Copy, onSelect: () => actions.duplicate.mutate(p.id), hidden: !can('proforma.create') },
                        { label: 'Download PDF', icon: Download, onSelect: () => download(p, false) },
                        { label: 'Print', icon: Printer, onSelect: () => download(p, true) },
                        { label: 'Send to client', icon: Mail, onSelect: () => navigate(`/email/proforma/${p.id}`), hidden: !can('proforma.send') || ['CANCELLED', 'CONVERTED'].includes(p.status) },
                        { label: 'Convert to Invoice', icon: ArrowRightLeft, onSelect: () => setConverting(p), hidden: !(can('proforma.convert') && can('invoices.create')) || !CONVERTIBLE.includes(p.status) },
                        { label: 'Cancel', icon: XCircle, onSelect: () => setCancelling(p), danger: true, hidden: !can('proforma.create') || ['CANCELLED', 'CONVERTED'].includes(p.status) },
                      ]} />
                    </TD>
                  </TR>
                ))}
              </TBody></Table>
            </div>
            <Pagination page={list.page} pages={list.data.pages} total={list.data.total} onPage={list.setPage} />
          </>
        )}
      </Card>
      <ConvertDialog p={converting} open={!!converting} onOpenChange={(v) => !v && setConverting(null)} loading={actions.convert.isPending} onConfirm={() => converting && actions.convert.mutate(converting.id)} />
      <CancelDialog p={cancelling} open={!!cancelling} onOpenChange={(v) => !v && setCancelling(null)} loading={actions.cancel.isPending}
        onConfirm={(reason) => cancelling && actions.cancel.mutate({ id: cancelling.id, reason }, { onSuccess: () => setCancelling(null) })} />
    </>
  );
}

// ───────────── Detail ─────────────

const EMAIL_STATUS: Record<string, string> = {
  QUEUED: 'Queued for sending', SENT: 'Accepted by the mail server', DELIVERED: 'Delivered', BOUNCED: 'Bounced', FAILED: 'Failed',
  NOT_CONFIGURED: 'Not sent: outgoing email (SMTP) is not configured',
};

function EmailActivity({ id }: { id: string }) {
  const logs = useQuery({
    queryKey: ['proforma-emails', id], queryFn: () => api.get<EmailLogEntry[]>(`/proforma-invoices/${id}/emails`),
    // Follow emails still waiting for the mail server.
    refetchInterval: (q) => (q.state.data?.some((l) => l.status === 'QUEUED') ? 3000 : false),
  });
  return (
    <Card>
      <CardHeader title="Email activity" />
      {logs.isLoading ? <LoadingBlock rows={2} /> : !logs.data?.length ? <EmptyState title="Not emailed yet" description="Use Send to client to email the PDF." /> : (
        <ul className="divide-y divide-line">
          {logs.data.map((l) => (
            <li key={l.id} className="space-y-1 px-5 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{l.to.join(', ')}</span><StatusBadge status={l.status} /></div>
              <p className="text-xs text-muted">{EMAIL_STATUS[l.status] ?? l.status} · {fmtDateTime(l.createdAt)}{l.sentByName ? ` · by ${l.sentByName}` : ''}{l.attachments.length ? ` · ${l.attachments.join(', ')}` : ''}</p>
              {l.error && l.status !== 'NOT_CONFIGURED' && <p className="text-xs text-red-600">{l.error}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ProformaDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const meta = useFinanceMeta();
  const q = useQuery({ queryKey: ['proforma', id], queryFn: () => api.get<Proforma & { salespersonName?: string | null }>(`/proforma-invoices/${id}`) });
  const actions = useProformaActions();
  const [convertOpen, setConvertOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  if (q.isLoading) return <Card><LoadingBlock rows={8} /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>;
  const d = q.data;
  const c = d.customer;
  const bill = d.billTo;
  const open = !['CANCELLED', 'CONVERTED'].includes(d.status);
  return (
    <>
      <PageHeader breadcrumb={<Link to="/proforma-invoices" className="hover:underline">Proforma Invoices</Link>}
        title={<span className="flex items-center gap-3">{d.number}<StatusBadge status={d.status} /></span>}
        description={`${c ? (c.company ?? c.name) : ''} · ${fmtDate(d.issueDate)}${d.validUntil ? ` · valid until ${fmtDate(d.validUntil)}` : ''}`}
        actions={<>
          {can('proforma.create') && d.status === 'DRAFT' && <Button variant="secondary" onClick={() => navigate(`/proforma-invoices/${d.id}/edit`)}><Pencil /> Edit</Button>}
          {can('proforma.send') && open && <Button variant="secondary" onClick={() => navigate(`/email/proforma/${d.id}`)}><Mail /> Send to client</Button>}
          <Button variant="secondary" onClick={() => download(d, true)}><Printer /> Preview / Print</Button>
          <Button variant="secondary" size="icon" aria-label="Download PDF" title="Download PDF" onClick={() => download(d, false)}><Download /></Button>
          {can('proforma.convert') && can('invoices.create') && CONVERTIBLE.includes(d.status) && <Button onClick={() => setConvertOpen(true)}><ArrowRightLeft /> Convert to Invoice</Button>}
          {d.convertedInvoice && <Button onClick={() => navigate(`/invoices/${d.convertedInvoice!.id}`)}>View invoice {d.convertedInvoice.number}</Button>}
          <MoreMenu items={[
            { label: 'Mark as Sent', icon: Send, onSelect: () => actions.status.mutate({ id: d.id, status: 'SENT' }), hidden: !can('proforma.send') || d.status !== 'DRAFT' },
            { label: 'Mark as Accepted', icon: CheckCircle2, onSelect: () => actions.status.mutate({ id: d.id, status: 'ACCEPTED' }), hidden: !can('proforma.send') || !['DRAFT', 'SENT', 'VIEWED', 'REJECTED', 'EXPIRED'].includes(d.status) },
            { label: 'Mark as Rejected', icon: XCircle, onSelect: () => actions.status.mutate({ id: d.id, status: 'REJECTED' }), hidden: !can('proforma.send') || !['DRAFT', 'SENT', 'VIEWED', 'ACCEPTED'].includes(d.status) },
            { label: 'Duplicate', icon: Copy, onSelect: () => actions.duplicate.mutate(d.id), hidden: !can('proforma.create') },
            { label: 'Cancel', icon: XCircle, onSelect: () => setCancelOpen(true), danger: true, hidden: !can('proforma.create') || !open },
          ]} />
        </>} />
      {d.status === 'CANCELLED' && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">Cancelled{d.cancelledAt ? ` on ${fmtDate(d.cancelledAt)}` : ''}: {d.cancelReason}</div>}
      {d.status === 'CONVERTED' && d.convertedInvoice && <div className="mb-4 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800">Converted to invoice <Link className="font-medium underline" to={`/invoices/${d.convertedInvoice.id}`}>{d.convertedInvoice.number}</Link>{d.convertedAt ? ` on ${fmtDate(d.convertedAt)}` : ''}.</div>}
      {d.status === 'DRAFT' && <div className="mb-4 rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-700">Draft. Send it to the client, or mark it as sent. Its seal and signature are fixed when it is sent.</div>}
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="min-w-0 space-y-6 xl:col-span-2">
          {d.subject && <Card className="p-5 text-sm"><p className="text-xs font-medium text-muted">Subject</p><p className="mt-1 whitespace-pre-wrap">{d.subject}</p></Card>}
          <Card>
            <ItemsTable items={d.items ?? []} currency={d.currency} />
            <div className="flex justify-end border-t border-line p-5"><TotalsBlock d={d} /></div>
          </Card>
          {(d.notes || d.terms) && <Card className="space-y-3 p-5 text-sm">{d.notes && <div><p className="text-xs font-medium text-muted">Customer notes</p><p className="whitespace-pre-wrap">{d.notes}</p></div>}{d.terms && <div><p className="text-xs font-medium text-muted">Terms & conditions</p><p className="whitespace-pre-wrap">{d.terms}</p></div>}</Card>}
          <EmailActivity id={d.id} />
        </div>
        <div className="min-w-0 space-y-6">
          <Card className="p-5"><DescList className="sm:grid-cols-1" items={[
            ['Client', c ? <Link to={`/customers/${c.id}`} className="text-brand-700 hover:underline">{c.company ?? c.name}</Link> : null],
            ['Bill to', bill ? <span className="whitespace-pre-line">{[bill.company ?? bill.name, bill.company ? `Attn: ${bill.name}` : null, bill.address, [bill.city, bill.state, bill.postalCode].filter(Boolean).join(' '), bill.gstin && `GSTIN ${bill.gstin}`].filter(Boolean).join('\n')}<span className="block text-xs text-muted">Document-specific billing details</span></span> : 'As on the customer record'],
            ['Currency', currencyLabel(d)], ['Issue date', fmtDate(d.issueDate)], ['Valid until', fmtDate(d.validUntil)], ['Payment terms', termsLabel(meta.data, d.paymentTerms)],
            ['Client ref / PO', d.referenceNumber], ['Project / service', d.serviceReference ?? (d.project ? `${d.project.code} · ${d.project.name}` : null)], ['Salesperson', d.salespersonName],
            ['Place of supply', d.placeOfSupply], ['Tax', d.isInterState ? 'Inter-state (IGST)' : 'Intra-state (CGST + SGST)'],
            ['Sent', d.sentAt ? fmtDateTime(d.sentAt) : null], ['Last emailed', d.lastEmailedAt ? `${fmtDateTime(d.lastEmailedAt)} to ${d.emailRecipients.join(', ')}` : null],
          ]} /></Card>
          <Card className="p-5"><p className="mb-3 text-sm font-semibold">Attachments</p><FileManager entityType="proforma" entityId={d.id} /></Card>
        </div>
      </div>
      <ConvertDialog p={d} open={convertOpen} onOpenChange={setConvertOpen} loading={actions.convert.isPending} onConfirm={() => actions.convert.mutate(d.id)} />
      <CancelDialog p={d} open={cancelOpen} onOpenChange={setCancelOpen} loading={actions.cancel.isPending} onConfirm={(reason) => actions.cancel.mutate({ id: d.id, reason }, { onSuccess: () => setCancelOpen(false) })} />
    </>
  );
}
