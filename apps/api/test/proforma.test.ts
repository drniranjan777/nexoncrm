import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { testDbConfigured } from './db.js';

// Proforma invoices end to end, and configurable tax rates in quotations and invoices.
const run = testDbConfigured();
const H = { 'x-requested-with': 'nexonweb' };
const PASSWORD = 'Test-Password-123';
let app: Express;
let prisma: typeof import('../src/lib/db.js')['prisma'];

type Agent = { cookie: string; tenantId: string };
const as = (ag: Agent, tenantId = ag.tenantId) => ({
  get: (url: string) => request(app).get(`/api/v1${url}`).set('Cookie', ag.cookie).set('x-tenant-id', tenantId),
  post: (url: string, body: object = {}) => request(app).post(`/api/v1${url}`).set(H).set('Cookie', ag.cookie).set('x-tenant-id', tenantId).send(body),
  patch: (url: string, body: object = {}) => request(app).patch(`/api/v1${url}`).set(H).set('Cookie', ag.cookie).set('x-tenant-id', tenantId).send(body),
  delete: (url: string) => request(app).delete(`/api/v1${url}`).set(H).set('Cookie', ag.cookie).set('x-tenant-id', tenantId),
});

async function register(company: string): Promise<Agent> {
  const res = await request(app).post('/api/v1/auth/register').set(H).send({ name: `${company} Owner`, email: `${company.replace(/\W/g, '').toLowerCase()}-${Date.now()}@test.local`, password: PASSWORD, companyName: company });
  expect(res.status).toBe(201);
  return { cookie: res.headers['set-cookie'][0].split(';')[0], tenantId: res.body.memberships[0].tenant.id };
}

async function member(owner: Agent, roleKey: string): Promise<Agent> {
  const roles = await as(owner).get('/roles');
  const role = roles.body.roles.find((r: { key: string }) => r.key === roleKey);
  const inv = await as(owner).post('/invitations', { email: `${roleKey}-${Date.now()}@test.local`, roleId: role.id });
  expect(inv.status).toBe(201);
  const token = new URL(inv.body.inviteLink).searchParams.get('token');
  const acc = await request(app).post(`/api/v1/auth/invitations/${token}/accept`).set(H).send({ name: roleKey, password: PASSWORD });
  expect(acc.status).toBe(200);
  return { cookie: acc.headers['set-cookie'][0].split(';')[0], tenantId: owner.tenantId };
}

const waitFor = async <T>(fn: () => Promise<T>, ok: (v: T) => boolean) => {
  for (let i = 0; i < 40; i++) { const v = await fn(); if (ok(v)) return v; await new Promise((r) => setTimeout(r, 50)); }
  return fn();
};

describe.skipIf(!run)('Proforma invoices and tax settings', () => {
  let a: Agent;
  let b: Agent;
  let customer: string;
  let otherState: string;
  const tax: Record<string, string> = {};

  beforeAll(async () => {
    app = (await import('../src/app.js')).createApp();
    prisma = (await import('../src/lib/db.js')).prisma;
    await prisma.plan.upsert({ where: { code: 'starter' }, create: { code: 'starter', name: 'Starter', maxUsers: 20, modules: [] }, update: {} });
    a = await register('Proforma Co A');
    b = await register('Proforma Co B');
    await as(a).patch('/settings/company', { stateCode: '27', gstin: '27ABCDE1234F1Z5', legalName: 'Proforma Co A Pvt Ltd' });
    customer = (await as(a).post('/customers', { name: 'Pune Retail', gstin: '27AAICB4670Q1Z1', email: 'pune@test.local' })).body.id;
    otherState = (await as(a).post('/customers', { name: 'Bengaluru Labs', gstin: '29AAICB4670Q1Z1', email: 'blr@test.local' })).body.id;
  });

  afterAll(async () => { await prisma?.$disconnect(); });

  it('seeds default GST rates for new organizations and lists them as options', async () => {
    const opts = await as(a).get('/tax-rates/options');
    expect(opts.status).toBe(200);
    for (const o of opts.body) tax[o.code] = o.id;
    expect(Object.keys(tax)).toEqual(expect.arrayContaining(['GST0', 'GST5', 'GST12', 'GST18', 'GST28', 'EXEMPT']));
  });

  it('lets administrators add a tax, validates it and rejects duplicate codes', async () => {
    const bad = await as(a).post('/tax-rates', { name: 'Broken', code: 'BROKEN', taxType: 'GST', rate: 18, components: { intra: [{ name: 'CGST', rate: 9 }], inter: [{ name: 'IGST', rate: 18 }] } });
    expect(bad.status).toBe(400);
    const created = await as(a).post('/tax-rates', { name: 'GST 3%', code: 'gst3', taxType: 'GST', rate: 3 });
    expect(created.status).toBe(201);
    expect(created.body.components).toEqual({ intra: [{ name: 'CGST', rate: 1.5 }, { name: 'SGST', rate: 1.5 }], inter: [{ name: 'IGST', rate: 3 }] });
    tax.GST3 = created.body.id;
    expect((await as(a).post('/tax-rates', { name: 'Again', code: 'GST3', taxType: 'GST', rate: 3 })).status).toBe(409);
    // The new rate is offered on quotation and invoice lines.
    expect((await as(a).get('/tax-rates/options')).body.map((o: { id: string }) => o.id)).toContain(tax.GST3);
  });

  let pi: { id: string; number: string };
  it('creates a proforma with several tax rates and calculates the totals', async () => {
    const res = await as(a).post('/proforma-invoices', {
      customerId: customer, referenceNumber: 'PO-77', serviceReference: 'Website rebuild',
      items: [
        { description: 'Design', quantity: 1, rate: 50000, taxRateId: tax.GST18 },
        { description: 'Printed manuals', quantity: 10, rate: 200, discountAmount: 100, taxRateId: tax.GST5 },
        { description: 'Training', quantity: 1, rate: 5000, taxRateId: tax.EXEMPT },
      ],
    });
    expect(res.status).toBe(201);
    pi = res.body;
    expect(res.body.number).toMatch(/^PI-\d{4}$/);
    expect(res.body.status).toBe('DRAFT');
    expect(Number(res.body.taxableTotal)).toBe(56900);
    // 18% of 50,000 = 9,000 and 5% of 1,900 = 95, split into CGST and SGST (same state).
    expect(Number(res.body.cgstTotal)).toBe(4547.5);
    expect(Number(res.body.sgstTotal)).toBe(4547.5);
    expect(Number(res.body.igstTotal)).toBe(0);
    expect(Number(res.body.total)).toBe(65995);
    expect(res.body.taxBreakdown).toEqual(expect.arrayContaining([{ name: 'CGST', rate: 9, taxable: 50000, amount: 4500 }, { name: 'SGST', rate: 2.5, taxable: 1900, amount: 47.5 }]));
    const detail = await as(a).get(`/proforma-invoices/${pi.id}`);
    expect(detail.body.items.map((i: { taxName: string }) => i.taxName)).toEqual(['GST 18%', 'GST 5%', 'Exempt']);
    expect(Number(detail.body.items[1].discountAmount)).toBe(100);
  });

  it('uses IGST for a customer in another state', async () => {
    const res = await as(a).post('/proforma-invoices', { customerId: otherState, items: [{ description: 'Audit', quantity: 1, rate: 10000, taxRateId: tax.GST18 }] });
    expect(res.status).toBe(201);
    expect(res.body.isInterState).toBe(true);
    expect(Number(res.body.igstTotal)).toBe(1800);
  });

  it('lists, searches and filters proforma invoices', async () => {
    const list = await as(a).get('/proforma-invoices?q=PO-77');
    expect(list.status).toBe(200);
    expect(list.body.items.map((x: { id: string }) => x.id)).toEqual([pi.id]);
    expect((await as(a).get('/proforma-invoices?status=SENT')).body.total).toBe(0);
    const today = new Date().toISOString().slice(0, 10);
    expect((await as(a).get(`/proforma-invoices?from=${today}&to=${today}`)).body.total).toBeGreaterThanOrEqual(2);
  });

  it('renders the PDF', async () => {
    const pdf = await as(a).get(`/proforma-invoices/${pi.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });

  it('emails the proforma with the PDF, records the activity and does not claim delivery', async () => {
    const draft = await as(a).get(`/email/proforma/${pi.id}/draft`);
    expect(draft.status).toBe(200);
    expect(draft.body.subject).toBe(`Proforma Invoice ${pi.number} from Proforma Co A`);
    expect(draft.body.to).toEqual(['pune@test.local']);
    expect(draft.body.html).toContain('Please find attached the Proforma Invoice for your review.');
    const sent = await as(a).post(`/email/proforma/${pi.id}/send`, { to: ['pune@test.local'], subject: draft.body.subject, html: draft.body.html });
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe('QUEUED');
    expect(sent.body.attachments).toEqual([`${pi.number}.pdf`]);
    // SMTP is not configured in tests: the log must say so rather than "sent" or "delivered".
    const logs = await waitFor(() => as(a).get(`/proforma-invoices/${pi.id}/emails`), (r) => r.body[0]?.status !== 'QUEUED');
    expect(logs.body[0]).toMatchObject({ status: 'NOT_CONFIGURED', to: ['pune@test.local'], attachments: [`${pi.number}.pdf`] });
    expect(logs.body[0].sentByName).toBe('Proforma Co A Owner');
    const after = await as(a).get(`/proforma-invoices/${pi.id}`);
    expect(after.body.status).toBe('SENT');
    expect(after.body.lastEmailedAt).toBeTruthy();
    // Sent proformas are not edited in place.
    expect((await as(a).patch(`/proforma-invoices/${pi.id}`, { customerId: customer, items: [{ description: 'X', quantity: 1, rate: 1, taxRateId: tax.GST18 }] })).status).toBe(409);
  });

  let invoiceId: string;
  it('converts to a draft invoice once, linked to the proforma, keeping lines and taxes', async () => {
    expect((await as(a).post(`/proforma-invoices/${pi.id}/status`, { status: 'ACCEPTED' })).status).toBe(200);
    // Two conversions at once: exactly one succeeds.
    const [r1, r2] = await Promise.all([as(a).post(`/proforma-invoices/${pi.id}/convert`), as(a).post(`/proforma-invoices/${pi.id}/convert`)]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const inv = r1.status === 201 ? r1.body : r2.body;
    invoiceId = inv.id;
    expect(inv.status).toBe('DRAFT');
    expect(inv.number).toMatch(/^INV-/);
    expect(inv.proformaInvoiceId).toBe(pi.id);
    expect(Number(inv.total)).toBe(65995);
    expect(Number(inv.amountPaid)).toBe(0);
    const full = await as(a).get(`/invoices/${inv.id}`);
    expect(full.body.items.map((i: { taxRateId: string }) => i.taxRateId)).toEqual([tax.GST18, tax.GST5, tax.EXEMPT]);
    expect(full.body.orderNumber).toBe('PO-77');
    const source = await as(a).get(`/proforma-invoices/${pi.id}`);
    expect(source.body.status).toBe('CONVERTED');
    expect(source.body.convertedInvoice).toMatchObject({ id: inv.id, number: inv.number });
    expect((await as(a).post(`/proforma-invoices/${pi.id}/convert`)).status).toBe(409);
    expect((await as(a).post(`/proforma-invoices/${pi.id}/cancel`, { reason: 'changed mind' })).status).toBe(409);
    const audit = await prisma.auditLog.findFirst({ where: { tenantId: a.tenantId, action: 'proforma.convert', entityId: pi.id } });
    expect(audit?.meta).toMatchObject({ invoiceId: inv.id });
  });

  it('uses configured taxes on quotations and invoices, and keeps saved values when a tax changes', async () => {
    const q = await as(a).post('/quotations', { customerId: customer, items: [{ description: 'Gold coin', quantity: 1, rate: 10000, taxRateId: tax.GST3 }, { description: 'Service', quantity: 1, rate: 1000, taxRateId: tax.GST18 }] });
    expect(q.status).toBe(201);
    expect(Number(q.body.cgstTotal)).toBe(150 + 90);
    const inv = await as(a).post('/invoices', { customerId: customer, items: [{ description: 'Gold coin', quantity: 1, rate: 10000, taxRateId: tax.GST3 }] });
    expect(inv.status).toBe(201);
    expect(Number(inv.body.total)).toBe(10300);

    // The administrator changes the rate, then deactivates it.
    expect((await as(a).patch(`/tax-rates/${tax.GST3}`, { rate: 4 })).status).toBe(200);
    expect((await as(a).post(`/tax-rates/${tax.GST3}/deactivate`)).status).toBe(200);
    // It cannot be deleted while documents use it, and it is no longer offered.
    expect((await as(a).delete(`/tax-rates/${tax.GST3}`)).status).toBe(409);
    expect((await as(a).get('/tax-rates/options')).body.map((o: { id: string }) => o.id)).not.toContain(tax.GST3);
    expect((await as(a).post('/invoices', { customerId: customer, items: [{ description: 'New', quantity: 1, rate: 100, taxRateId: tax.GST3 }] })).status).toBe(400);

    // Historical documents keep their original tax.
    const savedQ = await as(a).get(`/quotations/${q.body.id}`);
    expect(Number(savedQ.body.items[0].taxRate)).toBe(3);
    expect(Number(savedQ.body.total)).toBe(Number(q.body.total));
    const savedInv = await as(a).get(`/invoices/${inv.body.id}`);
    expect(Number(savedInv.body.total)).toBe(10300);
    // Editing a document that already used the inactive tax keeps its saved 3%.
    const edited = await as(a).patch(`/invoices/${inv.body.id}`, { customerId: customer, items: [{ description: 'Gold coin', quantity: 2, rate: 10000, taxRateId: tax.GST3 }] });
    expect(edited.status).toBe(200);
    expect(Number(edited.body.total)).toBe(20600);
    // Converting the quote keeps its tax details.
    const conv = await as(a).post(`/quotations/${q.body.id}/convert`);
    expect(conv.status).toBe(201);
    expect(Number(conv.body.total)).toBe(Number(q.body.total));
  });

  it('still accepts a plain GST rate from older clients', async () => {
    const res = await as(a).post('/invoices', { customerId: customer, items: [{ description: 'Legacy', quantity: 1, rate: 1000, taxRate: 18 }] });
    expect(res.status).toBe(201);
    expect(Number(res.body.total)).toBe(1180);
  });

  it('deleting the draft invoice reopens the proforma for conversion', async () => {
    expect((await as(a).delete(`/invoices/${invoiceId}`)).status).toBe(200);
    const p = await as(a).get(`/proforma-invoices/${pi.id}`);
    expect(p.body.status).toBe('ACCEPTED');
    expect(p.body.convertedInvoiceId).toBeNull();
  });

  it('duplicates and cancels proforma invoices', async () => {
    const dup = await as(a).post(`/proforma-invoices/${pi.id}/duplicate`);
    expect(dup.status).toBe(201);
    expect(dup.body.number).not.toBe(pi.number);
    expect(dup.body.status).toBe('DRAFT');
    expect(Number(dup.body.total)).toBe(65995);
    const cancel = await as(a).post(`/proforma-invoices/${dup.body.id}/cancel`, { reason: 'Client postponed' });
    expect(cancel.body.status).toBe('CANCELLED');
    expect((await as(a).post(`/proforma-invoices/${dup.body.id}/convert`)).status).toBe(409);
  });

  it('isolates tenants: no access to another tenant’s proformas or tax rates', async () => {
    expect((await as(b).get(`/proforma-invoices/${pi.id}`)).status).toBe(404);
    expect((await as(b).get(`/proforma-invoices/${pi.id}/pdf`)).status).toBe(404);
    expect((await as(b).post(`/proforma-invoices/${pi.id}/convert`)).status).toBe(404);
    expect((await as(b).get('/proforma-invoices')).body.items).toHaveLength(0);
    const bCustomer = (await as(b).post('/customers', { name: 'B Customer' })).body.id;
    // Using tenant A's tax configuration is rejected.
    const cross = await as(b).post('/proforma-invoices', { customerId: bCustomer, items: [{ description: 'X', quantity: 1, rate: 100, taxRateId: tax.GST18 }] });
    expect(cross.status).toBe(400);
    expect((await as(b).patch(`/tax-rates/${tax.GST18}`, { name: 'Hacked' })).status).toBe(404);
    expect((await as(a).get(`/email/proforma/${pi.id}/draft`)).status).toBe(200);
    expect((await as(b).get(`/email/proforma/${pi.id}/draft`)).status).toBe(404);
  });

  it('enforces permissions', async () => {
    const sales = await member(a, 'sales');
    expect((await as(sales).get('/proforma-invoices')).status).toBe(200);
    // Sales can prepare and send proformas but cannot convert them or manage taxes.
    expect((await as(sales).post(`/proforma-invoices/${pi.id}/convert`)).status).toBe(403);
    expect((await as(sales).post('/tax-rates', { name: 'X', code: 'X', taxType: 'GST', rate: 5 })).status).toBe(403);
    expect((await as(sales).get('/tax-rates/options')).status).toBe(200);
    const dev = await member(a, 'developer');
    expect((await as(dev).get('/proforma-invoices')).status).toBe(403);
    expect((await as(dev).get(`/proforma-invoices/${pi.id}/pdf`)).status).toBe(403);
    expect((await as(dev).post(`/email/proforma/${pi.id}/send`, { to: ['x@test.local'], subject: 's', html: 'h' })).status).toBe(403);
  });
});
