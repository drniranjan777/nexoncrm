import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, Circle, Download, LifeBuoy, MessageSquareHeart, Plus } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime, money, num, titleCase } from '@/lib/utils';
import { Button, Card, CardHeader, Dialog, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Progress, Select, Stat, Stars, StatusBadge, Table, TBody, TD, TH, THead, TR, Textarea } from '@/components/ui';

const pdf = (path: string, name: string) => api.download(path, name, undefined, true).catch((e) => toast.error(errorMessage(e)));

interface Overview {
  customer: { id: string; name: string; company: string | null; onboardingStatus: string; onboarding: { id: string; title: string; doneAt: string | null }[] };
  projects: { id: string; code: string; name: string; status: string; dueDate: string | null }[];
  openTickets: number;
  outstanding: { count: number; byCurrency: { currency: string; amount: string | number }[] };
  recentInvoices: { id: string; number: string; issueDate: string; dueDate: string | null; total: string; balanceDue: string; status: string; currency: string }[];
}

export function PortalHome() {
  const { membership } = useAuth();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['portal-overview'], queryFn: () => api.get<Overview>('/portal/overview') });
  if (q.isLoading) return <Card><LoadingBlock rows={8} /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>;
  const d = q.data;
  const done = d.customer.onboarding.filter((o) => o.doneAt).length;
  return (
    <div className="space-y-6">
      <PageHeader title={`Welcome, ${d.customer.name.split(' ')[0]}`} description={d.customer.company ?? undefined}
        actions={<><Button variant="secondary" onClick={() => navigate(`/submit-feedback?tenant=${membership?.tenant.slug ?? ''}`)}><MessageSquareHeart /> Give feedback</Button><Button onClick={() => navigate('/portal/tickets?new=1')}><LifeBuoy /> Get support</Button></>} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Active projects" value={d.projects.filter((p) => ['PLANNING', 'IN_PROGRESS'].includes(p.status)).length} />
        <Stat label="Open support tickets" value={d.openTickets} />
        <Stat label="Amount due" value={d.outstanding.byCurrency.length ? d.outstanding.byCurrency.map((o) => money(o.amount, o.currency)).join(' + ') : money(0, 'INR')} hint={`${d.outstanding.count} unpaid invoice(s)`} tone={d.outstanding.byCurrency.some((o) => num(o.amount) > 0) ? 'warn' : 'default'} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Your projects" />
          {!d.projects.length ? <EmptyState title="No projects yet" /> : (
            <ul className="divide-y divide-line">{d.projects.map((p) => (
              <li key={p.id}><Link to={`/portal/projects/${p.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50"><span className="flex-1"><span className="block text-sm font-medium">{p.name}</span><span className="text-xs text-muted">{p.code} · due {fmtDate(p.dueDate)}</span></span><StatusBadge status={p.status} /></Link></li>
            ))}</ul>
          )}
        </Card>
        {d.customer.onboarding.length > 0 && d.customer.onboardingStatus !== 'COMPLETED' && (
          <Card>
            <CardHeader title="Getting started" description={`${done} of ${d.customer.onboarding.length} steps complete`} />
            <div className="p-5">
              <Progress value={(done / d.customer.onboarding.length) * 100} className="mb-4" />
              <ul className="space-y-2">{d.customer.onboarding.map((o) => <li key={o.id} className="flex items-center gap-2 text-sm">{o.doneAt ? <CheckCircle2 className="size-4 text-emerald-600" /> : <Circle className="size-4 text-slate-300" />}<span className={o.doneAt ? 'text-muted' : ''}>{o.title}</span></li>)}</ul>
            </div>
          </Card>
        )}
        <Card>
          <CardHeader title="Recent invoices" actions={<Link to="/portal/invoices" className="text-[13px] font-medium text-brand-700 hover:underline">All invoices</Link>} />
          {!d.recentInvoices.length ? <EmptyState title="No invoices" /> : (
            <ul className="divide-y divide-line">{d.recentInvoices.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-5 py-3 text-sm"><span className="flex-1 font-medium">{i.number}</span><StatusBadge status={i.status} /><span className="w-32 text-right tabular-nums">{money(i.total, i.currency)}</span><Button variant="ghost" size="icon" className="size-8" aria-label="Download" onClick={() => pdf(`/portal/invoices/${i.id}/pdf`, `${i.number}.pdf`)}><Download /></Button></li>
            ))}</ul>
          )}
        </Card>
      </div>
    </div>
  );
}

export function PortalProject() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['portal-project', id], queryFn: () => api.get<{ id: string; code: string; name: string; status: string; startDate: string | null; dueDate: string | null; description: string | null; serviceCategory: string | null; milestones: { id: string; title: string; dueDate: string | null; status: string }[]; files: { id: string; originalName: string }[] }>(`/portal/projects/${id}`) });
  if (q.isLoading) return <Card><LoadingBlock /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>;
  const p = q.data;
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader breadcrumb={<Link to="/portal" className="hover:underline">Overview</Link>} title={<span className="flex items-center gap-3">{p.name}<StatusBadge status={p.status} /></span>} description={`${p.code}${p.serviceCategory ? ` · ${p.serviceCategory}` : ''}`} />
      {p.description && <Card className="p-5 text-sm"><p className="whitespace-pre-wrap">{p.description}</p></Card>}
      <Card>
        <CardHeader title="Milestones" description={`Started ${fmtDate(p.startDate)} · target ${fmtDate(p.dueDate)}`} />
        {!p.milestones.length ? <EmptyState title="Milestones will appear here" /> : (
          <ol className="divide-y divide-line">{p.milestones.map((m) => <li key={m.id} className="flex items-center gap-3 px-5 py-3 text-sm">{m.status === 'DONE' ? <CheckCircle2 className="size-5 text-emerald-600" /> : <Circle className="size-5 text-slate-300" />}<span className="flex-1 font-medium">{m.title}</span><span className="text-muted">{fmtDate(m.dueDate)}</span></li>)}</ol>
        )}
      </Card>
      {p.files.length > 0 && (
        <Card>
          <CardHeader title="Shared files" />
          <ul className="divide-y divide-line">{p.files.map((f) => <li key={f.id} className="flex items-center gap-3 px-5 py-3 text-sm"><span className="flex-1">{f.originalName}</span><Button variant="ghost" size="sm" onClick={() => api.download(`/portal/files/${f.id}/download`, f.originalName).catch((e) => toast.error(errorMessage(e)))}><Download /> Download</Button></li>)}</ul>
        </Card>
      )}
    </div>
  );
}

export function PortalInvoices() {
  const q = useQuery({ queryKey: ['portal-invoices'], queryFn: () => api.get<{ id: string; number: string; issueDate: string; dueDate: string | null; total: string; amountPaid: string; balanceDue: string; status: string; currency: string }[]>('/portal/invoices') });
  return (
    <>
      <PageHeader title="Invoices" />
      <Card>
        {q.isLoading ? <LoadingBlock /> : !q.data?.length ? <EmptyState title="No invoices yet" /> : (
          <Table><THead><tr><TH>Invoice</TH><TH>Date</TH><TH>Due</TH><TH>Status</TH><TH className="text-right">Total</TH><TH className="text-right">Balance</TH><TH /></tr></THead><TBody>
            {q.data.map((i) => (
              <tr key={i.id}><TD className="font-medium">{i.number}</TD><TD>{fmtDate(i.issueDate)}</TD><TD>{fmtDate(i.dueDate)}</TD><TD><StatusBadge status={i.status} /></TD><TD className="text-right tabular-nums">{money(i.total, i.currency)}</TD><TD className="text-right tabular-nums">{i.status === 'CANCELLED' ? '—' : money(i.balanceDue, i.currency)}</TD>
                <TD className="text-right"><Button variant="ghost" size="sm" onClick={() => pdf(`/portal/invoices/${i.id}/pdf`, `${i.number}.pdf`)}><Download /> PDF</Button></TD></tr>
            ))}
          </TBody></Table>
        )}
      </Card>
    </>
  );
}

export function PortalQuotations() {
  const q = useQuery({ queryKey: ['portal-quotations'], queryFn: () => api.get<{ id: string; number: string; issueDate: string; validUntil: string | null; total: string; status: string; currency: string }[]>('/portal/quotations') });
  const [respond, setRespond] = useState<{ id: string; decision: 'ACCEPTED' | 'REJECTED' } | null>(null);
  const [comment, setComment] = useState('');
  const act = useAction(() => api.post(`/portal/quotations/${respond!.id}/respond`, { decision: respond!.decision, comment: comment || undefined }), { success: 'Thank you, your response was sent', invalidate: [['portal-quotations']], onSuccess: () => { setRespond(null); setComment(''); } });
  return (
    <>
      <PageHeader title="Quotations" />
      <Card>
        {q.isLoading ? <LoadingBlock /> : !q.data?.length ? <EmptyState title="No quotations" /> : (
          <Table><THead><tr><TH>Quotation</TH><TH>Date</TH><TH>Valid until</TH><TH>Status</TH><TH className="text-right">Total</TH><TH /></tr></THead><TBody>
            {q.data.map((x) => (
              <tr key={x.id}><TD className="font-medium">{x.number}</TD><TD>{fmtDate(x.issueDate)}</TD><TD>{fmtDate(x.validUntil)}</TD><TD><StatusBadge status={x.status} /></TD><TD className="text-right tabular-nums">{money(x.total, x.currency)}</TD>
                <TD className="whitespace-nowrap text-right">
                  <Button variant="ghost" size="sm" onClick={() => pdf(`/portal/quotations/${x.id}/pdf`, `${x.number}.pdf`)}><Download /> PDF</Button>
                  {x.status === 'SENT' && <><Button size="sm" onClick={() => setRespond({ id: x.id, decision: 'ACCEPTED' })}>Accept</Button><Button variant="ghost" size="sm" onClick={() => setRespond({ id: x.id, decision: 'REJECTED' })}>Decline</Button></>}
                </TD></tr>
            ))}
          </TBody></Table>
        )}
      </Card>
      <Dialog open={!!respond} onOpenChange={(v) => !v && setRespond(null)} title={respond?.decision === 'ACCEPTED' ? 'Accept quotation' : 'Decline quotation'}
        footer={<><Button variant="secondary" onClick={() => setRespond(null)}>Cancel</Button><Button variant={respond?.decision === 'REJECTED' ? 'danger' : 'primary'} onClick={() => act.mutate()} loading={act.isPending}>Confirm</Button></>}>
        <Field label="Comment (optional)"><Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      </Dialog>
    </>
  );
}

export function PortalTickets() {
  const navigate = useNavigate();
  const params = new URLSearchParams(window.location.search);
  const [open, setOpen] = useState(params.get('new') === '1');
  const [f, setF] = useState({ subject: '', description: '', priority: 'MEDIUM', projectId: '' });
  const q = useQuery({ queryKey: ['portal-tickets'], queryFn: () => api.get<{ id: string; number: string; subject: string; status: string; priority: string; updatedAt: string }[]>('/portal/tickets') });
  const overview = useQuery({ queryKey: ['portal-overview'], queryFn: () => api.get<Overview>('/portal/overview'), enabled: open });
  const create = useAction(() => api.post<{ id: string; number: string }>('/portal/tickets', { ...f, projectId: f.projectId || null }), { success: (t) => `Ticket ${t.number} created`, invalidate: [['portal-tickets']], onSuccess: (t) => navigate(`/portal/tickets/${t.id}`) });
  return (
    <>
      <PageHeader title="Support" description="Raise an issue or change request and follow its progress." actions={<Button onClick={() => setOpen(true)}><Plus /> New request</Button>} />
      <Card>
        {q.isLoading ? <LoadingBlock /> : !q.data?.length ? <EmptyState icon={<LifeBuoy />} title="No support requests yet" /> : (
          <Table><THead><tr><TH>Request</TH><TH>Priority</TH><TH>Status</TH><TH>Updated</TH></tr></THead><TBody>
            {q.data.map((t) => <TR key={t.id} onClick={() => navigate(`/portal/tickets/${t.id}`)}><TD><p className="font-medium">{t.subject}</p><p className="text-xs text-muted">{t.number}</p></TD><TD><StatusBadge status={t.priority} /></TD><TD><StatusBadge status={t.status} /></TD><TD className="text-slate-600">{fmtDateTime(t.updatedAt)}</TD></TR>)}
          </TBody></Table>
        )}
      </Card>
      <Dialog open={open} onOpenChange={setOpen} title="New support request" size="lg"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => create.mutate()} loading={create.isPending} disabled={f.subject.length < 3 || f.description.length < 5}>Submit</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Subject" required className="sm:col-span-2"><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
          <Field label="Describe the issue or change" required className="sm:col-span-2"><Textarea rows={6} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Field label="Project"><Select value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}><option value="">—</option>{overview.data?.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
          <Field label="Urgency"><Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((p) => <option key={p} value={p}>{titleCase(p)}</option>)}</Select></Field>
        </div>
      </Dialog>
    </>
  );
}

export function PortalTicketDetail() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['portal-ticket', id], queryFn: () => api.get<{ id: string; number: string; subject: string; description: string; status: string; priority: string; createdAt: string; comments: { id: string; body: string; author: string; mine: boolean; createdAt: string }[] }>(`/portal/tickets/${id}`) });
  const [body, setBody] = useState('');
  const send = useAction(() => api.post(`/portal/tickets/${id}/comments`, { body }), { success: 'Reply sent', invalidate: [['portal-ticket'], ['portal-tickets']], onSuccess: () => setBody('') });
  if (q.isLoading) return <Card><LoadingBlock /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>;
  const t = q.data;
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader breadcrumb={<Link to="/portal/tickets" className="hover:underline">Support</Link>} title={<span className="flex items-center gap-3">{t.subject}<StatusBadge status={t.status} /></span>} description={`${t.number} · opened ${fmtDateTime(t.createdAt)}`} />
      <Card className="p-5"><p className="whitespace-pre-wrap text-sm">{t.description}</p></Card>
      <Card>
        <CardHeader title="Conversation" />
        <ol className="space-y-3 p-5">
          {t.comments.length === 0 && <li className="text-sm text-muted">Our team will reply here.</li>}
          {t.comments.map((c) => (
            <li key={c.id} className={`rounded-lg border p-3 text-sm ${c.mine ? 'ml-8 border-brand-100 bg-brand-50/50' : 'mr-8 border-line'}`}>
              <p className="text-xs text-muted">{c.mine ? 'You' : c.author} · {fmtDateTime(c.createdAt)}</p>
              <p className="mt-1 whitespace-pre-wrap">{c.body}</p>
            </li>
          ))}
        </ol>
        {t.status !== 'CLOSED' && (
          <div className="border-t border-line p-5">
            <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a reply" />
            <Button className="mt-2" onClick={() => send.mutate()} loading={send.isPending} disabled={!body.trim()}>Send reply</Button>
          </div>
        )}
      </Card>
    </div>
  );
}

export function PortalFeedback() {
  const { membership } = useAuth();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['portal-feedback'], queryFn: () => api.get<{ id: string; referenceNo: string; serviceCategory: string; ratingOverall: number; status: string; createdAt: string; events: { kind: string; body: string | null; createdAt: string }[] }[]>('/portal/feedback') });
  return (
    <>
      <PageHeader title="Your feedback" actions={<Button onClick={() => navigate(`/submit-feedback?tenant=${membership?.tenant.slug ?? ''}`)}><Plus /> Give feedback</Button>} />
      {q.isLoading ? <Card><LoadingBlock /></Card> : !q.data?.length ? <Card><EmptyState icon={<MessageSquareHeart />} title="You haven't shared feedback yet" /></Card> : (
        <div className="space-y-4">
          {q.data.map((f) => (
            <Card key={f.id} className="p-5">
              <div className="flex flex-wrap items-center gap-3"><span className="font-semibold">{f.referenceNo}</span><StatusBadge status={f.status} /><Stars value={f.ratingOverall} /><span className="ml-auto text-xs text-muted">{f.serviceCategory} · {fmtDate(f.createdAt)}</span></div>
              {f.events.filter((e) => e.kind === 'REPLY').map((e, i) => <p key={i} className="mt-3 rounded-lg bg-brand-50/60 p-3 text-sm"><span className="block text-xs text-muted">Reply · {fmtDateTime(e.createdAt)}</span>{e.body}</p>)}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
