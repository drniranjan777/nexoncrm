import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowRightLeft, Copy, Info, Plus, Sparkles, Target, Trash2, Upload, Wand2 } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useList, useMembers, memberName } from '@/lib/hooks';
import type { Activity, Lead, ScoreDetails, Task } from '@/lib/types';
import { cn, fmtDate, inr, inrCompact, titleCase, toDateInput } from '@/lib/utils';
import {
  Badge, Button, Card, CardHeader, Checkbox, ConfirmDialog, DescList, Dialog, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Pagination,
  SearchInput, Select, StatusBadge, Table, TBody, TD, TH, THead, Toolbar, TR, Textarea, Switch,
} from '@/components/ui';
import { ActivityTimeline, AssigneeSelect, CsvImportDialog, ExportButton, LogActivityDialog } from '@/components/shared';

export const STAGES = ['NEW', 'CONTACTED', 'QUALIFIED', 'MEETING_SCHEDULED', 'PROPOSAL_SENT', 'NEGOTIATION', 'WON', 'LOST', 'ON_HOLD'];
export const SERVICES = ['SEO and Digital Marketing', 'Website Design and Development', 'WordPress Development', 'Shopify Development', 'eCommerce', 'Mobile App Development', 'Custom Software', 'AI/ML', 'Website Maintenance', 'Other'];
const SOURCES = ['Website', 'Referral', 'Google Ads', 'LinkedIn', 'Instagram', 'Facebook', 'Trade show', 'Cold outreach', 'Partner', 'Other'];

const priorityTone = (score: number) => (score >= 75 ? 'red' : score >= 55 ? 'amber' : score >= 35 ? 'blue' : 'gray');
export function ScorePill({ score }: { score: number }) {
  return <Badge tone={priorityTone(score)} className="tabular-nums">{score}</Badge>;
}

type LeadForm = Partial<Omit<Lead, 'estimatedValue'>> & { estimatedValue?: string | number | null };

function LeadFormDialog({ open, onOpenChange, lead, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; lead?: Lead; onSaved?: (l: Lead) => void }) {
  const [f, setF] = useState<LeadForm>({});
  const [dupes, setDupes] = useState<{ leads: { id: string; name: string; company: string | null; stage: string }[]; customers: { id: string; name: string; code: string }[] } | null>(null);
  useEffect(() => {
    if (open) { setF(lead ? { ...lead, expectedDecisionAt: toDateInput(lead.expectedDecisionAt), nextFollowUpAt: toDateInput(lead.nextFollowUpAt) } : { stage: 'NEW' }); setDupes(null); }
  }, [open, lead]);
  // Duplicate detection while creating
  useEffect(() => {
    if (lead || !open || (!f.email && !f.phone && !f.company)) return;
    const t = setTimeout(() => {
      api.get<NonNullable<typeof dupes>>('/leads/duplicates', { email: f.email ?? undefined, phone: f.phone ?? undefined, company: f.company ?? undefined }).then(setDupes).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [f.email, f.phone, f.company, lead, open]);
  const set = (k: keyof LeadForm) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(() => {
    const body = { ...f, estimatedValue: f.estimatedValue === '' || f.estimatedValue == null ? null : Number(f.estimatedValue) };
    delete (body as Record<string, unknown>).scoreDetails;
    return lead ? api.patch<Lead>(`/leads/${lead.id}`, body) : api.post<Lead>('/leads', body);
  }, { success: lead ? 'Lead updated' : 'Lead created', invalidate: [['/leads'], ['lead'], ['/leads/pipeline'], ['/tasks']], onSuccess: (l) => { onOpenChange(false); onSaved?.(l); } });
  const hasDupes = !!(dupes && (dupes.leads.length || dupes.customers.length));
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={lead ? 'Edit lead' : 'New lead'} size="lg"
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!f.name}>Save lead</Button></>}>
      {hasDupes && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <p className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4" /> Possible duplicates</p>
          <ul className="mt-1 list-disc pl-6">
            {dupes!.leads.map((d) => <li key={d.id}><Link className="underline" to={`/leads/${d.id}`} target="_blank">{d.name}{d.company && ` (${d.company})`}</Link> · lead, {titleCase(d.stage)}</li>)}
            {dupes!.customers.map((d) => <li key={d.id}><Link className="underline" to={`/customers/${d.id}`} target="_blank">{d.name}</Link> · existing customer {d.code}</li>)}
          </ul>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" required><Input value={f.name ?? ''} onChange={set('name')} /></Field>
        <Field label="Company"><Input value={f.company ?? ''} onChange={set('company')} /></Field>
        <Field label="Email"><Input type="email" value={f.email ?? ''} onChange={set('email')} /></Field>
        <Field label="Phone"><Input value={f.phone ?? ''} onChange={set('phone')} /></Field>
        <Field label="Lead source"><Select value={f.source ?? ''} onChange={set('source')}><option value="">—</option>{SOURCES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
        <Field label="Service interest"><Select value={f.serviceInterest ?? ''} onChange={set('serviceInterest')}><option value="">—</option>{SERVICES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
        <Field label="Budget range"><Select value={f.budgetRange ?? ''} onChange={set('budgetRange')}><option value="">—</option>{['Under 50k', '50k-1 Lakh', '1-2 Lakh', '2-5 Lakh', '5-10 Lakh', '10 Lakh+'].map((s) => <option key={s}>{s}</option>)}</Select></Field>
        <Field label="Estimated deal value (₹)"><Input type="number" min={0} value={f.estimatedValue ?? ''} onChange={set('estimatedValue')} /></Field>
        <Field label="Expected decision date"><Input type="date" value={(f.expectedDecisionAt as string) ?? ''} onChange={set('expectedDecisionAt')} /></Field>
        <Field label="Next follow-up"><Input type="date" value={(f.nextFollowUpAt as string) ?? ''} onChange={set('nextFollowUpAt')} /></Field>
        <Field label="Stage"><Select value={f.stage ?? 'NEW'} onChange={set('stage')}>{STAGES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select></Field>
        <Field label="Assigned salesperson"><AssigneeSelect value={f.assignedToId} onChange={(v) => setF({ ...f, assignedToId: v })} /></Field>
        <Field label="Proposal status"><Input value={f.proposalStatus ?? ''} onChange={set('proposalStatus')} placeholder="e.g. Under review" /></Field>
        {f.stage === 'LOST' && <Field label="Lost reason" required><Input value={f.lostReason ?? ''} onChange={set('lostReason')} /></Field>}
        <Field label="Notes" className="sm:col-span-2"><Textarea rows={3} value={f.notes ?? ''} onChange={set('notes')} /></Field>
      </div>
    </Dialog>
  );
}

function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <CsvImportDialog open={open} onOpenChange={onOpenChange} title="Import leads from CSV" endpoint="/leads/import" noun="lead" invalidate={[['/leads'], ['leads-pipeline']]}
      help={<>
        <p>Comma-, tab- or semicolon-separated, with a header row. Columns recognised: <code className="text-xs">name, company, email, phone, source, service, budget, value, notes</code>. Only <code className="text-xs">name</code> is required.</p>
        <p>Values such as <code className="text-xs">₹ 1,30,000</code> are understood. Rows whose email or phone already exists (or repeats in the file) are skipped.</p>
      </>}
      template={{ filename: 'leads-template.csv', rows: [
        ['name', 'company', 'email', 'phone', 'source', 'service', 'budget', 'value', 'notes'],
        ['Asha Rao', 'Rao Textiles', 'asha@example.com', '9876543210', 'Google', 'Website Development', '50k-1 Lakh', '75000', 'Wants an e-commerce site'],
      ] }} />
  );
}

/** Largest page the leads API returns; offered as "All" in the rows-per-page menu. */
const LEADS_ALL = 2000;

type BulkResult = { matched: number; changed: number; skipped: { id: string; name: string; reason: string }[] };

/** Actions for the selected leads: change stage, reassign, delete. `target` is either picked ids or the current filters. */
function LeadBulkBar({ count, target, total, onDone, onClear }: {
  count: number; target: { ids: string[] } | { filters: Record<string, string> }; total: number; onDone: () => void; onClear: () => void;
}) {
  const members = useMembers();
  const [stage, setStage] = useState('');
  const [lostOpen, setLostOpen] = useState(false);
  const [lostReason, setLostReason] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const report = (r: BulkResult, verb: string) => {
    const msg = `${r.changed} lead${r.changed === 1 ? '' : 's'} ${verb}`;
    if (!r.skipped.length) toast.success(msg);
    else {
      const reasons = [...new Set(r.skipped.map((s) => s.reason))].slice(0, 2).join('; ');
      toast.warning(`${msg}, ${r.skipped.length} skipped (${reasons})`);
    }
    onDone();
  };
  const run = useAction((body: object) => api.post<BulkResult>('/leads/bulk', { ...target, ...body }), { invalidate: [['/leads'], ['leads-pipeline']] });
  const changeStage = (s: string, reason?: string) => run.mutate({ action: 'stage', stage: s, lostReason: reason }, { onSuccess: (r) => { report(r, `moved to ${titleCase(s)}`); setStage(''); setLostOpen(false); setLostReason(''); } });
  const what = 'filters' in target ? `all ${total.toLocaleString('en-IN')} matching leads` : `${count} selected lead${count === 1 ? '' : 's'}`;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-brand-50/60 px-4 py-2.5 text-sm">
      <span className="font-medium text-ink">{'filters' in target ? `All ${total.toLocaleString('en-IN')} selected` : `${count} selected`}</span>
      <span className="mx-1 h-5 w-px bg-line" />
      <Select className="h-8 w-48" value={stage} disabled={run.isPending} aria-label="Change stage"
        onChange={(e) => { const s = e.target.value; setStage(s); if (!s) return; if (s === 'LOST') setLostOpen(true); else changeStage(s); }}>
        <option value="">Change stage…</option>
        {STAGES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
      </Select>
      <Select className="h-8 w-48" value="" disabled={run.isPending} aria-label="Assign owner"
        onChange={(e) => { const id = e.target.value; if (id) run.mutate({ action: 'assign', assignedToId: id }, { onSuccess: (r) => report(r, `assigned to ${members.data?.find((m) => m.id === id)?.name ?? 'the new owner'}`) }); }}>
        <option value="">Assign to…</option>
        {members.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </Select>
      <Button size="sm" variant="secondary" className="text-red-600" disabled={run.isPending} onClick={() => setDeleteOpen(true)}><Trash2 /> Delete</Button>
      <Button size="sm" variant="ghost" onClick={onClear} className="ml-auto">Clear selection</Button>
      <Dialog open={lostOpen} onOpenChange={(v) => { setLostOpen(v); if (!v) setStage(''); }} title={`Mark ${what} as lost`} size="sm"
        footer={<><Button variant="secondary" onClick={() => { setLostOpen(false); setStage(''); }}>Cancel</Button><Button onClick={() => changeStage('LOST', lostReason.trim())} loading={run.isPending} disabled={lostReason.trim().length < 3}>Mark as lost</Button></>}>
        <Field label="Reason" required hint="Saved on each lead and in its activity log"><Input value={lostReason} onChange={(e) => setLostReason(e.target.value)} placeholder="e.g. Budget too low" autoFocus /></Field>
      </Dialog>
      <ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} danger confirmLabel="Delete" loading={run.isPending} title={`Delete ${what}?`}
        description="Deleted leads and their activities cannot be recovered. Leads already converted to customers are kept."
        onConfirm={() => run.mutate({ action: 'delete' }, { onSuccess: (r) => { setDeleteOpen(false); report(r, 'deleted'); } })} />
    </div>
  );
}

export function LeadsList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const members = useMembers();
  const list = useList<Lead>('/leads', { stage: '', serviceInterest: '', assignedToId: '' }, { sort: 'createdAt', storageKey: 'leads' }); // newest leads first
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  // Selection: picked ids (kept across pages), or every lead matching the filters.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const clearSelection = () => { setSelected(new Set()); setAllMatching(false); };
  useEffect(clearSelection, [JSON.stringify(list.params)]);
  const canEdit = can('leads.update');
  const pageIds = list.data?.items.map((l) => l.id) ?? [];
  const pageAllSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const total = list.data?.total ?? 0;
  const toggle = (id: string, on: boolean) => { setAllMatching(false); setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; }); };
  const togglePage = (on: boolean) => { setAllMatching(false); setSelected((s) => { const n = new Set(s); for (const id of pageIds) { if (on) n.add(id); else n.delete(id); } return n; }); };
  const filters = Object.fromEntries(Object.entries({ q: list.params.q ?? '', ...list.filters }).filter(([, v]) => v));
  return (
    <>
      <PageHeader title="Leads" description="Prospects in your sales pipeline, ranked by a transparent heuristic score."
        actions={<>
          <ExportButton path="/leads" filename="leads.csv" params={list.params} />
          {can('leads.update') && <Button variant="secondary" onClick={() => setImporting(true)}><Upload /> Import</Button>}
          {can('leads.update') && <Button onClick={() => setCreating(true)}><Plus /> New lead</Button>}
        </>} />
      <Card>
        <Toolbar>
          <SearchInput value={list.q} onChange={list.setQ} placeholder="Search name, company, email" className="w-full sm:w-72" />
          <Select value={list.filters.stage} onChange={(e) => list.setFilter('stage', e.target.value)} className="w-44"><option value="">All stages</option>{STAGES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select>
          <Select value={list.filters.serviceInterest} onChange={(e) => list.setFilter('serviceInterest', e.target.value)} className="w-52"><option value="">All services</option>{SERVICES.map((s) => <option key={s}>{s}</option>)}</Select>
          <Select value={list.filters.assignedToId} onChange={(e) => list.setFilter('assignedToId', e.target.value)} className="w-44"><option value="">Any owner</option>{members.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>
        </Toolbar>
        {list.isLoading ? <LoadingBlock /> : list.error ? <ErrorState error={list.error} onRetry={list.refetch} /> : !list.data?.items.length ? (
          <EmptyState icon={<Target />} title="No leads found" description="Add leads manually or import a CSV." action={can('leads.update') && <Button onClick={() => setCreating(true)}><Plus /> New lead</Button>} />
        ) : (
          <>
            {(selected.size > 0 || allMatching) && canEdit && (
              <LeadBulkBar count={allMatching ? total : selected.size} total={total} target={allMatching ? { filters } : { ids: [...selected] }} onDone={clearSelection} onClear={clearSelection} />
            )}
            {canEdit && pageAllSelected && !allMatching && total > pageIds.length && (
              <div className="border-b border-line bg-slate-50 px-4 py-2 text-center text-sm text-slate-600">
                {selected.size === pageIds.length ? `All ${pageIds.length} leads on this page are selected.` : `${selected.size} leads selected.`}{' '}
                <button className="font-medium text-brand-700 hover:underline" onClick={() => setAllMatching(true)}>Select all {total.toLocaleString('en-IN')} matching leads</button>
              </div>
            )}
            {allMatching && (
              <div className="border-b border-line bg-slate-50 px-4 py-2 text-center text-sm text-slate-600">
                All {total.toLocaleString('en-IN')} leads matching the current filters are selected. <button className="font-medium text-brand-700 hover:underline" onClick={clearSelection}>Clear selection</button>
              </div>
            )}
            <Table>
              <THead><tr>
                {canEdit && <TH className="w-10"><Checkbox checked={allMatching || pageAllSelected} onCheckedChange={togglePage} aria-label="Select all leads on this page" /></TH>}
                <TH><button onClick={() => list.toggleSort('score')}>Score {list.sort.sort === 'score' && (list.sort.dir === 'desc' ? '↓' : '↑')}</button></TH>
                <TH>Lead</TH><TH>Service</TH><TH>Stage</TH>
                <TH className="text-right"><button onClick={() => list.toggleSort('estimatedValue')}>Value {list.sort.sort === 'estimatedValue' && (list.sort.dir === 'desc' ? '↓' : '↑')}</button></TH>
                <TH><button onClick={() => list.toggleSort('nextFollowUpAt')}>Next follow-up {list.sort.sort === 'nextFollowUpAt' && (list.sort.dir === 'desc' ? '↓' : '↑')}</button></TH><TH>Owner</TH>
                <TH><button onClick={() => list.toggleSort('createdAt')}>Added {list.sort.sort === 'createdAt' && (list.sort.dir === 'desc' ? '↓' : '↑')}</button></TH>
              </tr></THead>
              <TBody>
                {list.data.items.map((l) => {
                  const overdue = l.nextFollowUpAt && new Date(l.nextFollowUpAt) < new Date() && !['WON', 'LOST'].includes(l.stage);
                  return (
                    <TR key={l.id} onClick={() => navigate(`/leads/${l.id}`)} className={cn((allMatching || selected.has(l.id)) && 'bg-brand-50/50')}>
                      {canEdit && <TD onClick={(e) => e.stopPropagation()}><Checkbox checked={allMatching || selected.has(l.id)} onCheckedChange={(v) => toggle(l.id, v)} aria-label={`Select ${l.name}`} /></TD>}
                      <TD><ScorePill score={l.score} /></TD>
                      <TD><p className="font-medium">{l.name}</p><p className="text-xs text-muted">{l.company ?? l.email ?? '—'}</p></TD>
                      <TD className="text-slate-600">{l.serviceInterest ?? '—'}</TD>
                      <TD><StatusBadge status={l.stage} /></TD>
                      <TD className="text-right tabular-nums">{l.estimatedValue ? inrCompact(l.estimatedValue) : '—'}</TD>
                      <TD className={overdue ? 'font-medium text-red-600' : 'text-slate-600'}>{fmtDate(l.nextFollowUpAt)}</TD>
                      <TD className="text-slate-600">{memberName(members.data, l.assignedToId)}</TD>
                      <TD className="whitespace-nowrap text-slate-600">{fmtDate(l.createdAt)}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
            <Pagination page={list.page} pages={list.data.pages} total={list.data.total} onPage={list.setPage} pageSize={list.pageSize} onPageSize={list.setPageSize} allSize={LEADS_ALL} />
          </>
        )}
      </Card>
      <LeadFormDialog open={creating} onOpenChange={setCreating} onSaved={(l) => navigate(`/leads/${l.id}`)} />
      <ImportDialog open={importing} onOpenChange={setImporting} />
    </>
  );
}

function ScorePanel({ lead, onRescore, rescoring }: { lead: Lead; onRescore: () => void; rescoring: boolean }) {
  const d = lead.scoreDetails as ScoreDetails;
  if (!d?.factors) return null;
  return (
    <Card>
      <CardHeader title="Lead score" description="Heuristic model (rule-based, not a calibrated probability)" actions={<Button variant="ghost" size="sm" onClick={onRescore} loading={rescoring}>Recalculate</Button>} />
      <div className="space-y-4 p-5">
        <div className="flex items-center gap-4">
          <div className={cn('flex size-16 items-center justify-center rounded-full text-2xl font-semibold tabular-nums', d.score >= 75 ? 'bg-red-50 text-red-700' : d.score >= 55 ? 'bg-amber-50 text-amber-700' : d.score >= 35 ? 'bg-brand-50 text-brand-800' : 'bg-slate-100 text-slate-600')}>{d.score}</div>
          <div className="space-y-1 text-sm">
            <p><span className="text-muted">Priority:</span> <strong>{d.priority}</strong></p>
            <p><span className="text-muted">Fit:</span> {d.fit} · <span className="text-muted">Engagement:</span> {d.engagementTrend}</p>
            {d.historicalWinRate !== undefined && <p className="text-xs text-muted">Historical win rate for this service: {d.historicalWinRate}%</p>}
          </div>
        </div>
        <div className="rounded-lg bg-brand-50 p-3 text-sm">
          <p className="font-medium text-brand-900">Recommended next action</p>
          <p className="mt-0.5 text-brand-800">{d.nextAction}</p>
          <p className="mt-1 text-xs text-brand-700">Suggested follow-up: {fmtDate(d.suggestedFollowUp)}</p>
        </div>
        <ul className="space-y-2">
          {d.factors.map((f) => (
            <li key={f.key} className="text-sm">
              <div className="flex justify-between"><span>{f.label}</span><span className="tabular-nums text-muted">{f.points}/{f.max}</span></div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-brand-600" style={{ width: `${(f.points / f.max) * 100}%` }} /></div>
              <p className="mt-0.5 text-xs text-muted">{f.reason}</p>
            </li>
          ))}
        </ul>
        {d.missing.length > 0 && <p className="flex items-start gap-2 text-xs text-amber-700"><Info className="mt-0.5 size-3.5 shrink-0" />Missing: {d.missing.join(', ')}</p>}
      </div>
    </Card>
  );
}

function AiAssistant({ leadId }: { leadId: string }) {
  const [out, setOut] = useState<{ text: string; provider: string } | null>(null);
  const run = useAction((feature: string) => api.post<{ text: string; provider: string }>(`/leads/${leadId}/ai/${feature}`), { onSuccess: setOut });
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Sparkles className="size-4 text-brand-600" /> Assistant</span>} description="Drafts only. Nothing is sent automatically." />
      <div className="space-y-3 p-5">
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => run.mutate('followup_draft')} loading={run.isPending && run.variables === 'followup_draft'}><Wand2 /> Draft follow-up</Button>
          <Button variant="secondary" size="sm" onClick={() => run.mutate('summary')} loading={run.isPending && run.variables === 'summary'}>Summarise</Button>
          <Button variant="secondary" size="sm" onClick={() => run.mutate('next_actions')} loading={run.isPending && run.variables === 'next_actions'}>Next actions</Button>
        </div>
        {out && (
          <div className="rounded-lg border border-line bg-slate-50 p-3">
            <pre className="whitespace-pre-wrap font-sans text-sm text-ink">{out.text}</pre>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-muted">{out.provider === 'anthropic' ? 'Generated by AI. Review before sending.' : 'Template draft (AI provider not configured).'}</span>
              <Button variant="ghost" size="sm" onClick={() => { navigator.clipboard.writeText(out.text); toast.success('Copied'); }}><Copy /> Copy</Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function ConvertDialog({ lead, open, onOpenChange }: { lead: Lead; open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate();
  const [opts, setOpts] = useState({ createProject: true, projectName: '', startOnboarding: true });
  const run = useAction(() => api.post<{ customer: { id: string; code: string }; project: { id: string } | null; reused: boolean }>(`/leads/${lead.id}/convert`, { ...opts, projectName: opts.projectName || undefined }), {
    success: (r) => (r.reused ? `Linked to existing customer ${r.customer.code}` : `Customer ${r.customer.code} created`),
    invalidate: [['/leads'], ['lead'], ['/customers'], ['customers-options']], onSuccess: (r) => navigate(`/customers/${r.customer.id}`),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Convert to customer"
      description="History, activities and quotations are carried over. If a customer with the same email exists, it is reused instead of duplicated."
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={() => run.mutate()} loading={run.isPending}><ArrowRightLeft /> Convert</Button></>}>
      <div className="space-y-4">
        <label className="flex items-center gap-3 text-sm"><Switch checked={opts.createProject} onCheckedChange={(v) => setOpts({ ...opts, createProject: v })} /> Create a project</label>
        {opts.createProject && <Field label="Project name" hint="Leave blank to use the service and company name"><Input value={opts.projectName} onChange={(e) => setOpts({ ...opts, projectName: e.target.value })} /></Field>}
        <label className="flex items-center gap-3 text-sm"><Switch checked={opts.startOnboarding} onCheckedChange={(v) => setOpts({ ...opts, startOnboarding: v })} /> Start onboarding checklist</label>
      </div>
    </Dialog>
  );
}

export function LeadDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const members = useMembers();
  const q = useQuery({ queryKey: ['lead', id], queryFn: () => api.get<Lead & { activities: Activity[]; tasks: Task[]; quotations: { id: string; number: string; status: string; total: string; issueDate: string }[] }>(`/leads/${id}`) });
  const [editing, setEditing] = useState(false);
  const [logging, setLogging] = useState(false);
  const [converting, setConverting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const rescore = useAction(() => api.post(`/leads/${id}/score`), { invalidate: [['lead']] });
  const stage = useAction((s: string) => api.patch(`/leads/${id}`, { stage: s }), { success: 'Stage updated', invalidate: [['lead'], ['/leads']] });
  const del = useAction(() => api.delete(`/leads/${id}`), { success: 'Lead deleted', invalidate: [['/leads']], onSuccess: () => navigate('/leads') });
  if (q.isLoading) return <Card><LoadingBlock rows={8} /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} onRetry={q.refetch} /></Card>;
  const l = q.data;
  const closed = ['WON', 'LOST'].includes(l.stage);
  return (
    <>
      <PageHeader breadcrumb={<Link to="/leads" className="hover:underline">Leads</Link>}
        title={<span className="flex items-center gap-3">{l.name}<StatusBadge status={l.stage} /></span>} description={l.company ?? undefined}
        actions={can('leads.update') && <>
          <Button variant="secondary" onClick={() => setLogging(true)}>Log activity</Button>
          {can('quotations.create') && <Button variant="secondary" onClick={() => navigate(`/quotations/new?leadId=${l.id}`)}>Create quotation</Button>}
          <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
          {!l.customerId && can('customers.update') && l.stage !== 'LOST' && <Button onClick={() => setConverting(true)}><ArrowRightLeft /> Convert</Button>}
          {l.customerId && <Button variant="secondary" onClick={() => navigate(`/customers/${l.customerId}`)}>View customer</Button>}
          {!l.customerId && <Button variant="ghost" size="icon" aria-label="Delete lead" onClick={() => setDeleting(true)}><Trash2 /></Button>}
        </>} />

      {can('leads.update') && !closed && (
        <div className="scrollbar-thin mb-6 flex overflow-x-auto rounded-xl border border-line bg-surface">
          {STAGES.filter((s) => s !== 'ON_HOLD' && s !== 'LOST').map((s, i, arr) => {
            const idx = arr.indexOf(l.stage);
            return (
              <button key={s} onClick={() => s !== l.stage && stage.mutate(s)} className={cn('flex-1 whitespace-nowrap border-r border-line px-3 py-2.5 text-xs font-medium last:border-0', i <= idx ? 'bg-brand-50 text-brand-800' : 'text-muted hover:bg-slate-50', s === l.stage && 'bg-primary text-white hover:bg-primary')}>
                {titleCase(s)}
              </button>
            );
          })}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card className="p-5">
            <DescList items={[
              ['Email', l.email], ['Phone', l.phone], ['Source', l.source], ['Service interest', l.serviceInterest],
              ['Budget range', l.budgetRange], ['Estimated value', l.estimatedValue ? inr(l.estimatedValue) : null],
              ['Expected decision', fmtDate(l.expectedDecisionAt)], ['Next follow-up', fmtDate(l.nextFollowUpAt)],
              ['Last contact', fmtDate(l.lastContactAt)], ['Owner', memberName(members.data, l.assignedToId)],
              ['Proposal status', l.proposalStatus], ...(l.lostReason ? [['Lost reason', l.lostReason] as [string, string]] : []),
              ...(l.convertedAt ? [['Converted', fmtDate(l.convertedAt)] as [string, string]] : []),
            ]} />
            {l.notes && <div className="mt-5 border-t border-line pt-4"><p className="text-xs font-medium text-muted">Notes</p><p className="mt-1 whitespace-pre-wrap text-sm">{l.notes}</p></div>}
          </Card>
          <Card>
            <CardHeader title="Follow-up tasks" />
            {l.tasks.length === 0 ? <EmptyState title="No tasks" /> : (
              <ul className="divide-y divide-line">{l.tasks.map((t) => (
                <li key={t.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                  <StatusBadge status={t.status} /><span className="flex-1">{t.title}</span>{t.automated && <Badge tone="violet">Auto</Badge>}<span className="text-xs text-muted">{fmtDate(t.dueDate)}</span>
                </li>
              ))}</ul>
            )}
          </Card>
          {l.quotations.length > 0 && (
            <Card>
              <CardHeader title="Quotations" />
              <ul className="divide-y divide-line">{l.quotations.map((qq) => (
                <li key={qq.id}><Link to={`/quotations/${qq.id}`} className="flex items-center gap-3 px-5 py-3 text-sm hover:bg-slate-50"><span className="font-medium">{qq.number}</span><StatusBadge status={qq.status} /><span className="flex-1" /><span className="tabular-nums">{inr(qq.total)}</span></Link></li>
              ))}</ul>
            </Card>
          )}
          <Card>
            <CardHeader title="Activity timeline" actions={can('leads.update') && <Button size="sm" variant="secondary" onClick={() => setLogging(true)}><Plus /> Log</Button>} />
            <div className="p-5"><ActivityTimeline items={l.activities} /></div>
          </Card>
        </div>
        <div className="space-y-6">
          <ScorePanel lead={l} onRescore={() => rescore.mutate(undefined, { onSuccess: () => qc.invalidateQueries({ queryKey: ['lead'] }) })} rescoring={rescore.isPending} />
          {can('ai.use') && <AiAssistant leadId={l.id} />}
        </div>
      </div>
      <LeadFormDialog open={editing} onOpenChange={setEditing} lead={l} />
      <LogActivityDialog open={logging} onOpenChange={setLogging} leadId={l.id} />
      <ConvertDialog lead={l} open={converting} onOpenChange={setConverting} />
      <ConfirmDialog open={deleting} onOpenChange={setDeleting} title="Delete this lead?" danger confirmLabel="Delete" loading={del.isPending} onConfirm={() => del.mutate()} description="Its activities and follow-up tasks are deleted too. This cannot be undone." />
    </>
  );
}

interface PipelineColumn { stage: string; count: number; value: number; items: { id: string; name: string; company: string | null; stage: string; score: number; estimatedValue: string | null; nextFollowUpAt: string | null; assignedToId: string | null; serviceInterest: string | null }[] }

export function Pipeline() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const members = useMembers();
  const [q, setQ] = useState('');
  const data = useQuery({ queryKey: ['/leads/pipeline', q], queryFn: () => api.get<PipelineColumn[]>('/leads/pipeline', { q }) });
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [lostFor, setLostFor] = useState<string | null>(null);
  const [lostReason, setLostReason] = useState('');
  const move = async (leadId: string, stage: string, reason?: string) => {
    // Optimistic update
    const key = ['/leads/pipeline', q];
    const prev = qc.getQueryData<PipelineColumn[]>(key);
    if (prev) {
      const item = prev.flatMap((c) => c.items).find((i) => i.id === leadId);
      if (!item || item.stage === stage) return;
      qc.setQueryData<PipelineColumn[]>(key, prev.map((c) => ({ ...c, items: c.stage === stage ? [{ ...item, stage }, ...c.items] : c.items.filter((i) => i.id !== leadId) })));
    }
    try {
      await api.patch(`/leads/${leadId}`, { stage, ...(reason ? { lostReason: reason } : {}) });
      toast.success(`Moved to ${titleCase(stage)}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      qc.invalidateQueries({ queryKey: ['/leads/pipeline'] });
      qc.invalidateQueries({ queryKey: ['/leads'] });
    }
  };
  return (
    <>
      <PageHeader title="Sales pipeline" description={can('leads.update') ? 'Drag cards between stages to update them.' : undefined}
        actions={<SearchInput value={q} onChange={setQ} placeholder="Filter leads" className="w-64" />} />
      {data.isLoading ? <Card><LoadingBlock /></Card> : data.error ? <Card><ErrorState error={data.error} /></Card> : (
        <div className="scrollbar-thin -mx-4 flex gap-4 overflow-x-auto px-4 pb-4 lg:-mx-8 lg:px-8">
          {data.data!.map((col) => (
            <div key={col.stage}
              onDragOver={(e) => { if (can('leads.update')) { e.preventDefault(); setOver(col.stage); } }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.preventDefault(); setOver(null);
                if (!dragId) return;
                if (col.stage === 'LOST') { setLostFor(dragId); setLostReason(''); } else move(dragId, col.stage);
                setDragId(null);
              }}
              className={cn('flex w-72 shrink-0 flex-col rounded-xl bg-slate-100/70 transition-colors', over === col.stage && 'bg-brand-50 ring-2 ring-brand-200')}>
              <div className="flex items-center justify-between px-3 py-2.5">
                <div className="flex items-center gap-2"><StatusBadge status={col.stage} /><span className="text-xs font-medium text-muted">{col.count}</span></div>
                <span className="text-xs tabular-nums text-muted">{inrCompact(col.value)}</span>
              </div>
              <div className="flex min-h-24 flex-col gap-2 px-2 pb-2">
                {col.items.map((l) => (
                  <div key={l.id} draggable={can('leads.update')} onDragStart={() => setDragId(l.id)} onClick={() => navigate(`/leads/${l.id}`)}
                    className={cn('cursor-pointer rounded-lg border border-line bg-surface p-3 shadow-xs transition hover:border-brand-300', dragId === l.id && 'opacity-50')}>
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium leading-snug">{l.name}</p><ScorePill score={l.score} />
                    </div>
                    {l.company && <p className="mt-0.5 truncate text-xs text-muted">{l.company}</p>}
                    <div className="mt-2 flex items-center justify-between text-xs text-muted">
                      <span>{l.estimatedValue ? inrCompact(l.estimatedValue) : '—'}</span>
                      <span className={l.nextFollowUpAt && new Date(l.nextFollowUpAt) < new Date() ? 'font-medium text-red-600' : ''}>{l.nextFollowUpAt ? fmtDate(l.nextFollowUpAt, { day: '2-digit', month: 'short' }) : ''}</span>
                    </div>
                    <p className="mt-1 truncate text-[11px] text-slate-500">{memberName(members.data, l.assignedToId)}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      <Dialog open={!!lostFor} onOpenChange={(v) => !v && setLostFor(null)} title="Why was this lead lost?"
        footer={<><Button variant="secondary" onClick={() => setLostFor(null)}>Cancel</Button><Button variant="danger" disabled={lostReason.length < 2} onClick={() => { move(lostFor!, 'LOST', lostReason); setLostFor(null); }}>Mark lost</Button></>}>
        <Field label="Lost reason"><Input autoFocus value={lostReason} onChange={(e) => setLostReason(e.target.value)} placeholder="e.g. Budget too low, chose competitor" /></Field>
      </Dialog>
    </>
  );
}

export function FollowUps() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const q = useQuery({ queryKey: ['/tasks', 'followups', scope], queryFn: () => api.get<{ items: Task[] }>('/tasks', { type: 'FOLLOW_UP', status: 'open', assignee: scope === 'mine' ? 'me' : undefined, sort: 'dueDate', dir: 'asc', pageSize: 200 }) });
  const done = useAction((id: string) => api.patch(`/tasks/${id}`, { status: 'DONE' }), { success: 'Marked done', onSuccess: () => qc.invalidateQueries({ queryKey: ['/tasks'] }) });
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const groups = [
    { label: 'Overdue', items: q.data?.items.filter((t) => t.dueDate && new Date(t.dueDate) < today) ?? [], tone: 'text-red-600' },
    { label: 'Today', items: q.data?.items.filter((t) => t.dueDate && new Date(t.dueDate) >= today && new Date(t.dueDate) < tomorrow) ?? [], tone: 'text-amber-700' },
    { label: 'Upcoming', items: q.data?.items.filter((t) => !t.dueDate || new Date(t.dueDate) >= tomorrow) ?? [], tone: 'text-ink' },
  ];
  return (
    <>
      <PageHeader title="Follow-ups" description="Follow-up tasks are created automatically from lead activity and scoring."
        actions={<Select value={scope} onChange={(e) => setScope(e.target.value as 'mine')} className="w-40"><option value="mine">My follow-ups</option><option value="all">Everyone</option></Select>} />
      {q.isLoading ? <Card><LoadingBlock /></Card> : q.error ? <Card><ErrorState error={q.error} /></Card> : !q.data?.items.length ? <Card><EmptyState title="No open follow-ups" /></Card> : (
        <div className="space-y-6">
          {groups.filter((g) => g.items.length).map((g) => (
            <Card key={g.label}>
              <CardHeader title={<span className={g.tone}>{g.label} ({g.items.length})</span>} />
              <ul className="divide-y divide-line">
                {g.items.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 px-5 py-3">
                    <input type="checkbox" className="size-4" aria-label="Mark done" onChange={() => done.mutate(t.id)} />
                    <button className="min-w-0 flex-1 text-left" onClick={() => t.leadId && navigate(`/leads/${t.leadId}`)}>
                      <p className="truncate text-sm font-medium">{t.title}</p>
                      {t.description && <p className="truncate text-xs text-muted">{t.description}</p>}
                    </button>
                    {t.automated && <Badge tone="violet">Auto</Badge>}
                    <StatusBadge status={t.priority} />
                    <span className="w-24 text-right text-xs text-muted">{fmtDate(t.dueDate)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

export function ActivitiesPage() {
  const list = useList<Activity>('/activities', { type: '' }, { sort: 'occurredAt' });
  const members = useMembers();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Activities" description="Calls, emails, meetings and notes across leads and customers." />
      <Card>
        <Toolbar>
          <SearchInput value={list.q} onChange={list.setQ} placeholder="Search subject or notes" className="w-full sm:w-72" />
          <Select value={list.filters.type} onChange={(e) => list.setFilter('type', e.target.value)} className="w-40"><option value="">All types</option>{['CALL', 'EMAIL', 'MEETING', 'WHATSAPP', 'NOTE', 'STAGE_CHANGE'].map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}</Select>
        </Toolbar>
        {list.isLoading ? <LoadingBlock /> : list.error ? <ErrorState error={list.error} /> : !list.data?.items.length ? <EmptyState title="No activities" /> : (
          <>
            <Table><THead><tr><TH>When</TH><TH>Type</TH><TH>Subject</TH><TH>Related to</TH><TH>By</TH></tr></THead><TBody>
              {list.data.items.map((a) => (
                <TR key={a.id} onClick={() => navigate(a.leadId ? `/leads/${a.leadId}` : `/customers/${a.customerId}`)}>
                  <TD className="whitespace-nowrap text-slate-600">{fmtDate(a.occurredAt)}</TD>
                  <TD><Badge>{titleCase(a.type)}</Badge></TD>
                  <TD><p className="font-medium">{a.subject}</p>{a.body && <p className="max-w-md truncate text-xs text-muted">{a.body}</p>}</TD>
                  <TD className="text-slate-600">{a.lead ? `${a.lead.name} (lead)` : a.customer?.name}</TD>
                  <TD className="text-slate-600">{memberName(members.data, a.userId)}</TD>
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
