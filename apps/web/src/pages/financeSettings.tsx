import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Coins, ImageOff, Landmark, PenLine, RefreshCw, Stamp, Trash2, Upload } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { cn, fmtDate, toDateInput } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, ConfirmDialog, Dialog, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Select, Switch, Table, TBody, TD, TH, THead } from '@/components/ui';

// ───────────────────────── Currency management ─────────────────────────

interface TenantCurrencyRow { code: string; name: string; symbol: string; decimals: number; enabled: boolean; isDefault: boolean; isBase: boolean; invoices: number; latestRate: number | null }
interface CurrencySettingsData { baseCurrency: string; defaultCurrency: string; currencies: TenantCurrencyRow[] }

export function CurrencySettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings-currencies'], queryFn: () => api.get<CurrencySettingsData>('/settings/currencies') });
  const [defaultCode, setDefaultCode] = useState('');
  const [rateFor, setRateFor] = useState<TenantCurrencyRow | null>(null);
  const [rate, setRate] = useState({ value: '', date: toDateInput(new Date()) });
  useEffect(() => { if (q.data) setDefaultCode(q.data.defaultCurrency); }, [q.data]);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['settings-currencies'] }); qc.invalidateQueries({ queryKey: ['finance-meta'] }); };
  const toggle = useAction(({ code, enabled }: { code: string; enabled: boolean }) => api.patch(`/settings/currencies/${code}`, { enabled }), { success: 'Currency updated', onSuccess: refresh });
  const saveDefault = useAction(() => api.put('/settings/default-currency', { code: defaultCode }), { success: 'Default currency saved. Existing documents are unchanged.', onSuccess: refresh });
  const saveRate = useAction(() => api.post('/settings/exchange-rates', { currency: rateFor!.code, rate: Number(rate.value), rateDate: rate.date }), { success: 'Exchange rate saved', onSuccess: () => { refresh(); setRateFor(null); } });

  if (q.isLoading) return <Card><LoadingBlock rows={8} /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>;
  const d = q.data;
  const base = d.currencies.find((c) => c.isBase);
  const enabled = d.currencies.filter((c) => c.enabled);

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader title="Currency management" description="Choose the currencies you invoice in and the one new quotes and invoices start with. Each document keeps its own currency." />

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-5">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700"><Coins className="size-5" /></span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Default currency</p>
              <p className="text-xs text-muted">Pre-selected on new quotes and invoices. Changing it never alters existing documents.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Select className="w-full sm:w-64" value={defaultCode} onChange={(e) => setDefaultCode(e.target.value)} aria-label="Default currency">
                  {enabled.map((c) => <option key={c.code} value={c.code}>{c.code} ({c.symbol}) · {c.name}</option>)}
                </Select>
                <Button onClick={() => saveDefault.mutate()} loading={saveDefault.isPending} disabled={defaultCode === d.defaultCurrency}>Save</Button>
                {defaultCode !== d.defaultCurrency && <Button variant="ghost" onClick={() => setDefaultCode(d.defaultCurrency)}>Cancel</Button>}
              </div>
            </div>
          </div>
        </Card>
        <Card className="p-5">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700"><Landmark className="size-5" /></span>
            <div>
              <p className="text-sm font-semibold">Base (reporting) currency: {d.baseCurrency} {base ? `(${base.symbol})` : ''}</p>
              <p className="text-xs text-muted">GST returns, reports and dashboards are stated in {d.baseCurrency}. Foreign-currency documents are converted at the exchange rate saved on each document. Tax always follows the customer's GST treatment and place of supply, not the currency.</p>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Currencies" description="Turn a currency off to hide it from new documents. Documents already in that currency keep it." />
        <div className="overflow-x-auto">
          <Table>
            <THead><tr><TH>Currency</TH><TH>Symbol</TH><TH className="text-right">Decimals</TH><TH className="text-right">Invoices</TH><TH>Latest rate to {d.baseCurrency}</TH><TH className="text-right">Active</TH></tr></THead>
            <TBody>
              {d.currencies.map((c) => (
                <tr key={c.code} className={cn(c.isDefault && 'bg-brand-50/50')}>
                  <TD>
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-12 shrink-0 items-center justify-center rounded-md border border-line bg-white text-xs font-bold tracking-wide">{c.code}</span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{c.name}</span>
                        <span className="flex gap-1">{c.isDefault && <Badge tone="blue">Default</Badge>}{c.isBase && <Badge tone="green">Base</Badge>}</span>
                      </span>
                    </div>
                  </TD>
                  <TD className="text-base">{c.symbol}</TD>
                  <TD className="text-right tabular-nums">{c.decimals}</TD>
                  <TD className="text-right tabular-nums">{c.invoices}</TD>
                  <TD>
                    {c.isBase ? <span className="text-xs text-muted">Always 1</span> : (
                      <span className="flex items-center gap-2">
                        <span className="tabular-nums text-sm">{c.latestRate ? `1 ${c.code} = ${c.latestRate.toLocaleString('en-IN', { maximumFractionDigits: 4 })} ${d.baseCurrency}` : <span className="text-muted">Not set</span>}</span>
                        <Button size="sm" variant="ghost" onClick={() => { setRateFor(c); setRate({ value: c.latestRate ? String(c.latestRate) : '', date: toDateInput(new Date()) }); }}><RefreshCw /> {c.latestRate ? 'Update' : 'Set'}</Button>
                      </span>
                    )}
                  </TD>
                  <TD className="text-right">
                    <Switch checked={c.enabled} disabled={(c.isDefault || c.isBase) && c.enabled} onCheckedChange={(v) => toggle.mutate({ code: c.code, enabled: v })} />
                  </TD>
                </tr>
              ))}
            </TBody>
          </Table>
        </div>
        <p className="border-t border-line px-5 py-3 text-xs text-muted">More currencies can be added to the catalog by the platform administrator; they appear here to switch on.</p>
      </Card>

      <ExchangeRateHistory base={d.baseCurrency} />

      <Dialog open={!!rateFor} onOpenChange={(v) => !v && setRateFor(null)} title={`Exchange rate for ${rateFor?.code ?? ''}`}
        description={`Used as the default rate for new ${rateFor?.code ?? ''} documents. Documents already created keep their own rate.`}
        footer={<><Button variant="secondary" onClick={() => setRateFor(null)}>Cancel</Button><Button onClick={() => saveRate.mutate()} loading={saveRate.isPending} disabled={!(Number(rate.value) > 0)}>Save rate</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={`1 ${rateFor?.code ?? ''} equals (${d.baseCurrency})`} required><Input type="number" min={0} step="0.0001" value={rate.value} onChange={(e) => setRate({ ...rate, value: e.target.value })} /></Field>
          <Field label="Rate date"><Input type="date" value={rate.date} onChange={(e) => setRate({ ...rate, date: e.target.value })} /></Field>
        </div>
      </Dialog>
    </div>
  );
}

function ExchangeRateHistory({ base }: { base: string }) {
  const q = useQuery({ queryKey: ['exchange-rates'], queryFn: () => api.get<{ id: string; currencyCode: string; rate: string; rateDate: string; source: string }[]>('/settings/exchange-rates') });
  return (
    <Card>
      <CardHeader title="Exchange rate history" description="Rates entered on documents, in conversions and here (latest 50)." />
      {q.isLoading ? <LoadingBlock rows={3} /> : !q.data?.length ? <EmptyState title="No rates recorded yet" description="A rate is saved the first time you create a document in a foreign currency." /> : (
        <Table><THead><tr><TH>Date</TH><TH>Currency</TH><TH className="text-right">Rate to {base}</TH><TH>Source</TH></tr></THead><TBody>
          {q.data.map((r) => <tr key={r.id}><TD>{fmtDate(r.rateDate)}</TD><TD className="font-medium">{r.currencyCode}</TD><TD className="text-right tabular-nums">{Number(r.rate).toLocaleString('en-IN', { maximumFractionDigits: 6 })}</TD><TD className="capitalize text-slate-600">{r.source}</TD></tr>)}
        </TBody></Table>
      )}
    </Card>
  );
}

// ───────────────────────── Company seal & authorized signature ─────────────────────────

interface Authorization {
  companyName: string; sealFileId: string | null; signatureFileId: string | null; signatoryName: string | null; signatoryDesignation: string | null;
  showSignatureOnInvoice: boolean; showSealOnInvoice: boolean; showSignatureOnQuote: boolean; showSealOnQuote: boolean;
}
type Toggles = Pick<Authorization, 'showSignatureOnInvoice' | 'showSealOnInvoice' | 'showSignatureOnQuote' | 'showSealOnQuote'>;

/** Loads a private seal/signature image (authenticated) as an object URL. */
function useAuthImage(kind: 'seal' | 'signature', fileId: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!fileId) { setUrl(null); return; }
    let revoked = false; let current: string | null = null;
    api.objectUrl(`/settings/authorization/${kind}/image`).then((u) => { if (revoked) URL.revokeObjectURL(u); else { current = u; setUrl(u); } }).catch(() => setUrl(null));
    return () => { revoked = true; if (current) URL.revokeObjectURL(current); };
  }, [kind, fileId]);
  return url;
}

function ImageCard({ kind, fileId, onChanged }: { kind: 'seal' | 'signature'; fileId: string | null; onChanged: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const url = useAuthImage(kind, fileId);
  const [confirm, setConfirm] = useState(false);
  const label = kind === 'seal' ? 'Company seal' : 'Authorized signature';
  const upload = useAction(async (file: File) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Upload a PNG, JPG or WebP image');
    if (file.size > 2 * 1024 * 1024) throw new Error('The image must be 2 MB or smaller');
    const fd = new FormData(); fd.append('file', file);
    return api.post(`/settings/authorization/${kind}`, fd);
  }, { success: `${label} uploaded`, onSuccess: onChanged });
  const remove = useAction(() => api.delete(`/settings/authorization/${kind}`), { success: `${label} removed`, onSuccess: () => { setConfirm(false); onChanged(); } });
  return (
    <div className="flex flex-col rounded-xl border border-line bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-full bg-brand-50 text-brand-700 [&_svg]:size-4">{kind === 'seal' ? <Stamp /> : <PenLine />}</span>
        <div><p className="text-sm font-semibold">{label}</p><p className="text-xs text-muted">{kind === 'seal' ? 'Transparent PNG recommended' : 'Signature on a transparent background'}</p></div>
      </div>
      <div className={cn('flex h-36 items-center justify-center rounded-lg border border-dashed border-line', 'bg-[length:16px_16px] bg-[linear-gradient(45deg,#f1f5f9_25%,transparent_25%),linear-gradient(-45deg,#f1f5f9_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#f1f5f9_75%),linear-gradient(-45deg,transparent_75%,#f1f5f9_75%)] bg-[position:0_0,0_8px,8px_-8px,-8px_0]')}>
        {url ? <img src={url} alt={label} className="max-h-32 max-w-[90%] object-contain" /> : <span className="flex flex-col items-center gap-1 text-xs text-muted"><ImageOff className="size-5" /> Not uploaded</span>}
      </div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => input.current?.click()} loading={upload.isPending}><Upload /> {fileId ? 'Replace' : 'Upload'}</Button>
        {fileId && <Button size="sm" variant="ghost" className="text-red-600" onClick={() => setConfirm(true)}><Trash2 /> Remove</Button>}
      </div>
      <p className="mt-2 text-[11px] text-muted">PNG, JPG or WebP, up to 2 MB. Converted to PNG for PDFs.</p>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Remove the ${label.toLowerCase()}?`} danger confirmLabel="Remove" loading={remove.isPending} onConfirm={() => remove.mutate()}
        description="New documents will no longer show it. Documents already sent keep the version they were sent with." />
    </div>
  );
}

export function AuthorizationSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['authorization'], queryFn: () => api.get<Authorization>('/settings/authorization') });
  const [f, setF] = useState<Partial<Authorization>>({});
  useEffect(() => { if (q.data) setF(q.data); }, [q.data]);
  const dirty = !!q.data && (['signatoryName', 'signatoryDesignation', 'showSignatureOnInvoice', 'showSealOnInvoice', 'showSignatureOnQuote', 'showSealOnQuote'] as const).some((k) => (f[k] ?? null) !== (q.data![k] ?? null));
  const save = useAction(() => api.patch('/settings/authorization', {
    signatoryName: f.signatoryName ?? '', signatoryDesignation: f.signatoryDesignation ?? '',
    showSignatureOnInvoice: f.showSignatureOnInvoice, showSealOnInvoice: f.showSealOnInvoice, showSignatureOnQuote: f.showSignatureOnQuote, showSealOnQuote: f.showSealOnQuote,
  }), { success: 'Authorization details saved', invalidate: [['authorization']] });
  const refresh = () => qc.invalidateQueries({ queryKey: ['authorization'] });
  if (q.isLoading) return <Card><LoadingBlock rows={5} /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>;
  const toggle = (k: keyof Toggles, label: string) => (
    <label className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5 text-sm">
      <span>{label}</span><Switch checked={!!f[k]} onCheckedChange={(v) => setF({ ...f, [k]: v })} />
    </label>
  );
  return (
    <Card>
      <CardHeader title="Branding & authorization" description="Company seal and authorized signature printed on quotes and invoices. Only administrators can change them." />
      <div className="space-y-6 p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <ImageCard kind="seal" fileId={q.data.sealFileId} onChanged={refresh} />
          <ImageCard kind="signature" fileId={q.data.signatureFileId} onChanged={refresh} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Authorized person"><Input value={f.signatoryName ?? ''} onChange={(e) => setF({ ...f, signatoryName: e.target.value })} placeholder="Full name" maxLength={120} /></Field>
          <Field label="Designation"><Input value={f.signatoryDesignation ?? ''} onChange={(e) => setF({ ...f, signatoryDesignation: e.target.value })} placeholder="e.g. Director" maxLength={120} /></Field>
          <Field label="Company" hint="From your legal name"><Input value={q.data.companyName} disabled /></Field>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2"><p className="text-xs font-semibold uppercase tracking-wide text-muted">Invoices</p>{toggle('showSignatureOnInvoice', 'Show signature')}{toggle('showSealOnInvoice', 'Show seal')}</div>
          <div className="space-y-2"><p className="text-xs font-semibold uppercase tracking-wide text-muted">Quotes</p>{toggle('showSignatureOnQuote', 'Show signature')}{toggle('showSealOnQuote', 'Show seal')}</div>
        </div>
        <SignaturePreview a={{ ...q.data, ...f } as Authorization} />
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}><BadgeCheck /> Save details</Button>
          <Button variant="ghost" onClick={() => setF(q.data!)} disabled={!dirty}>Cancel</Button>
          <p className="text-xs text-muted sm:ml-auto">Sent invoices and quotes keep the details they were sent with.</p>
        </div>
      </div>
    </Card>
  );
}

function SignaturePreview({ a }: { a: Authorization }) {
  const seal = useAuthImage('seal', a.sealFileId);
  const sign = useAuthImage('signature', a.signatureFileId);
  const nothing = !a.sealFileId && !a.signatureFileId && !a.signatoryName;
  return (
    <div className="rounded-xl bg-slate-50 p-4">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Invoice preview</p>
      {nothing ? <p className="text-sm text-muted">Nothing is printed until you add a name, seal or signature, so documents don't show an empty block.</p> : (
        <div className="ml-auto w-full max-w-xs rounded-lg border border-line bg-white p-4 text-right">
          <p className="text-sm font-semibold">For {a.companyName}</p>
          <div className="my-2 flex h-20 items-center justify-end gap-3">
            {a.showSealOnInvoice && seal && <img src={seal} alt="" className="max-h-20 max-w-20 object-contain" />}
            {a.showSignatureOnInvoice && sign && <img src={sign} alt="" className="max-h-16 max-w-36 object-contain" />}
          </div>
          <div className="border-t border-line pt-1.5">
            <p className="text-xs font-semibold">Authorized Signatory</p>
            {(a.signatoryName || a.signatoryDesignation) && <p className="text-xs text-muted">{[a.signatoryName, a.signatoryDesignation].filter(Boolean).join(', ')}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Platform: currency catalog ─────────────────────────

interface CatalogRow { code: string; name: string; symbol: string; decimals: number; isActive: boolean; sortOrder: number; tenantsUsing: number }

export function PlatformCurrencies() {
  const q = useQuery({ queryKey: ['platform-currencies'], queryFn: () => api.get<CatalogRow[]>('/platform/currencies') });
  const [edit, setEdit] = useState<(Partial<CatalogRow> & { isNew?: boolean }) | null>(null);
  const save = useAction(() => {
    const body = { name: edit!.name, symbol: edit!.symbol, decimals: Number(edit!.decimals ?? 2), sortOrder: Number(edit!.sortOrder ?? 100), isActive: edit!.isActive ?? true };
    return edit!.isNew ? api.post('/platform/currencies', { ...body, code: edit!.code }) : api.patch(`/platform/currencies/${edit!.code}`, body);
  }, { success: 'Currency saved', invalidate: [['platform-currencies']], onSuccess: () => setEdit(null) });
  const toggle = useAction((c: CatalogRow) => api.patch(`/platform/currencies/${c.code}`, { isActive: !c.isActive }), { success: 'Currency updated', invalidate: [['platform-currencies']] });
  return (
    <div className="max-w-5xl">
      <PageHeader title="Currency catalog" description="Currencies every organization can switch on. Organizations choose their own default." actions={<Button onClick={() => setEdit({ isNew: true, decimals: 2, sortOrder: 100, isActive: true })}>Add currency</Button>} />
      <Card>
        {q.isLoading ? <LoadingBlock /> : q.error ? <ErrorState error={q.error} /> : (
          <Table><THead><tr><TH>Code</TH><TH>Name</TH><TH>Symbol</TH><TH className="text-right">Decimals</TH><TH className="text-right">Organizations</TH><TH>Status</TH><TH /></tr></THead><TBody>
            {q.data!.map((c) => (
              <tr key={c.code}>
                <TD className="font-semibold">{c.code}</TD><TD>{c.name}</TD><TD>{c.symbol}</TD><TD className="text-right">{c.decimals}</TD><TD className="text-right">{c.tenantsUsing}</TD>
                <TD>{c.isActive ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</TD>
                <TD className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" onClick={() => setEdit(c)}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => toggle.mutate(c)}>{c.isActive ? 'Deactivate' : 'Activate'}</Button>
                </TD>
              </tr>
            ))}
          </TBody></Table>
        )}
      </Card>
      <Dialog open={!!edit} onOpenChange={(v) => !v && setEdit(null)} title={edit?.isNew ? 'Add currency' : `Edit ${edit?.code ?? ''}`}
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!edit?.code || !edit?.name || !edit?.symbol}>Save</Button></>}>
        {edit && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="ISO code" required hint="3 letters, e.g. JPY"><Input value={edit.code ?? ''} disabled={!edit.isNew} maxLength={3} className="uppercase" onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} /></Field>
            <Field label="Name" required><Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Symbol" required><Input value={edit.symbol ?? ''} maxLength={6} onChange={(e) => setEdit({ ...edit, symbol: e.target.value })} /></Field>
            <Field label="Decimal places"><Select value={String(edit.decimals ?? 2)} onChange={(e) => setEdit({ ...edit, decimals: Number(e.target.value) })}><option value="2">2</option><option value="1">1</option><option value="0">0</option></Select></Field>
            <Field label="Sort order"><Input type="number" value={edit.sortOrder ?? 100} onChange={(e) => setEdit({ ...edit, sortOrder: Number(e.target.value) })} /></Field>
          </div>
        )}
      </Dialog>
    </div>
  );
}

