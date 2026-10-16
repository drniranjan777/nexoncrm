import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, AlignCenter, AlignLeft, AlignRight, Bold, FileText, Italic, Link2, List, ListOrdered, Paperclip, Strikethrough, Underline, X } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { Button, Card, Checkbox, ErrorState, Input, LoadingBlock, PageHeader, Select } from '@/components/ui';

interface Draft {
  from: { name: string; email: string };
  to: string[]; cc: string[]; bcc: string[]; subject: string; html: string; attachmentName: string | null;
  contacts: { name: string; email: string }[]; customerId: string | null; smtpConfigured: boolean;
}

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function Recipients({ label, value, onChange, suggestions }: { label: string; value: string[]; onChange: (v: string[]) => void; suggestions: { name: string; email: string }[] }) {
  const [text, setText] = useState('');
  const add = (raw: string) => {
    const parts = raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    const ok = parts.filter(isEmail);
    if (parts.length && !ok.length) { toast.error(`"${raw}" is not a valid email`); return; }
    onChange([...new Set([...value, ...ok])]);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (['Enter', ',', ';', 'Tab'].includes(e.key) && text.trim()) { e.preventDefault(); add(text); }
    if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
  };
  const listId = `sugg-${label}`;
  return (
    <div className="flex items-start gap-3 border-b border-line px-4 py-2.5">
      <span className="w-16 shrink-0 pt-1.5 text-sm text-muted">{label}</span>
      <div className="flex min-h-9 flex-1 flex-wrap items-center gap-1.5">
        {value.map((e) => {
          const c = suggestions.find((s) => s.email === e);
          return (
            <span key={e} className="flex items-center gap-1.5 rounded-md bg-slate-100 py-1 pl-1 pr-2 text-sm">
              <span className="flex size-5 items-center justify-center rounded bg-surface text-[10px] font-semibold uppercase text-slate-500">{(c?.name ?? e)[0]}</span>
              {c ? `${c.name} <${e}>` : `<${e}>`}
              <button onClick={() => onChange(value.filter((x) => x !== e))} aria-label={`Remove ${e}`}><X className="size-3.5 text-slate-400 hover:text-ink" /></button>
            </span>
          );
        })}
        <input list={listId} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onBlur={() => text.trim() && add(text)}
          className="min-w-48 flex-1 bg-transparent py-1 text-sm outline-none" placeholder={value.length ? '' : 'Type an email and press Enter'} aria-label={`${label} recipients`} />
        <datalist id={listId}>{suggestions.filter((s) => !value.includes(s.email)).map((s) => <option key={s.email} value={s.email}>{s.name}</option>)}</datalist>
      </div>
    </div>
  );
}

function RichEditor({ html, onChange }: { html: string; onChange: (h: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const initial = useRef(html);
  useEffect(() => { if (ref.current && ref.current.innerHTML !== initial.current) ref.current.innerHTML = initial.current; }, []);
  // execCommand is deprecated but remains the only cross-browser contentEditable formatting API.
  const cmd = (c: string, v?: string) => { ref.current?.focus(); document.execCommand(c, false, v); onChange(ref.current?.innerHTML ?? ''); };
  const B = ({ c, v, icon: I, label }: { c: string; v?: string; icon: typeof Bold; label: string }) => (
    <button type="button" title={label} aria-label={label} onMouseDown={(e) => { e.preventDefault(); cmd(c, v); }} className="rounded p-1.5 text-slate-600 hover:bg-slate-200 hover:text-ink"><I className="size-4" /></button>
  );
  return (
    <div>
      <div className="flex flex-wrap items-center gap-0.5 border-b border-line bg-slate-50 px-3 py-1.5">
        <B c="bold" icon={Bold} label="Bold" /><B c="italic" icon={Italic} label="Italic" /><B c="underline" icon={Underline} label="Underline" /><B c="strikeThrough" icon={Strikethrough} label="Strikethrough" />
        <span className="mx-1 h-5 w-px bg-line" />
        <Select className="h-8 w-24 text-xs" defaultValue="3" onChange={(e) => cmd('fontSize', e.target.value)} aria-label="Font size">{[['2', '13px'], ['3', '16px'], ['4', '18px'], ['5', '24px']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        <Select className="h-8 w-32 text-xs" defaultValue="Arial" onChange={(e) => cmd('fontName', e.target.value)} aria-label="Font">{['Arial', 'Georgia', 'Helvetica', 'Tahoma', 'Times New Roman', 'Verdana'].map((f) => <option key={f}>{f}</option>)}</Select>
        <span className="mx-1 h-5 w-px bg-line" />
        <B c="justifyLeft" icon={AlignLeft} label="Align left" /><B c="justifyCenter" icon={AlignCenter} label="Align centre" /><B c="justifyRight" icon={AlignRight} label="Align right" />
        <B c="insertUnorderedList" icon={List} label="Bulleted list" /><B c="insertOrderedList" icon={ListOrdered} label="Numbered list" />
        <button type="button" title="Insert link" aria-label="Insert link" className="rounded p-1.5 text-slate-600 hover:bg-slate-200" onMouseDown={(e) => { e.preventDefault(); const url = prompt('Link URL (https://...)'); if (url && /^https?:\/\//.test(url)) cmd('createLink', url); }}><Link2 className="size-4" /></button>
      </div>
      <div ref={ref} contentEditable suppressContentEditableWarning onInput={() => onChange(ref.current?.innerHTML ?? '')}
        className="scrollbar-thin max-h-[560px] min-h-80 overflow-auto bg-surface p-2 text-sm focus:outline-none" role="textbox" aria-multiline="true" aria-label="Email body" />
    </div>
  );
}

export function EmailComposePage() {
  const { kind, id } = useParams() as { kind: 'invoice' | 'quote' | 'payment' | 'proforma'; id: string };
  const navigate = useNavigate();
  const { membership } = useAuth();
  // Emails reference the logo as an inline attachment (cid:); show the real image while editing.
  const logoUrl = membership ? `/api/v1/public/tenants/${membership.tenant.slug}/logo` : '';
  const toPreview = (h: string) => (logoUrl ? h.replaceAll('cid:org-logo', logoUrl) : h);
  const fromPreview = (h: string) => (logoUrl ? h.replaceAll(logoUrl, 'cid:org-logo') : h);
  const draft = useQuery({ queryKey: ['email-draft', kind, id], queryFn: () => api.get<Draft>(`/email/${kind}/${id}/draft`), refetchOnMount: 'always' });
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState('');
  const [html, setHtml] = useState('');
  const [attachPdf, setAttachPdf] = useState(true);
  const [attachStatement, setAttachStatement] = useState(false);
  const [files, setFiles] = useState<{ id: string; originalName: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!draft.data) return;
    setTo(draft.data.to); setCc(draft.data.cc); setBcc(draft.data.bcc); setSubject(draft.data.subject); setHtml(toPreview(draft.data.html));
  }, [draft.data]);

  const upload = async (list: FileList) => {
    setUploading(true);
    try {
      const fd = new FormData();
      Array.from(list).slice(0, 5 - files.length).forEach((f) => fd.append('files', f));
      fd.append('entityType', 'email');
      setFiles([...files, ...(await api.post<{ id: string; originalName: string }[]>('/files', fd))]);
    } catch (e) { toast.error(errorMessage(e)); } finally { setUploading(false); }
  };

  const send = async () => {
    if (!to.length) { toast.error('Add at least one recipient'); return; }
    setSending(true);
    try {
      const r = await api.post<{ delivered: boolean; status: string; attachments: string[] }>(`/email/${kind}/${id}/send`, { to, cc, bcc, subject, html: fromPreview(html), attachPdf, attachStatement, fileIds: files.map((f) => f.id) });
      // The email is queued; the mail server's response is recorded on the document's email activity.
      if (r.delivered) toast.success(`Email queued for ${to.join(', ')}. Its delivery status appears in the email activity.`);
      else toast.warning('Email not sent: outgoing email (SMTP) is not configured on the server. It was recorded in the email activity.');
      navigate(kind === 'invoice' ? `/invoices/${id}` : kind === 'quote' ? `/quotations/${id}` : kind === 'proforma' ? `/proforma-invoices/${id}` : `/payments/${id}`, { replace: true });
    } catch (e) { toast.error(errorMessage(e)); } finally { setSending(false); }
  };

  if (draft.isLoading) return <Card><LoadingBlock rows={8} /></Card>;
  if (draft.error || !draft.data) return <Card><ErrorState error={draft.error} /></Card>;
  const d = draft.data;
  const docLabel = kind === 'invoice' ? 'Invoice' : kind === 'quote' ? 'Quote' : kind === 'proforma' ? 'Proforma Invoice' : 'Payment receipt';
  const pdfPath = kind === 'invoice' ? `/invoices/${id}/pdf` : kind === 'quote' ? `/quotations/${id}/pdf` : kind === 'proforma' ? `/proforma-invoices/${id}/pdf` : null;
  return (
    <div className="max-w-5xl">
      <PageHeader title={`Email To ${d.contacts[0]?.name ?? to[0] ?? ''}`.trim()} />
      {!d.smtpConfigured && (
        <div className="mb-4 flex gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>No mail server is set up, so this email will be recorded but not sent. An administrator can add one under <a href="/settings/email" className="font-medium underline">Settings → Email (SMTP)</a>.</span>
        </div>
      )}
      <Card className="overflow-hidden">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3"><span className="w-16 text-sm text-muted">From</span><span className="text-sm">{d.from.name} &lt;{d.from.email}&gt;</span></div>
        <div className="relative">
          <Recipients label="Send To" value={to} onChange={setTo} suggestions={d.contacts} />
          {!showBcc && <button className="absolute right-4 top-3 text-sm text-brand-700 hover:underline" onClick={() => setShowBcc(true)}>Bcc</button>}
        </div>
        <Recipients label="Cc" value={cc} onChange={setCc} suggestions={d.contacts} />
        {showBcc && <Recipients label="Bcc" value={bcc} onChange={setBcc} suggestions={d.contacts} />}
        <div className="flex items-center gap-3 border-b border-line px-4 py-2"><span className="w-16 text-sm text-muted">Subject</span><Input className="border-0 shadow-none focus:ring-0" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" /></div>
        <RichEditor key={d.html.length} html={toPreview(d.html)} onChange={setHtml} />
      </Card>
      <div className="mt-4 space-y-3">
        {d.customerId && <Card className="flex items-center gap-3 px-4 py-3"><Checkbox checked={attachStatement} onCheckedChange={setAttachStatement} id="st" /><label htmlFor="st" className="text-sm">Attach Customer Statement</label></Card>}
        {d.attachmentName && (
          <Card className="flex flex-wrap items-center gap-3 px-4 py-3">
            <Checkbox checked={attachPdf} onCheckedChange={setAttachPdf} id="pdf" /><label htmlFor="pdf" className="text-sm">Attach {docLabel} PDF</label>
            <span className={cn('ml-auto flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-sm', !attachPdf && 'opacity-50')}><FileText className="size-4 text-red-600" />{d.attachmentName}</span>
            {pdfPath && <Button variant="secondary" size="sm" onClick={() => api.download(pdfPath, d.attachmentName ?? 'document.pdf', undefined, true).catch((e) => toast.error(errorMessage(e)))}>Preview PDF</Button>}
          </Card>
        )}
        <Card className="border-dashed px-4 py-3">
          <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files?.length) upload(e.target.files); e.target.value = ''; }} accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,.xls,.xlsx,.csv,.txt" />
          <button className="flex items-center gap-1.5 text-sm text-brand-700 hover:underline disabled:opacity-50" onClick={() => fileInput.current?.click()} disabled={uploading || files.length >= 5}><Paperclip className="size-4" /> {uploading ? 'Uploading…' : 'Attachments'}</button>
          {files.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{files.map((f) => <span key={f.id} className="flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1 text-sm">{f.originalName}<button onClick={() => setFiles(files.filter((x) => x.id !== f.id))} aria-label="Remove"><X className="size-3.5" /></button></span>)}</div>}
        </Card>
      </div>
      <div className="sticky bottom-0 -mx-4 mt-6 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur lg:-mx-8 lg:px-8">
        <Button onClick={send} loading={sending}>Send</Button>
        <Button variant="ghost" className="ml-2" onClick={() => navigate(-1)}>Cancel</Button>
      </div>
    </div>
  );
}
