import { useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, File as FileIcon, FileImage, FileSpreadsheet, FileText, Mail, MessageCircle, Phone, StickyNote, Trash2, Upload, Users, Repeat, Cog } from 'lucide-react';
import { api, errorMessage, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useMembers, memberName } from '@/lib/hooks';
import type { Activity, FileItem } from '@/lib/types';
import { cn, fileSize, fmtDateTime, timeAgo, toDateInput } from '@/lib/utils';
import { Button, Dialog, EmptyState, Field, Input, LoadingBlock, Select, Switch, Textarea } from './ui';

export function AssigneeSelect({ value, onChange, allowEmpty = true, id, disabled }: { value?: string | null; onChange: (v: string | null) => void; allowEmpty?: boolean; id?: string; disabled?: boolean }) {
  const members = useMembers();
  return (
    <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} disabled={disabled}>
      {allowEmpty && <option value="">Unassigned</option>}
      {members.data?.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.role}</option>)}
    </Select>
  );
}

export function ExportButton({ path, filename, params }: { path: string; filename: string; params?: Record<string, string | undefined> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button variant="secondary" loading={busy} onClick={async () => {
      setBusy(true);
      try { await api.download(path, filename, { ...params, format: 'csv' }); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
    }}><Download /> Export CSV</Button>
  );
}

const fileIcon = (mime: string) => (mime.startsWith('image/') ? FileImage : mime.includes('pdf') ? FileText : mime.includes('sheet') || mime.includes('csv') || mime.includes('excel') ? FileSpreadsheet : FileIcon);

/** Upload and list files attached to a record. Files inherit the record's access rules on the server. */
export function FileManager({ entityType, entityId, allowCustomerVisibility }: { entityType: string; entityId?: string; allowCustomerVisibility?: boolean }) {
  const { can, me } = useAuth();
  const input = useRef<HTMLInputElement>(null);
  const [visible, setVisible] = useState(false);
  const key = ['/files', { entityType, entityId }];
  const files = useQuery({ queryKey: key, queryFn: () => api.get<Paged<FileItem>>('/files', { entityType, entityId, pageSize: 100 }) });
  const upload = useAction(async (list: FileList) => {
    const fd = new FormData();
    Array.from(list).forEach((f) => fd.append('files', f));
    fd.append('entityType', entityType);
    if (entityId) fd.append('entityId', entityId);
    fd.append('visibility', visible ? 'customer' : 'internal');
    return api.post('/files', fd);
  }, { success: 'Uploaded', invalidate: [['/files']] });
  const remove = useAction((id: string) => api.delete(`/files/${id}`), { success: 'File deleted', invalidate: [['/files']] });

  return (
    <div>
      {can('files.upload') && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <input ref={input} type="file" multiple className="hidden" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
            onChange={(e) => { if (e.target.files?.length) upload.mutate(e.target.files); e.target.value = ''; }} />
          <Button variant="secondary" onClick={() => input.current?.click()} loading={upload.isPending}><Upload /> Upload files</Button>
          {allowCustomerVisibility && <label className="flex items-center gap-2 text-[13px] text-slate-600"><Switch checked={visible} onCheckedChange={setVisible} /> Visible to customer</label>}
          <span className="text-xs text-muted">PDF, images, Office documents · up to 15 MB each</span>
        </div>
      )}
      {files.isLoading ? <LoadingBlock rows={2} /> : !files.data?.items.length ? <EmptyState title="No files yet" /> : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {files.data.items.map((f) => {
            const Icon = fileIcon(f.mimeType);
            return (
              <li key={f.id} className="flex items-center gap-3 px-3 py-2.5">
                <Icon className="size-5 shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <button className="block max-w-full truncate text-left text-sm font-medium hover:text-brand-700 hover:underline"
                    onClick={() => api.download(`/files/${f.id}/download`, f.originalName, { inline: f.mimeType.startsWith('image/') || f.mimeType === 'application/pdf' ? 1 : undefined }, f.mimeType.startsWith('image/') || f.mimeType === 'application/pdf').catch((e) => toast.error(errorMessage(e)))}>
                    {f.originalName}
                  </button>
                  <p className="text-xs text-muted">{fileSize(f.sizeBytes)} · {timeAgo(f.createdAt)}{f.visibility === 'customer' && ' · visible to customer'}</p>
                </div>
                <Button variant="ghost" size="icon" className="size-8" aria-label="Download" onClick={() => api.download(`/files/${f.id}/download`, f.originalName).catch((e) => toast.error(errorMessage(e)))}><Download /></Button>
                {(f.uploadedById === me?.id || can('settings.manage', 'projects.update')) && (
                  <Button variant="ghost" size="icon" className="size-8 text-slate-400 hover:text-red-600" aria-label="Delete" onClick={() => remove.mutate(f.id)}><Trash2 /></Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const ACTIVITY_ICONS: Record<string, typeof Phone> = { CALL: Phone, EMAIL: Mail, MEETING: Users, NOTE: StickyNote, WHATSAPP: MessageCircle, STAGE_CHANGE: Repeat, SYSTEM: Cog };

export function ActivityTimeline({ items }: { items: Activity[] }) {
  const members = useMembers();
  if (!items.length) return <EmptyState title="No activity yet" description="Log calls, emails and meetings to build the history." />;
  return (
    <ol className="relative space-y-5 before:absolute before:inset-y-1 before:left-[15px] before:w-px before:bg-line">
      {items.map((a) => {
        const Icon = ACTIVITY_ICONS[a.type] ?? StickyNote;
        const system = a.type === 'SYSTEM' || a.type === 'STAGE_CHANGE';
        return (
          <li key={a.id} className="relative flex gap-3">
            <span className={cn('relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full ring-4 ring-white', system ? 'bg-slate-100 text-slate-500' : 'bg-brand-50 text-brand-700')}><Icon className="size-3.5" /></span>
            <div className="min-w-0 flex-1 pt-1">
              <p className={cn('text-sm', system ? 'text-slate-600' : 'font-medium')}>{a.subject}</p>
              {a.body && <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{a.body}</p>}
              <p className="mt-1 text-xs text-muted">{a.type !== 'SYSTEM' && `${a.type.replace('_', ' ').toLowerCase()} · `}{fmtDateTime(a.occurredAt)}{a.userId && ` · ${memberName(members.data, a.userId)}`}{!a.completed && ' · planned'}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function LogActivityDialog({ open, onOpenChange, leadId, customerId }: { open: boolean; onOpenChange: (v: boolean) => void; leadId?: string; customerId?: string }) {
  const [form, setForm] = useState({ type: 'CALL', subject: '', body: '', occurredAt: new Date().toISOString().slice(0, 16), completed: true, nextFollowUpAt: '' });
  const save = useAction(() => api.post('/activities', {
    ...form, leadId, customerId, occurredAt: new Date(form.occurredAt).toISOString(), nextFollowUpAt: form.nextFollowUpAt || undefined,
  }), {
    success: 'Activity logged',
    invalidate: [['lead'], ['customer'], ['/activities'], ['/tasks'], ['/leads']],
    onSuccess: () => { onOpenChange(false); setForm((f) => ({ ...f, subject: '', body: '', nextFollowUpAt: '' })); },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Log activity"
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!form.subject}>Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type"><Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{['CALL', 'EMAIL', 'MEETING', 'WHATSAPP', 'NOTE'].map((t) => <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>)}</Select></Field>
        <Field label="When"><Input type="datetime-local" value={form.occurredAt} onChange={(e) => setForm({ ...form, occurredAt: e.target.value })} /></Field>
        <Field label="Subject" required className="sm:col-span-2"><Input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="e.g. Discussed proposal pricing" /></Field>
        <Field label="Notes" className="sm:col-span-2"><Textarea rows={4} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></Field>
        <label className="flex items-center gap-2 text-sm"><Switch checked={form.completed} onCheckedChange={(v) => setForm({ ...form, completed: v })} /> Completed</label>
        {leadId && <Field label="Next follow-up" hint="Creates or updates a follow-up task"><Input type="date" value={form.nextFollowUpAt} min={toDateInput(new Date())} onChange={(e) => setForm({ ...form, nextFollowUpAt: e.target.value })} /></Field>}
      </div>
    </Dialog>
  );
}

// ───────────── CSV import ─────────────

/** Reads a CSV as UTF-8, or as Windows-1252 (Excel's plain "CSV" on Windows) when it is not valid UTF-8. */
async function readCsvFile(f: File) {
  const bytes = await f.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('windows-1252').decode(bytes); }
}

/** Saves a header row plus example rows as a UTF-8 CSV that Excel opens correctly. */
function downloadTemplate(filename: string, rows: string[][]) {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const blob = new Blob(['﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface ImportResult { created: number; skipped: { row: number; reason: string }[] }

/**
 * Upload a CSV (comma, tab or semicolon separated) to an import endpoint and show what was created and skipped.
 * The template gives users a file with the expected columns.
 */
export function CsvImportDialog({ open, onOpenChange, title, endpoint, help, template, noun, invalidate }: {
  open: boolean; onOpenChange: (v: boolean) => void; title: string; endpoint: string; help: ReactNode;
  template: { filename: string; rows: string[][] }; noun: string; invalidate: string[][];
}) {
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const run = useAction(() => api.post<ImportResult>(endpoint, { csv, skipDuplicates: true }), {
    invalidate, onSuccess: (r) => { setResult(r); setCsv(''); toast.success(`${r.created} ${noun}${r.created === 1 ? '' : 's'} imported`); },
  });
  const rows = csv ? csv.split(/\r?\n/).filter((l) => l.trim()).length - 1 : 0;
  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) { setCsv(''); setFileName(''); setResult(null); } }} title={title} size="lg"
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Close</Button><Button onClick={() => run.mutate()} loading={run.isPending} disabled={!csv}>Import{rows > 0 ? ` ${rows} row${rows === 1 ? '' : 's'}` : ''}</Button></>}>
      <div className="mb-3 space-y-2 text-sm text-slate-600">{help}</div>
      <input ref={file} type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" className="hidden"
        onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { setCsv(await readCsvFile(f)); setFileName(f.name); setResult(null); } }} />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => file.current?.click()}><Upload /> Choose CSV file</Button>
        <Button variant="ghost" onClick={() => downloadTemplate(template.filename, template.rows)}><Download /> Download template</Button>
      </div>
      {csv && <p className="mt-2 text-sm text-muted">{fileName}: {rows} data row{rows === 1 ? '' : 's'} loaded</p>}
      {result && (
        <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm">
          <p className="font-medium">{result.created} created, {result.skipped.length} skipped</p>
          {result.skipped.length > 0 && <ul className="mt-2 max-h-48 overflow-auto text-xs text-slate-600">{result.skipped.map((s, i) => <li key={i}>Row {s.row}: {s.reason}</li>)}</ul>}
        </div>
      )}
    </Dialog>
  );
}
