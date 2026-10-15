import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, LifeBuoy, Lock, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useCategories, useCustomerOptions, useList, useMembers, useProjectOptions, memberName } from '@/lib/hooks';
import type { Ticket } from '@/lib/types';
import { cn, fmtDate, fmtDateTime, timeAgo, titleCase } from '@/lib/utils';
import {
  Avatar, Badge, Button, Card, CardHeader, DescList, Dialog, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Pagination,
  SearchInput, Select, StatusBadge, Switch, Table, TBody, TD, TH, THead, Toolbar, TR, Textarea,
} from '@/components/ui';
import { AssigneeSelect, FileManager } from '@/components/shared';

const STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'];
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

function NewTicketDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const customers = useCustomerOptions(open && can('customers.read'));
  const projects = useProjectOptions(open);
  const categories = useCategories();
  const [f, setF] = useState<Record<string, string | null>>({ priority: 'MEDIUM' });
  useEffect(() => { if (open) setF({ priority: 'MEDIUM' }); }, [open]);
  const save = useAction(() => api.post<Ticket>('/tickets', { ...f, customerId: f.customerId || null, projectId: f.projectId || null, categoryId: f.categoryId || null }), {
    success: (t) => `Ticket ${t.number} created`, invalidate: [['/tickets']], onSuccess: (t) => navigate(`/tickets/${t.id}`),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New support ticket" size="lg"
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!f.subject || !f.description}>Create ticket</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Subject" required className="sm:col-span-2"><Input value={f.subject ?? ''} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
        <Field label="Description" required className="sm:col-span-2"><Textarea rows={5} value={f.description ?? ''} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        {can('customers.read') && <Field label="Customer"><Select value={f.customerId ?? ''} onChange={(e) => setF({ ...f, customerId: e.target.value })}><option value="">—</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.company ?? c.name}</option>)}</Select></Field>}
        <Field label="Project"><Select value={f.projectId ?? ''} onChange={(e) => setF({ ...f, projectId: e.target.value })}><option value="">—</option>{projects.data?.filter((p) => !f.customerId || p.customerId === f.customerId).map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</Select></Field>
        <Field label="Category"><Select value={f.categoryId ?? ''} onChange={(e) => setF({ ...f, categoryId: e.target.value })}><option value="">—</option>{categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        <Field label="Priority"><Select value={f.priority ?? 'MEDIUM'} onChange={(e) => setF({ ...f, priority: e.target.value })}>{PRIORITIES.map((p) => <option key={p} value={p}>{titleCase(p)}</option>)}</Select></Field>
        {can('tickets.assign') && <Field label="Assignee"><AssigneeSelect value={f.assigneeId} onChange={(v) => setF({ ...f, assigneeId: v })} /></Field>}
      </div>
    </Dialog>
  );
}

function TicketTable({ mine }: { mine?: boolean }) {
  const navigate = useNavigate();
  const members = useMembers();
  const categories = useCategories();
  const { can } = useAuth();
  const list = useList<Ticket>('/tickets', { status: 'open', priority: '', categoryId: '', mine: mine ? '1' : '', unassigned: '', overdue: '' }, { sort: 'updatedAt' });
  return (
    <Card>
      <Toolbar>
        <SearchInput value={list.q} onChange={list.setQ} placeholder="Search tickets" className="w-full sm:w-64" />
        <Select value={list.filters.status} onChange={(e) => list.setFilter('status', e.target.value)} className="w-44"><option value="open">Open (all active)</option><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select>
        <Select value={list.filters.priority} onChange={(e) => list.setFilter('priority', e.target.value)} className="w-36"><option value="">Any priority</option>{PRIORITIES.map((p) => <option key={p} value={p}>{titleCase(p)}</option>)}</Select>
        <Select value={list.filters.categoryId} onChange={(e) => list.setFilter('categoryId', e.target.value)} className="w-44"><option value="">All categories</option>{categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        {!mine && can('tickets.assign') && <label className="flex items-center gap-2 text-[13px] text-slate-600"><input type="checkbox" checked={list.filters.unassigned === '1'} onChange={(e) => list.setFilter('unassigned', e.target.checked ? '1' : '')} /> Unassigned</label>}
        <label className="flex items-center gap-2 text-[13px] text-slate-600"><input type="checkbox" checked={list.filters.overdue === '1'} onChange={(e) => list.setFilter('overdue', e.target.checked ? '1' : '')} /> Past SLA</label>
      </Toolbar>
      {list.isLoading ? <LoadingBlock /> : list.error ? <ErrorState error={list.error} /> : !list.data?.items.length ? <EmptyState icon={<LifeBuoy />} title="No tickets" /> : (
        <>
          <Table><THead><tr><TH>Ticket</TH><TH>Customer</TH><TH>Priority</TH><TH>Status</TH><TH>Assignee</TH><TH>SLA due</TH><TH>Updated</TH></tr></THead><TBody>
            {list.data.items.map((t) => {
              const breached = t.dueAt && new Date(t.dueAt) < new Date() && ['OPEN', 'IN_PROGRESS'].includes(t.status);
              return (
                <TR key={t.id} onClick={() => navigate(`/tickets/${t.id}`)}>
                  <TD><p className="font-medium">{t.subject}</p><p className="text-xs text-muted">{t.number}{t.category && ` · ${t.category.name}`}</p></TD>
                  <TD className="text-slate-600">{t.customer?.name ?? '—'}</TD>
                  <TD><StatusBadge status={t.priority} /></TD><TD><StatusBadge status={t.status} /></TD>
                  <TD className="text-slate-600">{memberName(members.data, t.assigneeId)}</TD>
                  <TD className={breached ? 'font-medium text-red-600' : 'text-slate-600'}>{t.dueAt ? fmtDateTime(t.dueAt) : '—'}</TD>
                  <TD className="text-slate-600">{timeAgo(t.updatedAt)}</TD>
                </TR>
              );
            })}
          </TBody></Table>
          <Pagination page={list.page} pages={list.data.pages} total={list.data.total} onPage={list.setPage} />
        </>
      )}
    </Card>
  );
}

export function TicketsPage() {
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Support tickets" description="Customer issues and change requests with SLA tracking." actions={can('tickets.update') && <Button onClick={() => setCreating(true)}><Plus /> New ticket</Button>} />
      <TicketTable />
      <NewTicketDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

export function MyTicketsPage() {
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="My tickets" description="Tickets assigned to you." actions={can('tickets.update') && <Button onClick={() => setCreating(true)}><Plus /> New ticket</Button>} />
      <TicketTable mine />
      <NewTicketDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

interface TicketDetailData extends Ticket { comments: { id: string; body: string; isInternal: boolean; userId: string | null; createdAt: string }[] }

export function TicketDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const members = useMembers();
  const categories = useCategories();
  const q = useQuery({ queryKey: ['ticket', id], queryFn: () => api.get<TicketDetailData>(`/tickets/${id}`) });
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const update = useAction((b: object) => api.patch(`/tickets/${id}`, b), { success: 'Ticket updated', invalidate: [['ticket'], ['/tickets']] });
  const comment = useAction(() => api.post(`/tickets/${id}/comments`, { body, isInternal: internal }), { success: internal ? 'Internal note added' : 'Reply sent', invalidate: [['ticket'], ['/tickets']], onSuccess: () => setBody('') });
  if (q.isLoading) return <Card><LoadingBlock rows={8} /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} onRetry={q.refetch} /></Card>;
  const t = q.data;
  const canUpdate = can('tickets.update');
  return (
    <>
      <PageHeader breadcrumb={<Link to="/tickets" className="hover:underline">Support tickets</Link>}
        title={<span className="flex flex-wrap items-center gap-3">{t.subject}<StatusBadge status={t.status} /></span>} description={`${t.number} · opened ${fmtDateTime(t.createdAt)}`} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card className="p-5"><p className="whitespace-pre-wrap text-sm">{t.description}</p></Card>
          <Card>
            <CardHeader title="Conversation" />
            <ol className="space-y-4 p-5">
              {t.comments.length === 0 && <li className="text-sm text-muted">No replies yet.</li>}
              {t.comments.map((c) => (
                <li key={c.id} className="flex gap-3">
                  <Avatar name={memberName(members.data, c.userId) === 'Former member' ? 'Customer' : memberName(members.data, c.userId)} />
                  <div className={cn('min-w-0 flex-1 rounded-lg border p-3', c.isInternal ? 'border-amber-100 bg-amber-50/50' : 'border-line')}>
                    <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
                      <span className="font-medium text-ink">{members.data?.some((m) => m.id === c.userId) ? memberName(members.data, c.userId) : 'Customer'}</span>
                      {fmtDateTime(c.createdAt)}{c.isInternal && <Badge tone="amber"><Lock className="size-3" /> Internal</Badge>}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{c.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            {canUpdate && (
              <div className="border-t border-line p-5">
                <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder={internal ? 'Internal note (not visible to the customer)' : 'Reply to the customer'} />
                <div className="mt-2 flex items-center justify-between">
                  <label className="flex items-center gap-2 text-sm text-slate-600"><Switch checked={internal} onCheckedChange={setInternal} /> Internal note</label>
                  <Button onClick={() => comment.mutate()} loading={comment.isPending} disabled={!body.trim()}>{internal ? 'Add note' : 'Send reply'}</Button>
                </div>
              </div>
            )}
          </Card>
          <Card><CardHeader title="Attachments" /><div className="p-5"><FileManager entityType="ticket" entityId={t.id} allowCustomerVisibility /></div></Card>
        </div>
        <div className="space-y-6">
          <Card className="space-y-4 p-5">
            <Field label="Status"><Select value={t.status} disabled={!canUpdate} onChange={(e) => update.mutate({ status: e.target.value })}>{STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select></Field>
            <Field label="Priority"><Select value={t.priority} disabled={!canUpdate} onChange={(e) => update.mutate({ priority: e.target.value })}>{PRIORITIES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select></Field>
            <Field label="Assignee"><AssigneeSelect value={t.assigneeId} disabled={!can('tickets.assign')} onChange={(v) => update.mutate({ assigneeId: v })} /></Field>
            <Field label="Category"><Select value={t.categoryId ?? ''} disabled={!canUpdate} onChange={(e) => update.mutate({ categoryId: e.target.value || null })}><option value="">—</option>{categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          </Card>
          <Card className="p-5">
            <DescList className="sm:grid-cols-1" items={[
              ['Customer', t.customer ? (can('customers.read') ? <Link to={`/customers/${t.customer.id}`} className="text-brand-700 hover:underline">{t.customer.name}</Link> : t.customer.name) : null],
              ['Contact', t.customer?.email ?? t.customer?.phone], ['Project', t.project ? `${t.project.code} · ${t.project.name}` : null],
              ['SLA due', t.dueAt ? fmtDateTime(t.dueAt) : null], ['Resolved', t.resolvedAt ? fmtDateTime(t.resolvedAt) : null],
            ]} />
          </Card>
        </div>
      </div>
    </>
  );
}

export function CategoriesPage() {
  const categories = useCategories();
  const [f, setF] = useState({ name: '', slaHours: '48' });
  const add = useAction(() => api.post('/ticket-categories', { name: f.name, slaHours: Number(f.slaHours) }), { success: 'Category added', invalidate: [['ticket-categories']], onSuccess: () => setF({ name: '', slaHours: '48' }) });
  const upd = useAction(({ id, slaHours }: { id: string; slaHours: number }) => api.patch(`/ticket-categories/${id}`, { slaHours }), { success: 'SLA updated', invalidate: [['ticket-categories']] });
  const del = useAction((id: string) => api.delete(`/ticket-categories/${id}`), { success: 'Category deleted', invalidate: [['ticket-categories']] });
  return (
    <>
      <PageHeader title="Ticket categories" description="Categories set the SLA target. Urgent tickets get a quarter of the time, high priority half, low priority double." />
      <Card className="max-w-3xl">
        {categories.isLoading ? <LoadingBlock /> : (
          <Table><THead><tr><TH>Category</TH><TH>SLA (hours)</TH><TH className="text-right">Tickets</TH><TH /></tr></THead><TBody>
            {categories.data?.map((c) => (
              <TR key={c.id}>
                <TD className="font-medium">{c.name}</TD>
                <TD><Input type="number" min={1} defaultValue={c.slaHours} className="w-24" onBlur={(e) => Number(e.target.value) !== c.slaHours && upd.mutate({ id: c.id, slaHours: Number(e.target.value) })} /></TD>
                <TD className="text-right tabular-nums">{c._count.tickets}</TD>
                <TD className="text-right"><Button variant="ghost" size="icon" className="size-8 text-slate-400 hover:text-red-600" aria-label="Delete category" onClick={() => del.mutate(c.id)}><Trash2 /></Button></TD>
              </TR>
            ))}
          </TBody></Table>
        )}
        <form className="flex flex-wrap gap-2 border-t border-line p-4" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Input className="min-w-48 flex-1" placeholder="New category name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Input type="number" min={1} className="w-28" value={f.slaHours} onChange={(e) => setF({ ...f, slaHours: e.target.value })} aria-label="SLA hours" />
          <Button type="submit" disabled={!f.name} loading={add.isPending}>Add</Button>
        </form>
      </Card>
    </>
  );
}

interface Article { id: string; title: string; slug: string; published: boolean; updatedAt: string; category: { id: string; name: string } | null; excerpt?: string; body?: string; categoryId?: string | null }

function ArticleDialog({ open, onOpenChange, article }: { open: boolean; onOpenChange: (v: boolean) => void; article?: Article | null }) {
  const categories = useCategories();
  const [f, setF] = useState<Partial<Article>>({});
  useEffect(() => { if (open) setF(article ? { ...article, categoryId: article.category?.id ?? null } : { published: true }); }, [open, article]);
  const save = useAction(() => {
    const body = { title: f.title, body: f.body, categoryId: f.categoryId || null, published: f.published };
    return article ? api.patch(`/kb/${article.id}`, body) : api.post('/kb', body);
  }, { success: 'Article saved', invalidate: [['/kb'], ['kb']], onSuccess: () => onOpenChange(false) });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={article ? 'Edit article' : 'New article'} size="xl"
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!f.title || !f.body}>Save</Button></>}>
      <div className="space-y-4">
        <Field label="Title" required><Input value={f.title ?? ''} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Category"><Select value={f.categoryId ?? ''} onChange={(e) => setF({ ...f, categoryId: e.target.value })}><option value="">—</option>{categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          <label className="flex items-end gap-2 pb-2 text-sm"><Switch checked={!!f.published} onCheckedChange={(v) => setF({ ...f, published: v })} /> Published (visible to customers)</label>
        </div>
        <Field label="Content" required hint="Plain text. Blank lines separate paragraphs."><Textarea rows={14} value={f.body ?? ''} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

export function KnowledgeBase() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Article | null | undefined>(undefined);
  const articles = useQuery({ queryKey: ['/kb', q], queryFn: () => api.get<Article[]>('/kb', { q }) });
  return (
    <>
      <PageHeader title="Knowledge base" description="Help articles for customers and your support team."
        actions={<><SearchInput value={q} onChange={setQ} placeholder="Search articles" className="w-64" />{can('kb.manage') && <Button onClick={() => setEditing(null)}><Plus /> New article</Button>}</>} />
      {articles.isLoading ? <Card><LoadingBlock /></Card> : !articles.data?.length ? <Card><EmptyState icon={<BookOpen />} title="No articles yet" /></Card> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {articles.data.map((a) => (
            <Link key={a.id} to={`/kb/${a.id}`}>
              <Card className="h-full p-5 transition hover:border-brand-300">
                <div className="flex items-center gap-2">{a.category && <Badge>{a.category.name}</Badge>}{!a.published && <Badge tone="amber">Draft</Badge>}</div>
                <p className="mt-2 font-semibold">{a.title}</p>
                <p className="mt-1 line-clamp-3 text-sm text-muted">{a.excerpt}</p>
                <p className="mt-3 text-xs text-slate-400">Updated {fmtDate(a.updatedAt)}</p>
              </Card>
            </Link>
          ))}
        </div>
      )}
      <ArticleDialog open={editing !== undefined} onOpenChange={(v) => !v && setEditing(undefined)} article={editing} />
    </>
  );
}

export function ArticlePage() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const a = useQuery({ queryKey: ['kb', id], queryFn: () => api.get<Article & { body: string }>(`/kb/${id}`) });
  const del = useAction(() => api.delete(`/kb/${id}`), { success: 'Article deleted', invalidate: [['/kb']], onSuccess: () => navigate('/kb') });
  if (a.isLoading) return <Card><LoadingBlock /></Card>;
  if (a.error || !a.data) return <Card><ErrorState error={a.error} /></Card>;
  return (
    <div className="max-w-3xl">
      <PageHeader breadcrumb={<Link to="/kb" className="hover:underline">Knowledge base</Link>} title={a.data.title} description={`${a.data.category?.name ?? 'General'} · updated ${fmtDate(a.data.updatedAt)}`}
        actions={can('kb.manage') && <><Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button><Button variant="ghost" className="text-red-600" onClick={() => del.mutate()}>Delete</Button></>} />
      <Card className="p-6 sm:p-8">
        <article className="space-y-4 text-[15px] leading-relaxed text-slate-700">{a.data.body.split(/\n\s*\n/).map((p, i) => <p key={i} className="whitespace-pre-wrap">{p}</p>)}</article>
      </Card>
      <ArticleDialog open={editing} onOpenChange={setEditing} article={a.data} />
    </div>
  );
}
