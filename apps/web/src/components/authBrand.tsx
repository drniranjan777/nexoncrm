import type { ReactNode } from 'react';
import { BarChart3, FileText, Package, ShieldCheck, Globe, UsersRound, LayoutDashboard, ReceiptText, FolderKanban, Headphones, LineChart, Users, BadgeIndianRupee } from 'lucide-react';
import { cn } from '@/lib/utils';

// Product brand for the sign-in / sign-up screens. Change PRODUCT_NAME (and the wordmark) here to rebrand them.
export const PRODUCT_NAME = 'Tallygen';

/** "Tallygen." wordmark drawn as text, so it stays sharp at any size; the amber full stop is the brand accent. */
export function TallygenLogo({ tone = 'dark', className }: { tone?: 'dark' | 'light'; className?: string }) {
  return (
    <span className={cn('inline-flex items-baseline font-display font-extrabold leading-none tracking-[-0.045em]', className)} role="img" aria-label={PRODUCT_NAME}>
      <span aria-hidden className={tone === 'light' ? 'text-white' : 'bg-gradient-to-br from-[#1f5bff] via-[#1846d6] to-[#0d2a8a] bg-clip-text text-transparent'}>{PRODUCT_NAME}</span>
      <span aria-hidden className="text-[#f5b82e]">.</span>
    </span>
  );
}

const FEATURES: [typeof Users, string, string][] = [
  [UsersRound, 'Sales & customer management', 'Track leads, customers and opportunities'],
  [FileText, 'Quotations and GST-ready invoicing', 'Create quotes, invoices and credit notes'],
  [Package, 'Projects, delivery and support', 'Manage projects, tasks and customer support'],
  [BarChart3, 'Real-time reports and team access', 'Insightful reports with multi-user access'],
];

/** Headline figures on the sign-in panel. Keep them in line with what you can substantiate. */
const STATS: [typeof Users, string, string][] = [
  [Globe, '500+', 'Businesses'],
  [Users, '10,000+', 'Active Users'],
  [ShieldCheck, '99.9%', 'Uptime'],
];

const Dot = () => <span className="text-[#f5b82e]">.</span>;

/** Illustrative product preview: a tilted mini dashboard. Purely decorative. */
function DashboardPreview() {
  const nav: [typeof Users, string][] = [[LayoutDashboard, 'Dashboard'], [BadgeIndianRupee, 'Sales'], [Users, 'Customers'], [ReceiptText, 'Invoices'], [FolderKanban, 'Projects'], [Headphones, 'Support'], [LineChart, 'Reports']];
  const invoices: [string, string, string][] = [
    ['#INV-1001', 'Paid', 'bg-emerald-100 text-emerald-700'],
    ['#INV-1002', 'Pending', 'bg-amber-100 text-amber-700'],
    ['#INV-1003', 'Paid', 'bg-emerald-100 text-emerald-700'],
    ['#INV-1004', 'Overdue', 'bg-red-100 text-red-600'],
  ];
  return (
    <div aria-hidden className="pointer-events-none absolute right-[-10rem] top-1/2 hidden w-[36rem] -translate-y-[52%] [perspective:1600px] xl:block">
      <div className="rounded-[1.75rem] border border-white/15 bg-white/[0.06] p-3 shadow-[0_40px_80px_-20px_rgba(0,0,0,0.6)] backdrop-blur-sm [transform:rotateY(-22deg)_rotateX(6deg)_rotateZ(2deg)]">
        <div className="flex gap-3 rounded-[1.25rem] bg-[#0d2565] p-3">
          <div className="w-28 shrink-0 space-y-1 pt-1">
            <p className="mb-3 px-2 font-display text-base font-extrabold tracking-tight text-white">{PRODUCT_NAME}<Dot /></p>
            {nav.map(([I, label], i) => (
              <div key={label} className={cn('flex items-center gap-2 rounded-lg px-2 py-1.5 text-[10px] text-blue-100/80', i === 0 && 'bg-white/10 font-semibold text-white')}><I className="size-3" />{label}</div>
            ))}
          </div>
          <div className="grid flex-1 grid-cols-[1.15fr_1fr] gap-2.5 rounded-xl bg-[#eef2fb] p-2.5">
            <div className="rounded-lg bg-white p-3 shadow-sm">
              <p className="text-[9px] text-slate-500">Total Revenue</p>
              <p className="mt-0.5 text-lg font-bold text-slate-900">₹12,48,320</p>
              <p className="text-[9px] font-semibold text-emerald-600">↑ 12%</p>
              <svg viewBox="0 0 120 34" className="mt-1 h-9 w-full"><defs><linearGradient id="rev" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2563eb" stopOpacity=".25" /><stop offset="1" stopColor="#2563eb" stopOpacity="0" /></linearGradient></defs><path d="M0 26 L12 20 L22 24 L34 15 L46 21 L58 13 L70 18 L82 10 L94 16 L106 6 L120 9 L120 34 L0 34Z" fill="url(#rev)" /><path d="M0 26 L12 20 L22 24 L34 15 L46 21 L58 13 L70 18 L82 10 L94 16 L106 6 L120 9" fill="none" stroke="#2563eb" strokeWidth="1.6" /></svg>
            </div>
            <div className="rounded-lg bg-white p-3 shadow-sm">
              <p className="text-[9px] text-slate-500">Active Projects</p>
              <p className="mt-0.5 text-lg font-bold text-slate-900">28</p>
              <div className="mt-2 flex h-9 items-end gap-1">{[40, 65, 50, 85, 60, 95].map((h, i) => <span key={i} className="w-2.5 rounded-sm bg-blue-600" style={{ height: `${h}%`, opacity: 0.55 + i * 0.08 }} />)}</div>
            </div>
            <div className="rounded-lg bg-white p-3 shadow-sm">
              <p className="mb-2 text-[9px] font-semibold text-slate-700">Recent Invoices</p>
              {invoices.map(([no, status, tone]) => (
                <div key={no} className="flex items-center justify-between border-b border-slate-100 py-1 last:border-0">
                  <span className="text-[8px] text-slate-600">{no}</span><span className={cn('rounded px-1.5 py-0.5 text-[7px] font-semibold', tone)}>{status}</span>
                </div>
              ))}
            </div>
            <div className="rounded-lg bg-white p-3 shadow-sm">
              <p className="mb-2 text-[9px] font-semibold text-slate-700">Sales Overview</p>
              <div className="flex h-20 items-end gap-1.5">{[30, 45, 38, 60, 52, 88, 70].map((h, i) => <span key={i} className="flex-1 rounded-sm bg-gradient-to-t from-blue-700 to-blue-400" style={{ height: `${h}%` }} />)}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The dark brand panel shown beside the sign-in and sign-up forms on large screens. */
export function AuthShowcase() {
  return (
    <aside className="relative hidden overflow-hidden bg-[#081a4b] text-white lg:flex lg:flex-col">
      {/* Background: deep blue gradient, sweeping arcs and a dot grid. */}
      <div aria-hidden className="absolute inset-0 bg-[radial-gradient(120%_80%_at_85%_10%,#1d4fd8_0%,transparent_55%),radial-gradient(90%_70%_at_0%_100%,#0c2a7a_0%,transparent_60%),linear-gradient(160deg,#0a2266_0%,#071640_70%)]" />
      <div aria-hidden className="absolute -right-56 -top-40 size-[44rem] rounded-full border-[56px] border-white/[0.04]" />
      <div aria-hidden className="absolute -right-24 top-24 size-[38rem] rounded-full border border-blue-300/20" />
      <div aria-hidden className="absolute -bottom-72 -left-40 size-[46rem] rounded-full border border-blue-300/10" />
      <div aria-hidden className="absolute right-24 top-24 h-48 w-64 bg-[radial-gradient(circle,rgba(147,180,253,0.35)_1.2px,transparent_1.3px)] [background-size:16px_16px] [mask-image:linear-gradient(to_bottom,black,transparent)]" />
      <DashboardPreview />

      <div className="relative z-10 flex flex-1 flex-col justify-between gap-10 px-12 py-12 xl:px-16 2xl:px-20">
        <div>
          <TallygenLogo tone="light" className="text-5xl xl:text-6xl" />
          <p className="mt-6 text-xs font-semibold uppercase tracking-[0.32em] text-[#f5b82e]">Business management platform</p>
        </div>
        <div className="max-w-xl">
          <h2 className="font-display text-5xl font-extrabold leading-[1.05] tracking-tight xl:text-6xl">Your business<Dot /><br />Connected<Dot /></h2>
          <p className="mt-5 max-w-md text-lg leading-relaxed text-blue-100/85">Manage sales, operations, billing and insights in one workspace.</p>
          <ul className="mt-10 space-y-5">
            {FEATURES.map(([Icon, title, text]) => (
              <li key={title} className="flex items-center gap-4">
                <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.07] text-[#f5b82e] shadow-inner"><Icon className="size-6" strokeWidth={1.75} /></span>
                <span><span className="block text-[17px] font-semibold">{title}</span><span className="block text-[15px] text-blue-100/80">{text}</span></span>
              </li>
            ))}
          </ul>
        </div>
        <dl className="grid max-w-2xl grid-cols-3 divide-x divide-white/15 rounded-2xl border border-white/15 bg-white/[0.05] py-5 backdrop-blur-sm">
          {STATS.map(([Icon, value, label]) => (
            <div key={label} className="flex items-center justify-center gap-3 px-4">
              <Icon className="size-9 shrink-0 text-[#f5b82e]" strokeWidth={1.5} aria-hidden />
              <div><dt className="sr-only">{label}</dt><dd className="text-2xl font-bold leading-none">{value}</dd><p aria-hidden className="mt-1 text-sm text-blue-100/80">{label}</p></div>
            </div>
          ))}
        </dl>
      </div>
    </aside>
  );
}

/** Soft decorative shapes behind the form side. */
export function AuthFormBackdrop({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-full flex-col overflow-hidden bg-white">
      <div aria-hidden className="pointer-events-none absolute -right-40 -top-40 size-[26rem] rounded-full bg-[#eef3ff]" />
      <div aria-hidden className="pointer-events-none absolute -bottom-48 -right-32 size-[30rem] rounded-full bg-[#f2f6ff]" />
      <div className="relative z-10 flex flex-1 flex-col">{children}</div>
    </div>
  );
}
