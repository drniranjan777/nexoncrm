import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, Mail, Send, Server, Trash2, XCircle } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, ConfirmDialog, ErrorState, Field, Input, LoadingBlock, PageHeader, Select, Switch } from '@/components/ui';

// Outgoing mail server (SMTP) settings: an organization's own server (Settings → Email) or the platform default
// (Platform → Settings). The password is write-only: the server never sends it back.

type Security = 'TLS' | 'STARTTLS' | 'NONE';
interface ServerView {
  enabled: boolean; host: string; port: number; security: Security; username: string | null; fromEmail: string; fromName: string | null; replyTo: string | null;
  hasPassword: boolean; passwordReadable: boolean; lastTestAt: string | null; lastTestOk: boolean | null; lastTestError: string | null;
}
interface Effective { source: 'tenant' | 'platform' | 'environment' | 'none'; host?: string; port?: number; fromEmail?: string; fromName?: string | null }
interface TenantView { own: ServerView | null; effective: Effective; platformDefault: { host: string; fromEmail: string } | null; canStorePasswords: boolean }
interface PlatformView { server: ServerView | null; effective: Effective; environment: { host: string; port: number } | null; canStorePasswords: boolean }

const PRESETS: { key: string; label: string; host: string; port: number; security: Security; hint: string }[] = [
  { key: 'gmail', label: 'Google Workspace / Gmail', host: 'smtp.gmail.com', port: 587, security: 'STARTTLS', hint: 'Use an app password (Google account → Security → App passwords), not your normal password.' },
  { key: 'm365', label: 'Microsoft 365 / Outlook', host: 'smtp.office365.com', port: 587, security: 'STARTTLS', hint: 'SMTP AUTH must be enabled for the mailbox in Microsoft 365 admin.' },
  { key: 'zoho', label: 'Zoho Mail (India)', host: 'smtp.zoho.in', port: 465, security: 'TLS', hint: 'Use smtp.zoho.com for accounts outside India. An app-specific password may be required.' },
  { key: 'ses', label: 'Amazon SES (Mumbai)', host: 'email-smtp.ap-south-1.amazonaws.com', port: 587, security: 'STARTTLS', hint: 'Use SES SMTP credentials, and verify the sender address or domain in SES.' },
  { key: 'sendgrid', label: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, security: 'STARTTLS', hint: 'Username is the word "apikey"; the password is your API key.' },
  { key: 'brevo', label: 'Brevo', host: 'smtp-relay.brevo.com', port: 587, security: 'STARTTLS', hint: 'Use the SMTP login and key from Brevo → SMTP & API.' },
];
const DEFAULT_PORT: Record<Security, number> = { TLS: 465, STARTTLS: 587, NONE: 25 };
const SECURITY_LABEL: Record<Security, string> = { STARTTLS: 'STARTTLS (usually port 587)', TLS: 'SSL/TLS (usually port 465)', NONE: 'None (not recommended)' };

type Form = { enabled: boolean; host: string; port: string; security: Security; username: string; password: string; fromEmail: string; fromName: string; replyTo: string };
const blank: Form = { enabled: true, host: '', port: '587', security: 'STARTTLS', username: '', password: '', fromEmail: '', fromName: '', replyTo: '' };
const toForm = (s: ServerView): Form => ({ enabled: s.enabled, host: s.host, port: String(s.port), security: s.security, username: s.username ?? '', password: '', fromEmail: s.fromEmail, fromName: s.fromName ?? '', replyTo: s.replyTo ?? '' });

function EffectiveBanner({ e, scope }: { e: Effective; scope: 'tenant' | 'platform' }) {
  if (e.source === 'none') {
    return (
      <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <span>No mail server is set up, so emails (quotes, invoices, invitations) are recorded but <strong>not sent</strong>. {scope === 'tenant' ? 'Add your mail server below.' : 'Add the platform mail server below.'}</span>
      </div>
    );
  }
  const via = { tenant: 'your own mail server', platform: scope === 'tenant' ? 'the platform’s default mail server' : 'this platform mail server', environment: 'the mail server in the server environment (SMTP_*)' }[e.source];
  return (
    <div className="flex gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
      <span>Emails are sent through {via}: <strong>{e.host}</strong>{e.fromEmail ? <> as <strong>{e.fromName ? `${e.fromName} <${e.fromEmail}>` : e.fromEmail}</strong></> : null}.</span>
    </div>
  );
}

function ServerForm({ path, server, canStorePasswords, scope, onRemoved }: { path: string; server: ServerView | null; canStorePasswords: boolean; scope: 'tenant' | 'platform'; onRemoved: () => void }) {
  const { me } = useAuth();
  const [f, setF] = useState<Form>(server ? toForm(server) : blank);
  const [preset, setPreset] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [testTo, setTestTo] = useState(me?.email ?? '');
  const [removeOpen, setRemoveOpen] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);
  useEffect(() => { setF(server ? toForm(server) : blank); setClearPassword(false); }, [server]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const invalidate = [['mail-settings', path]];
  const save = useAction(() => api.put(path, {
    enabled: f.enabled, host: f.host.trim(), port: Number(f.port), security: f.security, username: f.username.trim() || null,
    password: f.password || undefined, clearPassword: clearPassword && !f.password, fromEmail: f.fromEmail.trim(), fromName: f.fromName.trim() || null, replyTo: f.replyTo.trim() || null,
  }), { success: 'Mail server saved. Send a test email to check it.', invalidate });
  const test = useAction(() => api.post<{ ok: boolean; error?: string }>(`${path}/test`, { to: testTo.trim() }), {
    invalidate, onSuccess: (r) => (r.ok ? toast.success(`Test email sent to ${testTo}. Check the inbox (and spam folder).`) : toast.error(r.error ?? 'The test failed')),
  });
  const remove = useAction(() => api.delete(path), { success: scope === 'tenant' ? 'Your mail server was removed' : 'Platform mail server removed', invalidate, onSuccess: () => { setRemoveOpen(false); onRemoved(); } });
  const submit = () => {
    setErrors({});
    save.mutate(undefined, {
      onError: (e) => {
        const fe = e instanceof ApiError ? (e.details?.fieldErrors as Record<string, string[]> | undefined) : undefined;
        if (fe) setErrors(Object.fromEntries(Object.entries(fe).map(([k, v]) => [k, v[0]])));
      },
    });
  };
  const presetInfo = PRESETS.find((p) => p.key === preset);
  const dirty = !server || JSON.stringify(toForm(server)) !== JSON.stringify(f) || clearPassword;

  return (
    <>
      <Card>
        <CardHeader title={scope === 'tenant' ? 'Your mail server (SMTP)' : 'Platform mail server (SMTP)'}
          description={scope === 'tenant' ? 'Send quotes, invoices and other emails from your own domain.' : 'Default server for every organization without its own, and for platform emails.'}
          actions={server && <Button variant="ghost" size="sm" className="text-red-600" onClick={() => setRemoveOpen(true)}><Trash2 /> Remove</Button>} />
        <div className="space-y-5 p-5">
          {!canStorePasswords && (
            <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">The server cannot store mail passwords yet. Ask your administrator to set <code>SETTINGS_ENCRYPTION_KEY</code> in the server environment.</div>
          )}
          {server && !server.passwordReadable && (
            <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">The saved password can no longer be read (the server’s encryption key changed). Enter the password again and save.</div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Provider" hint="Fills in the server details. You can still change them.">
              <Select value={preset} onChange={(e) => { const p = PRESETS.find((x) => x.key === e.target.value); setPreset(e.target.value); if (p) setF((x) => ({ ...x, host: p.host, port: String(p.port), security: p.security, ...(p.key === 'sendgrid' ? { username: 'apikey' } : {}) })); }}>
                <option value="">Other / custom</option>
                {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </Select>
            </Field>
            <label className="flex items-center gap-3 self-end pb-2 text-sm"><Switch checked={f.enabled} onCheckedChange={(v) => set('enabled', v)} /> {f.enabled ? 'Use this server' : 'Turned off (falls back to the default)'}</label>
          </div>
          {presetInfo && <p className="-mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{presetInfo.hint}</p>}
          <div className="grid gap-4 sm:grid-cols-[1fr_120px_220px]">
            <Field label="SMTP host" required error={errors.host}><Input value={f.host} onChange={(e) => set('host', e.target.value)} placeholder="smtp.yourdomain.com" autoComplete="off" /></Field>
            <Field label="Port" required error={errors.port}><Input type="number" min={1} max={65535} value={f.port} onChange={(e) => set('port', e.target.value)} /></Field>
            <Field label="Security" error={errors.security}>
              <Select value={f.security} onChange={(e) => { const s = e.target.value as Security; setF((x) => ({ ...x, security: s, port: Object.values(DEFAULT_PORT).map(String).includes(x.port) ? String(DEFAULT_PORT[s]) : x.port })); }}>
                {(Object.keys(SECURITY_LABEL) as Security[]).map((s) => <option key={s} value={s}>{SECURITY_LABEL[s]}</option>)}
              </Select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Username" error={errors.username} hint="Usually the full email address"><Input value={f.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" /></Field>
            <Field label="Password" error={errors.password}
              hint={server?.hasPassword && !clearPassword ? 'A password is saved. Leave blank to keep it.' : clearPassword ? 'The saved password will be removed when you save.' : undefined}>
              <Input type="password" value={f.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" placeholder={server?.hasPassword && !clearPassword ? '••••••••' : ''} disabled={!canStorePasswords} />
            </Field>
          </div>
          {server?.hasPassword && !f.password && (
            <label className="-mt-2 flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={clearPassword} onChange={(e) => setClearPassword(e.target.checked)} /> Remove the saved password (server needs no login)</label>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Sender email" required error={errors.fromEmail} hint="Must be allowed to send from this server"><Input type="email" value={f.fromEmail} onChange={(e) => set('fromEmail', e.target.value)} placeholder="billing@yourdomain.com" /></Field>
            <Field label="Sender name" error={errors.fromName} hint="Documents use the sender’s name and company"><Input value={f.fromName} onChange={(e) => set('fromName', e.target.value)} placeholder="Your Company" /></Field>
            <Field label="Reply-to" error={errors.replyTo} hint="Optional. Replies normally go to the person who sent."><Input type="email" value={f.replyTo} onChange={(e) => set('replyTo', e.target.value)} /></Field>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <Button onClick={submit} loading={save.isPending} disabled={!dirty}>Save</Button>
            {dirty && server && <span className="text-xs text-muted">Unsaved changes</span>}
          </div>
        </div>
      </Card>

      {server && (
        <Card>
          <CardHeader title="Test the connection" description="Connects with the saved settings and sends a short test email." />
          <div className="space-y-3 p-5">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Send the test to" className="w-full max-w-sm"><Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} /></Field>
              <Button variant="secondary" onClick={() => test.mutate()} loading={test.isPending} disabled={!testTo.trim() || dirty}><Send /> Send test email</Button>
            </div>
            {dirty && <p className="text-xs text-muted">Save your changes first, then send a test.</p>}
            {server.lastTestAt && (
              <p className="flex items-start gap-2 text-sm">
                {server.lastTestOk ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-red-600" />}
                <span>{server.lastTestOk ? 'Last test succeeded' : `Last test failed: ${server.lastTestError}`} <span className="text-muted">· {fmtDateTime(server.lastTestAt)}</span></span>
              </p>
            )}
            {!server.lastTestAt && <Badge tone="amber">Not tested since the last change</Badge>}
          </div>
        </Card>
      )}

      <ConfirmDialog open={removeOpen} onOpenChange={setRemoveOpen} danger confirmLabel="Remove" loading={remove.isPending} onConfirm={() => remove.mutate()}
        title={scope === 'tenant' ? 'Remove your mail server?' : 'Remove the platform mail server?'}
        description={scope === 'tenant' ? 'Emails will go through the platform’s default mail server, if there is one; otherwise they are recorded but not sent.' : 'Organizations without their own server will fall back to the server environment settings, if any; otherwise emails are not sent.'} />
    </>
  );
}

/** Settings → Email: the organization's own SMTP server. */
export function EmailSettings() {
  const q = useQuery({ queryKey: ['mail-settings', '/settings/email'], queryFn: () => api.get<TenantView>('/settings/email') });
  if (q.isLoading) return <Card><LoadingBlock /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>;
  const d = q.data;
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Email (SMTP)" description="Choose the mail server that sends your quotes, proforma invoices, invoices, receipts and invitations." />
      <EffectiveBanner e={d.effective} scope="tenant" />
      {!d.own && d.platformDefault && (
        <p className="flex items-center gap-2 text-sm text-slate-600"><Server className="size-4" /> Without your own server, emails are sent by the platform from <strong>{d.platformDefault.fromEmail}</strong>. Add your server to send from your own domain.</p>
      )}
      <ServerForm path="/settings/email" server={d.own} canStorePasswords={d.canStorePasswords} scope="tenant" onRemoved={() => q.refetch()} />
    </div>
  );
}

/** Platform → Settings: default SMTP server for all organizations. */
export function PlatformEmailSettings() {
  const q = useQuery({ queryKey: ['mail-settings', '/platform/email'], queryFn: () => api.get<PlatformView>('/platform/email') });
  if (q.isLoading) return <Card><LoadingBlock rows={3} /></Card>;
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>;
  const d = q.data;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2"><Mail className="size-5 text-brand-700" /><h2 className="text-lg font-semibold">Email delivery</h2></div>
      <EffectiveBanner e={d.effective} scope="platform" />
      {d.environment && <p className="text-xs text-muted">The server environment also defines SMTP ({d.environment.host}:{d.environment.port}); a platform server saved here takes priority over it.</p>}
      <ServerForm path="/platform/email" server={d.server} canStorePasswords={d.canStorePasswords} scope="platform" onRemoved={() => q.refetch()} />
    </div>
  );
}

