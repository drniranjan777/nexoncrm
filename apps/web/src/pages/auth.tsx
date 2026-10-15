import { useState, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BarChart3, CheckCircle2, MessageSquareHeart, Receipt, ShieldCheck, Target } from 'lucide-react';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAuth, type Me } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/utils';
import { NexonwebLogo, NexonwebLogoWhite } from '@/components/brand';
import { Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Badge } from '@/components/ui';

function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-full lg:grid-cols-[1fr_1.1fr]">
      <div className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <Link to="/" className="mb-10 inline-flex" aria-label="Nexonweb home">
            <NexonwebLogo className="h-14" />
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-8 text-center text-sm text-muted">{footer}</div>}
        </div>
      </div>
      <div className="relative hidden overflow-hidden bg-brand-950 lg:block">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(59,110,245,0.35),transparent_55%),radial-gradient(circle_at_80%_80%,rgba(30,58,138,0.6),transparent_50%)]" />
        <div className="relative flex h-full flex-col justify-center px-16 text-white">
          <NexonwebLogoWhite className="mb-10 h-16" />
          <p className="text-sm font-medium uppercase tracking-widest text-brand-300">Business management platform</p>
          <h2 className="mt-4 max-w-md text-4xl font-semibold leading-tight tracking-tight">Customers, sales, delivery and billing in one place.</h2>
          <ul className="mt-10 space-y-4 text-[15px] text-brand-100">
            {[
              [Target, 'CRM with transparent lead scoring and automated follow-ups'],
              [MessageSquareHeart, 'Service-specific customer feedback with tracking'],
              [Receipt, 'GST-ready quotations, invoices and credit notes'],
              [BarChart3, 'Reports across sales, projects, support and finance'],
              [ShieldCheck, 'Multi-tenant isolation with granular roles'],
            ].map(([Icon, text], i) => {
              const I = Icon as typeof Target;
              return <li key={i} className="flex items-center gap-3"><span className="flex size-8 items-center justify-center rounded-lg bg-white/10"><I className="size-4" /></span>{text as string}</li>;
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

const fieldError = (e: unknown, field: string) => (e instanceof ApiError ? e.details?.fieldErrors?.[field]?.[0] : undefined);

export function Login() {
  const { me, setMe } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };
  const form = useForm<{ email: string; password: string }>({ resolver: zodResolver(z.object({ email: z.string().email('Enter a valid email'), password: z.string().min(1, 'Enter your password') })) });
  const [error, setError] = useState<string | null>(null);
  if (me) return <Navigate to={location.state?.from ?? '/'} replace />;
  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const user = await api.post<Me>('/auth/login', v);
      setMe(user);
      const portalOnly = user.memberships.length > 0 && user.memberships.every((m) => m.role.key === 'customer');
      navigate(location.state?.from ?? (user.memberships.length === 0 && user.isSuperAdmin ? '/platform' : portalOnly ? '/portal' : '/'), { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    }
  });
  return (
    <AuthLayout title="Sign in" subtitle="Welcome back. Sign in to your workspace." footer={<>New to Nexonweb? <Link to="/register" className="font-medium text-brand-700 hover:underline">Create a workspace</Link></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</div>}
        <Field label="Email" error={form.formState.errors.email?.message} htmlFor="email">
          <Input id="email" type="email" autoComplete="email" autoFocus {...form.register('email')} aria-invalid={!!form.formState.errors.email} />
        </Field>
        <Field label={<span className="flex justify-between"><span>Password</span><Link to="/forgot-password" className="font-normal text-brand-700 hover:underline">Forgot password?</Link></span>} error={form.formState.errors.password?.message} htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" {...form.register('password')} aria-invalid={!!form.formState.errors.password} />
        </Field>
        <Button type="submit" className="w-full" size="lg" loading={form.formState.isSubmitting}>Sign in</Button>
      </form>
    </AuthLayout>
  );
}

const registerSchema = z.object({
  name: z.string().min(2, 'Enter your name'),
  email: z.string().email('Enter a valid email'),
  companyName: z.string().min(2, 'Enter your company name'),
  password: z.string().min(10, 'Use at least 10 characters'),
});

export function Register() {
  const { me, setMe } = useAuth();
  const navigate = useNavigate();
  const form = useForm<z.infer<typeof registerSchema>>({ resolver: zodResolver(registerSchema) });
  const [error, setError] = useState<unknown>(null);
  if (me) return <Navigate to="/" replace />;
  const e = form.formState.errors;
  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      setMe(await api.post<Me>('/auth/register', v));
      toast.success('Workspace created. Your 14-day trial has started.');
      navigate('/settings/company');
    } catch (err) {
      setError(err);
    }
  });
  return (
    <AuthLayout title="Create your workspace" subtitle="Start a 14-day trial. No card required." footer={<>Already have an account? <Link to="/login" className="font-medium text-brand-700 hover:underline">Sign in</Link></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {!!error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{errorMessage(error)}</div>}
        <Field label="Your name" error={e.name?.message ?? fieldError(error, 'name')}><Input autoComplete="name" {...form.register('name')} /></Field>
        <Field label="Work email" error={e.email?.message ?? fieldError(error, 'email')}><Input type="email" autoComplete="email" {...form.register('email')} /></Field>
        <Field label="Company name" error={e.companyName?.message}><Input autoComplete="organization" {...form.register('companyName')} /></Field>
        <Field label="Password" error={e.password?.message ?? fieldError(error, 'password')} hint="At least 10 characters"><Input type="password" autoComplete="new-password" {...form.register('password')} /></Field>
        <Button type="submit" className="w-full" size="lg" loading={form.formState.isSubmitting}>Create workspace</Button>
      </form>
    </AuthLayout>
  );
}

export function ForgotPassword() {
  const [sent, setSent] = useState(false);
  const form = useForm<{ email: string }>({ resolver: zodResolver(z.object({ email: z.string().email('Enter a valid email') })) });
  const submit = form.handleSubmit(async (v) => {
    try {
      await api.post('/auth/forgot-password', v);
      setSent(true);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  });
  return (
    <AuthLayout title="Reset your password" subtitle="We'll email you a secure link to set a new password." footer={<Link to="/login" className="font-medium text-brand-700 hover:underline">Back to sign in</Link>}>
      {sent ? (
        <div className="flex items-start gap-3 rounded-lg bg-emerald-50 p-4 text-sm text-emerald-800"><CheckCircle2 className="mt-0.5 size-5 shrink-0" />If an account exists for that email, a reset link is on its way. It expires in 1 hour.</div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Email" error={form.formState.errors.email?.message}><Input type="email" autoFocus {...form.register('email')} /></Field>
          <Button type="submit" className="w-full" size="lg" loading={form.formState.isSubmitting}>Send reset link</Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const form = useForm<{ password: string; confirm: string }>({
    resolver: zodResolver(z.object({ password: z.string().min(10, 'Use at least 10 characters'), confirm: z.string() }).refine((d) => d.password === d.confirm, { path: ['confirm'], message: 'Passwords do not match' })),
  });
  const submit = form.handleSubmit(async (v) => {
    try {
      await api.post('/auth/reset-password', { token, password: v.password });
      toast.success('Password updated. Please sign in.');
      navigate('/login');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  });
  return (
    <AuthLayout title="Choose a new password">
      {!token ? <p className="text-sm text-red-600">This reset link is missing its token.</p> : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="New password" error={form.formState.errors.password?.message}><Input type="password" autoComplete="new-password" {...form.register('password')} /></Field>
          <Field label="Confirm password" error={form.formState.errors.confirm?.message}><Input type="password" autoComplete="new-password" {...form.register('confirm')} /></Field>
          <Button type="submit" className="w-full" size="lg" loading={form.formState.isSubmitting}>Update password</Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function AcceptInvite() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { setMe } = useAuth();
  const navigate = useNavigate();
  const info = useQuery({ queryKey: ['invite', token], queryFn: () => api.get<{ email: string; tenantName: string; roleName: string; hasAccount: boolean }>(`/auth/invitations/${token}`), enabled: !!token, retry: false });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    setBusy(true);
    try {
      const me = await api.post<Me>(`/auth/invitations/${token}/accept`, info.data?.hasAccount ? { password } : { name, password });
      setMe(me);
      toast.success(`Welcome to ${info.data?.tenantName}`);
      const m = me.memberships.find((x) => x.tenant.name === info.data?.tenantName);
      navigate(m?.role.key === 'customer' ? '/portal' : '/');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout title="Join workspace">
      {info.isLoading ? <LoadingBlock rows={3} /> : info.isError || !info.data ? (
        <EmptyState title="Invitation not valid" description="This invitation link is invalid, already used, or expired. Ask your administrator for a new one." />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">You've been invited to <strong>{info.data.tenantName}</strong> as <Badge tone="blue">{info.data.roleName}</Badge></p>
          <Field label="Email"><Input value={info.data.email} disabled /></Field>
          {!info.data.hasAccount && <Field label="Your name"><Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>}
          <Field label={info.data.hasAccount ? 'Your existing password' : 'Create a password'} hint={info.data.hasAccount ? 'You already have an account. Confirm your password to join.' : 'At least 10 characters'}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={info.data.hasAccount ? 'current-password' : 'new-password'} />
          </Field>
          <Button className="w-full" size="lg" loading={busy} onClick={accept} disabled={!password || (!info.data.hasAccount && name.length < 2)}>Accept invitation</Button>
        </div>
      )}
    </AuthLayout>
  );
}

export function Account() {
  const { me, setMe, logout } = useAuth();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<{ id: string; userAgent: string | null; ip: string | null; createdAt: string; lastSeenAt: string; current: boolean }[]>('/auth/sessions') });
  const [name, setName] = useState(me?.name ?? '');
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const saveName = useAction(() => api.patch<Me>('/auth/me', { name }), { success: 'Profile updated', onSuccess: (m) => setMe(m) });
  const changePw = useAction(() => api.post('/auth/change-password', pw), { success: 'Password changed. Other sessions were signed out.', invalidate: [['sessions']], onSuccess: () => setPw({ currentPassword: '', newPassword: '' }) });
  const revoke = useAction((id: string) => api.delete(`/auth/sessions/${id}`), { success: 'Session revoked', invalidate: [['sessions']] });
  const logoutAll = useAction(() => api.post('/auth/logout-all'), { onSuccess: () => logout() });
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Account & security" description={me?.email} />
      <Card>
        <CardHeader title="Profile" />
        <div className="flex flex-wrap items-end gap-3 p-5">
          <Field label="Name" className="min-w-64 flex-1"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Button onClick={() => saveName.mutate()} loading={saveName.isPending} disabled={name.length < 2}>Save</Button>
        </div>
      </Card>
      <Card>
        <CardHeader title="Change password" description="Changing your password signs out your other sessions." />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Current password"><Input type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
          <Field label="New password" hint="At least 10 characters"><Input type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Button onClick={() => changePw.mutate()} loading={changePw.isPending} disabled={!pw.currentPassword || pw.newPassword.length < 10}>Update password</Button></div>
        </div>
      </Card>
      <Card>
        <CardHeader title="Active sessions" actions={<Button variant="secondary" size="sm" onClick={() => logoutAll.mutate()} loading={logoutAll.isPending}>Sign out everywhere</Button>} />
        {sessions.isLoading ? <LoadingBlock rows={2} /> : sessions.isError ? <ErrorState error={sessions.error} /> : (
          <ul className="divide-y divide-line">
            {sessions.data?.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{s.userAgent?.split(')')[0]?.replace('(', ' · ') ?? 'Unknown device'}</p>
                  <p className="text-xs text-muted">{s.ip ?? 'Unknown IP'} · last active {fmtDateTime(s.lastSeenAt)}</p>
                </div>
                {s.current ? <Badge tone="green">This device</Badge> : <Button variant="ghost" size="sm" onClick={() => revoke.mutate(s.id)}>Revoke</Button>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
