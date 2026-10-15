import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, BarChart3, Building2, CheckCircle2, Clock, Copy, FileText, Hash, LayoutGrid, Lock, Mail, MessageSquareText, Phone,
  Send, Star, UploadCloud, User, X, ArrowRight,
} from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, errorMessage, qs } from '@/lib/api';
import { cn, fileSize, fmtDateTime, titleCase } from '@/lib/utils';
import { NexonwebLogo } from '@/components/brand';
import { Button, Card, EmptyState, Field, Input, LoadingBlock, Select, Spinner, StatusBadge, Textarea } from '@/components/ui';

// Public pages call the API without the tenant header or CSRF header (public endpoints accept neither).
async function publicFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1/public${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'Request failed', data.details);
  return data as T;
}

type Question = { id: string; label: string; type: 'rating' } | { id: string; label: string; type: 'choice'; options: string[] } | { id: string; label: string; type: 'text' };
interface FormMeta {
  tenant: { name: string; slug: string; brandColor: string; hasLogo: boolean };
  link: { projectName: string | null; projectCode: string | null; serviceCategory: string | null; customerName: string | null; company: string | null } | null;
  serviceCategories: string[];
  serviceQuestions: Record<string, Question[]>;
  technicalServices: string[];
  projectStatuses: string[];
  expectationStatuses: string[];
}

const RATING_LABELS = ['Very poor', 'Poor', 'Average', 'Good', 'Excellent'];
const MAX_FILES = 5;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.ppt,.pptx';

/* ---------- Building blocks ---------- */

function Stars({ value, onChange, label, size = 'md' }: { value?: number; onChange: (v: number) => void; label: string; size?: 'md' | 'lg' }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value || 0;
  return (
    <div>
      <div className="flex items-center gap-1" role="radiogroup" aria-label={label} onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} – ${RATING_LABELS[n - 1]}`}
            onMouseEnter={() => setHover(n)} onClick={() => onChange(n)}
            className="rounded-md p-0.5 transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-brand-600">
            <Star strokeWidth={1.6} className={cn(size === 'lg' ? 'size-8' : 'size-7', 'transition-colors', shown >= n ? 'fill-amber-400 text-amber-400' : 'text-slate-300')} />
          </button>
        ))}
      </div>
      <p className="mt-1 h-4 text-xs font-medium text-slate-500">{shown ? RATING_LABELS[shown - 1] : ''}</p>
    </div>
  );
}

function RatingCell({ label, required, error, ...p }: { label: string; required?: boolean; error?: string; value?: number; onChange: (v: number) => void }) {
  return (
    <div className="min-w-0">
      <p className="mb-2 text-[13px] font-semibold text-slate-800">{label}{required && <span className="ml-0.5 text-red-500">*</span>}</p>
      <Stars label={label} {...p} />
      {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
    </div>
  );
}

function Section({ icon, tone = 'blue', title, description, children, className }: { icon: ReactNode; tone?: 'blue' | 'orange'; title: string; description: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_8px_24px_-12px_rgba(16,24,40,0.08)] sm:p-6', className)}>
      <header className="mb-5 flex items-start gap-3.5">
        <span className={cn('flex size-11 shrink-0 items-center justify-center rounded-full [&_svg]:size-5', tone === 'blue' ? 'bg-blue-50 text-blue-600' : 'bg-orange-50 text-orange-500')}>{icon}</span>
        <div>
          <h2 className="text-[17px] font-semibold text-[#14163a]">{title}</h2>
          <p className="text-[13px] text-slate-500">{description}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

/** Wraps an input/select so it gets a leading icon. */
function WithIcon({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-slate-400 [&_svg]:size-4">{icon}</span>
      {children}
    </div>
  );
}

const ctl = 'h-11 rounded-lg border-slate-200 bg-white pl-10 text-sm placeholder:text-slate-400';
const area = 'min-h-[84px] rounded-lg border-slate-200 text-sm placeholder:text-slate-400';

function HeroArt() {
  return (
    <svg viewBox="0 0 340 170" className="h-full w-full" aria-hidden="true">
      <defs>
        <linearGradient id="fb-blob" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stopColor="#e8efff" /><stop offset="1" stopColor="#f4f7ff" /></linearGradient>
        <linearGradient id="fb-screen" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#eef3ff" /></linearGradient>
      </defs>
      <ellipse cx="190" cy="105" rx="150" ry="70" fill="url(#fb-blob)" />
      <path d="M60 170c10-40 30-60 52-62-8 22-20 44-52 62Z" fill="#c7d7fb" />
      <path d="M78 170c-2-34 6-58 22-70 4 26-4 48-22 70Z" fill="#a9c1f6" />
      <path d="M300 170c-6-30-22-48-42-52 6 20 18 38 42 52Z" fill="#c7d7fb" />
      <rect x="120" y="20" width="96" height="78" rx="8" fill="#fff" stroke="#dbe5fb" />
      <rect x="132" y="34" width="56" height="6" rx="3" fill="#c7d7fb" />
      <rect x="132" y="47" width="70" height="5" rx="2.5" fill="#e3ebfd" />
      <rect x="132" y="58" width="62" height="5" rx="2.5" fill="#e3ebfd" />
      <rect x="134" y="62" width="150" height="92" rx="8" fill="url(#fb-screen)" stroke="#2f5bd3" strokeWidth="4" transform="skewX(-6)" />
      {[0, 1, 2, 3].map((i) => (
        <path key={i} transform={`translate(${168 + i * 28} 92) scale(0.9)`} fill="#f97316"
          d="M12 1.5l3.1 6.4 7 1-5.1 4.9 1.2 7L12 17.5l-6.2 3.3 1.2-7L1.9 8.9l7-1z" />
      ))}
      <rect x="160" y="128" width="96" height="5" rx="2.5" fill="#dbe5fb" />
      <g transform="translate(92 48)">
        <rect width="46" height="36" rx="10" fill="#3b82f6" />
        <path d="M10 36l2 10 10-10Z" fill="#3b82f6" />
        <rect x="10" y="12" width="26" height="4" rx="2" fill="#fff" />
        <rect x="10" y="21" width="18" height="4" rx="2" fill="#bfdbfe" />
      </g>
      <g transform="translate(286 52) rotate(-18)">
        <path d="M0 14 34 0 24 32 16 20Z" fill="#fb923c" />
        <path d="M16 20 34 0 12 18Z" fill="#ea580c" />
      </g>
      <circle cx="104" cy="22" r="3" fill="#fb923c" />
      <g fill="#cbd5e1">{Array.from({ length: 12 }, (_, i) => <circle key={i} cx={312 + (i % 3) * 9} cy={100 + Math.floor(i / 3) * 9} r="1.5" />)}</g>
    </svg>
  );
}

function BrandMark({ meta, className }: { meta?: FormMeta['tenant']; className?: string }) {
  if (!meta) return <NexonwebLogo className={className} />;
  if (meta.hasLogo) return <img src={`/api/v1/public/tenants/${meta.slug}/logo`} alt={meta.name} className={cn('object-contain object-left', className)} />;
  return (
    <span className="flex items-center gap-2.5">
      <span className="flex size-10 items-center justify-center rounded-lg text-lg font-bold text-white" style={{ background: meta.brandColor }}>{meta.name[0]}</span>
      <span className="text-lg font-semibold text-[#14163a]">{meta.name}</span>
    </span>
  );
}

function Shell({ meta, wide, children }: { meta?: FormMeta['tenant']; wide?: boolean; children: ReactNode }) {
  return (
    <div className="relative min-h-full overflow-hidden bg-[#f6f8fc]">
      {/* Soft background shapes */}
      <div aria-hidden className="pointer-events-none absolute -top-32 -right-32 size-[28rem] rounded-full bg-blue-100/60 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute top-[45%] -left-40 size-[26rem] rounded-full bg-orange-100/50 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute top-[30%] left-6 hidden h-40 w-16 bg-[radial-gradient(#cbd5e1_1.2px,transparent_1.2px)] [background-size:12px_12px] xl:block" />
      <div aria-hidden className="pointer-events-none absolute right-6 bottom-24 hidden h-40 w-16 bg-[radial-gradient(#cbd5e1_1.2px,transparent_1.2px)] [background-size:12px_12px] xl:block" />

      <header className="relative border-b border-slate-200/70 bg-white/70 backdrop-blur">
        <div className={cn('mx-auto flex h-16 items-center justify-between px-4 sm:px-6', wide ? 'max-w-6xl' : 'max-w-3xl')}>
          <BrandMark meta={meta} className="h-11 max-w-52" />
          <span className="text-sm font-medium text-slate-600">Customer Feedback</span>
        </div>
      </header>

      <main className={cn('relative mx-auto px-4 pt-8 pb-10 sm:px-6', wide ? 'max-w-6xl' : 'max-w-3xl')}>
        {children}
        <footer className="mt-8 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-xs text-slate-500">
          <span className="flex items-center gap-1.5"><Lock className="size-3.5" /> Your feedback is stored securely and used only to improve our service.</span>
          <span className="hidden h-3 w-px bg-slate-300 sm:block" />
          <span className="flex items-center gap-1.5">Powered by <NexonwebLogo className="h-5" /></span>
        </footer>
      </main>
    </div>
  );
}

type Values = Record<string, string | number | undefined>;

/* ---------- Form ---------- */

export function PublicFeedbackForm() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const tenantSlug = params.get('tenant') ?? undefined;
  const meta = useQuery({ queryKey: ['public-form', token, tenantSlug], queryFn: () => publicFetch<FormMeta>(`/feedback/form${qs({ token, tenant: tenantSlug })}`), retry: false });
  const [v, setV] = useState<Values>({});
  const [answers, setAnswers] = useState<Values>({});
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [done, setDone] = useState<{ referenceNo: string; trackUrl: string; trackingToken: string; tenantSlug: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const l = meta.data?.link;
    if (l) setV((cur) => ({ ...cur, serviceCategory: cur.serviceCategory ?? l.serviceCategory ?? undefined, name: cur.name ?? l.customerName ?? undefined, company: cur.company ?? l.company ?? undefined, projectReference: l.projectCode ?? undefined }));
  }, [meta.data]);

  if (meta.isLoading) return <Shell wide><Card><LoadingBlock rows={6} /></Card></Shell>;
  if (meta.error || !meta.data) return <Shell><Card><EmptyState title="This feedback link is not available" description="The link may have expired or been disabled. Please contact your account manager for a new link." /></Card></Shell>;
  const m = meta.data;
  const set = (k: string, val: string | number | undefined) => { setV((c) => ({ ...c, [k]: val })); setErrors((e) => ({ ...e, [k]: '' })); };
  const service = v.serviceCategory as string | undefined;
  const questions = service ? m.serviceQuestions[service] ?? [] : [];
  const technical = service ? m.technicalServices.includes(service) : false;

  if (done) {
    const full = done.trackUrl.startsWith('http') ? done.trackUrl : `${window.location.origin}/track?ref=${done.referenceNo}&t=${done.trackingToken}`;
    return (
      <Shell meta={m.tenant}>
        <section className="rounded-2xl border border-slate-200/80 bg-white p-8 text-center shadow-sm">
          <span className="mx-auto flex size-16 items-center justify-center rounded-full bg-emerald-50"><CheckCircle2 className="size-9 text-emerald-600" /></span>
          <h1 className="mt-5 text-3xl font-bold tracking-tight text-[#14163a]">Thank you for your <span className="text-orange-500">feedback</span></h1>
          <p className="mt-2 text-slate-600">We've received it and our team will review it shortly.</p>
          <div className="mx-auto mt-6 max-w-sm rounded-xl border border-dashed border-blue-200 bg-blue-50/50 p-4">
            <p className="text-xs font-medium tracking-wider text-slate-500 uppercase">Your reference number</p>
            <p className="mt-1 text-2xl font-semibold tracking-wide text-[#14163a]">{done.referenceNo}</p>
          </div>
          <p className="mt-6 text-sm text-slate-600">Keep this private link to follow the status of your feedback{v.email ? ` (we've also emailed it to ${v.email})` : ''}:</p>
          <div className="mx-auto mt-2 flex max-w-lg gap-2">
            <Input readOnly value={full} className="h-10 text-xs" onFocus={(e) => e.target.select()} />
            <Button variant="secondary" className="h-10" onClick={() => { navigator.clipboard.writeText(full); toast.success('Copied'); }} aria-label="Copy link"><Copy /></Button>
          </div>
          <Button asChild size="lg" className="mt-6"><Link to={`/track?ref=${encodeURIComponent(done.referenceNo)}&t=${done.trackingToken}`}>View status <ArrowRight /></Link></Button>
        </section>
      </Shell>
    );
  }

  // Progress: details → ratings → consent.
  const detailsDone = !!v.name && String(v.name).trim().length >= 2 && /^\S+@\S+\.\S+$/.test(String(v.email ?? '')) && !!service;
  const ratingDone = !!v.ratingOverall;
  const step = !detailsDone ? 1 : !ratingDone ? 2 : 3;
  const progress = [detailsDone, ratingDone, !!v.consent].filter(Boolean).length;

  const addFiles = (list: FileList | null) => {
    const incoming = Array.from(list ?? []);
    const tooBig = incoming.filter((f) => f.size > MAX_FILE_BYTES);
    if (tooBig.length) toast.error(`${tooBig.map((f) => f.name).join(', ')} ${tooBig.length === 1 ? 'is' : 'are'} larger than 15 MB`);
    const ok = incoming.filter((f) => f.size <= MAX_FILE_BYTES);
    setFiles((cur) => {
      const next = [...cur, ...ok];
      if (next.length > MAX_FILES) toast.error(`You can attach up to ${MAX_FILES} files`);
      return next.slice(0, MAX_FILES);
    });
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!v.name || String(v.name).trim().length < 2) e.name = 'Please enter your name';
    if (!v.email || !/^\S+@\S+\.\S+$/.test(String(v.email))) e.email = 'Please enter a valid email';
    if (!service) e.serviceCategory = 'Please choose a service';
    if (!v.ratingOverall) e.ratingOverall = 'Please rate your overall satisfaction';
    if (!v.consent) e.consent = 'Please confirm to continue';
    setErrors(e);
    return e;
  };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const e = validate();
    if (Object.keys(e).length) {
      toast.error('Please complete the required fields');
      // Bring the first problem into view.
      const first = ['name', 'email', 'serviceCategory', 'ratingOverall', 'consent'].find((k) => e[k]);
      setTimeout(() => {
        const el = document.getElementById(`fb-${first}`);
        el?.scrollIntoView({ block: 'center' });
        if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.focus({ preventScroll: true });
      });
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      if (token) fd.append('token', token);
      if (!token) fd.append('tenant', tenantSlug ?? m.tenant.slug);
      for (const [k, val] of Object.entries(v)) if (val !== undefined && val !== '') fd.append(k, String(val));
      fd.append('serviceAnswers', JSON.stringify(answers));
      files.forEach((f) => fd.append('attachments', f));
      setDone(await publicFetch('/feedback', { method: 'POST', body: fd }));
      window.scrollTo({ top: 0 });
    } catch (err) {
      if (err instanceof ApiError && err.details?.fieldErrors) {
        setErrors(Object.fromEntries(Object.entries(err.details.fieldErrors).map(([k, msgs]) => [k, msgs[0]])));
      }
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const ratingCols = technical ? 'lg:grid-cols-5' : 'lg:grid-cols-4';

  return (
    <Shell meta={m.tenant} wide>
      <form onSubmit={submit} noValidate>
        {/* Hero */}
        <div className="grid items-end gap-6 md:grid-cols-[1fr_340px]">
          <div className="pb-2">
            <h1 className="text-4xl font-extrabold tracking-tight text-[#14163a] sm:text-5xl">Share your <span className="text-orange-500">feedback</span></h1>
            <p className="mt-3 text-lg text-slate-500">
              {m.link?.projectName ? <>About <strong className="font-semibold text-slate-700">{m.link.projectName}</strong>. </> : null}
              Your feedback helps us deliver better results.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-slate-600">
              <span className="flex items-center gap-2"><Clock className="size-5 text-slate-500" /> About 3 minutes</span>
              <span className="hidden h-6 w-px bg-slate-300 sm:block" />
              <span className="flex items-center gap-3">
                <span className="font-medium whitespace-nowrap">Step {step} of 3</span>
                <span className="h-2 w-48 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuemin={0} aria-valuemax={3} aria-valuenow={progress} aria-label="Form progress">
                  <span className="block h-full rounded-full bg-gradient-to-r from-blue-600 to-blue-500 transition-all duration-500" style={{ width: `${Math.max(12, (progress / 3) * 100)}%` }} />
                </span>
              </span>
            </div>
          </div>
          <div className="hidden h-[170px] md:block"><HeroArt /></div>
        </div>

        <div className="mt-2 space-y-5">
          {/* Details + project */}
          <div className="grid gap-5 lg:grid-cols-2">
            <Section icon={<User />} title="Your details" description="Tell us about yourself so we can better understand your feedback.">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Your name" required error={errors.name}>
                  <WithIcon icon={<User />}><Input id="fb-name" className={ctl} placeholder="Enter your full name" value={v.name ?? ''} onChange={(e) => set('name', e.target.value)} autoComplete="name" aria-invalid={!!errors.name} /></WithIcon>
                </Field>
                <Field label="Company">
                  <WithIcon icon={<Building2 />}><Input className={ctl} placeholder="Your company name" value={v.company ?? ''} onChange={(e) => set('company', e.target.value)} autoComplete="organization" /></WithIcon>
                </Field>
                <Field label="Work email" required error={errors.email}>
                  <WithIcon icon={<Mail />}><Input id="fb-email" type="email" className={ctl} placeholder="you@company.com" value={v.email ?? ''} onChange={(e) => set('email', e.target.value)} autoComplete="email" aria-invalid={!!errors.email} /></WithIcon>
                </Field>
                <Field label="Phone (optional)">
                  <WithIcon icon={<Phone />}><Input type="tel" className={ctl} placeholder="Enter your phone number" value={v.phone ?? ''} onChange={(e) => set('phone', e.target.value)} autoComplete="tel" /></WithIcon>
                </Field>
                {!m.link?.projectCode && (
                  <Field label="Project or order reference" className="sm:col-span-2">
                    <WithIcon icon={<FileText />}><Input className={ctl} placeholder="Project ID, order number or reference (if any)" value={v.projectReference ?? ''} onChange={(e) => set('projectReference', e.target.value)} /></WithIcon>
                  </Field>
                )}
              </div>
              {/* Honeypot: hidden from people, filled in by bots */}
              <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hidden" onChange={(e) => set('website', e.target.value)} aria-hidden="true" />
            </Section>

            <Section icon={<FileText />} tone="orange" title="Project details" description="Help us understand which project this feedback is about.">
              {m.link?.projectName && (
                <div className="mb-4 flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
                  <Hash className="size-4 text-slate-400" /> <span className="font-medium text-slate-800">{m.link.projectName}</span>{m.link.projectCode && <span className="text-slate-400">· {m.link.projectCode}</span>}
                </div>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Service" required error={errors.serviceCategory}>
                  <WithIcon icon={<LayoutGrid />}>
                    <Select id="fb-serviceCategory" className={cn(ctl, !service && 'text-slate-400')} value={service ?? ''} onChange={(e) => { set('serviceCategory', e.target.value); setAnswers({}); }} aria-invalid={!!errors.serviceCategory}>
                      <option value="">Select a service</option>
                      {m.serviceCategories.map((s) => <option key={s} className="text-ink">{s}</option>)}
                    </Select>
                  </WithIcon>
                </Field>
                <Field label="Project status">
                  <WithIcon icon={<Activity />}>
                    <Select className={cn(ctl, !v.projectStatus && 'text-slate-400')} value={v.projectStatus ?? ''} onChange={(e) => set('projectStatus', e.target.value)}>
                      <option value="">Select project status</option>
                      {m.projectStatuses.map((s) => <option key={s} className="text-ink">{s}</option>)}
                    </Select>
                  </WithIcon>
                </Field>
              </div>

              {/* Service-specific follow-up questions fill the space under the selects. */}
              {questions.length > 0 ? (
                <div className="mt-5 space-y-4 border-t border-dashed border-slate-200 pt-5">
                  <p className="text-xs font-semibold tracking-wider text-slate-500 uppercase">About your {service}</p>
                  {questions.map((q) => q.type === 'rating' ? (
                    <RatingCell key={q.id} label={q.label} value={answers[q.id] as number} onChange={(n) => setAnswers({ ...answers, [q.id]: n })} />
                  ) : q.type === 'choice' ? (
                    <Field key={q.id} label={q.label}>
                      <div className="flex flex-wrap gap-2">
                        {q.options.map((o) => (
                          <button key={o} type="button" onClick={() => setAnswers({ ...answers, [q.id]: o })}
                            className={cn('rounded-full border px-3.5 py-1.5 text-sm transition-colors', answers[q.id] === o ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300')}>{o}</button>
                        ))}
                      </div>
                    </Field>
                  ) : (
                    <Field key={q.id} label={q.label}><Textarea rows={2} className={area} value={(answers[q.id] as string) ?? ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} /></Field>
                  ))}
                </div>
              ) : !service && (
                <p className="mt-5 rounded-lg border border-dashed border-slate-200 px-4 py-3 text-[13px] text-slate-500">Choose a service and we'll ask a couple of quick questions specific to it.</p>
              )}
            </Section>
          </div>

          {/* Ratings */}
          <Section icon={<Star />} title="Rate your experience" description="How would you rate different aspects of our work?">
            <div id="fb-ratingOverall" className={cn('grid gap-6 sm:grid-cols-2 lg:gap-0 lg:divide-x lg:divide-slate-200 [&>*]:lg:px-6 [&>*:first-child]:lg:pl-1', ratingCols)}>
              <RatingCell label="Overall satisfaction" required value={v.ratingOverall as number} onChange={(n) => set('ratingOverall', n)} error={errors.ratingOverall} />
              <RatingCell label="Communication" value={v.ratingCommunication as number} onChange={(n) => set('ratingCommunication', n)} />
              <RatingCell label="Quality of work" value={v.ratingQuality as number} onChange={(n) => set('ratingQuality', n)} />
              <RatingCell label="Timeliness" value={v.ratingTimeliness as number} onChange={(n) => set('ratingTimeliness', n)} />
              {technical && <RatingCell label="Technical quality" value={v.ratingTechnical as number} onChange={(n) => set('ratingTechnical', n)} />}
            </div>
          </Section>

          {/* Written feedback */}
          <Section icon={<MessageSquareText />} tone="orange" title="Your feedback" description="Tell us more about your experience. Your input helps us improve.">
            <div className="grid gap-x-5 gap-y-4 md:grid-cols-2">
              <Field label="What is working well?"><Textarea rows={3} className={area} placeholder="Please share what you are happy with…" value={v.workingWell ?? ''} onChange={(e) => set('workingWell', e.target.value)} /></Field>
              <Field label="What could be improved?"><Textarea rows={3} className={area} placeholder="Share what we can do better…" value={v.needsImprovement ?? ''} onChange={(e) => set('needsImprovement', e.target.value)} /></Field>
              <Field label="Requested changes"><Textarea rows={3} className={area} placeholder="Let us know if you have any specific changes…" value={v.requestedChanges ?? ''} onChange={(e) => set('requestedChanges', e.target.value)} /></Field>
              <Field label="Urgent issues" hint="Anything blocking your business right now? We prioritise these.">
                <Textarea rows={3} className={cn(area, v.urgentIssues && 'border-orange-300 bg-orange-50/30')} placeholder="Let us know if there are any urgent issues…" value={v.urgentIssues ?? ''} onChange={(e) => set('urgentIssues', e.target.value)} />
              </Field>
              <Field label="Are we meeting your expectations?">
                <WithIcon icon={<BarChart3 />}>
                  <Select className={cn(ctl, !v.expectationStatus && 'text-slate-400')} value={v.expectationStatus ?? ''} onChange={(e) => set('expectationStatus', e.target.value)}>
                    <option value="">Select an option</option>
                    {m.expectationStatuses.map((s) => <option key={s} className="text-ink">{s}</option>)}
                  </Select>
                </WithIcon>
              </Field>
              <Field label="Additional comments"><Textarea rows={2} className={cn(area, 'min-h-11')} placeholder="Any other feedback you would like to share…" value={v.comments ?? ''} onChange={(e) => set('comments', e.target.value)} /></Field>
            </div>

            <div className="mt-5 grid gap-2 md:grid-cols-[140px_1fr] md:items-start">
              <p className="pt-1 text-[13px] font-medium text-slate-700">Attachments</p>
              <div>
                <input ref={fileInput} type="file" multiple className="hidden" accept={ACCEPT} onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
                <div
                  role="button" tabIndex={0}
                  onClick={() => files.length < MAX_FILES && fileInput.current?.click()}
                  onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && files.length < MAX_FILES) { e.preventDefault(); fileInput.current?.click(); } }}
                  onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
                  className={cn('flex cursor-pointer items-center justify-center gap-4 rounded-xl border-2 border-dashed px-4 py-4 transition-colors',
                    dragging ? 'border-blue-400 bg-blue-50' : 'border-slate-200 bg-slate-50/40 hover:border-blue-300 hover:bg-blue-50/40',
                    files.length >= MAX_FILES && 'cursor-not-allowed opacity-60')}
                >
                  <span className="flex size-11 items-center justify-center rounded-full bg-blue-50 text-blue-600"><UploadCloud className="size-5" /></span>
                  <span className="text-left">
                    <span className="block text-[13px] text-slate-700">Drag & drop files here or <span className="font-medium text-blue-600 underline underline-offset-2">click to upload</span></span>
                    <span className="block text-xs text-slate-500">Up to 5 files: images, PDF or Office documents, 15 MB each</span>
                  </span>
                </div>
                {files.length > 0 && (
                  <ul className="mt-3 flex flex-wrap gap-2">
                    {files.map((f, i) => (
                      <li key={i} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white py-1.5 pr-1.5 pl-3 text-xs text-slate-700">
                        <FileText className="size-3.5 text-slate-400" /><span className="max-w-48 truncate">{f.name}</span><span className="text-slate-400">{fileSize(f.size)}</span>
                        <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`} className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X className="size-3.5" /></button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="mt-6 flex flex-col gap-4 border-t border-slate-100 pt-5 md:flex-row md:items-center md:justify-between">
              <label id="fb-consent" className="flex max-w-2xl items-start gap-3 text-sm text-slate-600">
                <input type="checkbox" className="mt-0.5 size-4 shrink-0 rounded border-slate-300 accent-blue-600" checked={!!v.consent} onChange={(e) => set('consent', e.target.checked ? 'true' : undefined)} aria-invalid={!!errors.consent} />
                <span>I agree that {m.tenant.name} may store and process this feedback to respond to me and improve its services.{errors.consent && <span className="block text-xs text-red-600" role="alert">{errors.consent}</span>}</span>
              </label>
              <Button type="submit" size="lg" loading={busy} className="h-12 shrink-0 rounded-lg bg-blue-600 px-7 text-[15px] shadow-[0_8px_20px_-8px_rgba(37,99,235,0.7)] hover:bg-blue-700">
                {!busy && <Send />} Submit feedback {!busy && <ArrowRight />}
              </Button>
            </div>
          </Section>
        </div>
      </form>
    </Shell>
  );
}

export function TrackFeedback() {
  const [params] = useSearchParams();
  const ref = params.get('ref') ?? '';
  const t = params.get('t') ?? '';
  const q = useQuery({
    queryKey: ['track', ref, t], enabled: !!ref && !!t, retry: false,
    queryFn: () => publicFetch<{ referenceNo: string; tenantName: string; tenantSlug: string; brandColor: string; hasLogo: boolean; status: string; serviceCategory: string; submittedAt: string; updatedAt: string; resolvedAt: string | null; timeline: { kind: string; body: string | null; at: string }[] }>(`/feedback/track${qs({ ref, t })}`),
  });
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const send = async () => {
    setSending(true);
    try {
      await publicFetch('/feedback/track/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref, t, message: reply }) });
      setReply('');
      toast.success('Message sent');
      q.refetch();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSending(false);
    }
  };
  if (!ref || !t) return <Shell><Card><EmptyState title="Tracking link incomplete" description="Use the full link from your confirmation email." /></Card></Shell>;
  if (q.isLoading) return <Shell><div className="flex justify-center py-20"><Spinner /></div></Shell>;
  if (q.error || !q.data) return <Shell><Card><EmptyState title="Feedback not found" description="Check that you used the full tracking link from your confirmation email." /></Card></Shell>;
  const d = q.data;
  const steps = ['NEW', 'UNDER_REVIEW', 'IN_PROGRESS', 'RESOLVED'];
  const order: Record<string, number> = { NEW: 0, UNDER_REVIEW: 1, ASSIGNED: 1, IN_PROGRESS: 2, WAITING_FOR_CUSTOMER: 2, RESOLVED: 3, CLOSED: 3 };
  return (
    <Shell meta={{ name: d.tenantName, slug: d.tenantSlug, brandColor: d.brandColor, hasLogo: d.hasLogo }}>
      <Card className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><p className="text-sm text-muted">Reference</p><p className="text-2xl font-semibold">{d.referenceNo}</p></div>
          <StatusBadge status={d.status} className="px-2.5 py-1 text-sm" />
        </div>
        <ol className="mt-6 grid grid-cols-4 gap-2">
          {steps.map((s, i) => (
            <li key={s} className="text-center">
              <div className={cn('h-1.5 rounded-full', order[d.status] >= i ? 'bg-brand-700' : 'bg-slate-200')} />
              <p className={cn('mt-2 text-xs', order[d.status] >= i ? 'font-medium text-ink' : 'text-muted')}>{titleCase(s)}</p>
            </li>
          ))}
        </ol>
        {d.status === 'WAITING_FOR_CUSTOMER' && <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Our team is waiting for a reply from you. Please respond below.</p>}
        <p className="mt-4 text-sm text-muted">{d.serviceCategory} · submitted {fmtDateTime(d.submittedAt)}</p>
      </Card>
      <Card className="mt-6 p-6">
        <h2 className="mb-4 font-semibold">Updates</h2>
        <ol className="space-y-3">
          {d.timeline.map((e, i) => (
            <li key={i} className={cn('rounded-lg border p-3 text-sm', e.kind === 'REPLY' ? 'border-brand-100 bg-brand-50/60' : e.kind === 'CUSTOMER_REPLY' ? 'border-line bg-white' : 'border-transparent bg-slate-50')}>
              <p className="text-xs text-muted">{e.kind === 'REPLY' ? `${d.tenantName} replied` : e.kind === 'CUSTOMER_REPLY' ? 'You wrote' : 'Update'} · {fmtDateTime(e.at)}</p>
              {e.body && <p className="mt-1 whitespace-pre-wrap">{e.body}</p>}
            </li>
          ))}
        </ol>
        {d.status !== 'CLOSED' && (
          <div className="mt-5 border-t border-line pt-5">
            <Field label="Add a message"><Textarea rows={3} value={reply} onChange={(e) => setReply(e.target.value)} /></Field>
            <Button className="mt-2" onClick={send} loading={sending} disabled={!reply.trim()}>Send</Button>
          </div>
        )}
      </Card>
    </Shell>
  );
}
