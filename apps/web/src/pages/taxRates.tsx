import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Plus, Power, PowerOff, Trash2, X } from 'lucide-react';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { TaxComponent, TaxComponents, TaxRate } from '@/lib/types';
import { cn, fmtDate, num, toDateInput } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, ConfirmDialog, Dialog, EmptyState, ErrorState, Field, Input, LoadingBlock, Select, Table, TBody, TD, TH, THead, Textarea } from '@/components/ui';

// Settings → Tax Settings: the tenant's tax configurations offered on quotation, proforma and invoice lines.

interface TaxMeta { taxTypes: { code: string; label: string }[] }
const ZERO_TYPES = ['EXEMPT', 'NIL_RATED', 'ZERO_RATED'];

/** Default component split for a type and rate (the server applies the same default). */
function defaultSplit(type: string, rate: number): TaxComponents {
  if (ZERO_TYPES.includes(type) || rate <= 0) return { intra: [], inter: [] };
  if (type === 'IGST') return { intra: [{ name: 'IGST', rate }], inter: [{ name: 'IGST', rate }] };
  if (type === 'CUSTOM') return { intra: [{ name: 'TAX', rate }], inter: [{ name: 'TAX', rate }] };
  return { intra: [{ name: 'CGST', rate: rate / 2 }, { name: 'SGST', rate: rate / 2 }], inter: [{ name: 'IGST', rate }] };
}
const sum = (l: TaxComponent[]) => Math.round(l.reduce((s, c) => s + (Number(c.rate) || 0), 0) * 100) / 100;
const describe = (l: TaxComponent[]) => (l.length ? l.map((c) => `${c.name} ${c.rate}%`).join(' + ') : 'No tax');

type Form = {
  id?: string; name: string; code: string; taxType: string; rate: string; jurisdiction: string; description: string;
  effectiveFrom: string; effectiveUntil: string; sortOrder: string; split: TaxComponents; customSplit: boolean;
};
const blank = (): Form => ({ name: '', code: '', taxType: 'GST', rate: '', jurisdiction: 'IN', description: '', effectiveFrom: toDateInput(new Date()), effectiveUntil: '', sortOrder: '100', split: { intra: [], inter: [] }, customSplit: false });
const fromRate = (t: TaxRate): Form => ({
  id: t.id, name: t.name, code: t.code, taxType: t.taxType, rate: String(num(t.rate)), jurisdiction: t.jurisdiction, description: t.description ?? '',
  effectiveFrom: toDateInput(t.effectiveFrom), effectiveUntil: t.effectiveUntil ? toDateInput(t.effectiveUntil) : '', sortOrder: String(t.sortOrder),
  split: t.components, customSplit: JSON.stringify(t.components) !== JSON.stringify(defaultSplit(t.taxType, num(t.rate))),
});

function ComponentRows({ label, hint, list, onChange }: { label: string; hint: string; list: TaxComponent[]; onChange: (l: TaxComponent[]) => void }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label} <span className="font-normal text-muted">· {hint}</span></p>
      {list.map((c, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input className="w-32 uppercase" value={c.name} onChange={(e) => onChange(list.map((x, j) => (j === i ? { ...x, name: e.target.value.toUpperCase() } : x)))} aria-label={`${label} component name`} />
          <Input className="w-24 text-right" type="number" min={0} max={100} step="0.01" value={c.rate} onChange={(e) => onChange(list.map((x, j) => (j === i ? { ...x, rate: e.target.value as unknown as number } : x)))} aria-label={`${label} component rate`} />
          <span className="text-sm text-muted">%</span>
          <Button variant="ghost" size="icon" className="size-8 text-slate-400 hover:text-red-600" onClick={() => onChange(list.filter((_, j) => j !== i))} aria-label="Remove component"><X /></Button>
        </div>
      ))}
      {list.length < 6 && <Button variant="link" size="sm" className="px-0" onClick={() => onChange([...list, { name: '', rate: 0 }])}><Plus className="size-3.5" /> Add component</Button>}
    </div>
  );
}

function TaxRateDialog({ open, onOpenChange, initial, types }: { open: boolean; onOpenChange: (v: boolean) => void; initial: Form; types: TaxMeta['taxTypes'] }) {
  const [f, setF] = useState<Form>(initial);
  const [error, setError] = useState<string | null>(null);
  // Reset when a different row (or a new one) is opened.
  const key = `${initial.id ?? 'new'}-${open}`;
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) { setLastKey(key); setF(initial); setError(null); }
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const rate = Number(f.rate) || 0;
  const zero = ZERO_TYPES.includes(f.taxType);
  const split = f.customSplit ? f.split : defaultSplit(f.taxType, rate);
  const mismatch = !zero && f.customSplit && (sum(split.intra) !== rate || sum(split.inter) !== rate);
  const save = useAction(async () => {
    const body = {
      name: f.name.trim(), code: f.code.trim().toUpperCase(), taxType: f.taxType, rate: zero ? 0 : rate, jurisdiction: f.jurisdiction.trim() || 'IN',
      description: f.description.trim() || null, effectiveFrom: f.effectiveFrom || undefined, effectiveUntil: f.effectiveUntil || null, sortOrder: Number(f.sortOrder) || 100,
      components: zero ? { intra: [], inter: [] } : { intra: split.intra.map((c) => ({ name: c.name, rate: Number(c.rate) })), inter: split.inter.map((c) => ({ name: c.name, rate: Number(c.rate) })) },
    };
    return f.id ? api.patch(`/tax-rates/${f.id}`, body) : api.post('/tax-rates', body);
  }, { success: f.id ? 'Tax updated' : 'Tax added', invalidate: [['tax-rates'], ['tax-options']], onSuccess: () => onOpenChange(false) });
  const submit = () => {
    setError(null);
    if (!f.name.trim() || !f.code.trim()) { setError('Enter a name and a code.'); return; }
    if (!zero && !(rate > 0)) { setError('Enter a rate above 0%, or choose Exempt / Nil rated / Zero rated.'); return; }
    if (mismatch) { setError(`Each component list must add up to ${rate}%.`); return; }
    save.mutate(undefined, { onError: (e) => { const fe = e instanceof ApiError ? e.details?.fieldErrors : undefined; setError(fe ? Object.entries(fe).map(([k, v]) => `${k}: ${v[0]}`).join(' · ') : errorMessage(e)); } });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg" title={f.id ? `Edit ${initial.name}` : 'Add tax'}
      description={f.id ? 'Changes apply to new documents and edits. Documents already saved keep the tax they were created with.' : 'The new tax is offered on quotation, proforma and invoice lines from its effective date.'}
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={submit} loading={save.isPending}>Save</Button></>}>
      <div className="space-y-4">
        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</div>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tax name" required><Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="GST 18%" autoFocus /></Field>
          <Field label="Code" required hint="Unique, e.g. GST18"><Input className="uppercase" value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase())} /></Field>
          <Field label="Type" required>
            <Select value={f.taxType} onChange={(e) => setF((x) => ({ ...x, taxType: e.target.value, customSplit: false, ...(ZERO_TYPES.includes(e.target.value) ? { rate: '0' } : {}) }))}>
              {types.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
            </Select>
          </Field>
          <Field label="Rate (%)" required><Input type="number" min={0} max={100} step="0.01" value={zero ? '0' : f.rate} disabled={zero} onChange={(e) => set('rate', e.target.value)} /></Field>
          <Field label="Effective from"><Input type="date" value={f.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} /></Field>
          <Field label="Effective until" hint="Optional"><Input type="date" value={f.effectiveUntil} min={f.effectiveFrom} onChange={(e) => set('effectiveUntil', e.target.value)} /></Field>
          <Field label="Jurisdiction" hint="Country or region code"><Input className="uppercase" value={f.jurisdiction} onChange={(e) => set('jurisdiction', e.target.value.toUpperCase())} /></Field>
          <Field label="Sort order" hint="Lower numbers are listed first"><Input type="number" min={0} value={f.sortOrder} onChange={(e) => set('sortOrder', e.target.value)} /></Field>
          <Field label="Description" className="sm:col-span-2"><Textarea rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
        </div>
        {!zero && (
          <div className="rounded-lg border border-line p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold">Components</p>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={f.customSplit} onChange={(e) => setF((x) => ({ ...x, customSplit: e.target.checked, split: defaultSplit(x.taxType, rate) }))} /> Customise the split
              </label>
            </div>
            {!f.customSplit ? (
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                <div><dt className="text-muted">Within your state</dt><dd>{describe(split.intra)}</dd></div>
                <div><dt className="text-muted">Other states / exports</dt><dd>{describe(split.inter)}</dd></div>
              </dl>
            ) : (
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <ComponentRows label="Within your state" hint={`adds up to ${sum(split.intra)}%`} list={split.intra} onChange={(l) => set('split', { ...split, intra: l })} />
                <ComponentRows label="Other states" hint={`adds up to ${sum(split.inter)}%`} list={split.inter} onChange={(l) => set('split', { ...split, inter: l })} />
              </div>
            )}
            {mismatch && <p className="mt-2 text-xs text-red-600">Each list must add up to {rate}%.</p>}
            <p className="mt-2 text-xs text-muted">Components named CGST, SGST and IGST are reported in those GST columns; any other component (for example CESS) is shown separately and included in the total.</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function TaxRatesManager() {
  const rates = useQuery({ queryKey: ['tax-rates'], queryFn: () => api.get<TaxRate[]>('/tax-rates') });
  const meta = useQuery({ queryKey: ['tax-rates-meta'], staleTime: Infinity, queryFn: () => api.get<TaxMeta>('/tax-rates/meta') });
  const [editing, setEditing] = useState<Form | null>(null);
  const [removing, setRemoving] = useState<TaxRate | null>(null);
  const [showInactive, setShowInactive] = useState(true);
  const invalidate = [['tax-rates'], ['tax-options']];
  const toggle = useAction((t: TaxRate) => api.post(`/tax-rates/${t.id}/${t.isActive ? 'deactivate' : 'activate'}`), { success: (r) => ((r as TaxRate).isActive ? 'Tax activated' : 'Tax deactivated'), invalidate });
  const remove = useAction((t: TaxRate) => api.delete(`/tax-rates/${t.id}`), { success: 'Tax deleted', invalidate, onSuccess: () => setRemoving(null) });
  const typeLabel = useMemo(() => Object.fromEntries((meta.data?.taxTypes ?? []).map((t) => [t.code, t.label.split(' (')[0]])), [meta.data]);
  const list = (rates.data ?? []).filter((t) => showInactive || t.isActive);
  const today = new Date();
  return (
    <Card>
      <CardHeader title="Tax rates" description="Offered in the tax dropdown on quotation, proforma and invoice lines. Saved documents keep their original tax even if you change or deactivate a rate."
        actions={<Button size="sm" onClick={() => setEditing(blank())} disabled={!meta.data}><Plus /> Add tax</Button>} />
      <div className="flex items-center justify-end gap-2 border-b border-line px-5 py-2 text-sm">
        <label className="flex items-center gap-2 text-muted"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive</label>
      </div>
      {rates.isLoading ? <LoadingBlock rows={4} /> : rates.error ? <ErrorState error={rates.error} /> : !list.length ? <EmptyState title="No tax rates" description="Add the taxes your business charges." /> : (
        <div className="scrollbar-thin overflow-x-auto">
          <Table><THead><tr><TH>Name</TH><TH>Code</TH><TH>Type</TH><TH className="text-right">Rate</TH><TH>Components</TH><TH>Effective</TH><TH>Status</TH><TH className="w-32" /></tr></THead><TBody>
            {list.map((t) => {
              const notYet = new Date(t.effectiveFrom) > today;
              const ended = !!t.effectiveUntil && new Date(t.effectiveUntil) < today;
              return (
                <tr key={t.id} className={cn(!t.isActive && 'text-slate-400')}>
                  <TD className="font-medium">{t.name}{t.description && <span className="block text-xs font-normal text-muted">{t.description}</span>}</TD>
                  <TD className="font-mono text-xs">{t.code}</TD>
                  <TD className="text-sm">{typeLabel[t.taxType] ?? t.taxType}</TD>
                  <TD className="text-right tabular-nums">{num(t.rate)}%</TD>
                  <TD className="text-xs text-slate-600"><span className="block">In state: {describe(t.components.intra)}</span><span className="block">Inter-state: {describe(t.components.inter)}</span></TD>
                  <TD className="whitespace-nowrap text-xs text-slate-600">{fmtDate(t.effectiveFrom)}{t.effectiveUntil ? ` – ${fmtDate(t.effectiveUntil)}` : ' onwards'}</TD>
                  <TD>{!t.isActive ? <Badge>Inactive</Badge> : notYet ? <Badge tone="blue">Scheduled</Badge> : ended ? <Badge tone="amber">Ended</Badge> : <Badge tone="green">Active</Badge>}
                    {!!t.usage && <span className="mt-1 block text-[11px] text-muted">Used on {t.usage} line{t.usage === 1 ? '' : 's'}</span>}</TD>
                  <TD className="py-1 text-right">
                    <Button variant="ghost" size="icon" className="size-8" title="Edit" aria-label={`Edit ${t.name}`} onClick={() => setEditing(fromRate(t))}><Pencil /></Button>
                    <Button variant="ghost" size="icon" className="size-8" title={t.isActive ? 'Deactivate' : 'Activate'} aria-label={`${t.isActive ? 'Deactivate' : 'Activate'} ${t.name}`} onClick={() => toggle.mutate(t)}>{t.isActive ? <PowerOff /> : <Power />}</Button>
                    <Button variant="ghost" size="icon" className="size-8 text-slate-400 hover:text-red-600" title={t.usage ? 'In use: deactivate it instead' : 'Delete'} aria-label={`Delete ${t.name}`} disabled={!!t.usage} onClick={() => setRemoving(t)}><Trash2 /></Button>
                  </TD>
                </tr>
              );
            })}
          </TBody></Table>
        </div>
      )}
      {editing && meta.data && <TaxRateDialog open={!!editing} onOpenChange={(v) => !v && setEditing(null)} initial={editing} types={meta.data.taxTypes} />}
      <ConfirmDialog open={!!removing} onOpenChange={(v) => !v && setRemoving(null)} title={`Delete ${removing?.name ?? ''}?`} danger confirmLabel="Delete" loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)} description="This tax is not used on any document, so it can be removed. Taxes in use can only be deactivated." />
    </Card>
  );
}
