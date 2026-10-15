import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Inbox, Loader2, Search, X } from 'lucide-react';
import { cn, initials } from '@/lib/utils';

// ───────────── Button ─────────────

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-brand-800 text-white shadow-sm hover:bg-brand-900',
        secondary: 'border border-line bg-white text-ink shadow-xs hover:bg-slate-50',
        ghost: 'text-slate-600 hover:bg-slate-100 hover:text-ink',
        danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700',
        link: 'text-brand-700 underline-offset-4 hover:underline px-0',
      },
      size: { sm: 'h-8 px-3 text-[13px]', md: 'h-9 px-4', lg: 'h-11 px-5 text-[15px]', icon: 'size-9' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, loading, children, disabled, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
      {asChild ? children : (<>{loading && <Loader2 className="animate-spin" />}{children}</>)}
    </Comp>
  );
});
Button.displayName = 'Button';

// ───────────── Form controls ─────────────

const control =
  'w-full rounded-lg border border-line bg-white px-3 text-sm text-ink placeholder:text-slate-400 shadow-xs transition-colors focus:border-brand-500 focus:outline-none focus:ring-3 focus:ring-brand-100 disabled:bg-slate-50 disabled:text-slate-500 aria-[invalid=true]:border-red-400 aria-[invalid=true]:ring-red-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input ref={ref} className={cn(control, 'h-9', className)} {...p} />
));
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => (
  <textarea ref={ref} className={cn(control, 'min-h-20 py-2 leading-relaxed', className)} {...p} />
));
Textarea.displayName = 'Textarea';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...p }, ref) => (
  <select
    ref={ref}
    className={cn(control, "h-9 appearance-none bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%2364748b' stroke-width='2'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E\")] bg-[right_0.6rem_center] bg-no-repeat pr-8", className)}
    {...p}
  >
    {children}
  </select>
));
Select.displayName = 'Select';

export function Label({ className, ...p }: HTMLAttributes<HTMLLabelElement> & { htmlFor?: string }) {
  return <label className={cn('text-[13px] font-medium text-slate-700', className)} {...p} />;
}

export function Field({ label, error, hint, children, className, required, htmlFor }: { label?: ReactNode; error?: string; hint?: ReactNode; children: ReactNode; className?: string; required?: boolean; htmlFor?: string }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && <Label htmlFor={htmlFor}>{label}{required && <span className="ml-0.5 text-red-500">*</span>}</Label>}
      {children}
      {error ? <p className="text-xs text-red-600" role="alert">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…', className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="pl-9" aria-label={placeholder} />
    </div>
  );
}

export function Switch({ checked, onCheckedChange, id, disabled }: { checked: boolean; onCheckedChange: (v: boolean) => void; id?: string; disabled?: boolean }) {
  return (
    <SwitchPrimitive.Root id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled}
      className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-slate-200 transition-colors data-[state=checked]:bg-brand-700 disabled:opacity-50">
      <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </SwitchPrimitive.Root>
  );
}

export function Checkbox({ checked, onCheckedChange, id }: { checked: boolean; onCheckedChange: (v: boolean) => void; id?: string }) {
  return (
    <CheckboxPrimitive.Root id={id} checked={checked} onCheckedChange={(v) => onCheckedChange(v === true)}
      className="flex size-4 shrink-0 items-center justify-center rounded border border-slate-300 bg-white data-[state=checked]:border-brand-700 data-[state=checked]:bg-brand-700">
      <CheckboxPrimitive.Indicator><Check className="size-3 text-white" strokeWidth={3} /></CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

// ───────────── Surfaces ─────────────

export function Card({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-line bg-white shadow-xs', className)} {...p} />;
}

export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4', className)}>
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions, breadcrumb }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; breadcrumb?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {breadcrumb && <div className="mb-1.5 text-[13px] text-muted">{breadcrumb}</div>}
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, icon, tone = 'default' }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: 'default' | 'warn' | 'good' | 'bad' }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-medium text-muted">{label}</p>
        {icon && <span className="text-slate-400 [&_svg]:size-4">{icon}</span>}
      </div>
      <p className={cn('mt-2 text-2xl font-semibold tracking-tight tabular-nums', tone === 'bad' && 'text-red-600', tone === 'good' && 'text-emerald-600', tone === 'warn' && 'text-amber-600')}>{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </Card>
  );
}

// ───────────── Badges ─────────────

const tones = {
  gray: 'bg-slate-100 text-slate-700 ring-slate-200',
  blue: 'bg-brand-50 text-brand-700 ring-brand-100',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
  amber: 'bg-amber-50 text-amber-700 ring-amber-100',
  red: 'bg-red-50 text-red-700 ring-red-100',
  violet: 'bg-violet-50 text-violet-700 ring-violet-100',
} as const;
export type Tone = keyof typeof tones;

export function Badge({ tone = 'gray', className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset', tones[tone], className)}>{children}</span>;
}

const STATUS_TONES: Record<string, Tone> = {
  NEW: 'blue', OPEN: 'blue', TODO: 'gray', DRAFT: 'gray', PLANNING: 'gray', PENDING: 'gray', NOT_STARTED: 'gray', PROSPECT: 'violet',
  UNDER_REVIEW: 'violet', ASSIGNED: 'violet', CONTACTED: 'violet', QUALIFIED: 'violet', MEETING_SCHEDULED: 'violet', REVIEW: 'violet',
  IN_PROGRESS: 'amber', PROPOSAL_SENT: 'amber', NEGOTIATION: 'amber', SENT: 'amber', ISSUED: 'blue', PARTIALLY_PAID: 'amber', WAITING_FOR_CUSTOMER: 'amber', ON_HOLD: 'gray', TRIAL: 'violet', PAST_DUE: 'amber',
  RESOLVED: 'green', CLOSED: 'gray', DONE: 'green', WON: 'green', PAID: 'green', ACCEPTED: 'green', COMPLETED: 'green', ACTIVE: 'green', CONVERTED: 'green', VIEWED: 'blue', DELIVERED: 'green', QUEUED: 'gray', NOT_CONFIGURED: 'amber', FAILED: 'red', BOUNCED: 'red',
  LOST: 'red', OVERDUE: 'red', VOID: 'gray', WRITTEN_OFF: 'violet', STOPPED: 'gray', UNUSED: 'amber', CANCELLED: 'red', REJECTED: 'red', EXPIRED: 'red', URGENT: 'red', HIGH: 'amber', MEDIUM: 'blue', LOW: 'gray', SUSPENDED: 'red', DISABLED: 'red', INACTIVE: 'gray',
};

export function StatusBadge({ status, className }: { status?: string | null; className?: string }) {
  if (!status) return null;
  const label = status.toLowerCase().replace(/_/g, ' ');
  return <Badge tone={STATUS_TONES[status] ?? 'gray'} className={cn('capitalize', className)}>{label}</Badge>;
}

export function Avatar({ name, className }: { name?: string | null; className?: string }) {
  return <span className={cn('inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[11px] font-semibold text-brand-800', className)}>{initials(name)}</span>;
}

export function Stars({ value, className }: { value?: number | null; className?: string }) {
  if (!value) return <span className="text-muted">—</span>;
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-sm tabular-nums', className)} aria-label={`${value} out of 5`}>
      <span className={cn('font-semibold', value <= 2 ? 'text-red-600' : value === 3 ? 'text-amber-600' : 'text-emerald-600')}>{Number(value).toFixed(Number.isInteger(value) ? 0 : 1)}</span>
      <span className="text-slate-400">/5</span>
    </span>
  );
}

// ───────────── States ─────────────

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-5 animate-spin text-brand-700', className)} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-slate-100', className)} />;
}

export function LoadingBlock({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-5" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
    </div>
  );
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-slate-100 text-slate-500 [&_svg]:size-5">{icon ?? <Inbox />}</div>
      <p className="font-medium text-ink">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center" role="alert">
      <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-red-50 text-red-600"><AlertTriangle className="size-5" /></div>
      <p className="font-medium text-ink">Could not load this</p>
      <p className="mt-1 max-w-sm text-sm text-muted">{msg}</p>
      {onRetry && <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

// ───────────── Table ─────────────

export function Table({ className, ...p }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="scrollbar-thin overflow-x-auto">
      <table className={cn('w-full border-collapse text-sm', className)} {...p} />
    </div>
  );
}
export const THead = (p: HTMLAttributes<HTMLTableSectionElement>) => <thead className="border-b border-line bg-slate-50/70 text-left text-xs font-medium uppercase tracking-wide text-muted" {...p} />;
export const TH = ({ className, ...p }: HTMLAttributes<HTMLTableCellElement>) => <th className={cn('whitespace-nowrap px-4 py-2.5 font-medium', className)} {...p} />;
export const TBody = (p: HTMLAttributes<HTMLTableSectionElement>) => <tbody className="divide-y divide-line" {...p} />;
export const TR = ({ className, ...p }: HTMLAttributes<HTMLTableRowElement>) => <tr className={cn('transition-colors hover:bg-slate-50/70', p.onClick && 'cursor-pointer', className)} {...p} />;
export const TD = ({ className, ...p }: HTMLAttributes<HTMLTableCellElement> & { colSpan?: number }) => <td className={cn('px-4 py-3 align-middle', className)} {...p} />;

export function Pagination({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  if (total === 0) return null;
  return (
    <div className="flex items-center justify-between border-t border-line px-4 py-3 text-[13px] text-muted">
      <span>{total.toLocaleString('en-IN')} result{total === 1 ? '' : 's'}</span>
      <div className="flex items-center gap-2">
        <span>Page {page} of {pages}</span>
        <Button variant="secondary" size="icon" className="size-8" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft /></Button>
        <Button variant="secondary" size="icon" className="size-8" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight /></Button>
      </div>
    </div>
  );
}

// ───────────── Dialog & Sheet ─────────────

export function Dialog({ open, onOpenChange, title, description, children, footer, size = 'md' }: { open: boolean; onOpenChange: (v: boolean) => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const width = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[2px] data-[state=open]:animate-in" />
        <DialogPrimitive.Content className={cn('fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-line bg-white shadow-xl focus:outline-none', width)}>
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <DialogPrimitive.Title className="text-base font-semibold text-ink">{title}</DialogPrimitive.Title>
              {description ? <DialogPrimitive.Description className="mt-0.5 text-[13px] text-muted">{description}</DialogPrimitive.Description> : <DialogPrimitive.Description className="sr-only">{String(title)}</DialogPrimitive.Description>}
            </div>
            <DialogPrimitive.Close className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-ink" aria-label="Close"><X className="size-4" /></DialogPrimitive.Close>
          </div>
          <div className="scrollbar-thin overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line bg-slate-50/60 px-5 py-3">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Sheet({ open, onOpenChange, title, children, footer }: { open: boolean; onOpenChange: (v: boolean) => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-slate-900/30" />
        <DialogPrimitive.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-line bg-white shadow-2xl focus:outline-none">
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">{String(title)}</DialogPrimitive.Description>
            <DialogPrimitive.Close className="rounded-md p-1 text-slate-400 hover:bg-slate-100" aria-label="Close"><X className="size-4" /></DialogPrimitive.Close>
          </div>
          <div className="scrollbar-thin flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = 'Confirm', danger, loading, onConfirm, children }: { open: boolean; onOpenChange: (v: boolean) => void; title: string; description?: ReactNode; confirmLabel?: string; danger?: boolean; loading?: boolean; onConfirm: () => void; children?: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} size="sm"
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>{confirmLabel}</Button></>}>
      {description && <p className="text-sm text-slate-600">{description}</p>}
      {children}
    </Dialog>
  );
}

// ───────────── Tabs ─────────────

export const Tabs = TabsPrimitive.Root;
export function TabsList({ className, ...p }: TabsPrimitive.TabsListProps) {
  return <TabsPrimitive.List className={cn('scrollbar-thin flex gap-1 overflow-x-auto border-b border-line', className)} {...p} />;
}
export function TabsTrigger({ className, ...p }: TabsPrimitive.TabsTriggerProps) {
  return <TabsPrimitive.Trigger className={cn('-mb-px whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-muted transition-colors hover:text-ink data-[state=active]:border-brand-700 data-[state=active]:text-brand-800', className)} {...p} />;
}
export const TabsContent = ({ className, ...p }: TabsPrimitive.TabsContentProps) => <TabsPrimitive.Content className={cn('pt-5 focus:outline-none', className)} {...p} />;

// ───────────── Misc ─────────────

export function DescList({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2', className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="min-w-0">
          <dt className="text-xs font-medium text-muted">{k}</dt>
          <dd className="mt-0.5 break-words text-ink">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-slate-100', className)} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-2 border-b border-line px-4 py-3', className)}>{children}</div>;
}
