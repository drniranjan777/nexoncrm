import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { Bell, Building, Check, ChevronDown, ChevronsLeft, ChevronsRight, ChevronUp, LogOut, Menu, Plus, Search, Settings, ShieldCheck, User, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { cn, timeAgo } from '@/lib/utils';
import { Avatar, Badge, Spinner } from './ui';
import { NAV, PLATFORM_NAV, PORTAL_NAV, type NavGroup } from './nav';
import { NexonwebLogo, NexonwebMark, TenantLogo } from './brand';

function useCollapsed() {
  const [collapsed, set] = useState(() => {
    try { return localStorage.getItem('nx.sidebar') === '1'; } catch { return false; }
  });
  const toggle = () => set((c) => {
    try { localStorage.setItem('nx.sidebar', c ? '0' : '1'); } catch { /* ignore */ }
    return !c;
  });
  return [collapsed, toggle] as const;
}

const OPEN_KEY = 'nx.nav.open';
const isActivePath = (pathname: string, to: string) => (to === '/' || to === '/portal' || to === '/platform' ? pathname === to : pathname === to || pathname.startsWith(`${to}/`));

/** Which collapsible groups are open, remembered per browser. The group holding the current page always opens. */
function useOpenGroups(groups: NavGroup[], pathname: string) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, boolean>; } catch { return {}; }
  });
  const activeGroup = groups.find((g) => g.items.some((it) => isActivePath(pathname, it.to)))?.label;
  useEffect(() => {
    if (activeGroup && !open[activeGroup]) setOpen((o) => ({ ...o, [activeGroup]: true }));
  }, [activeGroup]); // runs when the page changes group; `open` is read, not a trigger
  useEffect(() => { try { localStorage.setItem(OPEN_KEY, JSON.stringify(open)); } catch { /* private mode */ } }, [open]);
  const toggle = (label: string) => setOpen((o) => ({ ...o, [label]: !o[label] }));
  return { isOpen: (label: string) => !!open[label], toggle };
}

const itemClass = (active: boolean, collapsed: boolean) => cn(
  'flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13.5px] font-medium transition-colors',
  active ? 'bg-brand-50 text-brand-800' : 'text-slate-600 hover:bg-slate-50 hover:text-ink',
  collapsed && 'lg:justify-center lg:px-0 lg:py-2',
);

function NavItems({ items, collapsed, onNavigate, id }: { items: NavGroup['items']; collapsed: boolean; onNavigate: () => void; id?: string }) {
  return (
    <ul id={id} className="space-y-0.5">
      {items.map((it) => (
        <li key={it.to}>
          <NavLink to={it.to} end={it.to === '/' || it.to === '/portal' || it.to === '/platform'} onClick={onNavigate} title={collapsed ? it.label : undefined}
            className={({ isActive }) => itemClass(isActive, collapsed)}>
            <it.icon className="size-[17px] shrink-0" />
            <span className={cn('truncate', collapsed && 'lg:hidden')}>{it.label}</span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

/** Settings pinned to the bottom of the sidebar: a menu of every settings page. */
function SettingsMenu({ group, collapsed, onNavigate }: { group: NavGroup; collapsed: boolean; onNavigate: () => void }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const active = group.items.some((it) => isActivePath(pathname, it.to));
  return (
    <div className="border-t border-line px-3 py-2">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger title={collapsed ? group.label : undefined}
          className={cn(itemClass(active, collapsed), 'w-full outline-none focus-visible:ring-2 focus-visible:ring-brand-300 data-[state=open]:bg-slate-100 data-[state=open]:text-ink')}>
          <Settings className="size-[17px] shrink-0" />
          <span className={cn('flex-1 truncate text-left', collapsed && 'lg:hidden')}>{group.label}</span>
          <ChevronUp className={cn('size-4 shrink-0 text-slate-400', collapsed && 'lg:hidden')} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content side="top" align="start" sideOffset={6} collisionPadding={8}
            className="z-50 max-h-[min(32rem,calc(100vh-6rem))] w-60 overflow-y-auto rounded-xl border border-line bg-white p-1.5 shadow-lg">
            <DropdownMenu.Label className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{group.label}</DropdownMenu.Label>
            {group.items.map((it) => {
              const on = isActivePath(pathname, it.to);
              return (
                <DropdownMenu.Item key={it.to} onSelect={() => { navigate(it.to); onNavigate(); }} aria-current={on ? 'page' : undefined}
                  className={cn('flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] outline-none data-[highlighted]:bg-slate-50', on ? 'font-medium text-brand-800' : 'text-slate-700')}>
                  <it.icon className="size-4 shrink-0 text-slate-500" />
                  <span className="flex-1 truncate">{it.label}</span>
                  {on && <Check className="size-4 text-brand-700" />}
                </DropdownMenu.Item>
              );
            })}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function Sidebar({ groups, collapsed, onToggle, mobileOpen, onClose, brand }: { groups: NavGroup[]; collapsed: boolean; onToggle: () => void; mobileOpen: boolean; onClose: () => void; brand: ReactNode }) {
  const { pathname } = useLocation();
  const main = groups.filter((g) => g.placement !== 'bottom');
  const bottom = groups.filter((g) => g.placement === 'bottom');
  // A lone group (portal, platform) or a fixed one has nothing to fold.
  const foldable = (g: NavGroup) => !g.fixed && main.length > 1;
  const { isOpen, toggle } = useOpenGroups(main.filter(foldable), pathname);
  return (
    <>
      {mobileOpen && <div className="fixed inset-0 z-30 bg-slate-900/30 lg:hidden" onClick={onClose} />}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex flex-col border-r border-line bg-white transition-[width,transform] duration-200 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0',
          collapsed ? 'lg:w-[68px]' : 'lg:w-64',
          mobileOpen ? 'w-64 translate-x-0' : 'w-64 -translate-x-full',
        )}
        aria-label="Main navigation"
      >
        <div className={cn('flex h-14 shrink-0 items-center gap-2 border-b border-line px-4', collapsed && 'lg:justify-center lg:px-0')}>
          {brand}
          <button className="ml-auto rounded-md p-1 text-slate-400 hover:bg-slate-100 lg:hidden" onClick={onClose} aria-label="Close menu"><X className="size-4" /></button>
        </div>
        <nav className="scrollbar-thin flex-1 overflow-y-auto px-3 py-3">
          {main.map((g) => {
            const id = `nav-${g.label.replace(/\W+/g, '-').toLowerCase()}`;
            if (!foldable(g)) {
              return (
                <div key={g.label} className="mb-3">
                  {main.length > 1 && g.label !== 'Overview' && <p className={cn('mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400', collapsed && 'lg:sr-only')}>{g.label}</p>}
                  <NavItems items={g.items} collapsed={collapsed} onNavigate={onClose} />
                </div>
              );
            }
            const open = isOpen(g.label);
            return (
              <div key={g.label} className="mb-1">
                <button type="button" onClick={() => toggle(g.label)} aria-expanded={open} aria-controls={id}
                  className={cn('group flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 hover:bg-slate-50 hover:text-slate-600', collapsed && 'lg:hidden')}>
                  <span className="flex-1 text-left">{g.label}</span>
                  <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} />
                </button>
                {/* Icon-only sidebar: every item stays visible, there is no header to unfold. */}
                <div className={cn('pb-2', !open && 'hidden', collapsed && 'lg:block')}>
                  <NavItems id={id} items={g.items} collapsed={collapsed} onNavigate={onClose} />
                </div>
              </div>
            );
          })}
        </nav>
        {bottom.map((g) => <SettingsMenu key={g.label} group={g} collapsed={collapsed} onNavigate={onClose} />)}
        <button onClick={onToggle} className="hidden h-11 items-center justify-center gap-2 border-t border-line text-[13px] text-muted hover:bg-slate-50 hover:text-ink lg:flex" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? <ChevronsRight className="size-4" /> : <><ChevronsLeft className="size-4" /> Collapse</>}
        </button>
      </aside>
    </>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState('');
  const navigate = useNavigate();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const { data, isFetching } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.get<{ type: string; id: string; title: string; subtitle?: string; link: string }[]>('/search', { q: debounced }),
    enabled: debounced.length >= 2,
  });
  return (
    <Popover.Root open={open && q.length >= 2} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input
            ref={ref}
            value={q}
            onChange={(e) => { setQ(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            placeholder="Search customers, leads, invoices…"
            className="h-9 w-full rounded-lg border border-line bg-slate-50 pl-9 pr-14 text-sm placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-3 focus:ring-brand-100"
            aria-label="Global search"
          />
          <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-line bg-white px-1.5 text-[10px] text-muted sm:block">Ctrl K</kbd>
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} onOpenAutoFocus={(e) => e.preventDefault()} className="z-50 w-[var(--radix-popover-trigger-width)] min-w-80 rounded-xl border border-line bg-white p-1.5 shadow-lg">
          {isFetching && !data ? <div className="flex justify-center p-4"><Spinner /></div> : !data?.length ? <p className="p-4 text-center text-sm text-muted">No matches</p> : (
            <ul>
              {data.map((r) => (
                <li key={`${r.type}-${r.id}`}>
                  <button className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-slate-50" onClick={() => { navigate(r.link); setOpen(false); setQ(''); }}>
                    <Badge tone="gray" className="w-20 justify-center">{r.type}</Badge>
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{r.title}</span>{r.subtitle && <span className="block truncate text-xs text-muted">{r.subtitle}</span>}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Notifications() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ items: { id: string; title: string; body?: string; link?: string; readAt: string | null; createdAt: string }[]; unread: number }>('/notifications'),
    refetchInterval: 60_000,
  });
  const markRead = useMutation({
    mutationFn: (ids?: string[]) => api.post('/notifications/read', ids ? { ids } : {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  return (
    <Popover.Root>
      <Popover.Trigger className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-ink" aria-label="Notifications">
        <Bell className="size-[18px]" />
        {!!data?.unread && <span className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-4 text-white">{data.unread > 9 ? '9+' : data.unread}</span>}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} className="z-50 w-96 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <p className="text-sm font-semibold">Notifications</p>
            {!!data?.unread && <button className="flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline" onClick={() => markRead.mutate(undefined)}><Check className="size-3" /> Mark all read</button>}
          </div>
          <ul className="scrollbar-thin max-h-96 overflow-y-auto">
            {!data?.items.length && <li className="p-6 text-center text-sm text-muted">You're all caught up.</li>}
            {data?.items.map((n) => (
              <li key={n.id}>
                <Popover.Close asChild>
                  <button className={cn('flex w-full gap-3 border-b border-line/60 px-4 py-3 text-left hover:bg-slate-50', !n.readAt && 'bg-brand-50/40')}
                    onClick={() => { if (!n.readAt) markRead.mutate([n.id]); if (n.link) navigate(n.link); }}>
                    <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-brand-600')} />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{n.title}</span>
                      {n.body && <span className="block truncate text-xs text-muted">{n.body}</span>}
                      <span className="mt-0.5 block text-[11px] text-slate-400">{timeAgo(n.createdAt)}</span>
                    </span>
                  </button>
                </Popover.Close>
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function QuickCreate() {
  const { can, hasModule } = useAuth();
  const navigate = useNavigate();
  const groups = [
    { title: 'General', items: [
      { label: 'Customer', to: '/customers?new=1', show: can('customers.update') },
      { label: 'Lead', to: '/leads', show: can('leads.update') && hasModule('crm') },
      { label: 'Task', to: '/tasks', show: can('tasks.read') },
      { label: 'Support ticket', to: '/tickets', show: can('tickets.update') && hasModule('support') },
    ] },
    { title: 'Sales', items: [
      { label: 'Quote', to: '/quotations/new', show: can('quotations.create') && hasModule('finance') },
      { label: 'Invoice', to: '/invoices/new', show: can('invoices.create') && hasModule('finance') },
      { label: 'Recurring invoice', to: '/recurring-invoices/new', show: can('invoices.create') && hasModule('finance') },
      { label: 'Payment received', to: '/payments/new', show: can('payments.record') && hasModule('finance') },
    ] },
    { title: 'Purchases & time', items: [
      { label: 'Expense', to: '/expenses', show: can('invoices.create') && hasModule('finance') },
      { label: 'Log time', to: '/time-tracking', show: can('tasks.read') && hasModule('projects') },
    ] },
  ].map((g) => ({ ...g, items: g.items.filter((i) => i.show) })).filter((g) => g.items.length);
  if (!groups.length) return null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="mr-1 flex size-8 items-center justify-center rounded-lg bg-brand-800 text-white hover:bg-brand-900" aria-label="Quick create"><Plus className="size-4" /></DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={8} className="z-50 grid w-[min(36rem,calc(100vw-2rem))] gap-4 rounded-xl border border-line bg-white p-4 shadow-lg sm:grid-cols-3">
          {groups.map((g) => (
            <div key={g.title}>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{g.title}</p>
              {g.items.map((i) => (
                <DropdownMenu.Item key={i.label} onSelect={() => navigate(i.to)} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-slate-50"><Plus className="size-3.5 text-brand-600" />{i.label}</DropdownMenu.Item>
              ))}
            </div>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function UserMenu({ platform }: { platform?: boolean }) {
  const { me, membership, switchTenant, logout } = useAuth();
  const navigate = useNavigate();
  if (!me) return null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 hover:bg-slate-100" aria-label="Account menu">
        <Avatar name={me.name} />
        <span className="hidden text-left sm:block">
          <span className="block max-w-36 truncate text-[13px] font-medium leading-tight">{me.name}</span>
          <span className="block max-w-36 truncate text-[11px] leading-tight text-muted">{platform ? 'Platform admin' : membership?.role.name}</span>
        </span>
        <ChevronDown className="size-3.5 text-slate-400" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 w-64 rounded-xl border border-line bg-white p-1.5 shadow-lg">
          <div className="px-2.5 py-2">
            <p className="truncate text-sm font-medium">{me.name}</p>
            <p className="truncate text-xs text-muted">{me.email}</p>
          </div>
          {me.memberships.length > 0 && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <DropdownMenu.Label className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Workspaces</DropdownMenu.Label>
              {me.memberships.map((m) => (
                <DropdownMenu.Item key={m.tenant.id} onSelect={() => { switchTenant(m.tenant.id); navigate(m.role.key === 'customer' ? '/portal' : '/'); }}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-slate-50">
                  <TenantLogo tenant={m.tenant} compact className="size-6 rounded-md text-[11px]" />
                  <span className="min-w-0 flex-1 truncate">{m.tenant.name}</span>
                  {!platform && m.tenant.id === membership?.tenant.id && <Check className="size-4 text-brand-700" />}
                </DropdownMenu.Item>
              ))}
            </>
          )}
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          {me.isSuperAdmin && (
            <DropdownMenu.Item onSelect={() => navigate(platform ? '/' : '/platform')} className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-slate-50">
              <ShieldCheck className="size-4 text-slate-500" /> {platform ? 'Back to workspace' : 'Platform admin'}
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item onSelect={() => navigate('/organizations')} className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-slate-50">
            <Building className="size-4 text-slate-500" /> Manage organizations
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => navigate('/account')} className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-slate-50">
            <User className="size-4 text-slate-500" /> Account & security
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={async () => { await logout(); navigate('/login'); }} className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-red-600 outline-none data-[highlighted]:bg-red-50">
            <LogOut className="size-4" /> Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function AppShell({ mode = 'tenant' }: { mode?: 'tenant' | 'portal' | 'platform' }) {
  const { can, hasModule, membership } = useAuth();
  const [collapsed, toggle] = useCollapsed();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);

  const groups =
    mode === 'platform' ? PLATFORM_NAV
      : mode === 'portal' ? PORTAL_NAV
        : NAV.map((g) => ({ ...g, items: g.items.filter((i) => (!i.perms || can(...i.perms)) && (!i.module || hasModule(i.module))) })).filter((g) => g.items.length);

  const tenant = membership?.tenant;
  const brand = (
    <Link to={mode === 'platform' ? '/platform' : mode === 'portal' ? '/portal' : '/'} className="flex min-w-0 items-center gap-2.5" aria-label="Home">
      {mode === 'platform' || !tenant ? (
        <>
          <NexonwebLogo className={cn('h-11', collapsed && 'lg:hidden')} />
          {collapsed && <NexonwebMark className="hidden lg:block" />}
          {mode === 'platform' && <span className={cn('rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white', collapsed && 'lg:hidden')}>Admin</span>}
        </>
      ) : tenant.logoFileId ? (
        <>
          <TenantLogo tenant={tenant} className={cn(collapsed && 'lg:hidden')} />
          {collapsed && <TenantLogo tenant={tenant} compact className="hidden lg:block" />}
        </>
      ) : (
        <>
          <TenantLogo tenant={tenant} compact />
          <span className={cn('truncate text-[15px] font-semibold', collapsed && 'lg:hidden')}>{tenant.name}</span>
        </>
      )}
    </Link>
  );

  const trialEnds = membership?.tenant.status === 'TRIAL' && membership.tenant.trialEndsAt ? Math.ceil((new Date(membership.tenant.trialEndsAt).getTime() - Date.now()) / 86_400_000) : null;

  return (
    <div className="flex min-h-full">
      <Sidebar groups={groups} collapsed={collapsed} onToggle={toggle} mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} brand={brand} />
      <div className="flex min-w-0 flex-1 flex-col">
        {mode === 'tenant' && trialEnds !== null && trialEnds <= 7 && (
          <div className="no-print bg-amber-50 px-4 py-2 text-center text-[13px] text-amber-800">
            Your trial ends in {Math.max(0, trialEnds)} day{trialEnds === 1 ? '' : 's'}. {can('subscription.manage') && <Link to="/settings/subscription" className="font-medium underline">Choose a plan</Link>}
          </div>
        )}
        <header className="no-print sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-white/90 px-4 backdrop-blur lg:px-6">
          <button className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu"><Menu className="size-5" /></button>
          {mode === 'tenant' ? <GlobalSearch /> : <div className="flex-1" />}
          <div className="ml-auto flex items-center gap-1">
            {mode === 'tenant' && <QuickCreate />}
            {mode !== 'platform' && <Notifications />}
            {mode === 'tenant' && can('settings.manage') && <Link to="/settings/company" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-ink" aria-label="Settings"><Settings className="size-[18px]" /></Link>}
            <UserMenu platform={mode === 'platform'} />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
