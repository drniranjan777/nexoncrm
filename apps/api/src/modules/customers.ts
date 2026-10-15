import { currencyInfo, toBase } from '../lib/currency.js';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { dateParam, listParams, orderBy, paged, parseCsv, qstr, searchAny, toCsv } from '../lib/list.js';
import { nextNumber } from '../lib/numbering.js';
import { assertTenantRefs } from '../lib/tenantRefs.js';
import { tenantSettings } from '../lib/tenants.js';
import { renderStatementPdf } from '../lib/pdf.js';
import { buyerOf, sellerOf } from './finance.js';
import { GSTIN_REGEX, INDIAN_STATES, PAYMENT_TERMS, panFromGstin, stateFromGstin } from '../lib/gst.js';
import { badRequest } from '../lib/errors.js';
import { invitePortalUser } from './portalInvite.js';
import { requirePerm, tid } from '../middleware/tenant.js';
import { parse } from '../middleware/validate.js';

export const customersRouter = Router();

const opt = (s: z.ZodString) => s.optional().nullable().or(z.literal('').transform(() => null));

export const customerSchema = z.object({
  name: z.string().min(1).max(160), // display name
  customerType: z.enum(['BUSINESS', 'INDIVIDUAL']).optional(),
  salutation: opt(z.string().max(10)),
  firstName: opt(z.string().max(80)),
  lastName: opt(z.string().max(80)),
  company: opt(z.string().max(160)),
  email: opt(z.string().email()),
  phone: opt(z.string().max(40)),
  mobile: opt(z.string().max(40)),
  website: opt(z.string().max(200)),
  currency: z.string().length(3).optional(),
  language: z.string().max(10).optional(),
  gstTreatment: z.enum(['REGISTERED_REGULAR', 'REGISTERED_COMPOSITION', 'UNREGISTERED', 'CONSUMER', 'OVERSEAS', 'SEZ', 'DEEMED_EXPORT']).optional().nullable(),
  gstin: opt(z.string().toUpperCase().regex(GSTIN_REGEX, 'Invalid GSTIN format')),
  pan: opt(z.string().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN format')),
  taxPreference: z.enum(['TAXABLE', 'EXEMPT']).optional(),
  exemptionReason: opt(z.string().max(200)),
  paymentTerms: z.enum(Object.keys(PAYMENT_TERMS) as [string, ...string[]]).optional(),
  billingAttention: opt(z.string().max(120)),
  billingAddress: opt(z.string().max(500)),
  city: opt(z.string().max(80)),
  state: opt(z.string().max(80)),
  stateCode: opt(z.string().regex(/^\d{2}$/, 'Two-digit GST state code')),
  postalCode: opt(z.string().max(12)),
  country: z.string().max(60).optional(),
  shippingAttention: opt(z.string().max(120)),
  shippingAddress: opt(z.string().max(500)),
  shippingCity: opt(z.string().max(80)),
  shippingState: opt(z.string().max(80)),
  shippingPostalCode: opt(z.string().max(12)),
  shippingCountry: opt(z.string().max(60)),
  customFields: z.record(z.string().max(500)).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'PROSPECT']).optional(),
  ownerId: z.string().optional().nullable(),
  notes: opt(z.string().max(5000)),
});

/** GST rules: registered treatments need a GSTIN whose state matches the place of supply; PAN is derived when missing. */
function normalizeGst<T extends z.infer<ReturnType<typeof customerSchema.partial>>>(body: T): T {
  if (body.gstin) {
    body.stateCode ??= stateFromGstin(body.gstin);
    body.pan ??= panFromGstin(body.gstin);
    body.gstTreatment ??= 'REGISTERED_REGULAR';
  }
  if (body.gstTreatment && ['REGISTERED_REGULAR', 'REGISTERED_COMPOSITION', 'SEZ', 'DEEMED_EXPORT'].includes(body.gstTreatment) && body.gstin === null) {
    throw badRequest('A GSTIN is required for registered customers', { fieldErrors: { gstin: ['Required for this GST treatment'] } });
  }
  if (body.taxPreference === 'EXEMPT' && body.exemptionReason === null) {
    throw badRequest('Give a reason for tax exemption', { fieldErrors: { exemptionReason: ['Required for tax-exempt customers'] } });
  }
  if (body.stateCode && !body.state) body.state = INDIAN_STATES[body.stateCode];
  return body;
}

/** Outstanding receivables and unused credits per customer, in the base currency (foreign documents converted at their rate). */
async function balances(tenantId: string, ids: string[]) {
  const [recv, credits] = await Promise.all([
    prisma.invoice.findMany({ where: { tenantId, customerId: { in: ids }, status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] } }, select: { customerId: true, balanceDue: true, exchangeRate: true } }),
    prisma.payment.findMany({ where: { tenantId, customerId: { in: ids }, unusedAmount: { gt: 0 } }, select: { customerId: true, unusedAmount: true, exchangeRate: true } }),
  ]);
  const sum = (rows: { customerId: string | null; v: unknown; rate: unknown }[], id: string) => Math.round(rows.filter((r) => r.customerId === id).reduce((s, r) => s + toBase(r.v, r.rate), 0) * 100) / 100;
  const r = recv.map((x) => ({ customerId: x.customerId, v: x.balanceDue, rate: x.exchangeRate }));
  const c = credits.map((x) => ({ customerId: x.customerId, v: x.unusedAmount, rate: x.exchangeRate }));
  return new Map(ids.map((id) => [id, { receivables: sum(r, id), unusedCredits: sum(c, id) }]));
}

customersRouter.get('/customers', requirePerm('customers.read'), async (req, res) => {
  const p = listParams(req, ['createdAt', 'name', 'code']);
  const where = {
    tenantId: tid(req),
    ...searchAny(p.q, ['name', 'company', 'email', 'phone', 'code', 'gstin']),
    ...(qstr(req.query.status) ? { status: req.query.status as 'ACTIVE' } : {}),
    ...(qstr(req.query.onboardingStatus) ? { onboardingStatus: req.query.onboardingStatus as 'IN_PROGRESS' } : {}),
  };
  if (req.query.format === 'csv') {
    const rows = await prisma.customer.findMany({ where, orderBy: { name: 'asc' } });
    await audit(req, { action: 'customers.export', meta: { count: rows.length } });
    res.type('text/csv').attachment('customers.csv');
    return res.send(toCsv(rows as never, ['code', 'name', 'company', 'email', 'phone', 'mobile', 'gstin', 'billingAddress', 'city', 'state', 'stateCode', 'postalCode', 'status', 'createdAt']));
  }
  const [items, total] = await Promise.all([
    prisma.customer.findMany({
      where, orderBy: orderBy(p), skip: p.skip, take: p.pageSize,
      include: { _count: { select: { projects: true, invoices: true, tickets: true } } },
    }),
    prisma.customer.count({ where }),
  ]);
  const bal = req.ctx!.permissions.has('invoices.read') ? await balances(tid(req), items.map((c) => c.id)) : null;
  res.json(paged(items.map((c) => ({ ...c, ...(bal?.get(c.id) ?? {}) })), total, p));
});

customersRouter.get('/customers/options', requirePerm('customers.read', 'quotations.read', 'proforma.read', 'invoices.read', 'projects.read', 'tickets.read', 'feedback.read'), async (req, res) => {
  const items = await prisma.customer.findMany({
    where: { tenantId: tid(req), ...searchAny(qstr(req.query.q), ['name', 'company', 'email']) },
    select: { id: true, name: true, company: true, email: true, stateCode: true, gstin: true },
    orderBy: { name: 'asc' }, take: 50,
  });
  res.json(items);
});

customersRouter.post('/customers', requirePerm('customers.update'), async (req, res) => {
  const body = normalizeGst(parse(customerSchema, req.body));
  const enablePortal = req.body?.enablePortal === true;
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) }, include: { plan: true } });
  if (tenant.plan && (await prisma.customer.count({ where: { tenantId: tid(req) } })) >= tenant.plan.maxCustomers) {
    throw badRequest(`Your plan allows ${tenant.plan.maxCustomers} customers. Upgrade to add more.`);
  }
  await assertTenantRefs(tid(req), { user: body.ownerId });
  const customer = await prisma.$transaction(async (tx) => {
    const code = await nextNumber(tx, tid(req), 'CUSTOMER');
    return tx.customer.create({ data: { ...body, tenantId: tid(req), code } });
  });
  await audit(req, { action: 'customers.create', entityType: 'customer', entityId: customer.id });
  const portal = enablePortal ? await invitePortalUser(req, customer) : null;
  res.status(201).json({ ...customer, portal });
});

// ── CSV import ──

const normKey = (k: string) => k.toLowerCase().replace(/[^a-z]/g, '');
const phoneKey = (phone?: string | null) => {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : null;
};
/** Free-text GST treatment ("Registered", "Unregistered", "Consumer", "Overseas", "SEZ", …) to the stored value. */
function gstTreatmentOf(v?: string) {
  const t = normKey(v ?? '');
  if (!t) return undefined;
  if (t.includes('composition')) return 'REGISTERED_COMPOSITION';
  if (t.includes('unregistered')) return 'UNREGISTERED';
  if (t.includes('registered') || t === 'regular' || t === 'b2b') return 'REGISTERED_REGULAR';
  if (t.includes('consumer') || t === 'b2c' || t === 'individual') return 'CONSUMER';
  if (t.includes('overseas') || t.includes('export') || t.includes('foreign')) return 'OVERSEAS';
  if (t.includes('sez') || t.includes('specialeconomic')) return 'SEZ';
  if (t.includes('deemed')) return 'DEEMED_EXPORT';
  return 'INVALID';
}
/** GST state code from a state name ("Karnataka", "karnataka", "New Delhi", "Telangana"…). */
function stateCodeFromName(name: string) {
  const k = normKey(name.replace(/^new\s+delhi$/i, 'Delhi').replace(/&/g, 'and'));
  return Object.entries(INDIAN_STATES).find(([code, n]) => code !== '96' && code !== '97' && normKey(n.replace(/&/g, 'and')) === k)?.[0];
}
/** "Net 30", "net30", "Due on receipt", "NET_30" … to the payment-terms code (digits matter here). */
function paymentTermsOf(v?: string) {
  const key = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = key(v ?? '');
  if (!t) return undefined;
  const hit = Object.entries(PAYMENT_TERMS).find(([code, def]) => key(code) === t || key(def.label) === t);
  return hit?.[0] ?? 'INVALID';
}

customersRouter.post('/customers/import', requirePerm('customers.update'), async (req, res) => {
  const body = parse(z.object({ csv: z.string().min(1).max(5_000_000), skipDuplicates: z.boolean().default(true) }), req.body);
  const rows = parseCsv(body.csv);
  if (!rows.length) throw badRequest('The CSV file has no data rows');
  if (rows.length > 2000) throw badRequest('Import at most 2000 rows at a time');
  const columns = Object.keys(rows[0]);
  const NAME = ['name', 'customername', 'displayname', 'contactname', 'fullname', 'contactperson'];
  const COMPANY = ['company', 'companyname', 'organization', 'organisation', 'businessname', 'firmname'];
  if (!columns.some((c) => [...NAME, ...COMPANY].includes(normKey(c)))) {
    throw badRequest(`No "name" or "company" column found. The header row has: ${columns.slice(0, 10).map((c) => `"${c.slice(0, 40)}"`).join(', ')}. Use a comma-, tab- or semicolon-separated file whose first row names the columns.`);
  }
  const pick = (r: Record<string, string>, ...keys: string[]) => {
    for (const k of keys) {
      const hit = Object.keys(r).find((rk) => normKey(rk) === k);
      if (hit && r[hit]?.trim()) return r[hit].trim();
    }
    return undefined;
  };

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) }, include: { plan: true } });
  let room = tenant.plan ? tenant.plan.maxCustomers - (await prisma.customer.count({ where: { tenantId: tid(req) } })) : Infinity;
  const existing = body.skipDuplicates ? await prisma.customer.findMany({ where: { tenantId: tid(req) }, select: { name: true, email: true, phone: true, mobile: true, gstin: true } }) : [];
  const emails = new Set(existing.map((c) => c.email?.toLowerCase()).filter(Boolean));
  const gstins = new Set(existing.map((c) => c.gstin?.toUpperCase()).filter(Boolean));
  const phones = new Set(existing.flatMap((c) => [phoneKey(c.phone), phoneKey(c.mobile)]).filter(Boolean));
  // Customers without email, GSTIN or phone can only be matched by name.
  const nameKey = (name: string) => name.toLowerCase().replace(/\s+/g, ' ').trim();
  const bareNames = new Set(existing.filter((c) => !c.email && !c.gstin && !phoneKey(c.phone) && !phoneKey(c.mobile)).map((c) => nameKey(c.name)));

  let created = 0;
  const skipped: { row: number; reason: string }[] = [];
  for (const [i, r] of rows.entries()) {
    const row = i + 2; // header is row 1
    const company = pick(r, ...COMPANY);
    const typeRaw = normKey(pick(r, 'customertype', 'type') ?? '');
    const gstTreatment = gstTreatmentOf(pick(r, 'gsttreatment', 'gstregistrationtype', 'registrationtype', 'taxtreatment'));
    const paymentTerms = paymentTermsOf(pick(r, 'paymentterms', 'terms', 'creditterms'));
    if (gstTreatment === 'INVALID') { skipped.push({ row, reason: `Unknown GST treatment "${pick(r, 'gsttreatment', 'gstregistrationtype', 'registrationtype', 'taxtreatment')}"` }); continue; }
    if (paymentTerms === 'INVALID') { skipped.push({ row, reason: `Unknown payment terms "${pick(r, 'paymentterms', 'terms', 'creditterms')}"` }); continue; }
    const stateName = pick(r, 'state', 'billingstate', 'province');
    // The state code decides CGST+SGST vs IGST: take it from the column, else from the state name (GSTIN wins later).
    const stateCodeRaw = pick(r, 'statecode', 'gststatecode', 'placeofsupply') ?? (stateName ? stateCodeFromName(stateName) : undefined);
    const statusRaw = (pick(r, 'status') ?? '').toUpperCase();
    const parsed = customerSchema.safeParse({
      name: pick(r, ...NAME) ?? company,
      company,
      customerType: typeRaw.startsWith('ind') ? 'INDIVIDUAL' : typeRaw.startsWith('bus') || typeRaw.startsWith('com') ? 'BUSINESS' : undefined,
      email: pick(r, 'email', 'emailaddress', 'emailid')?.toLowerCase(),
      phone: pick(r, 'phone', 'phonenumber', 'workphone', 'contactnumber', 'telephone'),
      mobile: pick(r, 'mobile', 'mobilenumber', 'mobilephone', 'whatsapp'),
      website: pick(r, 'website', 'web', 'url'),
      currency: pick(r, 'currency', 'currencycode')?.toUpperCase(),
      gstTreatment,
      gstin: pick(r, 'gstin', 'gstnumber', 'gstno', 'gst', 'gstinuin')?.replace(/\s/g, '').toUpperCase(),
      pan: pick(r, 'pan', 'pannumber', 'panno')?.replace(/\s/g, '').toUpperCase(),
      paymentTerms,
      billingAttention: pick(r, 'attention', 'billingattention'),
      billingAddress: pick(r, 'billingaddress', 'address', 'street', 'addressline', 'billingstreet'),
      city: pick(r, 'city', 'billingcity', 'town'),
      state: stateName,
      stateCode: stateCodeRaw && /^\d{1,2}$/.test(stateCodeRaw) ? stateCodeRaw.padStart(2, '0') : stateCodeRaw,
      postalCode: pick(r, 'postalcode', 'pincode', 'pin', 'zip', 'zipcode', 'billingzip', 'billingcode'),
      country: pick(r, 'country', 'billingcountry'),
      status: ['ACTIVE', 'INACTIVE', 'PROSPECT'].includes(statusRaw) ? statusRaw : undefined,
      notes: pick(r, 'notes', 'note', 'remarks', 'comments'),
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      skipped.push({ row, reason: issue ? `${issue.path.join('.') || 'Row'}: ${issue.message}` : 'Invalid row' });
      continue;
    }
    let d: typeof parsed.data;
    try {
      // Same GST rules as adding a customer by hand: state and PAN come from the GSTIN.
      d = normalizeGst({ ...parsed.data, gstin: parsed.data.gstin ?? (parsed.data.gstTreatment ? null : undefined) });
    } catch (e) {
      skipped.push({ row, reason: (e as Error).message });
      continue;
    }
    const pk = phoneKey(d.phone) ?? phoneKey(d.mobile);
    if (body.skipDuplicates) {
      if (d.email && emails.has(d.email)) { skipped.push({ row, reason: `Duplicate email ${d.email}` }); continue; }
      if (d.gstin && gstins.has(d.gstin)) { skipped.push({ row, reason: `Duplicate GSTIN ${d.gstin}` }); continue; }
      if (pk && phones.has(pk)) { skipped.push({ row, reason: `Duplicate phone ${d.phone ?? d.mobile}` }); continue; }
      if (!d.email && !d.gstin && !pk && bareNames.has(nameKey(d.name))) { skipped.push({ row, reason: `Duplicate customer ${d.name} (no email, GSTIN or phone)` }); continue; }
    }
    if (room <= 0) { skipped.push({ row, reason: `Your plan allows ${tenant.plan?.maxCustomers} customers. Upgrade to add more.` }); continue; }
    await prisma.$transaction(async (tx) => {
      const code = await nextNumber(tx, tid(req), 'CUSTOMER');
      await tx.customer.create({ data: { ...d, tenantId: tid(req), code, ownerId: req.user!.id } });
    });
    room--;
    created++;
    if (d.email) emails.add(d.email);
    if (d.gstin) gstins.add(d.gstin);
    if (pk) phones.add(pk);
    if (!d.email && !d.gstin && !pk) bareNames.add(nameKey(d.name));
  }
  await audit(req, { action: 'customers.import', meta: { created, skipped: skipped.length } });
  res.json({ created, skipped });
});

customersRouter.get('/customers/:id', requirePerm('customers.read'), async (req, res) => {
  const customer = await prisma.customer.findFirst({
    where: { id: String(req.params.id), tenantId: tid(req) },
    include: {
      contacts: { orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }] },
      onboarding: { orderBy: { sortOrder: 'asc' } },
      projects: { select: { id: true, code: true, name: true, status: true, dueDate: true }, orderBy: { createdAt: 'desc' } },
      activities: { orderBy: { occurredAt: 'desc' }, take: 50 },
      _count: { select: { tickets: true, feedback: true, invoices: true, quotations: true } },
    },
  });
  if (!customer) throw notFound('Customer');
  const canFinance = req.ctx!.permissions.has('invoices.read');
  const finance = canFinance
    ? await prisma.invoice.findMany({
        where: { tenantId: tid(req), customerId: customer.id, status: { notIn: ['DRAFT', 'CANCELLED'] } },
        select: { total: true, amountPaid: true, balanceDue: true, exchangeRate: true },
      }).then((rows) => ({ _sum: {
        total: rows.reduce((s, r) => s + toBase(r.total, r.exchangeRate), 0),
        amountPaid: rows.reduce((s, r) => s + toBase(r.amountPaid, r.exchangeRate), 0),
        balanceDue: rows.reduce((s, r) => s + toBase(r.balanceDue, r.exchangeRate), 0),
      } }))
    : null;
  const [bal, portalUsers] = await Promise.all([
    canFinance ? balances(tid(req), [customer.id]) : Promise.resolve(null),
    prisma.membership.count({ where: { tenantId: tid(req), customerId: customer.id, status: 'ACTIVE' } }),
  ]);
  res.json({ ...customer, finance: finance?._sum ?? null, ...(bal?.get(customer.id) ?? {}), portalEnabled: portalUsers > 0 });
});

customersRouter.patch('/customers/:id', requirePerm('customers.update'), async (req, res) => {
  const body = normalizeGst(parse(customerSchema.partial(), req.body));
  const enablePortal = req.body?.enablePortal === true;
  await assertTenantRefs(tid(req), { user: body.ownerId });
  const r = await prisma.customer.updateMany({ where: { id: String(req.params.id), tenantId: tid(req) }, data: body });
  if (!r.count) throw notFound('Customer');
  await audit(req, { action: 'customers.update', entityType: 'customer', entityId: String(req.params.id), meta: { fields: Object.keys(body) } });
  const customer = await prisma.customer.findUniqueOrThrow({ where: { id: String(req.params.id) } });
  const portal = enablePortal ? await invitePortalUser(req, customer) : null;
  res.json({ ...customer, portal });
});

customersRouter.delete('/customers/:id', requirePerm('customers.update'), async (req, res) => {
  const id = String(req.params.id);
  const customer = await prisma.customer.findFirst({
    where: { id, tenantId: tid(req) },
    include: { _count: { select: { invoices: true, quotations: true, proformaInvoices: true, projects: true } } },
  });
  if (!customer) throw notFound('Customer');
  if (customer._count.invoices || customer._count.quotations || customer._count.proformaInvoices || customer._count.projects) {
    // Keep financial and project history intact: deactivate instead of deleting.
    await prisma.customer.update({ where: { id }, data: { status: 'INACTIVE' } });
    await audit(req, { action: 'customers.deactivate', entityType: 'customer', entityId: id });
    return res.json({ ok: true, deactivated: true });
  }
  await prisma.customer.delete({ where: { id } });
  await audit(req, { action: 'customers.delete', entityType: 'customer', entityId: id, meta: { name: customer.name } });
  res.json({ ok: true });
});

// ── Contacts ──

const contactSchema = z.object({
  customerId: z.string(),
  name: z.string().min(1).max(120),
  email: opt(z.string().email()),
  phone: opt(z.string().max(40)),
  designation: opt(z.string().max(80)),
  isPrimary: z.boolean().optional(),
});

customersRouter.get('/contacts', requirePerm('customers.read'), async (req, res) => {
  const p = listParams(req, ['createdAt', 'name']);
  const where = {
    tenantId: tid(req),
    ...searchAny(p.q, ['name', 'email', 'phone', 'designation']),
    ...(qstr(req.query.customerId) ? { customerId: String(req.query.customerId) } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.contact.findMany({ where, orderBy: orderBy(p), skip: p.skip, take: p.pageSize, include: { customer: { select: { id: true, name: true, company: true } } } }),
    prisma.contact.count({ where }),
  ]);
  res.json(paged(items, total, p));
});

customersRouter.post('/contacts', requirePerm('customers.update'), async (req, res) => {
  const body = parse(contactSchema, req.body);
  await assertTenantRefs(tid(req), { customer: body.customerId });
  const contact = await prisma.$transaction(async (tx) => {
    if (body.isPrimary) await tx.contact.updateMany({ where: { tenantId: tid(req), customerId: body.customerId }, data: { isPrimary: false } });
    return tx.contact.create({ data: { ...body, tenantId: tid(req) } });
  });
  res.status(201).json(contact);
});

customersRouter.patch('/contacts/:id', requirePerm('customers.update'), async (req, res) => {
  const body = parse(contactSchema.omit({ customerId: true }).partial(), req.body);
  const existing = await prisma.contact.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) } });
  if (!existing) throw notFound('Contact');
  const contact = await prisma.$transaction(async (tx) => {
    if (body.isPrimary) await tx.contact.updateMany({ where: { tenantId: tid(req), customerId: existing.customerId }, data: { isPrimary: false } });
    return tx.contact.update({ where: { id: existing.id }, data: body });
  });
  res.json(contact);
});

customersRouter.delete('/contacts/:id', requirePerm('customers.update'), async (req, res) => {
  const r = await prisma.contact.deleteMany({ where: { id: String(req.params.id), tenantId: tid(req) } });
  if (!r.count) throw notFound('Contact');
  res.json({ ok: true });
});

// ── Onboarding ──

customersRouter.get('/onboarding', requirePerm('customers.read'), async (req, res) => {
  const customers = await prisma.customer.findMany({
    where: { tenantId: tid(req), onboardingStatus: qstr(req.query.status) ? (req.query.status as 'IN_PROGRESS') : { not: 'NOT_STARTED' } },
    select: {
      id: true, code: true, name: true, company: true, onboardingStatus: true, createdAt: true,
      onboarding: { select: { id: true, doneAt: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  });
  res.json(customers.map(({ onboarding, ...c }) => ({ ...c, total: onboarding.length, done: onboarding.filter((o) => o.doneAt).length })));
});

customersRouter.post('/customers/:id/onboarding/start', requirePerm('customers.update'), async (req, res) => {
  const customer = await prisma.customer.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) }, include: { onboarding: true } });
  if (!customer) throw notFound('Customer');
  if (!customer.onboarding.length) {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) } });
    const template = tenantSettings(tenant.settings).onboardingTemplate;
    await prisma.onboardingItem.createMany({
      data: template.map((title, i) => ({ tenantId: tid(req), customerId: customer.id, title, sortOrder: i })),
    });
  }
  await prisma.customer.update({ where: { id: customer.id }, data: { onboardingStatus: 'IN_PROGRESS' } });
  await audit(req, { action: 'onboarding.start', entityType: 'customer', entityId: customer.id });
  res.json(await prisma.onboardingItem.findMany({ where: { customerId: customer.id }, orderBy: { sortOrder: 'asc' } }));
});

customersRouter.post('/customers/:id/onboarding', requirePerm('customers.update'), async (req, res) => {
  const body = parse(z.object({ title: z.string().min(1).max(200) }), req.body);
  await assertTenantRefs(tid(req), { customer: String(req.params.id) });
  const count = await prisma.onboardingItem.count({ where: { customerId: String(req.params.id) } });
  const item = await prisma.onboardingItem.create({ data: { tenantId: tid(req), customerId: String(req.params.id), title: body.title, sortOrder: count } });
  res.status(201).json(item);
});

customersRouter.patch('/onboarding-items/:id', requirePerm('customers.update'), async (req, res) => {
  const body = parse(z.object({ done: z.boolean().optional(), title: z.string().min(1).max(200).optional() }), req.body);
  const item = await prisma.onboardingItem.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) } });
  if (!item) throw notFound('Onboarding item');
  const updated = await prisma.onboardingItem.update({
    where: { id: item.id },
    data: {
      ...(body.title ? { title: body.title } : {}),
      ...(body.done !== undefined ? { doneAt: body.done ? new Date() : null, doneById: body.done ? req.user!.id : null } : {}),
    },
  });
  const all = await prisma.onboardingItem.findMany({ where: { customerId: item.customerId } });
  const complete = all.length > 0 && all.every((i) => i.doneAt);
  await prisma.customer.update({ where: { id: item.customerId }, data: { onboardingStatus: complete ? 'COMPLETED' : 'IN_PROGRESS' } });
  if (complete) await audit(req, { action: 'onboarding.complete', entityType: 'customer', entityId: item.customerId });
  res.json(updated);
});

customersRouter.delete('/onboarding-items/:id', requirePerm('customers.update'), async (req, res) => {
  const r = await prisma.onboardingItem.deleteMany({ where: { id: String(req.params.id), tenantId: tid(req) } });
  if (!r.count) throw notFound('Onboarding item');
  res.json({ ok: true });
});

// ── Statement of accounts ──

customersRouter.get('/customers/:id/statement', requirePerm('invoices.read'), async (req, res) => {
  const customer = await prisma.customer.findFirst({ where: { id: String(req.params.id), tenantId: tid(req) } });
  if (!customer) throw notFound('Customer');
  const now = new Date();
  const from = dateParam(req.query.from) ?? new Date(now.getFullYear(), now.getMonth(), 1);
  const to = dateParam(req.query.to, { endOfDay: true }) ?? now;
  const currency = qstr(req.query.currency) ? String(req.query.currency).toUpperCase() : undefined;
  const statement = await buildStatement(tid(req), customer.id, from, to, currency);
  if (req.query.format === 'pdf') {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) } });
    const pdf = await renderStatementPdf({ seller: await sellerOf(tenant), customer: buyerOf(customer), from, to, ...statement });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="statement-${customer.code}.pdf"`);
    return res.send(pdf);
  }
  res.json({ customer: { id: customer.id, name: customer.name, company: customer.company }, from, to, ...statement });
});

/** Currencies a customer has transactions in, most used first (statements are produced per currency). */
export async function customerCurrencies(tenantId: string, customerId: string) {
  const [inv, pay] = await Promise.all([
    prisma.invoice.groupBy({ by: ['currency'], where: { tenantId, customerId, status: { notIn: ['DRAFT', 'CANCELLED'] } }, _count: true }),
    prisma.payment.groupBy({ by: ['currency'], where: { tenantId, customerId }, _count: true }),
  ]);
  const counts = new Map<string, number>();
  for (const r of [...inv, ...pay]) counts.set(r.currency, (counts.get(r.currency) ?? 0) + r._count);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

export async function buildStatement(tenantId: string, customerId: string, from: Date, to: Date, currency?: string) {
  const end = new Date(to);
  end.setHours(23, 59, 59, 999);
  const available = await customerCurrencies(tenantId, customerId);
  const cur = currency ?? available[0] ?? (await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultCurrency: true } })).defaultCurrency;
  const [invBefore, payBefore, cnBefore, invoices, payments, credits] = await Promise.all([
    prisma.invoice.aggregate({ where: { tenantId, customerId, currency: cur, status: { notIn: ['DRAFT', 'CANCELLED'] }, issueDate: { lt: from } }, _sum: { total: true, writeOffAmount: true } }),
    prisma.payment.aggregate({ where: { tenantId, customerId, currency: cur, paidAt: { lt: from } }, _sum: { amount: true, taxDeducted: true, refundedAmount: true } }),
    prisma.creditNote.aggregate({ where: { tenantId, currency: cur, status: 'ISSUED', issueDate: { lt: from }, invoice: { customerId } }, _sum: { total: true } }),
    prisma.invoice.findMany({ where: { tenantId, customerId, currency: cur, status: { notIn: ['DRAFT', 'CANCELLED'] }, issueDate: { gte: from, lte: end } }, select: { issueDate: true, number: true, total: true } }),
    prisma.payment.findMany({ where: { tenantId, customerId, currency: cur, paidAt: { gte: from, lte: end } }, select: { paidAt: true, number: true, amount: true, taxDeducted: true } }),
    prisma.creditNote.findMany({ where: { tenantId, currency: cur, status: 'ISSUED', issueDate: { gte: from, lte: end }, invoice: { customerId } }, select: { issueDate: true, number: true, total: true } }),
  ]);
  const n = (v: unknown) => Number(v ?? 0);
  const opening = n(invBefore._sum.total) - n(invBefore._sum.writeOffAmount) - n(payBefore._sum.amount) - n(payBefore._sum.taxDeducted)
    + n(payBefore._sum.refundedAmount) - n(cnBefore._sum.total);
  const events = [
    ...invoices.map((i) => ({ date: i.issueDate, type: 'Invoice', number: i.number ?? '', amount: n(i.total), payment: 0 })),
    ...payments.map((p) => ({ date: p.paidAt, type: 'Payment Received', number: p.number, amount: 0, payment: n(p.amount) + n(p.taxDeducted) })),
    ...credits.map((c) => ({ date: c.issueDate, type: 'Credit Note', number: c.number, amount: 0, payment: n(c.total) })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());
  let running = opening;
  const rows = events.map((e) => {
    running += e.amount - e.payment;
    return { ...e, balance: Math.round(running * 100) / 100 };
  });
  return { currency: await currencyInfo(cur), currencies: available.length ? available : [cur], opening: Math.round(opening * 100) / 100, rows, closing: Math.round(running * 100) / 100 };
}

// ── Transactions tab ──

customersRouter.get('/customers/:id/transactions', requirePerm('invoices.read', 'quotations.read', 'payments.read'), async (req, res) => {
  await assertTenantRefs(tid(req), { customer: String(req.params.id) });
  const c = String(req.params.id);
  const t = tid(req);
  const has = (p: string) => req.ctx!.permissions.has(p as never);
  const [invoices, quotes, payments, recurring, expenses] = await Promise.all([
    has('invoices.read') ? prisma.invoice.findMany({ where: { tenantId: t, customerId: c }, orderBy: { issueDate: 'desc' }, take: 100, select: { id: true, number: true, issueDate: true, dueDate: true, total: true, balanceDue: true, status: true, currency: true } }) : [],
    has('quotations.read') ? prisma.quotation.findMany({ where: { tenantId: t, customerId: c }, orderBy: { issueDate: 'desc' }, take: 100, select: { id: true, number: true, issueDate: true, total: true, status: true, referenceNumber: true, currency: true } }) : [],
    has('payments.read') ? prisma.payment.findMany({ where: { tenantId: t, customerId: c }, orderBy: { paidAt: 'desc' }, take: 100, select: { id: true, number: true, paidAt: true, amount: true, unusedAmount: true, method: true, reference: true, currency: true } }) : [],
    has('invoices.read') ? prisma.recurringProfile.findMany({ where: { tenantId: t, customerId: c }, select: { id: true, profileName: true, frequency: true, nextRunDate: true, status: true } }) : [],
    has('invoices.read') ? prisma.expense.findMany({ where: { tenantId: t, customerId: c }, orderBy: { date: 'desc' }, take: 100, select: { id: true, date: true, total: true, billable: true, invoiceId: true, category: { select: { name: true } } } }) : [],
  ]);
  res.json({ invoices, quotes, payments, recurring, expenses });
});
