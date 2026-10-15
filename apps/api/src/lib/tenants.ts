import { enableCatalogFor } from './currency.js';
import { prisma, type Tx } from './db.js';
import { SYSTEM_ROLES } from './permissions.js';
import { seedTaxRates } from './taxes.js';

export const DEFAULT_TENANT_SETTINGS = {
  documents: {
    quotationTerms: 'This quotation is valid for 30 days from the date of issue.\n50% advance, balance on delivery.',
    invoiceTerms: 'Payment due within 15 days of invoice date.\nPlease quote the invoice number with your payment.',
    invoiceNotes: 'Thank you for your business.',
    defaultDueDays: 15,
    quotationValidityDays: 30,
    proformaTerms: 'This is a proforma invoice and not a tax invoice. A tax invoice will be issued on supply.\nPayment is requested in advance as per the terms agreed.',
    proformaValidityDays: 15,
    /** Short label for compact UI and numbering, e.g. "PI". The PDF heading is always PROFORMA INVOICE. */
    proformaLabel: 'PI',
    bankDetails: '',
    footer: 'This is a computer-generated document and does not require a signature.',
  },
  tax: { defaultTaxRate: 18, pricesIncludeTax: false, sacDefault: '998314', roundOff: false },
  crm: {
    autoFollowUpTasks: true,
    followUpDaysAfterContact: 3,
    coreServices: [] as string[],
  },
  notifications: { emailOnNewFeedback: true, emailOnTicketAssigned: true, emailCustomerOnFeedback: true },
  onboardingTemplate: [
    'Kick-off call completed',
    'Project scope and deliverables confirmed',
    'Access and credentials shared securely',
    'Brand assets and content received',
    'Billing details and GSTIN verified',
    'Communication channels set up',
  ],
};

export type TenantSettings = typeof DEFAULT_TENANT_SETTINGS;

export function tenantSettings(raw: unknown): TenantSettings {
  const s = (raw ?? {}) as Partial<TenantSettings>;
  return {
    documents: { ...DEFAULT_TENANT_SETTINGS.documents, ...(s.documents ?? {}) },
    tax: { ...DEFAULT_TENANT_SETTINGS.tax, ...(s.tax ?? {}) },
    crm: { ...DEFAULT_TENANT_SETTINGS.crm, ...(s.crm ?? {}) },
    notifications: { ...DEFAULT_TENANT_SETTINGS.notifications, ...(s.notifications ?? {}) },
    onboardingTemplate: s.onboardingTemplate ?? DEFAULT_TENANT_SETTINGS.onboardingTemplate,
  };
}

export const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'workspace';

/** Creates a tenant with its system roles and makes the given user its owner. */
export async function provisionTenant(
  input: { name: string; slug?: string; ownerUserId?: string; planCode?: string; trialDays?: number; status?: 'TRIAL' | 'ACTIVE' },
  tx: Tx = prisma,
) {
  const plan = await tx.plan.findUnique({ where: { code: input.planCode ?? 'starter' } });
  const base = slugify(input.slug ?? input.name);
  let slug = base;
  for (let i = 2; await tx.tenant.findUnique({ where: { slug } }); i++) slug = `${base}-${i}`;
  const trialDays = input.trialDays ?? 14;
  // Public 11-digit organization ID.
  let orgCode = '';
  do orgCode = String(60_000_000_000 + Math.floor(Math.random() * 9_999_999_999)).slice(0, 11);
  while (await tx.tenant.findUnique({ where: { orgCode }, select: { id: true } }));
  const tenant = await tx.tenant.create({
    data: {
      name: input.name,
      slug,
      orgCode,
      planId: plan?.id,
      status: input.status ?? 'TRIAL',
      trialEndsAt: (input.status ?? 'TRIAL') === 'TRIAL' ? new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000) : null,
      settings: DEFAULT_TENANT_SETTINGS as object,
    },
  });
  await tx.role.createMany({
    data: SYSTEM_ROLES.map((r) => ({
      tenantId: tenant.id, key: r.key, name: r.name, description: r.description, permissions: r.permissions, isSystem: true,
    })),
  });
  if (input.ownerUserId) {
    const owner = await tx.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenant.id, key: 'owner' } } });
    await tx.membership.create({ data: { tenantId: tenant.id, userId: input.ownerUserId, roleId: owner.id } });
  }
  await tx.ticketCategory.createMany({
    data: ['General', 'Bug / Issue', 'Change Request', 'Billing', 'Hosting & Domain'].map((name) => ({ tenantId: tenant.id, name })),
  });
  await enableCatalogFor(tenant.id, tx);
  await seedTaxRates(tenant.id, tx);
  return tenant;
}
