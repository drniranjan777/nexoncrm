import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { testDbConfigured } from './db.js';

// Invoicing parity: payments across invoices, credits, refunds, write-offs, recurring profiles,
// expenses, time billing, email, reports, GST returns and organizations.
const run = testDbConfigured();
const H = { 'x-requested-with': 'nexonweb' };
let app: Express;
let prisma: typeof import('../src/lib/db.js')['prisma'];

type Agent = { cookie: string; tenantId: string };
let a: Agent;
let customerId: string;

const as = (ag: Agent) => ({
  get: (url: string) => request(app).get(`/api/v1${url}`).set('Cookie', ag.cookie).set('x-tenant-id', ag.tenantId),
  post: (url: string, body: object = {}) => request(app).post(`/api/v1${url}`).set(H).set('Cookie', ag.cookie).set('x-tenant-id', ag.tenantId).send(body),
  patch: (url: string, body: object = {}) => request(app).patch(`/api/v1${url}`).set(H).set('Cookie', ag.cookie).set('x-tenant-id', ag.tenantId).send(body),
  delete: (url: string) => request(app).delete(`/api/v1${url}`).set(H).set('Cookie', ag.cookie).set('x-tenant-id', ag.tenantId),
});

async function invoice(amount: number, extra: object = {}) {
  const r = await as(a).post('/invoices', { customerId, items: [{ description: 'Service', quantity: 1, rate: amount, taxRate: 18 }], issue: true, ...extra });
  expect(r.status).toBe(201);
  return r.body;
}

describe.skipIf(!run)('Invoicing parity', () => {
  beforeAll(async () => {
    app = (await import('../src/app.js')).createApp();
    prisma = (await import('../src/lib/db.js')).prisma;
    await prisma.plan.upsert({ where: { code: 'starter' }, create: { code: 'starter', name: 'Starter', maxUsers: 20, modules: [] }, update: {} });
    const reg = await request(app).post('/api/v1/auth/register').set(H).send({ name: 'Billing Owner', email: `bill-${Date.now()}@test.local`, password: 'Test-Password-123', companyName: 'Billing Co' });
    expect(reg.status).toBe(201);
    a = { cookie: reg.headers['set-cookie'][0].split(';')[0], tenantId: reg.body.memberships[0].tenant.id };
    await as(a).patch('/settings/company', { stateCode: '36', gstin: '36ABCDE1234F1Z5', legalName: 'Billing Co Pvt Ltd' });
    const c = await as(a).post('/customers', {
      name: 'Binginapalli Infra', customerType: 'BUSINESS', company: 'Binginapalli Infra Pvt Ltd', email: 'accounts@bingi.test',
      gstin: '36AAICB4670Q1Z1', paymentTerms: 'NET_15', billingAddress: '3rd Floor, G&G Trade Centre', city: 'Hyderabad', postalCode: '500048',
      shippingAddress: 'Site office', shippingCity: 'Hyderabad',
    });
    expect(c.status).toBe(201);
    customerId = c.body.id;
    // GSTIN fills place of supply, PAN and GST treatment automatically.
    expect(c.body.stateCode).toBe('36');
    expect(c.body.pan).toBe('AAICB4670Q');
    expect(c.body.gstTreatment).toBe('REGISTERED_REGULAR');
  });

  afterAll(async () => { await prisma?.$disconnect(); });

  it('creates invoices with terms, document discount, TDS and adjustment', async () => {
    const inv = await invoice(10000, { discountType: 'PERCENT', discountValue: 10, withholdingType: 'TDS', withholdingRate: 10, adjustment: 50, orderNumber: 'PO-77', subject: 'AMC' });
    expect(inv.paymentTerms).toBe('NET_15');
    expect(Math.round((new Date(inv.dueDate).getTime() - new Date(inv.issueDate).getTime()) / 86_400_000)).toBe(15);
    expect(Number(inv.taxableTotal)).toBe(9000);
    expect(Number(inv.cgstTotal)).toBe(810);
    expect(Number(inv.withholdingAmount)).toBe(-900);
    expect(Number(inv.total)).toBe(9000 + 1620 - 900 + 50);
    const pdf = await as(a).get(`/invoices/${inv.id}/pdf`);
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });

  it('splits one payment across invoices, keeps the excess as credit, applies and refunds it', async () => {
    const i1 = await invoice(1000); // 1180
    const i2 = await invoice(2000); // 2360
    const open = await as(a).get(`/customers/${customerId}/open-invoices`);
    expect(open.body.invoices.length).toBeGreaterThanOrEqual(2);
    const pay = await as(a).post('/payments', {
      customerId, amount: 4000, paidAt: new Date().toISOString(), method: 'BANK_TRANSFER', reference: 'UTR1',
      allocations: [{ invoiceId: i1.id, amount: 1180 }, { invoiceId: i2.id, amount: 2000 }],
    });
    expect(pay.status).toBe(201);
    expect(Number(pay.body.unusedAmount)).toBe(820);
    expect((await as(a).get(`/invoices/${i1.id}`)).body.status).toBe('PAID');
    expect((await as(a).get(`/invoices/${i2.id}`)).body.status).toBe('PARTIALLY_PAID');
    // Over-applying is rejected.
    expect((await as(a).post(`/payments/${pay.body.id}/apply`, { allocations: [{ invoiceId: i2.id, amount: 900 }] })).status).toBe(400);
    expect((await as(a).post(`/payments/${pay.body.id}/apply`, { allocations: [{ invoiceId: i2.id, amount: 360 }] })).status).toBe(200);
    expect((await as(a).get(`/invoices/${i2.id}`)).body.status).toBe('PAID');
    const refund = await as(a).post(`/payments/${pay.body.id}/refund`, { amount: 460, refundedAt: new Date().toISOString(), method: 'BANK_TRANSFER' });
    expect(refund.status).toBe(201);
    const after = await as(a).get(`/payments/${pay.body.id}`);
    expect(Number(after.body.unusedAmount)).toBe(0);
    expect((await as(a).post(`/payments/${pay.body.id}/refund`, { amount: 1, refundedAt: new Date().toISOString(), method: 'CASH' })).status).toBe(400);
    const list = await as(a).get('/customers?q=Binginapalli');
    expect(list.body.items[0].unusedCredits).toBe(0);
  });

  it('writes off and restores an invoice', async () => {
    const inv = await invoice(500);
    const w = await as(a).post(`/invoices/${inv.id}/write-off`, { reason: 'Uncollectable' });
    expect(w.body.status).toBe('WRITTEN_OFF');
    expect(Number(w.body.balanceDue)).toBe(0);
    const u = await as(a).post(`/invoices/${inv.id}/cancel-write-off`);
    expect(Number(u.body.balanceDue)).toBe(590);
  });

  it('runs recurring profiles on schedule', async () => {
    const start = new Date(); start.setDate(start.getDate() - 35);
    const r = await as(a).post('/recurring-invoices', { profileName: 'Monthly AMC', customerId, frequency: 'MONTH', startDate: start.toISOString(), items: [{ description: 'AMC', quantity: 1, rate: 8000, taxRate: 18 }] });
    expect(r.status).toBe(201);
    // Creation runs the first (overdue) occurrence; the scheduler catches up the rest.
    const { runDueRecurringProfiles } = await import('../src/modules/billing.js');
    await runDueRecurringProfiles();
    const detail = await as(a).get(`/recurring-invoices/${r.body.id}`);
    expect(detail.body.invoices.length).toBe(2);
    expect(new Date(detail.body.nextRunDate).getTime()).toBeGreaterThan(Date.now());
    expect((await as(a).post(`/recurring-invoices/${r.body.id}/stop`)).body.ok).toBe(true);
  });

  it('bills unbilled time and expenses onto a draft invoice', async () => {
    const p = await as(a).post('/projects', { name: 'Website build', customerId });
    await as(a).patch(`/projects/${p.body.id}`, { name: 'Website build' });
    await prisma.project.update({ where: { id: p.body.id }, data: { hourlyRate: 1500 } });
    const t1 = await as(a).post('/time-entries', { projectId: p.body.id, date: new Date().toISOString(), minutes: 90, billable: true });
    expect(t1.status).toBe(201);
    const cats = await as(a).get('/expense-categories');
    const e = await as(a).post('/expenses', { date: new Date().toISOString(), categoryId: cats.body[0].id, amount: 1180, taxRate: 18, amountIncludesTax: true, customerId, billable: true });
    expect(Number(e.body.amount)).toBe(1000);
    const un = await as(a).get(`/customers/${customerId}/unbilled`);
    const inv = await as(a).post('/invoices/from-unbilled', { customerId, timeEntryIds: un.body.time.map((x: { id: string }) => x.id), expenseIds: un.body.expenses.map((x: { id: string }) => x.id) });
    expect(inv.status).toBe(201);
    expect(Number(inv.body.taxableTotal)).toBe(2250 + 1000);
    expect((await as(a).get(`/customers/${customerId}/unbilled`)).body.time.length).toBe(0);
  });

  it('prepares and sends an invoice email with the PDF attached', async () => {
    const draft = await as(a).post('/invoices', { customerId, items: [{ description: 'Ads', quantity: 1, rate: 10000, taxRate: 18 }] });
    const d = await as(a).get(`/email/invoice/${draft.body.id}/draft`);
    expect(d.body.to).toEqual(['accounts@bingi.test']);
    expect(d.body.subject).toContain(draft.body.number);
    const sent = await as(a).post(`/email/invoice/${draft.body.id}/send`, { to: d.body.to, cc: d.body.cc, subject: d.body.subject, html: d.body.html + '<script>alert(1)</script>', attachPdf: true, attachStatement: true });
    expect(sent.status).toBe(200);
    expect(sent.body.attachments).toEqual([`${draft.body.number}.pdf`, expect.stringMatching(/^statement-/)]);
    // Sending a draft marks it as sent.
    expect((await as(a).get(`/invoices/${draft.body.id}`)).body.status).toBe('ISSUED');
  });

  it('serves the billing dashboard, reports and GST returns', async () => {
    const home = await as(a).get('/dashboard/billing');
    expect(home.status).toBe(200);
    expect(home.body.monthly).toHaveLength(12);
    expect(home.body.receivables.total).toBeGreaterThan(0);
    const cat = await as(a).get('/reports-center/catalog');
    expect(cat.body.length).toBeGreaterThan(25);
    for (const key of ['sales-by-customer', 'ar-aging-summary', 'payments-received', 'gstr3b-summary', 'refund-history', 'bad-debts']) {
      const rep = await as(a).get(`/reports-center/${key}`);
      expect(rep.status, key).toBe(200);
      expect(rep.body.columns.length, key).toBeGreaterThan(0);
    }
    const csv = await as(a).get('/reports-center/sales-by-customer?format=csv');
    expect(csv.text.split('\n')[0]).toContain('Customer');
    const gst = await as(a).get(`/gst/returns?month=${new Date().toISOString().slice(0, 7)}`);
    expect(gst.body.summary.b2b.count).toBeGreaterThan(0);
    expect(gst.body.gstr1.hsn.length).toBeGreaterThan(0);
    const st = await as(a).get(`/customers/${customerId}/statement`);
    expect(st.body.rows.length).toBeGreaterThan(0);
  });

  it('lets a user create and switch organizations', async () => {
    const r = await request(app).post('/api/v1/auth/organizations').set(H).set('Cookie', a.cookie).send({ name: 'Second Org', gstin: '29AAFCG5678K1Z9' });
    expect(r.status).toBe(201);
    const org = r.body.memberships.find((m: { tenant: { name: string } }) => m.tenant.name === 'Second Org');
    expect(org.tenant.orgCode).toMatch(/^\d{11}$/);
    const d = await request(app).post(`/api/v1/auth/organizations/${org.tenant.id}/default`).set(H).set('Cookie', a.cookie);
    expect(d.body.defaultTenantId).toBe(org.tenant.id);
    // The new org is isolated from the first one.
    const other = await request(app).get('/api/v1/customers').set('Cookie', a.cookie).set('x-tenant-id', org.tenant.id);
    expect(other.body.total).toBe(0);
  });

  it('edits and deletes sent invoices, quotes, payments and credit notes within safe limits', async () => {
    const line = (rate: number) => [{ description: 'Service', quantity: 1, rate, taxRate: 18 }];
    const inv = await invoice(1000); // 1180, sent
    const pay = await as(a).post('/payments', { customerId, amount: 500, paidAt: new Date().toISOString(), method: 'UPI', allocations: [{ invoiceId: inv.id, amount: 500 }] });
    expect(pay.status).toBe(201);

    // A sent invoice can be edited; it keeps its number and payment status.
    const edited = await as(a).patch(`/invoices/${inv.id}`, { customerId, items: line(2000) });
    expect(edited.status).toBe(200);
    expect(edited.body.number).toBe(inv.number);
    expect(Number(edited.body.total)).toBe(2360);
    expect(Number(edited.body.balanceDue)).toBe(1860);
    expect(edited.body.status).toBe('PARTIALLY_PAID');
    // ...but not below what has already been received.
    expect((await as(a).patch(`/invoices/${inv.id}`, { customerId, items: line(100) })).status).toBe(409);
    // It cannot be deleted while a payment is applied.
    expect((await as(a).delete(`/invoices/${inv.id}`)).status).toBe(409);

    // Payment edits cannot drop below the amount already applied.
    const base = { paidAt: new Date().toISOString(), method: 'UPI' };
    expect((await as(a).patch(`/payments/${pay.body.id}`, { ...base, amount: 400 })).status).toBe(409);
    const payEdit = await as(a).patch(`/payments/${pay.body.id}`, { ...base, amount: 700, reference: 'UTR-EDIT' });
    expect(payEdit.status).toBe(200);
    expect(Number(payEdit.body.unusedAmount)).toBe(200);
    expect(payEdit.body.reference).toBe('UTR-EDIT');

    // A sent invoice with nothing applied can be deleted.
    const spare = await invoice(300);
    expect((await as(a).delete(`/invoices/${spare.id}`)).status).toBe(200);
    expect((await as(a).get(`/invoices/${spare.id}`)).status).toBe(404);

    // Credit notes: deleting one restores the invoice balance; invoices with credit notes cannot be deleted.
    const credited = await invoice(1000);
    const cn = await as(a).post('/credit-notes', { invoiceId: credited.id, reason: 'Scope reduced', taxableAmount: 200 });
    expect(cn.status).toBe(201);
    expect(Number((await as(a).get(`/invoices/${credited.id}`)).body.balanceDue)).toBe(944);
    expect((await as(a).delete(`/invoices/${credited.id}`)).status).toBe(409);
    expect((await as(a).delete(`/credit-notes/${cn.body.id}`)).status).toBe(200);
    expect(Number((await as(a).get(`/invoices/${credited.id}`)).body.balanceDue)).toBe(1180);

    // Quotes can be edited after being accepted, but not once converted.
    const q = await as(a).post('/quotations', { customerId, items: line(500) });
    expect(q.status).toBe(201);
    expect((await as(a).post(`/quotations/${q.body.id}/status`, { status: 'ACCEPTED' })).status).toBe(200);
    const qEdit = await as(a).patch(`/quotations/${q.body.id}`, { customerId, items: line(800) });
    expect(qEdit.status).toBe(200);
    expect(Number(qEdit.body.total)).toBe(944);
    expect((await as(a).post(`/quotations/${q.body.id}/convert`)).status).toBe(201);
    expect((await as(a).patch(`/quotations/${q.body.id}`, { customerId, items: line(900) })).status).toBe(409);

    // Expense categories: rename, and in-use ones cannot be deleted.
    const cat = await as(a).post('/expense-categories', { name: 'Temp Cat' });
    expect((await as(a).patch(`/expense-categories/${cat.body.id}`, { name: 'Renamed Cat' })).body.name).toBe('Renamed Cat');
    const exp = await as(a).post('/expenses', { date: new Date().toISOString(), categoryId: cat.body.id, amount: 100 });
    expect(exp.status).toBe(201);
    expect((await as(a).delete(`/expense-categories/${cat.body.id}`)).status).toBe(409);
    expect((await as(a).delete(`/expenses/${exp.body.id}`)).status).toBe(200);
    expect((await as(a).delete(`/expense-categories/${cat.body.id}`)).status).toBe(200);
  });
});
