import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, FolderKanban, Link2, Plus, Trash2, UserPlus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useCustomerOptions, useList, useMembers, memberName } from '@/lib/hooks';
import type { Milestone, Project, Task } from '@/lib/types';
import { fmtDate, inr, titleCase, toDateInput } from '@/lib/utils';
import {
  Avatar, Badge, Button, Card, CardHeader, ConfirmDialog, DescList, Dialog, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Pagination,
  Progress, SearchInput, Select, StatusBadge, Table, TBody, TD, TH, THead, Toolbar, TR, Tabs, TabsContent, TabsList, TabsTrigger, Textarea,
} from '@/components/ui';
import { AssigneeSelect, FileManager } from '@/components/shared';
import { TaskSheet } from './tasks';
import { SERVICES } from './crm';

const PROJECT_STATUSES = ['PLANNING', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];

function ProjectFormDialog({ open, onOpenChange, project, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; project?: Project; onSaved?: (p: Project) => void }) {
  const customers = useCustomerOptions(open);
  const [f, setF] = useState<Partial<Project>>({});
  useEffect(() => { if (open) setF(project ? { ...project, startDate: toDateInput(project.startDate), dueDate: toDateInput(project.dueDate) } : { status: 'PLANNING' }); }, [open, project]);
  const save = useAction(() => {
    const body = { name: f.name, customerId: f.customerId || null, serviceCategory: f.serviceCategory || null, status: f.status, description: f.description, startDate: f.startDate || null, dueDate: f.dueDate || null, budget: f.budget === '' || f.budget == null ? null : Number(f.budget), managerId: f.managerId, billingMethod: f.billingMethod ?? 'FIXED', hourlyRate: f.hourlyRate === '' || f.hourlyRate == null ? null : Number(f.hourlyRate) };
    return project ? api.patch<Project>(`/projects/${project.id}`, body) : api.post<Project>('/projects', body);
  }, { success: 'Project saved', invalidate: [['/projects'], ['project'], ['projects-options']], onSuccess: (p) => { onOpenChange(false); onSaved?.(p); } });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={project ? 'Edit project' : 'New project'} size="lg"
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!f.name}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Project name" required className="sm:col-span-2"><Input value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Customer"><Select value={f.customerId ?? ''} onChange={(e) => setF({ ...f, customerId: e.target.value })}><option value="">Internal / none</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.company ?? c.name}</option>)}</Select></Field>
        <Field label="Service category"><Select value={f.serviceCategory ?? ''} onChange={(e) => setF({ ...f, serviceCategory: e.target.value })}><option value="">—</option>{SERVICES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
        <Field label="Start date"><Input type="date" value={(f.startDate as string) ?? ''} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
        <Field label="Due date"><Input type="date" value={(f.dueDate as string) ?? ''} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></Field>
        <Field label="Status"><Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{PROJECT_STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select></Field>
        <Field label="Budget (₹)"><Input type="number" min={0} value={(f.budget as string) ?? ''} onChange={(e) => setF({ ...f, budget: e.target.value })} /></Field>
        <Field label="Project manager"><AssigneeSelect value={f.managerId} onChange={(v) => setF({ ...f, managerId: v })} /></Field>
        <Field label="Billing method"><Select value={f.billingMethod ?? 'FIXED'} onChange={(e) => setF({ ...f, billingMethod: e.target.value })}><option value="FIXED">Fixed cost for project</option><option value="PROJECT_HOURS">Based on project hours</option></Select></Field>
        <Field label="Hourly rate (Rs)" hint="Used when invoicing logged time"><Input type="number" min={0} value={(f.hourlyRate ?? '') as string} onChange={(e) => setF({ ...f, hourlyRate: e.target.value })} /></Field>
        <Field label="Description" className="sm:col-span-2"><Textarea rows={3} value={f.description ?? ''} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

export function ProjectsList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const list = useList<Project>('/projects', { status: '' }, { sort: 'createdAt' });
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Projects" description={can('projects.read') ? 'All client and internal projects.' : 'Projects you are a member of.'}
        actions={can('projects.update') && <Button onClick={() => setCreating(true)}><Plus /> New project</Button>} />
      <Card>
        <Toolbar>
          <SearchInput value={list.q} onChange={list.setQ} placeholder="Search projects" className="w-full sm:w-72" />
          <Select value={list.filters.status} onChange={(e) => list.setFilter('status', e.target.value)} className="w-40"><option value="">All statuses</option>{PROJECT_STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select>
        </Toolbar>
        {list.isLoading ? <LoadingBlock /> : list.error ? <ErrorState error={list.error} /> : !list.data?.items.length ? <EmptyState icon={<FolderKanban />} title="No projects" /> : (
          <>
            <Table><THead><tr><TH>Project</TH><TH>Customer</TH><TH>Status</TH><TH className="w-48">Progress</TH><TH>Due</TH><TH className="text-right">Tasks</TH></tr></THead><TBody>
              {list.data.items.map((p) => (
                <TR key={p.id} onClick={() => navigate(`/projects/${p.id}`)}>
                  <TD><p className="font-medium">{p.name}</p><p className="text-xs text-muted">{p.code}{p.serviceCategory && ` · ${p.serviceCategory}`}</p></TD>
                  <TD className="text-slate-600">{p.customer?.company ?? p.customer?.name ?? 'Internal'}</TD>
                  <TD><StatusBadge status={p.status} /></TD>
                  <TD><div className="flex items-center gap-2"><Progress value={p.progress ?? 0} /><span className="w-9 text-right text-xs tabular-nums text-muted">{p.progress ?? 0}%</span></div></TD>
                  <TD className={p.dueDate && new Date(p.dueDate) < new Date() && ['PLANNING', 'IN_PROGRESS'].includes(p.status) ? 'font-medium text-red-600' : 'text-slate-600'}>{fmtDate(p.dueDate)}</TD>
                  <TD className="text-right tabular-nums">{p._count?.tasks ?? 0}</TD>
                </TR>
              ))}
            </TBody></Table>
            <Pagination page={list.page} pages={list.data.pages} total={list.data.total} onPage={list.setPage} />
          </>
        )}
      </Card>
      <ProjectFormDialog open={creating} onOpenChange={setCreating} onSaved={(p) => navigate(`/projects/${p.id}`)} />
    </>
  );
}

interface ProjectDetailData extends Project {
  members: { id: string; userId: string; role: string | null; user: { name: string; email: string } | null }[];
  milestones: (Milestone & { _count: { tasks: number } })[];
  taskStats: Record<string, number>;
}

export function ProjectDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['project', id], queryFn: () => api.get<ProjectDetailData>(`/projects/${id}`) });
  const tasks = useQuery({ queryKey: ['/tasks', { projectId: id }], queryFn: () => api.get<{ items: Task[] }>('/tasks', { projectId: id, pageSize: 200, sort: 'dueDate', dir: 'asc' }) });
  const members = useMembers();
  const [editing, setEditing] = useState(false);
  const [task, setTask] = useState<Task | null>(null);
  const [newTask, setNewTask] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const del = useAction(() => api.delete<{ cancelled?: boolean }>(`/projects/${id}`), { success: (r) => (r.cancelled ? 'Project has invoices, so it was cancelled instead' : 'Project deleted'), invalidate: [['/projects']], onSuccess: () => navigate('/projects') });
  if (q.isLoading) return <Card><LoadingBlock rows={8} /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} onRetry={q.refetch} /></Card>;
  const p = q.data;
  const totalTasks = Object.entries(p.taskStats).filter(([k]) => k !== 'CANCELLED').reduce((s, [, v]) => s + v, 0);
  const progress = totalTasks ? Math.round(((p.taskStats.DONE ?? 0) / totalTasks) * 100) : 0;
  return (
    <>
      <PageHeader breadcrumb={<Link to="/projects" className="hover:underline">Projects</Link>}
        title={<span className="flex items-center gap-3">{p.name}<StatusBadge status={p.status} /></span>}
        description={`${p.code}${p.customer ? ` · ${p.customer.company ?? p.customer.name}` : ''}`}
        actions={can('projects.update') && <><Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button><Button variant="ghost" size="icon" aria-label="Delete project" onClick={() => setDeleting(true)}><Trash2 /></Button></>} />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card className="p-4"><p className="text-[13px] text-muted">Progress</p><p className="mt-1 text-xl font-semibold">{progress}%</p><Progress value={progress} className="mt-2" /></Card>
        <Card className="p-4"><p className="text-[13px] text-muted">Open tasks</p><p className="mt-1 text-xl font-semibold">{totalTasks - (p.taskStats.DONE ?? 0)}</p></Card>
        <Card className="p-4"><p className="text-[13px] text-muted">Due date</p><p className="mt-1 text-xl font-semibold">{fmtDate(p.dueDate)}</p></Card>
        <Card className="p-4"><p className="text-[13px] text-muted">{p.budget != null ? 'Budget' : 'Team'}</p><p className="mt-1 text-xl font-semibold tabular-nums">{p.budget != null ? inr(p.budget) : p.members.length}</p></Card>
      </div>
      <Tabs defaultValue="tasks">
        <TabsList>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          <TabsTrigger value="milestones">Milestones ({p.milestones.length})</TabsTrigger>
          <TabsTrigger value="team">Team ({p.members.length})</TabsTrigger>
          <TabsTrigger value="overview">Details</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          {can('feedback.read') && <TabsTrigger value="feedback">Feedback links</TabsTrigger>}
        </TabsList>
        <TabsContent value="tasks">
          <Card>
            <CardHeader title="Tasks" actions={<Button size="sm" onClick={() => setNewTask(true)}><Plus /> Add task</Button>} />
            {tasks.isLoading ? <LoadingBlock /> : !tasks.data?.items.length ? <EmptyState title="No tasks yet" /> : (
              <Table><THead><tr><TH>Task</TH><TH>Status</TH><TH>Priority</TH><TH>Milestone</TH><TH>Assignee</TH><TH>Due</TH></tr></THead><TBody>
                {tasks.data.items.map((t) => (
                  <TR key={t.id} onClick={() => setTask(t)}>
                    <TD className="font-medium">{t.title}</TD><TD><StatusBadge status={t.status} /></TD><TD><StatusBadge status={t.priority} /></TD>
                    <TD className="text-slate-600">{t.milestone?.title ?? '—'}</TD><TD className="text-slate-600">{memberName(members.data, t.assigneeId)}</TD><TD className="text-slate-600">{fmtDate(t.dueDate)}</TD>
                  </TR>
                ))}
              </TBody></Table>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="milestones"><MilestonesPanel projectId={p.id} milestones={p.milestones} /></TabsContent>
        <TabsContent value="team"><TeamPanel project={p} /></TabsContent>
        <TabsContent value="overview">
          <Card className="p-5">
            <DescList items={[
              ['Customer', p.customer ? <Link to={`/customers/${p.customer.id}`} className="text-brand-700 hover:underline">{p.customer.company ?? p.customer.name}</Link> : 'Internal'],
              ['Service', p.serviceCategory], ['Start', fmtDate(p.startDate)], ['Due', fmtDate(p.dueDate)],
              ['Manager', memberName(members.data, p.managerId)], ['Created', fmtDate(p.createdAt)],
            ]} />
            {p.description && <p className="mt-5 whitespace-pre-wrap border-t border-line pt-4 text-sm">{p.description}</p>}
          </Card>
        </TabsContent>
        <TabsContent value="files"><Card className="p-5"><FileManager entityType="project" entityId={p.id} allowCustomerVisibility={can('projects.update')} /></Card></TabsContent>
        {can('feedback.read') && <TabsContent value="feedback"><FeedbackLinksPanel projectId={p.id} serviceCategory={p.serviceCategory} /></TabsContent>}
      </Tabs>
      <ProjectFormDialog open={editing} onOpenChange={setEditing} project={p} />
      <TaskSheet task={task} open={!!task} onOpenChange={(v) => !v && setTask(null)} />
      <TaskSheet open={newTask} onOpenChange={setNewTask} defaults={{ projectId: p.id, type: 'PROJECT' }} />
      <ConfirmDialog open={deleting} onOpenChange={setDeleting} title="Delete this project?" danger confirmLabel="Delete" loading={del.isPending} onConfirm={() => del.mutate()} description="Tasks and milestones are deleted. Projects with invoices are cancelled instead." />
    </>
  );
}

function MilestonesPanel({ projectId, milestones }: { projectId: string; milestones: (Milestone & { _count: { tasks: number } })[] }) {
  const { can } = useAuth();
  const [form, setForm] = useState({ title: '', dueDate: '' });
  const add = useAction(() => api.post('/milestones', { projectId, title: form.title, dueDate: form.dueDate || null }), { success: 'Milestone added', invalidate: [['project'], ['/milestones']], onSuccess: () => setForm({ title: '', dueDate: '' }) });
  const update = useAction(({ id, status }: { id: string; status: string }) => api.patch(`/milestones/${id}`, { status }), { invalidate: [['project'], ['/milestones']] });
  const remove = useAction((id: string) => api.delete(`/milestones/${id}`), { invalidate: [['project'], ['/milestones']] });
  return (
    <Card>
      {milestones.length === 0 ? <EmptyState title="No milestones" /> : (
        <ul className="divide-y divide-line">
          {milestones.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <span className="min-w-48 flex-1 text-sm font-medium">{m.title}</span>
              <span className="text-xs text-muted">{m._count.tasks} tasks · due {fmtDate(m.dueDate)}</span>
              {can('projects.update') ? (
                <Select value={m.status} onChange={(e) => update.mutate({ id: m.id, status: e.target.value })} className="w-36"><option value="PENDING">Pending</option><option value="IN_PROGRESS">In progress</option><option value="DONE">Done</option></Select>
              ) : <StatusBadge status={m.status} />}
              {can('projects.update') && <Button variant="ghost" size="icon" className="size-8 text-slate-400" aria-label="Delete milestone" onClick={() => remove.mutate(m.id)}><Trash2 /></Button>}
            </li>
          ))}
        </ul>
      )}
      {can('projects.update') && (
        <form className="flex flex-wrap gap-2 border-t border-line p-4" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Input className="min-w-48 flex-1" placeholder="Milestone title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <Input type="date" className="w-40" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
          <Button type="submit" disabled={!form.title} loading={add.isPending}>Add milestone</Button>
        </form>
      )}
    </Card>
  );
}

function TeamPanel({ project }: { project: ProjectDetailData }) {
  const { can } = useAuth();
  const [userId, setUserId] = useState<string | null>(null);
  const [role, setRole] = useState('');
  const add = useAction(() => api.post(`/projects/${project.id}/members`, { userId, role: role || undefined }), { success: 'Member added', invalidate: [['project']], onSuccess: () => { setUserId(null); setRole(''); } });
  const remove = useAction((uid: string) => api.delete(`/projects/${project.id}/members/${uid}`), { success: 'Member removed', invalidate: [['project']] });
  return (
    <Card>
      <ul className="divide-y divide-line">
        {project.members.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-5 py-3">
            <Avatar name={m.user?.name} />
            <div className="min-w-0 flex-1"><p className="text-sm font-medium">{m.user?.name ?? 'Former member'}</p><p className="text-xs text-muted">{m.user?.email}</p></div>
            {m.role && <Badge>{m.role}</Badge>}
            {can('projects.update') && <Button variant="ghost" size="sm" className="text-red-600" onClick={() => remove.mutate(m.userId)}>Remove</Button>}
          </li>
        ))}
      </ul>
      {can('projects.update') && (
        <div className="flex flex-wrap gap-2 border-t border-line p-4">
          <div className="min-w-56 flex-1"><AssigneeSelect value={userId} onChange={setUserId} /></div>
          <Input className="w-48" placeholder="Role (e.g. Developer)" value={role} onChange={(e) => setRole(e.target.value)} />
          <Button onClick={() => add.mutate()} disabled={!userId} loading={add.isPending}><UserPlus /> Add to project</Button>
        </div>
      )}
    </Card>
  );
}

function FeedbackLinksPanel({ projectId, serviceCategory }: { projectId: string; serviceCategory: string | null }) {
  const { can } = useAuth();
  const links = useQuery({ queryKey: ['/feedback-links', projectId], queryFn: () => api.get<{ id: string; url: string; active: boolean; useCount: number; expiresAt: string | null; createdAt: string }[]>('/feedback-links', { projectId }) });
  const create = useAction(() => api.post('/feedback-links', { projectId, serviceCategory: serviceCategory ?? undefined, expiresInDays: 90 }), { success: 'Secure link created', invalidate: [['/feedback-links']] });
  const toggle = useAction(({ id, active }: { id: string; active: boolean }) => api.patch(`/feedback-links/${id}`, { active }), { invalidate: [['/feedback-links']] });
  return (
    <Card>
      <CardHeader title="Secure feedback links" description="Share with the customer. Links reveal only the project name, never private records."
        actions={can('feedback.resolve') && <Button size="sm" onClick={() => create.mutate()} loading={create.isPending}><Link2 /> Create link</Button>} />
      {links.isLoading ? <LoadingBlock rows={2} /> : !links.data?.length ? <EmptyState title="No links yet" /> : (
        <ul className="divide-y divide-line">
          {links.data.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              <code className="min-w-0 flex-1 truncate rounded bg-slate-50 px-2 py-1 text-xs">{l.url}</code>
              <Button variant="ghost" size="sm" onClick={() => { navigator.clipboard.writeText(l.url); toast.success('Link copied'); }}><Copy /> Copy</Button>
              <span className="text-xs text-muted">{l.useCount} submissions · {l.expiresAt ? `expires ${fmtDate(l.expiresAt)}` : 'no expiry'}</span>
              {can('feedback.resolve') ? <Button variant="secondary" size="sm" onClick={() => toggle.mutate({ id: l.id, active: !l.active })}>{l.active ? 'Disable' : 'Enable'}</Button> : <StatusBadge status={l.active ? 'ACTIVE' : 'DISABLED'} />}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function MilestonesPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['/milestones', 'all', status], queryFn: () => api.get<Milestone[]>('/milestones', { status }) });
  return (
    <>
      <PageHeader title="Milestones" description="Upcoming delivery milestones across projects." />
      <Card>
        <Toolbar><Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40"><option value="">All</option><option value="PENDING">Pending</option><option value="IN_PROGRESS">In progress</option><option value="DONE">Done</option></Select></Toolbar>
        {q.isLoading ? <LoadingBlock /> : q.error ? <ErrorState error={q.error} /> : !q.data?.length ? <EmptyState title="No milestones" /> : (
          <Table><THead><tr><TH>Milestone</TH><TH>Project</TH><TH>Status</TH><TH className="w-48">Tasks done</TH><TH>Due</TH></tr></THead><TBody>
            {q.data.map((m) => (
              <TR key={m.id} onClick={() => navigate(`/projects/${m.projectId}`)}>
                <TD className="font-medium">{m.title}</TD><TD className="text-slate-600">{m.project?.code} · {m.project?.name}</TD><TD><StatusBadge status={m.status} /></TD>
                <TD><div className="flex items-center gap-2"><Progress value={m.taskCount ? ((m.doneCount ?? 0) / m.taskCount) * 100 : 0} /><span className="text-xs tabular-nums text-muted">{m.doneCount}/{m.taskCount}</span></div></TD>
                <TD className={m.dueDate && new Date(m.dueDate) < new Date() && m.status !== 'DONE' ? 'font-medium text-red-600' : 'text-slate-600'}>{fmtDate(m.dueDate)}</TD>
              </TR>
            ))}
          </TBody></Table>
        )}
      </Card>
    </>
  );
}

export function TeamPage() {
  const q = useQuery({ queryKey: ['/team-assignments'], queryFn: () => api.get<{ userId: string; name: string; email: string; role: string; title: string | null; openTasks: number; projects: { id: string; code: string; name: string; status: string; memberRole: string | null }[] }[]>('/team-assignments') });
  return (
    <>
      <PageHeader title="Team assignments" description="Who is working on what, and their current open task load." />
      {q.isLoading ? <Card><LoadingBlock /></Card> : q.error ? <Card><ErrorState error={q.error} /></Card> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {q.data!.map((u) => (
            <Card key={u.userId} className="p-5">
              <div className="flex items-center gap-3">
                <Avatar name={u.name} className="size-10 text-sm" />
                <div className="min-w-0 flex-1"><p className="truncate font-medium">{u.name}</p><p className="truncate text-xs text-muted">{u.role}</p></div>
                <Badge tone={u.openTasks > 10 ? 'red' : u.openTasks > 5 ? 'amber' : 'gray'}>{u.openTasks} open tasks</Badge>
              </div>
              <ul className="mt-4 space-y-1.5">
                {u.projects.length === 0 && <li className="text-sm text-muted">No active projects</li>}
                {u.projects.map((p) => <li key={p.id}><Link to={`/projects/${p.id}`} className="flex items-center gap-2 text-sm hover:text-brand-700"><StatusBadge status={p.status} /><span className="truncate">{p.name}</span>{p.memberRole && <span className="ml-auto shrink-0 text-xs text-muted">{p.memberRole}</span>}</Link></li>)}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

export function FilesPage() {
  return (
    <>
      <PageHeader title="Files" description="Shared company documents. Project, customer and ticket files live on those records and follow their access rules." />
      <Card className="p-5"><FileManager entityType="general" /></Card>
    </>
  );
}
