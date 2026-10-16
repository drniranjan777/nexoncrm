import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckSquare, LayoutGrid, List, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useList, useMembers, useProjectOptions, memberName } from '@/lib/hooks';
import type { Task } from '@/lib/types';
import { cn, fmtDate, titleCase, toDateInput } from '@/lib/utils';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Pagination, SearchInput, Select, Sheet, StatusBadge, Table, TBody, TD, TH, THead, Toolbar, TR, Textarea } from '@/components/ui';
import { AssigneeSelect } from '@/components/shared';

const STATUSES = ['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE', 'CANCELLED'];
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

export function TaskSheet({ task, open, onOpenChange, defaults }: { task?: Task | null; open: boolean; onOpenChange: (v: boolean) => void; defaults?: Partial<Task> }) {
  const { can, me } = useAuth();
  const projects = useProjectOptions(open && can('projects.read', 'projects.read_assigned'));
  const [f, setF] = useState<Partial<Task>>({});
  const milestones = useQuery({
    queryKey: ['/milestones', f.projectId], enabled: open && !!f.projectId,
    queryFn: () => api.get<{ id: string; title: string }[]>('/milestones', { projectId: f.projectId! }),
  });
  useEffect(() => { if (open) setF(task ? { ...task, dueDate: toDateInput(task.dueDate) } : { status: 'TODO', priority: 'MEDIUM', assigneeId: me?.id, ...defaults }); }, [open, task, defaults, me]);
  const save = useAction(() => {
    const body = { title: f.title, description: f.description, status: f.status, priority: f.priority, dueDate: f.dueDate || null, assigneeId: f.assigneeId, projectId: f.projectId || null, milestoneId: f.milestoneId || null, ...(task ? {} : { leadId: f.leadId, customerId: f.customerId, feedbackId: f.feedbackId, type: f.type }) };
    return task ? api.patch(`/tasks/${task.id}`, body) : api.post('/tasks', body);
  }, { success: task ? 'Task updated' : 'Task created', invalidate: [['/tasks'], ['project'], ['dashboard'], ['lead']], onSuccess: () => onOpenChange(false) });
  const del = useAction(() => api.delete(`/tasks/${task!.id}`), { success: 'Task deleted', invalidate: [['/tasks'], ['project']], onSuccess: () => onOpenChange(false) });
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={task ? 'Task' : 'New task'}
      footer={<>{task && (task.createdById === me?.id || can('tasks.assign')) && <Button variant="ghost" className="mr-auto text-red-600" onClick={() => del.mutate()} loading={del.isPending}>Delete</Button>}<Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!f.title}>Save</Button></>}>
      <div className="space-y-4">
        <Field label="Title" required><Input value={f.title ?? ''} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Description"><Textarea rows={5} value={f.description ?? ''} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Status"><Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select></Field>
          <Field label="Priority"><Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{PRIORITIES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select></Field>
          <Field label="Due date"><Input type="date" value={(f.dueDate as string) ?? ''} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></Field>
          <Field label="Assignee"><AssigneeSelect value={f.assigneeId} onChange={(v) => setF({ ...f, assigneeId: v })} disabled={!can('tasks.assign')} allowEmpty={can('tasks.assign')} /></Field>
        </div>
        {can('projects.read', 'projects.read_assigned') && (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Project"><Select value={f.projectId ?? ''} onChange={(e) => setF({ ...f, projectId: e.target.value || null, milestoneId: null })}><option value="">None</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</Select></Field>
            <Field label="Milestone"><Select value={f.milestoneId ?? ''} disabled={!f.projectId} onChange={(e) => setF({ ...f, milestoneId: e.target.value || null })}><option value="">None</option>{milestones.data?.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}</Select></Field>
          </div>
        )}
        {task && (task.lead || task.customer || task.feedbackId) && (
          <div className="rounded-lg bg-slate-50 p-3 text-sm">
            {task.lead && <p>Lead: <Link className="text-brand-700 hover:underline" to={`/leads/${task.lead.id}`}>{task.lead.name}</Link></p>}
            {task.customer && <p>Customer: <Link className="text-brand-700 hover:underline" to={`/customers/${task.customer.id}`}>{task.customer.name}</Link></p>}
            {task.feedbackId && <p>From <Link className="text-brand-700 hover:underline" to={`/feedback/${task.feedbackId}`}>customer feedback</Link></p>}
          </div>
        )}
      </div>
    </Sheet>
  );
}

export function TasksPage() {
  const { can } = useAuth();
  const members = useMembers();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<'list' | 'board'>('list');
  const list = useList<Task>('/tasks', { status: 'open', assignee: can('tasks.assign') ? '' : 'me', type: '', due: '' }, { sort: 'dueDate', dir: 'asc', pageSize: view === 'board' ? 200 : 25 });
  const [selected, setSelected] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const openId = params.get('open');
  const opened = useQuery({ queryKey: ['task', openId], enabled: !!openId && !list.data?.items.some((t) => t.id === openId), queryFn: () => api.get<{ items: Task[] }>('/tasks', { q: '', pageSize: 200, status: '' }).then((r) => r.items.find((t) => t.id === openId) ?? null) });
  useEffect(() => {
    if (!openId) return;
    const t = list.data?.items.find((x) => x.id === openId) ?? opened.data;
    if (t) setSelected(t);
  }, [openId, list.data, opened.data]);
  const move = useAction(({ id, status }: { id: string; status: string }) => api.patch(`/tasks/${id}`, { status }), { invalidate: [['/tasks']] });
  const [drag, setDrag] = useState<string | null>(null);

  return (
    <>
      <PageHeader title="Tasks" description="Project work, follow-ups and feedback actions."
        actions={<>
          <div className="flex rounded-lg border border-line bg-surface p-0.5">
            <button className={cn('rounded-md px-2 py-1', view === 'list' && 'bg-slate-100')} onClick={() => setView('list')} aria-label="List view"><List className="size-4" /></button>
            <button className={cn('rounded-md px-2 py-1', view === 'board' && 'bg-slate-100')} onClick={() => { setView('board'); list.setFilter('status', ''); }} aria-label="Board view"><LayoutGrid className="size-4" /></button>
          </div>
          <Button onClick={() => setCreating(true)}><Plus /> New task</Button>
        </>} />
      <Card className={view === 'board' ? 'mb-4' : ''}>
        <Toolbar className={view === 'board' ? 'border-0' : ''}>
          <SearchInput value={list.q} onChange={list.setQ} placeholder="Search tasks" className="w-full sm:w-64" />
          {view === 'list' && <Select value={list.filters.status} onChange={(e) => list.setFilter('status', e.target.value)} className="w-36"><option value="open">Open</option><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select>}
          <Select value={list.filters.assignee} onChange={(e) => list.setFilter('assignee', e.target.value)} className="w-40"><option value="me">Assigned to me</option>{can('tasks.assign') && <option value="">Everyone</option>}</Select>
          <Select value={list.filters.type} onChange={(e) => list.setFilter('type', e.target.value)} className="w-36"><option value="">All types</option><option value="PROJECT">Project</option>{can('leads.read') && <option value="FOLLOW_UP">Follow-up</option>}<option value="FEEDBACK">Feedback</option><option value="GENERAL">General</option></Select>
          <Select value={list.filters.due} onChange={(e) => list.setFilter('due', e.target.value)} className="w-36"><option value="">Any due date</option><option value="overdue">Overdue</option><option value="today">Due today</option></Select>
        </Toolbar>
        {view === 'list' && (list.isLoading ? <LoadingBlock /> : list.error ? <ErrorState error={list.error} /> : !list.data?.items.length ? <EmptyState icon={<CheckSquare />} title="No tasks" /> : (
          <>
            <Table><THead><tr><TH>Task</TH><TH>Status</TH><TH>Priority</TH><TH>Due</TH><TH>Assignee</TH><TH>Related</TH></tr></THead><TBody>
              {list.data.items.map((t) => {
                const overdue = t.dueDate && new Date(t.dueDate) < new Date() && !['DONE', 'CANCELLED'].includes(t.status);
                return (
                  <TR key={t.id} onClick={() => setSelected(t)}>
                    <TD><p className={cn('font-medium', t.status === 'DONE' && 'text-muted line-through')}>{t.title}</p>{t.automated && <Badge tone="violet" className="mt-1">Auto follow-up</Badge>}</TD>
                    <TD><StatusBadge status={t.status} /></TD><TD><StatusBadge status={t.priority} /></TD>
                    <TD className={overdue ? 'font-medium text-red-600' : 'text-slate-600'}>{fmtDate(t.dueDate)}</TD>
                    <TD className="text-slate-600">{memberName(members.data, t.assigneeId)}</TD>
                    <TD className="text-slate-600">{t.project ? `${t.project.code}` : t.lead ? t.lead.name : t.customer?.name ?? '—'}</TD>
                  </TR>
                );
              })}
            </TBody></Table>
            <Pagination page={list.page} pages={list.data.pages} total={list.data.total} onPage={list.setPage} />
          </>
        ))}
      </Card>
      {view === 'board' && (list.isLoading ? <Card><LoadingBlock /></Card> : (
        <div className="scrollbar-thin flex gap-4 overflow-x-auto pb-4">
          {STATUSES.filter((s) => s !== 'CANCELLED').map((s) => (
            <div key={s} className="w-72 shrink-0 rounded-xl bg-slate-100/70" onDragOver={(e) => e.preventDefault()} onDrop={() => { if (drag) move.mutate({ id: drag, status: s }); setDrag(null); }}>
              <div className="px-3 py-2.5"><StatusBadge status={s} /></div>
              <div className="flex min-h-24 flex-col gap-2 px-2 pb-2">
                {list.data?.items.filter((t) => t.status === s).map((t) => (
                  <div key={t.id} draggable onDragStart={() => setDrag(t.id)} onClick={() => setSelected(t)} className="cursor-pointer rounded-lg border border-line bg-surface p-3 shadow-xs hover:border-brand-300">
                    <p className="text-sm font-medium">{t.title}</p>
                    <div className="mt-2 flex items-center justify-between text-xs text-muted"><StatusBadge status={t.priority} /><span>{fmtDate(t.dueDate, { day: '2-digit', month: 'short' })}</span></div>
                    <p className="mt-1 truncate text-[11px] text-slate-500">{memberName(members.data, t.assigneeId)}{t.project && ` · ${t.project.code}`}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
      <TaskSheet task={selected} open={!!selected} onOpenChange={(v) => { if (!v) { setSelected(null); if (openId) setParams({}); } }} />
      <TaskSheet open={creating} onOpenChange={setCreating} />
    </>
  );
}
