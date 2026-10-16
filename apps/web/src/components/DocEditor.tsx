import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowRightLeft, GripVertical, Info, ListPlus, Pencil, Plus, Repeat, Search, Settings2, Trash2, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCustomerOptions, useFinanceMeta, useMembers, useProjectOptions, useTaxOptions } from '@/lib/hooks';
import { previewTotals } from '@/lib/gst';
import type { BillTo, Customer, LineItem, Product, TaxComponents, TaxOption } from '@/lib/types';
import { cn, currencyOf, inr, money, num, toDateInput } from '@/lib/utils';
import { Badge, Button, Card, Checkbox, Dialog, Field, Input, LoadingBlock, PageHeader, SearchInput, Select, Switch, Textarea } from './ui';

export type DocKind = 'quotation' | 'invoice' | 'recurring' | 'proforma';

type EditLine = {
  productId: string | null; description: string; itemType: 'GOODS' | 'SERVICE'; hsnSac: string; quantity: string; unit: string; rate: string;
  /** Line discount as a percentage or a fixed amount for the whole line. */
  discountMode: 'PERCENT' | 'AMOUNT'; discountPct: string; discountAmount: string;
  /** Chosen tax configuration; '' with a taxRate means a plain GST rate saved by an older version. */
  taxRateId: string; taxRate: string; taxName: string | null; taxComponents: TaxComponents | null;
};
const blankLineTax = (t: TaxOption): Pick<EditLine, 'taxRateId' | 'taxRate' | 'taxName' | 'taxComponents'> => ({ taxRateId: t.id, taxRate: String(num(t.rate)), taxName: t.name, taxComponents: t.components });
const blankLine = (tax?: TaxOption): EditLine => ({
  productId: null, description: '', itemType: 'SERVICE', hsnSac: '', quantity: '1', unit: '', rate: '', discountMode: 'PERCENT', discountPct: '0', discountAmount: '',
  taxRateId: '', taxRate: '', taxName: null, taxComponents: null, ...(tax ? blankLineTax(tax) : {}),
});
const toEditLine = (l: LineItem): EditLine => ({
  productId: l.productId, description: l.description, itemType: l.hsnSac && !l.hsnSac.startsWith('99') ? 'GOODS' : 'SERVICE', hsnSac: l.hsnSac ?? '', quantity: String(num(l.quantity)), unit: l.unit ?? '', rate: String(num(l.rate)),
  discountMode: num(l.discountAmount) > 0 ? 'AMOUNT' : 'PERCENT', discountPct: String(num(l.discountPct)), discountAmount: num(l.discountAmount) > 0 ? String(num(l.discountAmount)) : '',
  taxRateId: l.taxRateId ?? '', taxRate: String(num(l.taxRate)), taxName: l.taxName ?? null, taxComponents: l.taxComponents ?? null,
});
/** Tax option label: "GST 18%" or "VAT [5%]". */
const taxLabel = (name: string, rate: unknown) => (name.includes(`${num(rate)}%`) ? name : `${name} [${num(rate)}%]`);
const emptyBillTo: BillTo = { name: '', company: '', address: '', city: '', state: '', stateCode: '', postalCode: '', gstin: '', email: '', phone: '' };

interface Head {
  number: string; numberEdited: boolean; customerId: string; leadId: string; projectId: string; placeOfSupply: string; issueDate: string; secondDate: string;
  referenceNumber: string; orderNumber: string; paymentTerms: string; salespersonId: string; subject: string; notes: string; terms: string;
  discountType: 'PERCENT' | 'AMOUNT'; discountValue: string; withholdingType: '' | 'TDS' | 'TCS'; withholdingRate: string; adjustmentLabel: string; adjustment: string;
  emailRecipients: string[];
  /** Proforma: project or service reference, and document-only billing details. */
  serviceReference: string; billToOn: boolean; billTo: BillTo;
  /** Document currency and its rate to the base currency (blank for the base currency). */
  currency: string; exchangeRate: string;
  // recurring
  profileName: string; frequency: string; endDate: string; neverExpires: boolean; createAs: 'DRAFT' | 'SEND';
}

const RECURRING_DRAFT_KEY = 'nx.recurring.prefill';

function ItemPicker({ value, products, onPick, onText }: { value: string; products: Product[]; onPick: (p: Product) => void; onText: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const q = value.split('\n')[0].toLowerCase();
  const matches = products.filter((p) => !q || p.name.toLowerCase().includes(q) || p.sku?.toLowerCase().includes(q)).slice(0, 8);
  return (
    <div ref={ref} className="relative">
      <Textarea rows={2} className="min-h-14 resize-y" value={value} placeholder="Type or click to select an item."
        onFocus={() => setOpen(true)} onChange={(e) => { onText(e.target.value); setOpen(true); }} />
      {open && matches.length > 0 && (
        <ul className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-line bg-surface py-1 shadow-lg">
          {matches.map((p) => (
            <li key={p.id}>
              <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-slate-50" onMouseDown={(e) => { e.preventDefault(); onPick(p); setOpen(false); }}>
                <span className="min-w-0"><span className="block truncate text-sm font-medium">{p.name}</span><span className="text-xs text-muted">{p.type === 'GOODS' ? 'HSN' : 'SAC'}: {p.hsnSac ?? '—'}{p.sku ? ` · SKU ${p.sku}` : ''}</span></span>
                <span className="shrink-0 text-sm tabular-nums">{inr(p.rate)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type ItemKind = 'GOODS' | 'SERVICE';
/** SAC codes (services) all start with 99; anything else is treated as an HSN (goods) code. */
const kindFromCode = (code: string): ItemKind => (code.startsWith('99') ? 'SERVICE' : 'GOODS');

// Frequently used codes for an IT/digital agency, offered before the user types anything.
const COMMON_CODES: { code: string; label: string; kind: ItemKind }[] = [
  { code: '998314', label: 'IT design and development services', kind: 'SERVICE' },
  { code: '998313', label: 'IT consulting and support services', kind: 'SERVICE' },
  { code: '998315', label: 'Hosting and IT infrastructure provisioning services', kind: 'SERVICE' },
  { code: '998316', label: 'IT infrastructure and network management services', kind: 'SERVICE' },
  { code: '998319', label: 'Other information technology services', kind: 'SERVICE' },
  { code: '997331', label: 'Licensing services for the right to use software', kind: 'SERVICE' },
  { code: '998361', label: 'Advertising services', kind: 'SERVICE' },
  { code: '998365', label: 'Sale of internet advertising space', kind: 'SERVICE' },
  { code: '998391', label: 'Specialty design services (graphic, UI)', kind: 'SERVICE' },
  { code: '998311', label: 'Management consulting services', kind: 'SERVICE' },
  { code: '998713', label: 'Maintenance and repair of computers', kind: 'SERVICE' },
  { code: '999293', label: 'Commercial training and coaching services', kind: 'SERVICE' },
  { code: '8471', label: 'Computers and data processing machines', kind: 'GOODS' },
  { code: '8523', label: 'Storage media, including software on media', kind: 'GOODS' },
  { code: '8517', label: 'Phones and network equipment', kind: 'GOODS' },
];

/** Inline "SERVICE · SAC: 998314 ✎ Update" tag under an item, with a search popover. */
function CodeTag({ kind, code, products, onKind, onCode }: { kind: ItemKind; code: string; products: Product[]; onKind: (k: ItemKind) => void; onCode: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const label = kind === 'GOODS' ? 'HSN' : 'SAC';

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!panel.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // The item table scrolls horizontally, so the panel is fixed-positioned and follows its trigger when anything scrolls.
    const onMove = (e: Event) => { if (!(e.target instanceof Node) || !panel.current?.contains(e.target)) place(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); window.removeEventListener('scroll', onMove, true); window.removeEventListener('resize', onMove); };
  }, [open]);

  function place() {
    const r = trigger.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 8, left: Math.max(8, Math.min(r.left - 70, window.innerWidth - 448)) });
  }
  const show = () => {
    place();
    setQ(code);
    setOpen(true);
  };

  // Suggestions: codes already used on items, then common codes, matching the kind and the search text.
  const known = new Map<string, { code: string; label: string; kind: ItemKind }>();
  for (const p of products) if (p.hsnSac) known.set(p.hsnSac, { code: p.hsnSac, label: p.name, kind: p.type === 'GOODS' ? 'GOODS' : 'SERVICE' });
  for (const c of COMMON_CODES) if (!known.has(c.code)) known.set(c.code, c);
  const term = q.trim().toLowerCase();
  const options = [...known.values()].filter((o) => o.kind === kind && (!term || o.code.includes(term) || o.label.toLowerCase().includes(term))).slice(0, 8);
  const typed = q.trim();
  const validTyped = /^\d{4,8}$/.test(typed);
  const pick = (c: string) => { onCode(c); setOpen(false); };

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
      <button type="button" onClick={() => onKind(kind === 'GOODS' ? 'SERVICE' : 'GOODS')} title="Switch between goods and service"
        className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-white', kind === 'GOODS' ? 'bg-[#0284c7]' : 'bg-[#059669]')}>
        {kind}
      </button>
      <span className="text-slate-600">{label}:</span>
      {code && <span className="font-medium tabular-nums text-ink">{code}</span>}
      <button ref={trigger} type="button" onClick={() => (open ? setOpen(false) : show())} className="flex items-center gap-1 font-medium text-brand-700 hover:underline">
        <Pencil className="size-3" /> {code ? 'Update' : 'Add'}
      </button>
      {open && createPortal(
        <div ref={panel} role="dialog" aria-label={`${label} code`} style={{ top: pos.top, left: pos.left }}
          className="fixed z-50 w-[26rem] max-w-[calc(100vw-1rem)] rounded-xl border border-line bg-surface p-4 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold">{label} code</p>
            {code && <button type="button" className="text-xs text-slate-500 hover:text-red-600" onClick={() => pick('')}>Clear</button>}
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <Input autoFocus className="pl-9" placeholder="Type a code or description" value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (validTyped) pick(typed); else if (options[0]) pick(options[0].code); } }} />
          </div>
          <ul className="mt-2 max-h-64 overflow-auto rounded-lg border border-line">
            {validTyped && !options.some((o) => o.code === typed) && (
              <li><button type="button" onClick={() => pick(typed)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50"><Plus className="size-4 text-brand-700" /> Use <span className="font-semibold tabular-nums">{typed}</span></button></li>
            )}
            {options.map((o) => (
              <li key={o.code}>
                <button type="button" onClick={() => pick(o.code)} className={cn('flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-slate-50', o.code === code && 'bg-brand-50/60')}>
                  <span className="w-16 shrink-0 text-sm font-semibold tabular-nums">{o.code}</span>
                  <span className="text-sm text-slate-600">{o.label}</span>
                </button>
              </li>
            ))}
            {!options.length && !validTyped && <li className="px-3 py-3 text-xs text-muted">No matches. Enter a 4 to 8 digit {label} code to use it.</li>}
          </ul>
          <p className="mt-2 text-[11px] text-muted">{kind === 'GOODS' ? 'HSN codes classify goods.' : 'SAC codes classify services and start with 99.'} Check the code with your accountant if unsure.</p>
        </div>,
        document.body,
      )}
    </div>
  );
}

/** Explicit conversion: multiplies every price by a stated rate after the user confirms. */
function ConvertAmountsDialog({ open, onOpenChange, from, base, fromRate, currencies, onApply }: {
  open: boolean; onOpenChange: (v: boolean) => void; from: string; base: string; fromRate: number;
  currencies: { code: string; name: string; symbol: string }[]; onApply: (to: string, rate: number) => void;
}) {
  const [to, setTo] = useState('');
  const [rate, setRate] = useState('');
  const [date, setDate] = useState(toDateInput(new Date()));
  const [confirmed, setConfirmed] = useState(false);
  const target = to || currencies.find((c) => c.code !== from)?.code || '';
  const targetLatest = useQuery({ queryKey: ['exchange-rates', target], enabled: open && !!target && target !== base, queryFn: () => api.get<{ rate: string }[]>('/settings/exchange-rates', { currency: target }) });
  useEffect(() => { if (open) { setTo(''); setRate(''); setConfirmed(false); setDate(toDateInput(new Date())); } }, [open]);
  // Suggest a cross rate from the known rates to the base currency.
  useEffect(() => {
    if (!open || !target) return;
    const toBase = target === base ? 1 : num(targetLatest.data?.[0]?.rate);
    if (toBase > 0 && fromRate > 0) setRate(String(Math.round((fromRate / toBase) * 1e6) / 1e6));
  }, [open, target, base, fromRate, targetLatest.data]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Convert amounts to another currency"
      description="Every item price, amount discount and adjustment is multiplied by the rate below. Review the totals before saving."
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={!confirmed || !(Number(rate) > 0) || !target} onClick={() => { onApply(target, Number(rate)); onOpenChange(false); }}><ArrowRightLeft /> Convert</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="From"><Input value={from} disabled /></Field>
        <Field label="To" required>
          <Select value={target} onChange={(e) => setTo(e.target.value)}>{currencies.filter((c) => c.code !== from).map((c) => <option key={c.code} value={c.code}>{c.code} ({c.symbol}) · {c.name}</option>)}</Select>
        </Field>
        <Field label={`Rate: 1 ${from} = ? ${target}`} required><Input type="number" min={0} step="0.000001" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
        <Field label="Conversion date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <label className="flex items-start gap-2 text-sm sm:col-span-2"><Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(!!v)} /> <span>I understand the amounts on this document will change{Number(rate) > 0 && target ? ` (e.g. 100.00 ${from} becomes ${(100 * Number(rate)).toFixed(2)} ${target})` : ''}.</span></label>
      </div>
    </Dialog>
  );
}

function BulkItemsDialog({ open, onOpenChange, products, onAdd }: { open: boolean; onOpenChange: (v: boolean) => void; products: Product[]; onAdd: (items: { product: Product; qty: number }[]) => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Record<string, number>>({});
  useEffect(() => { if (open) { setSel({}); setQ(''); } }, [open]);
  const list = products.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
  const chosen = Object.entries(sel).filter(([, v]) => v > 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add items in bulk" size="lg"
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={!chosen.length} onClick={() => { onAdd(chosen.map(([id, qty]) => ({ product: products.find((p) => p.id === id)!, qty }))); onOpenChange(false); }}>Add {chosen.length || ''} item{chosen.length === 1 ? '' : 's'}</Button></>}>
      <SearchInput value={q} onChange={setQ} placeholder="Search items" />
      <ul className="mt-3 max-h-96 divide-y divide-line overflow-auto rounded-lg border border-line">
        {list.map((p) => (
          <li key={p.id} className="flex items-center gap-3 px-3 py-2">
            <Checkbox checked={!!sel[p.id]} onCheckedChange={(v) => setSel({ ...sel, [p.id]: v ? 1 : 0 })} />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{p.name}</span><span className="text-xs text-muted">{inr(p.rate)} · GST {num(p.taxRate)}%</span></span>
            {!!sel[p.id] && <Input type="number" min={1} className="w-20" value={sel[p.id]} onChange={(e) => setSel({ ...sel, [p.id]: Number(e.target.value) })} aria-label="Quantity" />}
          </li>
        ))}
        {!list.length && <li className="p-4 text-center text-sm text-muted">No items. Add them under Items.</li>}
      </ul>
    </Dialog>
  );
}

export function DocEditor({ kind }: { kind: DocKind }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { me, can } = useAuth();
  const meta = useFinanceMeta();
  const members = useMembers();
  const customers = useCustomerOptions();
  const projects = useProjectOptions();
  const products = useQuery({ queryKey: ['/products', 'active-all'], queryFn: () => api.get<{ items: Product[] }>('/products', { active: 1, pageSize: 200, sort: 'name', dir: 'asc' }) });
  const leadId = params.get('leadId');
  const lead = useQuery({ queryKey: ['lead', leadId], enabled: !!leadId, queryFn: () => api.get<{ id: string; name: string; company: string | null; customerId: string | null }>(`/leads/${leadId}`) });
  const endpoint = kind === 'quotation' ? 'quotations' : kind === 'invoice' ? 'invoices' : kind === 'proforma' ? 'proforma-invoices' : 'recurring-invoices';
  const taxOptions = useTaxOptions();
  const existing = useQuery({ queryKey: [kind, id], enabled: !!id, queryFn: () => api.get<Record<string, unknown> & { items: LineItem[] }>(`/${endpoint}/${id}`) });
  const nextNo = useQuery({ queryKey: [kind, 'next-number'], enabled: !id && kind !== 'recurring', queryFn: () => api.get<{ number: string }>(`/${endpoint}/next-number`) });
  const frequencies = useQuery({ queryKey: ['recurring-meta'], enabled: kind === 'recurring', queryFn: () => api.get<{ frequencies: { code: string; label: string }[] }>('/recurring-invoices/meta') });

  const today = toDateInput(new Date());
  const [h, setH] = useState<Head>({
    number: '', numberEdited: false, customerId: params.get('customerId') ?? '', leadId: leadId ?? '', projectId: params.get('projectId') ?? '', placeOfSupply: '',
    issueDate: today, secondDate: '', referenceNumber: '', orderNumber: '', paymentTerms: '', salespersonId: me?.id ?? '', subject: '', notes: '', terms: '',
    discountType: 'PERCENT', discountValue: '0', withholdingType: '', withholdingRate: '', adjustmentLabel: 'Adjustment', adjustment: '', emailRecipients: [],
    serviceReference: '', billToOn: false, billTo: emptyBillTo,
    currency: '', exchangeRate: '',
    profileName: '', frequency: 'MONTH', endDate: '', neverExpires: true, createAs: 'DRAFT',
  });
  const [lines, setLines] = useState<EditLine[]>([blankLine()]);
  const [errors, setErrors] = useState<string | null>(null);
  const [saving, setSaving] = useState<null | 'draft' | 'send'>(null);
  const [bulk, setBulk] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [numberEditable, setNumberEditable] = useState(false);
  const set = <K extends keyof Head>(k: K, v: Head[K]) => setH((x) => ({ ...x, [k]: v }));

  // Prefill from an existing document, or from "Make Recurring".
  useEffect(() => {
    const d = existing.data as Record<string, unknown> | undefined;
    if (!d) return;
    const s = (k: string) => (d[k] == null ? '' : String(d[k]));
    setH((x) => ({
      ...x, number: s('number'), customerId: s('customerId'), leadId: s('leadId'), projectId: s('projectId'), placeOfSupply: s('placeOfSupply'),
      issueDate: toDateInput((d.issueDate ?? d.startDate) as string), secondDate: toDateInput((kind === 'invoice' ? d.dueDate : d.validUntil) as string),
      referenceNumber: s('referenceNumber'), orderNumber: s('orderNumber'), paymentTerms: s('paymentTerms'), salespersonId: s('salespersonId'), subject: s('subject'),
      notes: s('notes'), terms: s('terms'), discountType: (s('discountType') || 'PERCENT') as 'PERCENT', discountValue: String(num(d.discountValue)),
      withholdingType: (s('withholdingType') || '') as '', withholdingRate: String(num(d.withholdingRate) || ''), adjustmentLabel: s('adjustmentLabel') || 'Adjustment',
      adjustment: num(d.adjustment) ? String(num(d.adjustment)) : '', emailRecipients: (d.emailRecipients as string[]) ?? [],
      serviceReference: s('serviceReference'), billToOn: !!d.billTo, billTo: { ...emptyBillTo, ...((d.billTo as BillTo | null) ?? {}) },
      currency: s('currency'), exchangeRate: num(d.exchangeRate) && num(d.exchangeRate) !== 1 ? String(num(d.exchangeRate)) : '',
      profileName: s('profileName'), frequency: s('frequency') || 'MONTH', endDate: toDateInput(d.endDate as string), neverExpires: !d.endDate, createAs: (s('createAs') || 'DRAFT') as 'DRAFT',
    }));
    setLines(((d.items as LineItem[] | undefined) ?? []).map(toEditLine));
  }, [existing.data, kind]);
  useEffect(() => {
    if (kind !== 'recurring' || id) return;
    try {
      const raw = sessionStorage.getItem(RECURRING_DRAFT_KEY);
      if (!raw) return;
      sessionStorage.removeItem(RECURRING_DRAFT_KEY);
      const { head, lines: l } = JSON.parse(raw) as { head: Partial<Head>; lines: EditLine[] };
      setH((x) => ({ ...x, ...head, issueDate: today, profileName: head.subject || '' }));
      setLines(l);
    } catch { /* ignore */ }
  }, [kind, id, today]);
  useEffect(() => { if (nextNo.data && !h.numberEdited && !id) set('number', nextNo.data.number); }, [nextNo.data, id, h.numberEdited]);
  // The tax pre-selected on new lines: the GST configuration at the company's default rate, else the first option.
  const options = taxOptions.data ?? [];
  const defaultTax = options.find((o) => o.taxType === 'GST' && num(o.rate) === (meta.data?.defaultTaxRate ?? 18)) ?? options[0];
  useEffect(() => { if (defaultTax) setLines((ls) => ls.map((l) => (!l.taxRateId && l.taxRate === '' ? { ...l, ...blankLineTax(defaultTax) } : l))); }, [defaultTax]);
  useEffect(() => { if (lead.data?.customerId && !h.customerId) set('customerId', lead.data.customerId); }, [lead.data, h.customerId]);

  const customer = useQuery({ queryKey: ['customer', h.customerId], enabled: !!h.customerId, queryFn: () => api.get<Customer & { contacts: { id: string; name: string; email: string | null }[] }>(`/customers/${h.customerId}`) });
  // Customer defaults: payment terms and the email recipients.
  const lastCustomer = useRef<string | null>(null);
  useEffect(() => {
    const c = customer.data;
    if (!c || lastCustomer.current === c.id) return;
    const first = lastCustomer.current === null && !!id;
    lastCustomer.current = c.id;
    if (first) return; // keep saved values when editing
    setH((x) => ({ ...x, paymentTerms: c.paymentTerms, placeOfSupply: '', emailRecipients: c.email ? [c.email] : [] }));
  }, [customer.data, id]);

  // Exports and SEZ supplies are zero rated and inter-state; tax never depends on the currency.
  const zeroRated = ['OVERSEAS', 'SEZ'].includes(customer.data?.gstTreatment ?? '');
  const pos = h.placeOfSupply || customer.data?.stateCode || (customer.data?.gstTreatment === 'OVERSEAS' ? '96' : meta.data?.companyStateCode) || '';
  const interState = zeroRated || (!!meta.data?.companyStateCode && !!pos && pos !== meta.data.companyStateCode);
  const exempt = customer.data?.taxPreference === 'EXEMPT' || zeroRated;
  const base = meta.data?.baseCurrency ?? 'INR';
  const cur = h.currency || meta.data?.defaultCurrency || base;
  const foreign = cur !== base;
  const m = (v: unknown) => money(v, cur);
  const preview = useMemo(() => previewTotals(lines.map((l) => ({
    quantity: Number(l.quantity), rate: Number(l.rate), discountPct: l.discountMode === 'PERCENT' ? Number(l.discountPct) : 0, discountAmount: l.discountMode === 'AMOUNT' ? Number(l.discountAmount) || 0 : 0,
    taxRate: exempt ? 0 : Number(l.taxRate) || 0, taxComponents: exempt ? null : l.taxComponents,
  })), interState, {
    decimals: currencyOf(cur).decimals,
    discountType: h.discountType, discountValue: Number(h.discountValue) || 0, withholdingType: h.withholdingType || null, withholdingRate: Number(h.withholdingRate) || 0,
    adjustment: Number(h.adjustment) || 0, roundOff: meta.data?.roundOff,
  }), [lines, interState, exempt, h.discountType, h.discountValue, h.withholdingType, h.withholdingRate, h.adjustment, meta.data?.roundOff, cur]);

  // New documents start in the company's default currency.
  useEffect(() => { if (!id && !h.currency && meta.data) set('currency', meta.data.defaultCurrency); }, [id, h.currency, meta.data]);
  // Picking a foreign currency pre-fills the last rate used for it.
  const lastRate = useQuery({ queryKey: ['exchange-rates', cur], enabled: foreign, queryFn: () => api.get<{ rate: string }[]>('/settings/exchange-rates', { currency: cur }) });
  useEffect(() => { if (foreign && !h.exchangeRate && lastRate.data?.[0]) set('exchangeRate', String(num(lastRate.data[0].rate))); }, [foreign, h.exchangeRate, lastRate.data]);
  const [convertOpen, setConvertOpen] = useState(false);

  const dueDate = useMemo(() => {
    if (kind !== 'invoice') return '';
    const issue = new Date(h.issueDate || today);
    const t = h.paymentTerms || 'DUE_ON_RECEIPT';
    if (t === 'CUSTOM') return h.secondDate || h.issueDate;
    const days: Record<string, number> = { DUE_ON_RECEIPT: 0, NET_15: 15, NET_30: 30, NET_45: 45, NET_60: 60 };
    if (t in days) return toDateInput(new Date(issue.getTime() + days[t] * 86_400_000));
    if (t === 'END_OF_MONTH') return toDateInput(new Date(issue.getFullYear(), issue.getMonth() + 1, 0));
    if (t === 'END_OF_NEXT_MONTH') return toDateInput(new Date(issue.getFullYear(), issue.getMonth() + 2, 0));
    return h.secondDate;
  }, [kind, h.issueDate, h.paymentTerms, h.secondDate, today]);

  const setLine = (i: number, patch: Partial<EditLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  // Item prices are kept in the base currency; on a foreign-currency document they are converted at the document's rate.
  const priceIn = (baseRate: number) => (foreign && Number(h.exchangeRate) > 0 ? Math.round((baseRate / Number(h.exchangeRate)) * 100) / 100 : baseRate);
  // An item's GST rate maps to the matching configuration (Exempt for non-taxable items); otherwise the line keeps its tax.
  const taxForProduct = (p: Product) => (p.taxPreference === 'EXEMPT' ? options.find((o) => o.taxType === 'EXEMPT') : options.find((o) => o.taxType === 'GST' && num(o.rate) === num(p.taxRate)));
  const fromProduct = (p: Product): Partial<EditLine> => {
    const t = taxForProduct(p);
    return { productId: p.id, description: p.description ? `${p.name}\n${p.description}` : p.name, itemType: p.type === 'GOODS' ? 'GOODS' : 'SERVICE', hsnSac: p.hsnSac ?? '', unit: p.unit, rate: String(priceIn(num(p.rate))), ...(t ? blankLineTax(t) : {}) };
  };
  const pickTax = (i: number, value: string) => {
    const o = options.find((x) => x.id === value);
    if (o) setLine(i, blankLineTax(o));
  };

  const body = (issue: boolean) => {
    const items = lines.filter((l) => l.description.trim()).map((l) => ({
      productId: l.productId, description: l.description.trim(), hsnSac: l.hsnSac || null, quantity: Number(l.quantity), unit: l.unit || null, rate: Number(l.rate || 0),
      discountPct: l.discountMode === 'PERCENT' ? Number(l.discountPct || 0) : 0, discountAmount: l.discountMode === 'AMOUNT' ? Number(l.discountAmount || 0) : 0,
      // A configured tax is sent by id; a line saved before tax configurations keeps its plain rate.
      ...(l.taxRateId ? { taxRateId: l.taxRateId } : { taxRate: Number(l.taxRate) }),
    }));
    const common = {
      customerId: h.customerId || null, placeOfSupply: h.placeOfSupply || null, salespersonId: h.salespersonId || null, subject: h.subject || null, projectId: h.projectId || null,
      discountType: h.discountType, discountValue: Number(h.discountValue) || 0, withholdingType: h.withholdingType || null, withholdingRate: Number(h.withholdingRate) || 0,
      adjustmentLabel: h.adjustmentLabel || null, adjustment: Number(h.adjustment) || 0, notes: h.notes || null, terms: h.terms || null, items,
      currency: cur, exchangeRate: foreign ? Number(h.exchangeRate) || null : null,
    };
    if (kind === 'recurring') return { ...common, profileName: h.profileName, orderNumber: h.orderNumber || null, frequency: h.frequency, startDate: h.issueDate, endDate: h.neverExpires ? null : h.endDate || null, paymentTerms: h.paymentTerms || undefined, createAs: h.createAs };
    const num_ = numberEditable || h.numberEdited ? h.number || null : null;
    if (kind === 'quotation') return { ...common, number: num_, leadId: h.leadId || null, referenceNumber: h.referenceNumber || null, issueDate: h.issueDate, validUntil: h.secondDate || null };
    if (kind === 'proforma') {
      const clean = (v?: string | null) => (v && v.trim() ? v.trim() : null);
      const billTo = h.billToOn && h.billTo.name.trim() ? Object.fromEntries(Object.entries(h.billTo).map(([k, v]) => [k, clean(v)])) : null;
      return { ...common, number: num_, referenceNumber: h.referenceNumber || null, serviceReference: h.serviceReference || null, issueDate: h.issueDate,
        // Left blank on a new proforma, the validity period from Document Settings applies.
        validUntil: h.secondDate || (id ? null : undefined), paymentTerms: h.paymentTerms || undefined, emailRecipients: h.emailRecipients, billTo };
    }
    return { ...common, number: num_, orderNumber: h.orderNumber || null, issueDate: h.issueDate, paymentTerms: h.paymentTerms || undefined, dueDate: h.paymentTerms === 'CUSTOM' ? h.secondDate || null : undefined, emailRecipients: h.emailRecipients, issue };
  };

  const save = async (mode: 'draft' | 'send') => {
    setErrors(null);
    if (!h.customerId && !(kind === 'quotation' && h.leadId)) { setErrors('Select a customer.'); return; }
    if (lines.some((l) => l.description.trim() && !l.taxRateId && l.taxRate === '')) { setErrors('Choose a tax for every line.'); return; }
    if (kind === 'proforma' && h.billToOn && !h.billTo.name.trim()) { setErrors('Enter the billing name, or turn off the document-specific billing details.'); return; }
    if (kind === 'recurring' && !h.profileName.trim()) { setErrors('Enter a profile name.'); return; }
    if (foreign && !(Number(h.exchangeRate) > 0)) { setErrors(`Enter the exchange rate from ${cur} to ${base}.`); return; }
    setSaving(mode);
    try {
      const payload = body(mode === 'send' && kind === 'invoice' && can('invoices.issue'));
      const saved = id ? await api.patch<{ id: string }>(`/${endpoint}/${id}`, payload) : await api.post<{ id: string }>(`/${endpoint}`, payload);
      toast.success(kind === 'recurring' ? 'Recurring profile saved' : mode === 'send' ? 'Saved. Compose the email to send it.' : sentDoc ? 'Changes saved' : 'Saved as draft');
      if (mode === 'send' && kind !== 'recurring') navigate(`/email/${kind === 'quotation' ? 'quote' : kind}/${saved.id}`, { replace: true });
      else navigate(`/${endpoint}/${saved.id}`, { replace: true });
    } catch (e) {
      const fe = e instanceof ApiError ? e.details?.fieldErrors : undefined;
      setErrors(fe ? Object.entries(fe).map(([k, v]) => `${k}: ${v[0]}`).join(' · ') : errorMessage(e));
    } finally {
      setSaving(null);
    }
  };

  const makeRecurring = () => {
    try { sessionStorage.setItem(RECURRING_DRAFT_KEY, JSON.stringify({ head: { ...h, number: '' }, lines })); } catch { /* ignore */ }
    navigate('/recurring-invoices/new');
  };

  if (id && existing.isLoading) return <Card><LoadingBlock rows={8} /></Card>;
  const savedStatus = id ? String(existing.data?.status ?? '') : '';
  // A document that has already gone to the customer: saving keeps its status instead of turning it back into a draft.
  const sentDoc = !!savedStatus && savedStatus !== 'DRAFT' && kind !== 'recurring';
  const title = kind === 'quotation' ? 'Quote' : kind === 'invoice' ? 'Invoice' : kind === 'proforma' ? 'Proforma Invoice' : 'Recurring Invoice';
  const listLabel = kind === 'quotation' ? 'Quotes' : kind === 'invoice' ? 'Invoices' : kind === 'proforma' ? 'Proforma Invoices' : 'Recurring Invoices';
  const c = customer.data;
  const projectChoices = projects.data?.filter((p) => !h.customerId || p.customerId === h.customerId) ?? [];
  const contactEmails = [...new Set([c?.email, ...(c?.contacts ?? []).map((x) => x.email)].filter((x): x is string => !!x))];

  return (
    <div>
      <PageHeader breadcrumb={<Link to={`/${endpoint}`} className="hover:underline">{listLabel}</Link>} title={`${id ? 'Edit' : 'New'} ${title}`} />
      {kind === 'proforma' && <div className="mb-4 rounded-lg bg-sky-50 px-4 py-3 text-sm text-sky-800">A proforma invoice requests payment or confirms an order. It is not a tax invoice: convert it to an invoice when you make the supply.</div>}
      {sentDoc && kind === 'invoice' && <div className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">This invoice has already been sent. Your changes update it in place; resend it so the customer has the latest copy. Payments already recorded stay applied.</div>}
      {sentDoc && kind === 'quotation' && <div className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">This quote is {savedStatus.toLowerCase()}. Your changes update it in place; resend it so the customer has the latest copy.</div>}
      {errors && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{errors}</div>}
      {!meta.data?.companyGstin && <div className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">Your company GSTIN and state are not set. <Link to="/settings/company" className="font-medium underline">Complete your company profile</Link> so tax is calculated correctly.</div>}

      {/* Customer */}
      <Card className="mb-6 bg-slate-50/60 p-5">
        <div className="grid gap-4 lg:grid-cols-[180px_1fr]">
          <label className="pt-2 text-sm font-medium text-red-600">Customer Name*</label>
          <div className="max-w-xl">
            {kind === 'quotation' && h.leadId && !h.customerId ? (
              <Input disabled value={lead.data ? `${lead.data.name}${lead.data.company ? ` (${lead.data.company})` : ''} · lead` : 'Lead'} />
            ) : (
              <Select value={h.customerId} onChange={(e) => set('customerId', e.target.value)} aria-label="Customer">
                <option value="">Select or add a customer</option>
                {customers.data?.map((x) => <option key={x.id} value={x.id}>{x.company ?? x.name}{x.gstin ? ` · ${x.gstin}` : ''}</option>)}
              </Select>
            )}
            {!h.customerId && can('customers.update') && <Link to="/customers?new=1" className="mt-1 inline-block text-xs text-brand-700 hover:underline">+ New customer</Link>}
          </div>
        </div>
        {c && (
          <div className="mt-4 grid gap-6 text-sm lg:ml-[196px] lg:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Billing address <Link to={`/customers/${c.id}?edit=1`} className="ml-1 text-brand-700"><Pencil className="inline size-3" /></Link></p>
              <p className="font-medium">{c.company ?? c.name}</p>
              <p className="whitespace-pre-line text-slate-600">{[c.billingAttention, c.billingAddress, [c.city, c.state, c.postalCode].filter(Boolean).join(' '), c.country, c.phone && `Phone: ${c.phone}`].filter(Boolean).join('\n') || 'No billing address'}</p>
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Shipping address</p>
              <p className="whitespace-pre-line text-slate-600">{c.shippingAddress ? [c.shippingAttention ?? c.company ?? c.name, c.shippingAddress, [c.shippingCity, c.shippingState, c.shippingPostalCode].filter(Boolean).join(' '), c.shippingCountry].filter(Boolean).join('\n') : 'Same as billing'}</p>
            </div>
            <div className="lg:col-span-2">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">GST details</p>
              <p className="text-slate-600">GST Treatment: <span className="text-ink">{c.gstTreatment ? meta.data?.gstTreatments[c.gstTreatment] : 'Not set'}</span>{c.gstin && <> · GSTIN: <span className="font-mono text-ink">{c.gstin}</span></>}{exempt && <Badge tone="amber" className="ml-2">Tax exempt</Badge>}</p>
            </div>
          </div>
        )}
        {kind === 'proforma' && c && (
          <div className="mt-4 lg:ml-[196px]">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={h.billToOn} onCheckedChange={(v) => setH((x) => ({ ...x, billToOn: !!v, billTo: v && !x.billTo.name ? { ...emptyBillTo, name: c.billingAttention ?? c.name, company: c.company ?? '', address: c.billingAddress ?? '', city: c.city ?? '', state: c.state ?? '', stateCode: c.stateCode ?? '', postalCode: c.postalCode ?? '', gstin: c.gstin ?? '', email: c.email ?? '', phone: c.phone ?? '' } : x.billTo }))} />
              Use different billing details on this document
            </label>
            <p className="mt-1 text-xs text-muted">Only this proforma invoice changes. The customer record stays as it is.</p>
            {h.billToOn && (
              <div className="mt-3 grid gap-3 rounded-lg border border-line bg-surface p-4 sm:grid-cols-2">
                {([['name', 'Contact name*'], ['company', 'Company'], ['address', 'Address'], ['city', 'City'], ['state', 'State'], ['postalCode', 'Postal code'], ['gstin', 'GSTIN'], ['email', 'Email'], ['phone', 'Phone']] as [keyof BillTo, string][]).map(([k, label]) => (
                  <Field key={k} label={label} className={k === 'address' ? 'sm:col-span-2' : undefined}>
                    {k === 'address'
                      ? <Textarea rows={2} value={h.billTo[k] ?? ''} onChange={(e) => setH((x) => ({ ...x, billTo: { ...x.billTo, [k]: e.target.value } }))} />
                      : <Input value={h.billTo[k] ?? ''} onChange={(e) => setH((x) => ({ ...x, billTo: { ...x.billTo, [k]: e.target.value } }))} />}
                  </Field>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="mt-4 grid gap-4 lg:grid-cols-[180px_1fr]">
          <label className="pt-2 text-sm font-medium text-red-600">Place of Supply*</label>
          <div className="max-w-sm">
            <Select value={pos} onChange={(e) => set('placeOfSupply', e.target.value)} aria-label="Place of supply">
              <option value="">—</option>
              {(meta.data?.stateList ?? []).map(([code, n]) => <option key={code} value={code}>[{code}] - {n}</option>)}
            </Select>
            <p className="mt-1 text-xs text-muted">{zeroRated ? 'Export / SEZ supply: zero rated under LUT, no GST charged' : interState ? 'Inter-state supply: IGST applies' : 'Intra-state supply: CGST + SGST apply'}</p>
          </div>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-[180px_1fr]">
          <label className="pt-2 text-sm font-medium">Currency</label>
          <div className="flex flex-wrap items-start gap-3">
            <div className="w-full max-w-sm">
              <Select value={cur} onChange={(e) => setH((x) => ({ ...x, currency: e.target.value, exchangeRate: '' }))} aria-label="Currency">
                {(meta.data?.currencies ?? []).map((c) => <option key={c.code} value={c.code}>{c.code} ({c.symbol}) · {c.name}{c.code === meta.data?.defaultCurrency ? ' · default' : ''}</option>)}
                {!meta.data?.currencies.some((c) => c.code === cur) && <option value={cur}>{cur}</option>}
              </Select>
              <p className="mt-1 text-xs text-muted">Changing the currency does not convert amounts.{lines.some((l) => Number(l.rate) > 0) && <> Use <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => setConvertOpen(true)}>Convert amounts</button> to recalculate prices.</>}</p>
              {c?.currency && c.currency !== cur && meta.data?.currencies.some((x) => x.code === c.currency) && (
                <p className="mt-1 text-xs text-amber-700">This customer's preferred currency is {c.currency}. <button type="button" className="font-medium underline" onClick={() => setH((x) => ({ ...x, currency: c.currency, exchangeRate: '' }))}>Use {c.currency}</button></p>
              )}
            </div>
            {foreign && (
              <div className="flex items-center gap-2 text-sm">
                <span className="whitespace-nowrap text-slate-600">1 {cur} =</span>
                <Input className="w-32 text-right" type="number" min={0} step="0.0001" value={h.exchangeRate} onChange={(e) => set('exchangeRate', e.target.value)} aria-label="Exchange rate" />
                <span className="text-slate-600">{base}</span>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* Document header */}
      <Card className="mb-6 p-5">
        <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
          {kind === 'recurring' ? (
            <>
              <Field label={<span className="text-red-600">Profile Name*</span>}><Input value={h.profileName} onChange={(e) => set('profileName', e.target.value)} /></Field>
              <Field label="Order Number"><Input value={h.orderNumber} onChange={(e) => set('orderNumber', e.target.value)} /></Field>
              <Field label={<span className="text-red-600">Repeat Every*</span>}>
                <Select value={h.frequency} onChange={(e) => set('frequency', e.target.value)}>{frequencies.data?.frequencies.map((f) => <option key={f.code} value={f.code}>{f.label}</option>)}</Select>
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Start On"><Input type="date" value={h.issueDate} onChange={(e) => set('issueDate', e.target.value)} /></Field>
                <Field label="Ends On"><Input type="date" value={h.endDate} disabled={h.neverExpires} onChange={(e) => set('endDate', e.target.value)} /></Field>
                <label className="col-span-2 -mt-2 flex items-center gap-2 text-sm"><Checkbox checked={h.neverExpires} onCheckedChange={(v) => set('neverExpires', v)} /> Never Expires</label>
              </div>
              <Field label="Payment Terms"><Select value={h.paymentTerms || 'DUE_ON_RECEIPT'} onChange={(e) => set('paymentTerms', e.target.value)}>{meta.data?.paymentTerms.filter((t) => t.code !== 'CUSTOM').map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}</Select></Field>
            </>
          ) : (
            <>
              <Field label={<span className="text-red-600">{kind === 'quotation' ? 'Quote#*' : kind === 'proforma' ? 'Proforma Invoice#*' : 'Invoice#*'}</span>}>
                <div className="relative">
                  <Input value={h.number} readOnly={!numberEditable} onChange={(e) => setH((x) => ({ ...x, number: e.target.value, numberEdited: true }))} className={cn(!numberEditable && 'bg-slate-50')} />
                  <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-brand-700" title="Enter a number manually" onClick={() => setNumberEditable((v) => !v)} aria-label="Toggle manual numbering"><Settings2 className="size-4" /></button>
                </div>
                <p className="mt-1 text-xs text-muted">{numberEditable ? 'Manual number. It must be unique.' : 'Auto-generated from your numbering settings.'}</p>
              </Field>
              {kind === 'quotation' || kind === 'proforma'
                ? <Field label={kind === 'proforma' ? 'Client Reference / PO#' : 'Reference#'}><Input value={h.referenceNumber} onChange={(e) => set('referenceNumber', e.target.value)} /></Field>
                : <Field label="Order Number"><Input value={h.orderNumber} onChange={(e) => set('orderNumber', e.target.value)} /></Field>}
              <Field label={<span className="text-red-600">{kind === 'quotation' ? 'Quote Date*' : kind === 'proforma' ? 'Issue Date*' : 'Invoice Date*'}</span>}><Input type="date" value={h.issueDate} onChange={(e) => set('issueDate', e.target.value)} /></Field>
              {kind === 'quotation' ? (
                <Field label="Expiry Date"><Input type="date" value={h.secondDate} onChange={(e) => set('secondDate', e.target.value)} /></Field>
              ) : kind === 'proforma' ? (
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Valid Until" hint={!id && !h.secondDate ? 'Defaults to your document settings' : undefined}><Input type="date" value={h.secondDate} min={h.issueDate} onChange={(e) => set('secondDate', e.target.value)} /></Field>
                  <Field label="Payment Terms"><Select value={h.paymentTerms || 'DUE_ON_RECEIPT'} onChange={(e) => set('paymentTerms', e.target.value)}>{meta.data?.paymentTerms.filter((t) => t.code !== 'CUSTOM').map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}</Select></Field>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Terms"><Select value={h.paymentTerms || 'DUE_ON_RECEIPT'} onChange={(e) => set('paymentTerms', e.target.value)}>{meta.data?.paymentTerms.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}</Select></Field>
                  <Field label="Due Date"><Input type="date" value={dueDate} readOnly={h.paymentTerms !== 'CUSTOM'} className={cn(h.paymentTerms !== 'CUSTOM' && 'bg-slate-50')} onChange={(e) => set('secondDate', e.target.value)} /></Field>
                </div>
              )}
            </>
          )}
        </div>
        <div className="my-5 border-t border-line" />
        <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
          <Field label="Salesperson">
            <Select value={h.salespersonId} onChange={(e) => set('salespersonId', e.target.value)}><option value="">—</option>{members.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>
          </Field>
          <Field label={kind === 'recurring' ? 'Associate Project' : 'Project Name'} hint={!h.customerId ? 'Select a customer to associate a project.' : projectChoices.length ? undefined : 'There are no active projects for this customer.'}>
            <Select value={h.projectId} disabled={!h.customerId} onChange={(e) => set('projectId', e.target.value)}><option value="">Select a project</option>{projectChoices.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</Select>
          </Field>
          {kind === 'proforma' && <Field label="Project / Service Reference" className="lg:col-span-2"><Input value={h.serviceReference} onChange={(e) => set('serviceReference', e.target.value)} placeholder="e.g. Website redesign - phase 1" /></Field>}
          <Field label={<span className="flex items-center gap-1">Subject <Info className="size-3.5 text-slate-400" /></span>} className="lg:col-span-2" hint={`Let your customer know what this ${title.toLowerCase()} is for`}>
            <Textarea rows={2} value={h.subject} onChange={(e) => set('subject', e.target.value)} />
          </Field>
        </div>
      </Card>

      {/* Items */}
      <Card className="mb-6">
        <div className="flex items-center justify-between border-b border-line px-5 py-3"><h3 className="font-semibold">Item Table</h3>{exempt && <Badge tone="amber">Customer is tax exempt: GST set to 0%</Badge>}</div>
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="border-b border-line bg-slate-50/70 text-left text-xs uppercase tracking-wide text-muted">
              <tr><th className="w-6" /><th className="px-3 py-2">Item details</th><th className="w-24 px-3 py-2 text-right">Quantity</th><th className="w-32 px-3 py-2 text-right">Rate</th><th className="w-36 px-3 py-2 text-right">Discount</th><th className="w-44 px-3 py-2">Tax</th><th className="w-32 px-3 py-2 text-right">Amount</th><th className="w-10" /></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {lines.map((l, i) => (
                <tr key={i} className="align-top">
                  <td className="pl-2 pt-4 text-slate-300"><GripVertical className="size-4" /></td>
                  <td className="px-3 py-2"><ItemPicker value={l.description} products={products.data?.items ?? []} onText={(v) => setLine(i, { description: v, productId: null })} onPick={(p) => setLine(i, fromProduct(p))} />
                    <CodeTag kind={l.itemType} code={l.hsnSac} products={products.data?.items ?? []} onKind={(k) => setLine(i, { itemType: k })} onCode={(c) => setLine(i, { hsnSac: c, ...(c ? { itemType: kindFromCode(c) } : {}) })} />
                  </td>
                  <td className="px-3 py-2"><Input className="text-right" type="number" min={0} step="any" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></td>
                  <td className="px-3 py-2"><Input className="text-right" type="number" min={0} step="0.01" value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} /></td>
                  <td className="px-3 py-2">
                    <div className="flex">
                      {l.discountMode === 'PERCENT'
                        ? <Input className="rounded-r-none text-right" type="number" min={0} max={100} value={l.discountPct} onChange={(e) => setLine(i, { discountPct: e.target.value })} aria-label="Line discount percent" />
                        : <Input className="rounded-r-none text-right" type="number" min={0} step="0.01" value={l.discountAmount} onChange={(e) => setLine(i, { discountAmount: e.target.value })} aria-label="Line discount amount" />}
                      <Select className="w-14 rounded-l-none border-l-0 pr-5" value={l.discountMode} onChange={(e) => setLine(i, { discountMode: e.target.value as 'PERCENT' })} aria-label="Line discount type">
                        <option value="PERCENT">%</option><option value="AMOUNT">{currencyOf(cur).symbol}</option>
                      </Select>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {exempt ? <Select disabled value="0" aria-label="Tax"><option value="0">{zeroRated ? 'Zero rated' : 'Exempt'}</option></Select> : (
                      <Select value={l.taxRateId || (l.taxRate === '' ? '' : `saved:${l.taxRate}`)} onChange={(e) => pickTax(i, e.target.value)} aria-label="Tax" className={cn(!l.taxRateId && l.taxRate === '' && 'border-red-300')}>
                        {!l.taxRateId && l.taxRate === '' && <option value="">{taxOptions.isLoading ? 'Loading taxes…' : 'Select a tax'}</option>}
                        {/* A tax no longer offered (inactive, or saved before tax settings) stays selectable on the line that has it. */}
                        {(l.taxRateId ? !options.some((o) => o.id === l.taxRateId) : l.taxRate !== '') && (
                          <option value={l.taxRateId || `saved:${l.taxRate}`}>{taxLabel(l.taxName ?? 'GST', l.taxRate)} (as saved)</option>
                        )}
                        {options.map((o) => <option key={o.id} value={o.id}>{taxLabel(o.name, o.rate)}</option>)}
                      </Select>
                    )}
                    {l.taxComponents && !exempt && Number(l.taxRate) > 0 && <p className="mt-1 text-[11px] text-muted">{(interState ? l.taxComponents.inter : l.taxComponents.intra).map((x) => `${x.name} ${x.rate}%`).join(' + ')}</p>}
                  </td>
                  <td className="px-3 py-2 pt-4 text-right font-medium tabular-nums">{m(preview.amounts[i])}</td>
                  <td className="px-1 py-2"><Button variant="ghost" size="icon" className="size-8 text-slate-400 hover:text-red-600" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove line"><Trash2 /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid gap-6 border-t border-line p-5 lg:grid-cols-2">
          <div className="min-w-0 space-y-5">
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setLines([...lines, blankLine(defaultTax)])}><Plus /> Add New Row</Button>
              <Button variant="secondary" onClick={() => setBulk(true)}><ListPlus /> Add Items in Bulk</Button>
            </div>
            <Field label="Customer Notes" hint={`Will be displayed on the ${title.toLowerCase()}`}><Textarea rows={3} value={h.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Enter any notes to be displayed in your transaction" /></Field>
          </div>
          <div className="min-w-0 space-y-3 rounded-xl bg-slate-50 p-4 text-sm">
            <div className="flex justify-between font-semibold"><span>Sub Total</span><span className="tabular-nums">{m(preview.subtotal)}</span></div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="w-28">Discount</span>
              <div className="flex">
                <Input className="w-24 rounded-r-none text-right" type="number" min={0} value={h.discountValue} onChange={(e) => set('discountValue', e.target.value)} aria-label="Discount" />
                <Select className="w-16 rounded-l-none border-l-0 pr-6" value={h.discountType} onChange={(e) => set('discountType', e.target.value as 'PERCENT')} aria-label="Discount type"><option value="PERCENT">%</option><option value="AMOUNT">{currencyOf(cur).symbol}</option></Select>
              </div>
              <span className="ml-auto tabular-nums">{preview.docDiscount ? `- ${m(preview.docDiscount)}` : m(0)}</span>
            </div>
            {preview.breakdown.length > 0 && <div className="flex justify-between text-slate-600"><span>Taxable amount</span><span className="tabular-nums">{m(preview.taxableTotal)}</span></div>}
            {preview.breakdown.map((t) => (
              <div key={`${t.name}-${t.rate}`} className="flex justify-between text-slate-600"><span>{t.name} [{t.rate}%] <span className="text-xs text-muted">on {m(t.taxable)}</span></span><span className="tabular-nums">{m(t.amount)}</span></div>
            ))}
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5"><input type="radio" name="wh" checked={h.withholdingType !== 'TCS'} onChange={() => setH((x) => ({ ...x, withholdingType: x.withholdingType ? 'TDS' : '', withholdingRate: '' }))} /> TDS</label>
              {kind !== 'recurring' && <label className="flex items-center gap-1.5"><input type="radio" name="wh" checked={h.withholdingType === 'TCS'} onChange={() => setH((x) => ({ ...x, withholdingType: 'TCS', withholdingRate: '' }))} /> TCS</label>}
              <Select className="w-full sm:w-52" value={h.withholdingType ? h.withholdingRate : ''} aria-label="Withholding tax"
                onChange={(e) => setH((x) => ({ ...x, withholdingType: e.target.value ? (x.withholdingType === 'TCS' ? 'TCS' : 'TDS') : '', withholdingRate: e.target.value }))}>
                <option value="">Select a Tax</option>
                {(h.withholdingType === 'TCS' ? meta.data?.tcsRates : meta.data?.tdsRates)?.map((r) => <option key={r.label} value={r.rate}>{r.label}</option>)}
              </Select>
              <span className="ml-auto tabular-nums">{preview.withholdingAmount < 0 ? `- ${m(-preview.withholdingAmount)}` : m(preview.withholdingAmount)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Input className="w-28 border-dashed" value={h.adjustmentLabel} onChange={(e) => set('adjustmentLabel', e.target.value)} aria-label="Adjustment label" />
              <Input className="w-28 text-right" type="number" step="0.01" value={h.adjustment} onChange={(e) => set('adjustment', e.target.value)} aria-label="Adjustment amount" />
              <span className="ml-auto tabular-nums">{m(preview.adjustment)}</span>
            </div>
            {meta.data?.roundOff && <div className="flex justify-between text-slate-600"><span>Round Off</span><span className="tabular-nums">{m(preview.roundOff)}</span></div>}
            <div className="flex justify-between border-t border-line pt-3 text-base font-semibold"><span>Total ( {cur} {currencyOf(cur).symbol} )</span><span className="tabular-nums">{m(preview.total)}</span></div>
            {foreign && Number(h.exchangeRate) > 0 && <div className="flex justify-between text-xs text-muted"><span>In {base} at {h.exchangeRate}</span><span className="tabular-nums">{money(preview.total * Number(h.exchangeRate), base)}</span></div>}
          </div>
        </div>
      </Card>

      <Card className="mb-6 grid gap-6 p-5 lg:grid-cols-2">
        <Field label="Terms & Conditions" hint="Leave blank to use your default terms"><Textarea rows={5} value={h.terms} onChange={(e) => set('terms', e.target.value)} placeholder="Enter the terms and conditions of your business to be displayed in your transaction" /></Field>
        <div className="space-y-4">
          {(kind === 'invoice' || kind === 'proforma') && (
            <div>
              <p className="mb-2 text-sm font-medium">Email Communications {h.emailRecipients.length > 0 && <button className="ml-2 text-xs font-normal text-red-600" onClick={() => set('emailRecipients', [])}><X className="inline size-3" /> Clear Selection</button>}</p>
              <div className="flex flex-wrap gap-2">
                {[...new Set([...contactEmails, ...h.emailRecipients])].map((e) => (
                  <label key={e} className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm">
                    <Checkbox checked={h.emailRecipients.includes(e)} onCheckedChange={(v) => set('emailRecipients', v ? [...h.emailRecipients, e] : h.emailRecipients.filter((x) => x !== e))} />&lt;{e}&gt;
                  </label>
                ))}
                <form className="flex gap-1" onSubmit={(ev) => { ev.preventDefault(); if (/^\S+@\S+\.\S+$/.test(newEmail)) { set('emailRecipients', [...h.emailRecipients, newEmail]); setNewEmail(''); } }}>
                  <Input className="h-8 w-48" type="email" placeholder="Add new email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
                  <Button size="sm" variant="secondary" type="submit"><Plus /> Add New</Button>
                </form>
              </div>
            </div>
          )}
          {kind === 'recurring' && (
            <div>
              <p className="mb-2 text-sm font-medium">Preferences</p>
              <label className="flex items-center gap-3 text-sm"><Switch checked={h.createAs === 'SEND'} onCheckedChange={(v) => set('createAs', v ? 'SEND' : 'DRAFT')} disabled={!can('invoices.issue')} /> {h.createAs === 'SEND' ? 'Create invoices as sent (issued automatically)' : 'Create invoices as drafts'}</label>
              <p className="mt-1 text-xs text-muted">Invoices are generated on each scheduled date. Emailing them stays a manual step you review.</p>
            </div>
          )}
          <p className="text-xs text-muted">You can attach files after saving, from the document page.</p>
        </div>
      </Card>

      <div className="sticky bottom-0 z-20 -mx-4 border-t border-line bg-surface/95 backdrop-blur lg:-mx-8">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 lg:px-8">
          {kind === 'recurring' || sentDoc ? (
            <>
              <Button onClick={() => save('draft')} loading={saving === 'draft'}>{sentDoc ? 'Save changes' : 'Save'}</Button>
              {sentDoc && <Button variant="secondary" onClick={() => save('send')} loading={saving === 'send'}>Save and Resend</Button>}
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => save('draft')} loading={saving === 'draft'}>Save as Draft</Button>
              <Button onClick={() => save('send')} loading={saving === 'send'}>Save and Send</Button>
            </>
          )}
          <Button variant="ghost" onClick={() => navigate(-1)}>Cancel</Button>
          {kind === 'invoice' && !id && <Button variant="link" className="ml-2" onClick={makeRecurring}><Repeat className="size-4" /> Make Recurring</Button>}
          <span className="ml-auto text-sm text-muted">Total Amount: <strong className="text-ink tabular-nums">{m(preview.total)}</strong> · Total Quantity: {lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0)}</span>
        </div>
      </div>

      <ConvertAmountsDialog open={convertOpen} onOpenChange={setConvertOpen} from={cur} base={base} fromRate={foreign ? Number(h.exchangeRate) || 0 : 1}
        currencies={meta.data?.currencies ?? []} onApply={(to, r) => {
          const scale = (v: string) => (v === '' ? '' : String(Math.round(Number(v) * r * 100) / 100));
          const fromRate = foreign ? Number(h.exchangeRate) || 0 : 1;
          setLines((ls) => ls.map((l) => ({ ...l, rate: scale(l.rate) })));
          setH((x) => ({
            ...x, currency: to, exchangeRate: to === base ? '' : String(Math.round((fromRate / r) * 1e6) / 1e6),
            adjustment: scale(x.adjustment), discountValue: x.discountType === 'AMOUNT' ? scale(x.discountValue) : x.discountValue,
          }));
          toast.success(`Converted to ${to} at ${r}. Review and save.`);
        }} />
      <BulkItemsDialog open={bulk} onOpenChange={setBulk} products={products.data?.items ?? []}
        onAdd={(items) => setLines((ls) => [...ls.filter((l) => l.description.trim()), ...items.map(({ product, qty }) => ({ ...blankLine(defaultTax), ...fromProduct(product), quantity: String(qty) }))])} />
    </div>
  );
}
