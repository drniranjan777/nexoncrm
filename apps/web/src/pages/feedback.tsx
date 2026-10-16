import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Copy, ExternalLink, LifeBuoy, ListPlus, MessageSquareHeart, Send, Sparkles, StickyNote } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useList, useMembers, useCategories, memberName } from '@/lib/hooks';
import type { Feedback } from '@/lib/types';
import { cn, fmtDate, fmtDateTime, titleCase } from '@/lib/utils';
import {
  Badge, Button, Card, CardHeader, DescList, Dialog, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Pagination, SearchInput,
  Select, StatusBadge, Stars, Table, TBody, TD, TH, THead, Toolbar, TR, Textarea,
} from '@/components/ui';
import { AssigneeSelect, ExportButton } from '@/components/shared';
import { SERVICES } from './crm';

const STATUSES = ['NEW', 'UNDER_REVIEW', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'];
const sentimentTone = (s?: string | null) => (s === 'positive' ? 'green' : s === 'negative' ? 'red' : 'gray');

export function FeedbackList() {
  const navigate = useNavigate();
  const members = useMembers();
  const list = useList<Feedback>('/feedback', { status: '', serviceCategory: '', maxRating: '', sentiment: '', urgent: '', assignedToId: '', from: '', to: '' }, { sort: 'createdAt' });
  const counts = (list.data?.statusCounts ?? {}) as Record<string, number>;
  const publicUrl = `${window.location.origin}/submit-feedback`;
  return (
    <>
      <PageHeader title="Customer feedback" description="Submissions from the feedback portal, with automatic sentiment and urgency detection."
        actions={<>
          <Button variant="secondary" onClick={() => { navigator.clipboard.writeText(publicUrl); toast.success('Public form link copied'); }}><Copy /> Public form link</Button>
          <ExportButton path="/feedback" filename="feedback.csv" params={list.params} />
        </>} />
      <div className="scrollbar-thin mb-4 flex gap-2 overflow-x-auto">
        {[['', 'All'], ...STATUSES.map((s) => [s, titleCase(s)])].map(([s, label]) => (
          <button key={s} onClick={() => list.setFilter('status', s)} className={cn('whitespace-nowrap rounded-full border px-3 py-1 text-[13px] font-medium', list.filters.status === s ? 'border-primary bg-primary text-white' : 'border-line bg-surface text-slate-600 hover:bg-slate-50')}>
            {label}{s && counts[s] ? <span className="ml-1.5 opacity-70">{counts[s]}</span> : null}
          </button>
        ))}
      </div>
      <Card>
        <Toolbar>
          <SearchInput value={list.q} onChange={list.setQ} placeholder="Reference, name, company, text" className="w-full sm:w-64" />
          <Select value={list.filters.serviceCategory} onChange={(e) => list.setFilter('serviceCategory', e.target.value)} className="w-52"><option value="">All services</option>{SERVICES.map((s) => <option key={s}>{s}</option>)}</Select>
          <Select value={list.filters.maxRating} onChange={(e) => list.setFilter('maxRating', e.target.value)} className="w-36"><option value="">Any rating</option><option value="2">2 or below</option><option value="3">3 or below</option></Select>
          <Select value={list.filters.sentiment} onChange={(e) => list.setFilter('sentiment', e.target.value)} className="w-36"><option value="">Any sentiment</option><option value="negative">Negative</option><option value="neutral">Neutral</option><option value="positive">Positive</option></Select>
          <Select value={list.filters.assignedToId} onChange={(e) => list.setFilter('assignedToId', e.target.value)} className="w-40"><option value="">Anyone</option><option value="me">Assigned to me</option>{members.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>
          <label className="flex items-center gap-2 text-[13px] text-slate-600"><input type="checkbox" checked={list.filters.urgent === '1'} onChange={(e) => list.setFilter('urgent', e.target.checked ? '1' : '')} /> Urgent only</label>
          <Input type="date" className="w-36" value={list.filters.from} onChange={(e) => list.setFilter('from', e.target.value)} aria-label="From date" />
          <Input type="date" className="w-36" value={list.filters.to} onChange={(e) => list.setFilter('to', e.target.value)} aria-label="To date" />
        </Toolbar>
        {list.isLoading ? <LoadingBlock /> : list.error ? <ErrorState error={list.error} /> : !list.data?.items.length ? (
          <EmptyState icon={<MessageSquareHeart />} title="No feedback found" description="Share your public form or project-specific secure links with customers." />
        ) : (
          <>
            <Table><THead><tr><TH>Reference</TH><TH>Customer</TH><TH>Service</TH><TH>Rating</TH><TH>Sentiment</TH><TH>Status</TH><TH>Assigned</TH><TH>Received</TH></tr></THead><TBody>
              {list.data.items.map((f) => (
                <TR key={f.id} onClick={() => navigate(`/feedback/${f.id}`)}>
                  <TD><p className="flex items-center gap-1.5 font-medium">{f.isUrgent && <AlertTriangle className="size-3.5 text-red-600" aria-label="Urgent" />}{f.referenceNo}</p>{f.project && <p className="text-xs text-muted">{f.project.code}</p>}</TD>
                  <TD><p>{f.name}</p><p className="text-xs text-muted">{f.company ?? f.email}</p></TD>
                  <TD className="max-w-40 truncate text-slate-600">{f.serviceCategory}</TD>
                  <TD><Stars value={f.ratingOverall} /></TD>
                  <TD><Badge tone={sentimentTone(f.sentiment)} className="capitalize">{f.sentiment ?? '—'}</Badge></TD>
                  <TD><StatusBadge status={f.status} /></TD>
                  <TD className="text-slate-600">{memberName(members.data, f.assignedToId)}</TD>
                  <TD className="whitespace-nowrap text-slate-600">{fmtDate(f.createdAt)}</TD>
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

interface FeedbackDetailData extends Feedback {
  events: { id: string; kind: string; body: string | null; isInternal: boolean; userId: string | null; createdAt: string }[];
  tasks: { id: string; title: string; status: string; assigneeId: string | null; dueDate: string | null }[];
  files: { id: string; originalName: string; mimeType: string; sizeBytes: number }[];
  tickets: { id: string; number: string; subject: string; status: string }[];
}

const RatingRow = ({ label, value }: { label: string; value: number | null }) => (
  <div className="flex items-center justify-between py-1.5 text-sm"><span className="text-slate-600">{label}</span><Stars value={value} /></div>
);

export function FeedbackDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const members = useMembers();
  const categories = useCategories();
  const q = useQuery({ queryKey: ['feedback', id], queryFn: () => api.get<FeedbackDetailData>(`/feedback/${id}`) });
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState<'NOTE' | 'REPLY'>('NOTE');
  const [taskOpen, setTaskOpen] = useState(false);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [taskForm, setTaskForm] = useState({ title: '', assigneeId: null as string | null, dueDate: '' });
  const [ticketForm, setTicketForm] = useState({ assigneeId: null as string | null, categoryId: '' });
  const inv = [['feedback'], ['/feedback'], ['/tasks'], ['/tickets'], ['dashboard']];
  const update = useAction((body: object) => api.patch(`/feedback/${id}`, body), { success: 'Updated', invalidate: inv });
  const post = useAction(() => api.post(`/feedback/${id}/events`, { body: message, kind: mode }), { success: mode === 'REPLY' ? 'Reply sent to customer' : 'Note added', invalidate: inv, onSuccess: () => setMessage('') });
  const aiReply = useAction(() => api.post<{ text: string; provider: string }>(`/feedback/${id}/ai-reply`), { onSuccess: (r) => { setMessage(r.text); setMode('REPLY'); toast.info(r.provider === 'anthropic' ? 'AI draft inserted. Review before sending.' : 'Template draft inserted.'); } });
  const createTask = useAction(() => api.post(`/feedback/${id}/task`, { ...taskForm, dueDate: taskForm.dueDate || undefined, assigneeId: taskForm.assigneeId ?? undefined }), { success: 'Task created', invalidate: inv, onSuccess: () => setTaskOpen(false) });
  const createTicket = useAction(() => api.post<{ id: string; number: string }>(`/feedback/${id}/ticket`, { assigneeId: ticketForm.assigneeId ?? undefined, categoryId: ticketForm.categoryId || undefined }), { success: (t) => `Ticket ${t.number} created`, invalidate: inv, onSuccess: () => setTicketOpen(false) });

  if (q.isLoading) return <Card><LoadingBlock rows={8} /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} onRetry={q.refetch} /></Card>;
  const f = q.data;
  const resolve = can('feedback.resolve');
  const answers = Object.entries(f.serviceAnswers ?? {});
  const sections: [string, string | null][] = [['What is working well', f.workingWell], ['What needs improvement', f.needsImprovement], ['Requested changes', f.requestedChanges], ['Urgent issues', f.urgentIssues], ['Additional comments', f.comments]];

  return (
    <>
      <PageHeader breadcrumb={<Link to="/feedback" className="hover:underline">Feedback</Link>}
        title={<span className="flex flex-wrap items-center gap-3">{f.referenceNo}<StatusBadge status={f.status} />{f.isUrgent && <Badge tone="red"><AlertTriangle className="size-3" /> Urgent</Badge>}</span>}
        description={`${f.name}${f.company ? ` · ${f.company}` : ''} · ${fmtDateTime(f.createdAt)}`}
        actions={resolve && <>
          <Button variant="secondary" onClick={() => { setTaskForm({ title: `Address feedback ${f.referenceNo}`, assigneeId: null, dueDate: '' }); setTaskOpen(true); }}><ListPlus /> Create task</Button>
          {can('tickets.update', 'tickets.assign') && <Button variant="secondary" onClick={() => setTicketOpen(true)}><LifeBuoy /> Create ticket</Button>}
        </>} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card>
            <CardHeader title="Submission" description={f.serviceCategory} />
            <div className="space-y-5 p-5">
              {sections.filter(([, v]) => v).map(([label, v]) => (
                <div key={label} className={label === 'Urgent issues' ? 'rounded-lg border border-red-100 bg-red-50 p-3' : ''}>
                  <p className={cn('text-xs font-medium', label === 'Urgent issues' ? 'text-red-700' : 'text-muted')}>{label}</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{v}</p>
                </div>
              ))}
              {answers.length > 0 && (
                <div className="border-t border-line pt-4">
                  <p className="mb-2 text-xs font-medium text-muted">Service-specific answers</p>
                  <dl className="grid gap-2 sm:grid-cols-2">
                    {answers.map(([k, v]) => <div key={k} className="rounded-lg bg-slate-50 px-3 py-2"><dt className="text-xs text-muted">{titleCase(k.replace(/([A-Z])/g, '_$1'))}</dt><dd className="text-sm font-medium">{typeof v === 'number' ? `${v}/5` : v}</dd></div>)}
                  </dl>
                </div>
              )}
              {f.files.length > 0 && (
                <div className="border-t border-line pt-4">
                  <p className="mb-2 text-xs font-medium text-muted">Attachments</p>
                  <div className="flex flex-wrap gap-2">
                    {f.files.map((file) => <Button key={file.id} variant="secondary" size="sm" onClick={() => api.download(`/files/${file.id}/download`, file.originalName, { inline: 1 }, true)}><ExternalLink /> {file.originalName}</Button>)}
                  </div>
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Resolution history" />
            <ol className="space-y-4 p-5">
              {f.events.map((e) => (
                <li key={e.id} className={cn('rounded-lg border p-3', e.kind === 'REPLY' ? 'border-brand-100 bg-brand-50/50' : e.kind === 'CUSTOMER_REPLY' ? 'border-emerald-100 bg-emerald-50/50' : e.kind === 'NOTE' ? 'border-amber-100 bg-amber-50/40' : 'border-line')}>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <Badge tone={e.kind === 'REPLY' ? 'blue' : e.kind === 'CUSTOMER_REPLY' ? 'green' : e.kind === 'NOTE' ? 'amber' : 'gray'}>{e.kind === 'CUSTOMER_REPLY' ? 'Customer' : e.kind === 'NOTE' ? 'Internal note' : e.kind === 'REPLY' ? 'Reply to customer' : titleCase(e.kind)}</Badge>
                    {e.userId && <span>{memberName(members.data, e.userId)}</span>}<span>{fmtDateTime(e.createdAt)}</span>
                    {!e.isInternal && e.kind !== 'CUSTOMER_REPLY' && <span className="text-emerald-700">visible to customer</span>}
                  </div>
                  {e.body && <p className="mt-1.5 whitespace-pre-wrap text-sm">{e.body}</p>}
                </li>
              ))}
            </ol>
            {resolve && (
              <div className="border-t border-line p-5">
                <div className="mb-2 flex gap-1">
                  <button onClick={() => setMode('NOTE')} className={cn('flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] font-medium', mode === 'NOTE' ? 'bg-amber-50 text-amber-800' : 'text-muted')}><StickyNote className="size-3.5" /> Internal note</button>
                  <button onClick={() => setMode('REPLY')} className={cn('flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] font-medium', mode === 'REPLY' ? 'bg-brand-50 text-brand-800' : 'text-muted')}><Send className="size-3.5" /> Reply to customer</button>
                  {can('ai.use') && <Button variant="ghost" size="sm" className="ml-auto" onClick={() => aiReply.mutate()} loading={aiReply.isPending}><Sparkles /> Draft reply</Button>}
                </div>
                <Textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} placeholder={mode === 'REPLY' ? 'This is emailed to the customer and shown on their tracking page.' : 'Only your team can see notes.'} />
                <div className="mt-2 flex justify-end"><Button onClick={() => post.mutate()} loading={post.isPending} disabled={!message.trim()}>{mode === 'REPLY' ? 'Send reply' : 'Add note'}</Button></div>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          {resolve && (
            <Card className="space-y-4 p-5">
              <Field label="Status"><Select value={f.status} onChange={(e) => update.mutate({ status: e.target.value })}>{STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select></Field>
              <Field label="Assigned to"><AssigneeSelect value={f.assignedToId} onChange={(v) => update.mutate({ assignedToId: v })} /></Field>
            </Card>
          )}
          <Card className="p-5">
            <p className="mb-2 text-sm font-semibold">Ratings</p>
            <RatingRow label="Overall satisfaction" value={f.ratingOverall} />
            <RatingRow label="Communication" value={f.ratingCommunication} />
            <RatingRow label="Quality" value={f.ratingQuality} />
            <RatingRow label="Timeliness" value={f.ratingTimeliness} />
            {f.ratingTechnical != null && <RatingRow label="Technical quality" value={f.ratingTechnical} />}
            <div className="mt-3 border-t border-line pt-3 text-sm">
              <p className="flex items-center justify-between"><span className="text-slate-600">Sentiment</span><Badge tone={sentimentTone(f.sentiment)} className="capitalize">{f.sentiment} ({f.sentimentScore})</Badge></p>
              {f.aiCategories.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{f.aiCategories.map((c) => <Badge key={c} tone="violet">{c}</Badge>)}</div>}
              <p className="mt-2 text-xs text-muted">Detected automatically by keyword and rating rules.</p>
            </div>
          </Card>
          <Card className="p-5">
            <DescList className="sm:grid-cols-1" items={[
              ['Email', <a href={`mailto:${f.email}`} className="text-brand-700 hover:underline">{f.email}</a>], ['Phone', f.phone],
              ['Customer record', f.customer ? <Link to={`/customers/${f.customer.id}`} className="text-brand-700 hover:underline">{f.customer.name}</Link> : 'Not linked'],
              ['Project', f.project ? <Link to={`/projects/${f.project.id}`} className="text-brand-700 hover:underline">{f.project.code} · {f.project.name}</Link> : null],
              ['Project status', f.projectStatus], ['Expectations', f.expectationStatus],
            ]} />
          </Card>
          {(f.tasks.length > 0 || f.tickets.length > 0) && (
            <Card className="p-5">
              <p className="mb-2 text-sm font-semibold">Linked work</p>
              <ul className="space-y-2 text-sm">
                {f.tasks.map((t) => <li key={t.id}><Link to={`/tasks?open=${t.id}`} className="flex items-center gap-2 hover:text-brand-700"><StatusBadge status={t.status} /><span className="truncate">{t.title}</span></Link></li>)}
                {f.tickets.map((t) => <li key={t.id}><Link to={`/tickets/${t.id}`} className="flex items-center gap-2 hover:text-brand-700"><StatusBadge status={t.status} /><span className="truncate">{t.number} · {t.subject}</span></Link></li>)}
              </ul>
            </Card>
          )}
        </div>
      </div>

      <Dialog open={taskOpen} onOpenChange={setTaskOpen} title="Create task from feedback"
        footer={<><Button variant="secondary" onClick={() => setTaskOpen(false)}>Cancel</Button><Button onClick={() => createTask.mutate()} loading={createTask.isPending} disabled={!taskForm.title}>Create task</Button></>}>
        <div className="space-y-4">
          <Field label="Title"><Input value={taskForm.title} onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Assignee"><AssigneeSelect value={taskForm.assigneeId} onChange={(v) => setTaskForm({ ...taskForm, assigneeId: v })} /></Field>
            <Field label="Due date"><Input type="date" value={taskForm.dueDate} onChange={(e) => setTaskForm({ ...taskForm, dueDate: e.target.value })} /></Field>
          </div>
        </div>
      </Dialog>
      <Dialog open={ticketOpen} onOpenChange={setTicketOpen} title="Create support ticket"
        footer={<><Button variant="secondary" onClick={() => setTicketOpen(false)}>Cancel</Button><Button onClick={() => createTicket.mutate()} loading={createTicket.isPending}>Create ticket</Button></>}>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Assignee"><AssigneeSelect value={ticketForm.assigneeId} onChange={(v) => setTicketForm({ ...ticketForm, assigneeId: v })} /></Field>
          <Field label="Category"><Select value={ticketForm.categoryId} onChange={(e) => setTicketForm({ ...ticketForm, categoryId: e.target.value })}><option value="">—</option>{categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        </div>
        <p className="mt-3 text-xs text-muted">Priority is set from urgency and rating. The customer's issues are copied into the description.</p>
      </Dialog>
    </>
  );
}
