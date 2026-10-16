import { forwardRef, useState, type ComponentProps, type InputHTMLAttributes, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertCircle, ArrowRight, Building2, CheckCircle2, Eye, EyeOff, Lock, Mail, User } from 'lucide-react';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAuth, type Me } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/utils';
import { AuthFormBackdrop, AuthShowcase, PRODUCT_NAME, TallygenLogo } from '@/components/authBrand';
import { cn } from '@/lib/utils';
import { ForceLightTheme } from '@/lib/theme';
import { Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Badge } from '@/components/ui';

function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-full bg-surface lg:grid-cols-[minmax(0,1.42fr)_minmax(0,1fr)]">
      <ForceLightTheme />
      <AuthShowcase />
      <AuthFormBackdrop>
        <main className="flex flex-1 flex-col justify-center px-6 py-10 sm:px-12 lg:px-14 xl:px-20">
          <div className="mx-auto w-full max-w-[29rem]">
            <Link to="/login" className="mb-10 inline-flex rounded-md lg:mb-12" aria-label={`${PRODUCT_NAME} sign in`}>
              <TallygenLogo className="text-[2.6rem] sm:text-5xl xl:text-[3.6rem]" />
            </Link>
            <h1 className="font-display text-3xl font-extrabold tracking-tight text-[#0b1a3d] sm:text-[2.2rem]">{title}</h1>
            {subtitle && <p className="mt-2 text-base text-slate-500 sm:text-lg">{subtitle}</p>}
            <div className="mt-9">{children}</div>
            {footer && <div className="mt-8 text-center text-[15px] text-slate-600">{footer}</div>}
          </div>
        </main>
      </AuthFormBackdrop>
    </div>
  );
}

/** "OR" separator between the form and the alternative action. */
const OrDivider = () => (
  <div className="my-7 flex items-center gap-4 text-sm font-medium text-slate-500" role="separator" aria-label="or">
    <span className="h-px flex-1 bg-slate-200" />OR<span className="h-px flex-1 bg-slate-200" />
  </div>
);

const authInput = 'h-12 w-full rounded-xl border border-slate-200 bg-surface text-[15px] text-ink shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition placeholder:text-slate-400 hover:border-slate-300 focus:border-brand-600 focus:outline-none focus:ring-4 focus:ring-brand-100 disabled:bg-slate-50 disabled:text-slate-500 aria-[invalid=true]:border-red-400 aria-[invalid=true]:focus:ring-red-100';

/** Labelled input with an optional leading icon and an error linked for screen readers. */
const AuthField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { id: string; label: ReactNode; icon?: typeof Mail; error?: string; hint?: ReactNode; labelAside?: ReactNode; trailing?: ReactNode }>(
  ({ id, label, icon: Icon, error, hint, labelAside, trailing, className, ...props }, ref) => {
    const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={id} className="text-[15px] font-semibold text-[#0b1a3d]">{label}</label>
          {labelAside}
        </div>
        <div className="relative">
          {Icon && <Icon aria-hidden className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-slate-500" strokeWidth={1.75} />}
          <input ref={ref} id={id} aria-invalid={!!error} aria-describedby={describedBy} className={cn(authInput, Icon ? 'pl-12' : 'pl-4', trailing ? 'pr-12' : 'pr-4', className)} {...props} />
          {trailing}
        </div>
        {error ? <p id={`${id}-error`} className="text-sm text-red-600" role="alert">{error}</p> : hint ? <p id={`${id}-hint`} className="text-sm text-slate-500">{hint}</p> : null}
      </div>
    );
  },
);
AuthField.displayName = 'AuthField';

/** Password field with a show/hide toggle and a Caps Lock warning. */
const PasswordField = forwardRef<HTMLInputElement, Omit<ComponentProps<typeof AuthField>, 'type' | 'trailing'>>(({ hint, onKeyUp, onBlur, ...props }, ref) => {
  const [visible, setVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  return (
    <AuthField
      ref={ref} type={visible ? 'text' : 'password'} icon={Lock} spellCheck={false} autoCapitalize="off" {...props}
      hint={capsLock ? <span className="font-medium text-amber-700">Caps Lock is on</span> : hint}
      onKeyUp={(e) => { setCapsLock(e.getModifierState('CapsLock')); onKeyUp?.(e); }}
      onBlur={(e) => { setCapsLock(false); onBlur?.(e); }}
      trailing={
        <button type="button" onClick={() => setVisible((v) => !v)} aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible}
          className="absolute right-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-brand-500">
          {visible ? <Eye className="size-5" strokeWidth={1.75} /> : <EyeOff className="size-5" strokeWidth={1.75} />}
        </button>
      }
    />
  );
});
PasswordField.displayName = 'PasswordField';

/** Primary action button styled for the sign-in screens. */
const AuthSubmit = ({ children, loading, ...props }: ComponentProps<typeof Button>) => (
  <Button {...props} loading={loading} className="h-[3.25rem] w-full rounded-xl bg-[#0b3aa8] text-[17px] font-semibold shadow-[0_10px_24px_-10px_rgba(11,58,168,0.7)] hover:bg-[#0a3290] focus-visible:outline-offset-4">
    {children}
  </Button>
);

const FormError = ({ children }: { children: ReactNode }) => (
  <div className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert"><AlertCircle className="mt-0.5 size-4 shrink-0" />{children}</div>
);

const linkClass = 'font-semibold text-[#1847d6] underline-offset-4 hover:underline';

const fieldError = (e: unknown, field: string) => (e instanceof ApiError ? e.details?.fieldErrors?.[field]?.[0] : undefined);

export function Login() {
  const { me, setMe } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };
  const form = useForm<{ email: string; password: string }>({ resolver: zodResolver(z.object({ email: z.string().trim().email('Enter a valid email address'), password: z.string().min(1, 'Enter your password') })) });
  const [error, setError] = useState<string | null>(null);
  if (me) return <Navigate to={location.state?.from ?? '/'} replace />;
  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const user = await api.post<Me>('/auth/login', { ...v, email: v.email.trim() });
      setMe(user);
      const portalOnly = user.memberships.length > 0 && user.memberships.every((m) => m.role.key === 'customer');
      navigate(location.state?.from ?? (user.memberships.length === 0 && user.isSuperAdmin ? '/platform' : portalOnly ? '/portal' : '/'), { replace: true });
    } catch (e) {
      setError(e instanceof ApiError && e.status === 429 ? 'Too many sign-in attempts. Please wait a few minutes and try again.' : errorMessage(e));
    }
  });
  return (
    <AuthLayout title="Welcome back" subtitle={`Sign in to your ${PRODUCT_NAME} workspace.`}>
      <form onSubmit={submit} className="space-y-6" noValidate aria-label="Sign in">
        {error && <FormError>{error}</FormError>}
        <AuthField id="email" label="Email" icon={Mail} type="email" inputMode="email" autoComplete="username" autoFocus placeholder="you@company.com"
          error={form.formState.errors.email?.message} {...form.register('email')} />
        <PasswordField id="password" label="Password" autoComplete="current-password" placeholder="Enter your password"
          labelAside={<Link to="/forgot-password" className={cn(linkClass, 'text-[15px]')}>Forgot password?</Link>}
          error={form.formState.errors.password?.message} {...form.register('password')} />
        <AuthSubmit type="submit" loading={form.formState.isSubmitting}>Sign in{!form.formState.isSubmitting && <ArrowRight className="size-5" />}</AuthSubmit>
      </form>
      <OrDivider />
      <p className="text-center text-[15px] text-slate-600">New to {PRODUCT_NAME}? <Link to="/register" className={linkClass}>Create a workspace</Link></p>
    </AuthLayout>
  );
}

const registerSchema = z.object({
  name: z.string().min(2, 'Enter your name'),
  email: z.string().trim().email('Enter a valid email address'),
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
    <AuthLayout title="Create your workspace" subtitle="Start a 14-day trial. No card required.">
      <form onSubmit={submit} className="space-y-5" noValidate aria-label="Create your workspace">
        {!!error && <FormError>{errorMessage(error)}</FormError>}
        <AuthField id="name" label="Your name" icon={User} autoComplete="name" autoFocus error={e.name?.message ?? fieldError(error, 'name')} {...form.register('name')} />
        <AuthField id="email" label="Work email" icon={Mail} type="email" inputMode="email" autoComplete="email" placeholder="you@company.com" error={e.email?.message ?? fieldError(error, 'email')} {...form.register('email')} />
        <AuthField id="companyName" label="Company name" icon={Building2} autoComplete="organization" error={e.companyName?.message ?? fieldError(error, 'companyName')} {...form.register('companyName')} />
        <PasswordField id="password" label="Password" autoComplete="new-password" hint="At least 10 characters" error={e.password?.message ?? fieldError(error, 'password')} {...form.register('password')} />
        <AuthSubmit type="submit" loading={form.formState.isSubmitting}>Create workspace{!form.formState.isSubmitting && <ArrowRight className="size-5" />}</AuthSubmit>
      </form>
      <OrDivider />
      <p className="text-center text-[15px] text-slate-600">Already have an account? <Link to="/login" className={linkClass}>Sign in</Link></p>
    </AuthLayout>
  );
}

export function ForgotPassword() {
  const [sent, setSent] = useState(false);
  const form = useForm<{ email: string }>({ resolver: zodResolver(z.object({ email: z.string().trim().email('Enter a valid email address') })) });
  const submit = form.handleSubmit(async (v) => {
    try {
      await api.post('/auth/forgot-password', v);
      setSent(true);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  });
  return (
    <AuthLayout title="Reset your password" subtitle="We'll email you a secure link to set a new password." footer={<Link to="/login" className={linkClass}>Back to sign in</Link>}>
      {sent ? (
        <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800" role="status"><CheckCircle2 className="mt-0.5 size-5 shrink-0" />If an account exists for that email, a reset link is on its way. It expires in 1 hour.</div>
      ) : (
        <form onSubmit={submit} className="space-y-6" noValidate aria-label="Reset your password">
          <AuthField id="email" label="Email" icon={Mail} type="email" inputMode="email" autoComplete="email" autoFocus placeholder="you@company.com" error={form.formState.errors.email?.message} {...form.register('email')} />
          <AuthSubmit type="submit" loading={form.formState.isSubmitting}>Send reset link</AuthSubmit>
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
    <AuthLayout title="Choose a new password" subtitle="Use at least 10 characters." footer={<Link to="/login" className={linkClass}>Back to sign in</Link>}>
      {!token ? <FormError>This reset link is incomplete. Request a new one from the sign-in page.</FormError> : (
        <form onSubmit={submit} className="space-y-5" noValidate aria-label="Choose a new password">
          <PasswordField id="password" label="New password" autoComplete="new-password" autoFocus error={form.formState.errors.password?.message} {...form.register('password')} />
          <PasswordField id="confirm" label="Confirm password" autoComplete="new-password" error={form.formState.errors.confirm?.message} {...form.register('confirm')} />
          <AuthSubmit type="submit" loading={form.formState.isSubmitting}>Update password</AuthSubmit>
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
          <AuthField id="invite-email" label="Email" icon={Mail} value={info.data.email} disabled readOnly autoComplete="username" />
          {!info.data.hasAccount && <AuthField id="invite-name" label="Your name" icon={User} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus />}
          <PasswordField id="invite-password" label={info.data.hasAccount ? 'Your existing password' : 'Create a password'} value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete={info.data.hasAccount ? 'current-password' : 'new-password'} hint={info.data.hasAccount ? 'You already have an account. Confirm your password to join.' : 'At least 10 characters'}
            onKeyDown={(e) => { if (e.key === 'Enter' && password && (info.data!.hasAccount || name.length >= 2)) accept(); }} />
          <AuthSubmit loading={busy} onClick={accept} disabled={!password || (!info.data.hasAccount && name.length < 2)}>Accept invitation</AuthSubmit>
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
