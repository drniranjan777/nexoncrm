import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Clock, Play, Plus, Receipt, Square, Timer } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useCustomerOptions, useList, useMembers, useProjectOptions, memberName } from '@/lib/hooks';
import type { TimeEntry } from '@/lib/types';
import { fmtDate, inr, num, toDateInput } from '@/lib/utils';
import { Badge, Button, Card, Checkbox, Dialog, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Pagination, Select, Switch, Table, TBody, TD, TH, THead, Toolbar, TR, Textarea } from '@/components/ui';
import { StatusTabs } from './finance';

const hm = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;

function RunningTimer({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  return <span className="font-mono tabular-nums">{String(Math.floor(s / 3600)).padStart(2, '0')}:{String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:{String(s % 60).padStart(2, '0')}</span>;
}

export function TimeTrackingPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const members = useMembers();
  const projects = useProjectOptions();
  const list = useList<TimeEntry>('/time-entries', { status: '', projectId: '', from: '', to: '' }, { sort: 'date' });
  const running = (list.data as { runningTimer?: TimeEntry & { project: { name: string } } } | undefined)?.runningTimer;
  const totalMinutes = (list.data as { totalMinutes?: number } | undefined)?.totalMinutes ?? 0;
  const [log, setLog] = useState<{ id?: string; projectId: string; date: string; hours: string; minutes: string; notes: string; billable: boolean } | null>(null);
  const [timer, setTimer] = useState<{ projectId: string; notes: string } | null>(null);
  const [bill, setBill] = useState(false);
  const inv = [['/time-entries'], ['billing-home']];
  const save = useAction(() => {
    const body = { projectId: log!.projectId, date: log!.date, minutes: (Number(log!.hours) || 0) * 60 + (Number(log!.minutes) || 0), notes: log!.notes || null, billable: log!.billable };
    return log!.id ? api.patch(`/time-entries/${log!.id}`, body) : api.post('/time-entries', body);
  }, { success: 'Time logged', invalidate: inv, onSuccess: () => setLog(null) });
  const start = useAction(() => api.post('/time-entries/timer/start', { projectId: timer!.projectId, notes: timer!.notes || null }), { success: 'Timer started', invalidate: inv, onSuccess: () => setTimer(null) });
  const stop = useAction(() => api.post('/time-entries/timer/stop'), { success: 'Timer stopped and logged', invalidate: inv });
  const remove = useAction((id: string) => api.delete(`/time-entries/${id}`), { success: 'Entry deleted', invalidate: inv, onSuccess: () => setLog(null) });
  return (
    <>
      <PageHeader title="Time Tracking" description="Log time against projects and bill unbilled hours to customers."
        actions={<>
          {can('invoices.create') && <Button variant="secondary" onClick={() => setBill(true)}><Receipt /> Invoice unbilled</Button>}
          {!running && <Button variant="secondary" onClick={() => setTimer({ projectId: projects.data?.[0]?.id ?? '', notes: '' })}><Play /> Start timer</Button>}
          <Button onClick={() => setLog({ projectId: projects.data?.[0]?.id ?? '', date: toDateInput(new Date()), hours: '1', minutes: '0', notes: '', billable: true })}><Plus /> Log Time</Button>
        </>} />
      {running && (
        <Card className="mb-4 flex flex-wrap items-center gap-4 border-brand-200 bg-brand-50 p-4">
          <Timer className="size-5 text-brand-700" />
          <div className="flex-1"><p className="text-sm font-medium">Timer running on {running.project?.name}</p>{running.notes && <p className="text-xs text-muted">{running.notes}</p>}</div>
          <span className="text-xl"><RunningTimer startedAt={running.timerStartedAt!} /></span>
          <Button variant="danger" onClick={() => stop.mutate()} loading={stop.isPending}><Square /> Stop</Button>
        </Card>
      )}
      <StatusTabs value={list.filters.status} onChange={(v) => list.setFilter('status', v)} tabs={[['', 'All'], ['unbilled', 'Unbilled'], ['invoiced', 'Invoiced']]} />
      <Card>
        <Toolbar>
          <Select value={list.filters.projectId} onChange={(e) => list.setFilter('projectId', e.target.value)} className="w-56"><option value="">All projects</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
          <Input type="date" className="w-36" value={list.filters.from} onChange={(e) => list.setFilter('from', e.target.value)} aria-label="From" />
          <Input type="date" className="w-36" value={list.filters.to} onChange={(e) => list.setFilter('to', e.target.value)} aria-label="To" />
          <span className="ml-auto flex items-center gap-1.5 text-sm text-muted"><Clock className="size-4" /> Total <strong className="text-ink">{hm(totalMinutes)}</strong> hrs</span>
        </Toolbar>
        {list.isLoading ? <LoadingBlock /> : list.error ? <ErrorState error={list.error} /> : !list.data?.items.length ? <EmptyState icon={<Timer />} title="No time logged" /> : (
          <>
            <Table><THead><tr><TH>Date</TH><TH>Project</TH><TH>User</TH><TH>Notes</TH><TH>Billing</TH><TH className="text-right">Time (h:mm)</TH></tr></THead><TBody>
              {list.data.items.map((e) => (
                <TR key={e.id} onClick={() => !e.invoiceId && !e.timerStartedAt && setLog({ id: e.id, projectId: e.projectId, date: toDateInput(e.date), hours: String(Math.floor(e.minutes / 60)), minutes: String(e.minutes % 60), notes: e.notes ?? '', billable: e.billable })}>
                  <TD>{fmtDate(e.date)}</TD><TD className="font-medium">{e.project?.name}</TD><TD className="text-slate-600">{memberName(members.data, e.userId)}</TD><TD className="max-w-xs truncate text-slate-600">{e.notes}</TD>
                  <TD>{e.timerStartedAt ? <Badge tone="blue">Running</Badge> : e.invoice ? <span className="text-xs font-semibold text-emerald-700">INVOICED {e.invoice.number}</span> : e.billable ? <span className="text-xs font-semibold text-amber-700">UNBILLED</span> : <span className="text-xs text-muted">NON-BILLABLE</span>}</TD>
                  <TD className="text-right font-mono tabular-nums">{hm(e.minutes)}</TD>
                </TR>
              ))}
            </TBody></Table>
            <Pagination page={list.page} pages={list.data.pages} total={list.data.total} onPage={list.setPage} />
          </>
        )}
      </Card>

      <Dialog open={!!log} onOpenChange={(v) => !v && setLog(null)} title={log?.id ? 'Edit time entry' : 'Log time'}
        footer={<>{log?.id && <Button variant="ghost" className="mr-auto text-red-600" onClick={() => remove.mutate(log.id!)}>Delete</Button>}<Button variant="secondary" onClick={() => setLog(null)}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!log?.projectId}>Save</Button></>}>
        {log && <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Project" className="sm:col-span-2"><Select value={log.projectId} onChange={(e) => setLog({ ...log, projectId: e.target.value })}><option value="">Select project</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</Select></Field>
          <Field label="Date"><Input type="date" value={log.date} onChange={(e) => setLog({ ...log, date: e.target.value })} /></Field>
          <Field label="Time spent">
            <div className="flex items-center gap-2"><Input type="number" min={0} max={24} className="w-20" value={log.hours} onChange={(e) => setLog({ ...log, hours: e.target.value })} aria-label="Hours" /><span className="text-sm text-muted">h</span><Input type="number" min={0} max={59} className="w-20" value={log.minutes} onChange={(e) => setLog({ ...log, minutes: e.target.value })} aria-label="Minutes" /><span className="text-sm text-muted">m</span></div>
          </Field>
          <Field label="Notes" className="sm:col-span-2"><Textarea rows={2} value={log.notes} onChange={(e) => setLog({ ...log, notes: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-sm"><Switch checked={log.billable} onCheckedChange={(v) => setLog({ ...log, billable: v })} /> Billable</label>
        </div>}
      </Dialog>
      <Dialog open={!!timer} onOpenChange={(v) => !v && setTimer(null)} title="Start timer"
        footer={<><Button variant="secondary" onClick={() => setTimer(null)}>Cancel</Button><Button onClick={() => start.mutate()} loading={start.isPending} disabled={!timer?.projectId}><Play /> Start</Button></>}>
        {timer && <div className="space-y-4">
          <Field label="Project"><Select value={timer.projectId} onChange={(e) => setTimer({ ...timer, projectId: e.target.value })}><option value="">Select project</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</Select></Field>
          <Field label="What are you working on?"><Input value={timer.notes} onChange={(e) => setTimer({ ...timer, notes: e.target.value })} /></Field>
        </div>}
      </Dialog>
      <InvoiceUnbilledDialog open={bill} onOpenChange={setBill} onCreated={(id) => navigate(`/invoices/${id}/edit`)} />
    </>
  );
}

export function InvoiceUnbilledDialog({ open, onOpenChange, onCreated, customerId: fixed }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: (invoiceId: string) => void; customerId?: string }) {
  const customers = useCustomerOptions(open);
  const [customerId, setCustomerId] = useState(fixed ?? '');
  const data = useQuery({ queryKey: ['unbilled', customerId], enabled: open && !!customerId, queryFn: () => api.get<{ time: (TimeEntry & { project: { name: string; hourlyRate: string | null } })[]; expenses: { id: string; date: string; total: string; amount: string; markupPct: string; category: { name: string } | null; vendor: string | null }[] }>(`/customers/${customerId}/unbilled`) });
  const [sel, setSel] = useState<Record<string, boolean>>({});
  useEffect(() => { if (data.data) setSel(Object.fromEntries([...data.data.time.map((t) => [t.id, true]), ...data.data.expenses.map((e) => [e.id, true])])); }, [data.data]);
  const create = useAction(() => api.post<{ id: string }>('/invoices/from-unbilled', { customerId, timeEntryIds: data.data!.time.filter((t) => sel[t.id]).map((t) => t.id), expenseIds: data.data!.expenses.filter((e) => sel[e.id]).map((e) => e.id) }), {
    success: 'Draft invoice created', invalidate: [['/time-entries'], ['/expenses'], ['/invoices']], onSuccess: (r) => { onOpenChange(false); onCreated(r.id); },
  });
  const total = (data.data?.time.filter((t) => sel[t.id]).reduce((s, t) => s + (t.minutes / 60) * num(t.project.hourlyRate), 0) ?? 0) + (data.data?.expenses.filter((e) => sel[e.id]).reduce((s, e) => s + num(e.amount) * (1 + num(e.markupPct) / 100), 0) ?? 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Invoice unbilled time and expenses" size="lg"
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={() => create.mutate()} loading={create.isPending} disabled={!Object.values(sel).some(Boolean)}>Create draft invoice</Button></>}>
      {!fixed && <Field label="Customer"><Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}><option value="">Select customer</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.company ?? c.name}</option>)}</Select></Field>}
      {customerId && (data.isLoading ? <LoadingBlock rows={3} /> : !data.data?.time.length && !data.data?.expenses.length ? <EmptyState title="Nothing unbilled for this customer" /> : (
        <div className="mt-4 space-y-4">
          {!!data.data?.time.length && <div><p className="mb-2 text-sm font-semibold">Time entries</p><ul className="divide-y divide-line rounded-lg border border-line">{data.data.time.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm"><Checkbox checked={!!sel[t.id]} onCheckedChange={(v) => setSel({ ...sel, [t.id]: v })} /><span className="flex-1">{fmtDate(t.date)} · {t.project.name}{t.notes ? ` · ${t.notes}` : ''}</span><span className="font-mono">{hm(t.minutes)}</span><span className="w-24 text-right tabular-nums">{t.project.hourlyRate ? inr((t.minutes / 60) * num(t.project.hourlyRate)) : <span className="text-xs text-amber-700">no rate</span>}</span></li>
          ))}</ul></div>}
          {!!data.data?.expenses.length && <div><p className="mb-2 text-sm font-semibold">Billable expenses</p><ul className="divide-y divide-line rounded-lg border border-line">{data.data.expenses.map((e) => (
            <li key={e.id} className="flex items-center gap-3 px-3 py-2 text-sm"><Checkbox checked={!!sel[e.id]} onCheckedChange={(v) => setSel({ ...sel, [e.id]: v })} /><span className="flex-1">{fmtDate(e.date)} · {e.category?.name}{e.vendor ? ` · ${e.vendor}` : ''}</span><span className="w-24 text-right tabular-nums">{inr(num(e.amount) * (1 + num(e.markupPct) / 100))}</span></li>
          ))}</ul></div>}
          <p className="text-right text-sm">Estimated value before GST: <strong>{inr(total)}</strong></p>
          <p className="text-xs text-muted">Hours are billed at each project's hourly rate (set in the project). You can edit the draft before sending.</p>
        </div>
      ))}
    </Dialog>
  );
}
