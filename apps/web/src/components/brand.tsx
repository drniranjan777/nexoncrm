import { cn } from '@/lib/utils';

/** Nexonweb product logo (wordmark with tagline). */
export function NexonwebLogo({ className }: { className?: string }) {
  return <img src="/brand/nexonweb-logo.png" alt="Nexonweb – Unleash Your IT Potential" className={cn('h-10 w-auto object-contain', className)} />;
}

/** White wordmark variant for dark backgrounds. */
export function NexonwebLogoWhite({ className }: { className?: string }) {
  return <img src="/brand/nexonweb-logo-white.png" alt="Nexonweb" className={cn('h-10 w-auto object-contain', className)} />;
}

/** Square dot-ring mark, for tight spaces such as the collapsed sidebar. */
export function NexonwebMark({ className }: { className?: string }) {
  return <img src="/brand/nexonweb-mark.png" alt="Nexonweb" className={cn('size-8 object-contain', className)} />;
}

/** A tenant's uploaded logo, falling back to a coloured initial. */
export function TenantLogo({ tenant, className, compact }: { tenant: { name: string; slug: string; brandColor?: string; logoFileId?: string | null; hasLogo?: boolean }; className?: string; compact?: boolean }) {
  const hasLogo = tenant.hasLogo ?? !!tenant.logoFileId;
  if (hasLogo) {
    const src = `/api/v1/public/tenants/${tenant.slug}/logo?v=${tenant.logoFileId ?? ''}`;
    // Compact: Nexonweb's own workspace uses its dedicated mark; other tenants show the left edge of their logo.
    if (compact && tenant.slug === 'nexonweb') return <NexonwebMark className={className} />;
    return compact
      ? <img src={src} alt={tenant.name} className={cn('size-8 shrink-0 object-cover object-left', className)} />
      : <img src={src} alt={tenant.name} className={cn('h-11 w-auto max-w-48 object-contain', className)} />;
  }
  return (
    <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white', className)} style={{ background: tenant.brandColor ?? '#1e3a8a' }}>
      {tenant.name[0]}
    </span>
  );
}
