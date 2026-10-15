import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import { testDbConfigured } from './db.js';

// Multi-currency documents, tenant currency settings, company seal and authorized signature.
const run = testDbConfigured();
const H = { 'x-requested-with': 'nexonweb' };
const PASSWORD = 'Test-Password-123';
let app: Express;
let prisma: typeof import('../src/lib/db.js')['prisma'];

type Agent = { cookie: string; tenantId: string };
const as = (ag: Agent, tenantId = ag.tenantId) => ({
  get: (url: string) => request(app).get(`/api/v1${url}`).set('Cookie', ag.cookie).set('x-tenant-id', tenantId),
  post: (url: string, body: object = {}) => request(app).post(`/api/v1${url}`).set(H).set('Cookie', ag.cookie).set('x-tenant-id', tenantId).send(body),
  put: (url: string, body: object = {}) => request(app).put(`/api/v1${url}`).set(H).set('Cookie', ag.cookie).set('x-tenant-id', tenantId).send(body),
  patch: (url: string, body: object = {}) => request(app).patch(`/api/v1${url}`).set(H).set('Cookie', ag.cookie).set('x-tenant-id', tenantId).send(body),
  delete: (url: string) => request(app).delete(`/api/v1${url}`).set(H).set('Cookie', ag.cookie).set('x-tenant-id', tenantId),
  upload: (url: string, buf: Buffer, name: string, type: string) => request(app).post(`/api/v1${url}`).set(H).set('Cookie', ag.cookie).set('x-tenant-id', tenantId).attach('file', buf, { filename: name, contentType: type }),
});

async function register(company: string): Promise<Agent> {
  const res = await request(app).post('/api/v1/auth/register').set(H).send({ name: `${company} Owner`, email: `${company.replace(/\W/g, '').toLowerCase()}-${Date.now()}@test.local`, password: PASSWORD, companyName: company });
  expect(res.status).toBe(201);
  return { cookie: res.headers['set-cookie'][0].split(';')[0], tenantId: res.body.memberships[0].tenant.id };
}

const line = (rate: number) => [{ description: 'Website development', quantity: 1, rate, taxRate: 18, hsnSac: '998314' }];

describe.skipIf(!run)('Multi-currency, seal and signature', () => {
  let a: Agent;
  let b: Agent;
  let indian: string; // registered Indian customer (GST applies)
  let overseas: string; // export customer (zero rated)

  beforeAll(async () => {
    app = (await import('../src/app.js')).createApp();
    prisma = (await import('../src/lib/db.js')).prisma;
    await prisma.plan.upsert({ where: { code: 'starter' }, create: { code: 'starter', name: 'Starter', maxUsers: 20, modules: [] }, update: {} });
    a = await register('Currency Co A');
    b = await register('Currency Co B');
    await as(a).patch('/settings/company', { stateCode: '27', gstin: '27ABCDE1234F1Z5', legalName: 'Currency Co A Pvt Ltd' });
    indian = (await as(a).post('/customers', { name: 'Pune Retail', gstin: '27AAICB4670Q1Z1', email: 'pune@test.local' })).body.id;
    const o = await as(a).post('/customers', { name: 'Acme Inc', company: 'Acme Inc (USA)', gstTreatment: 'OVERSEAS', currency: 'USD', email: 'ap@acme.test' });
    expect(o.status).toBe(201);
    overseas = o.body.id;
  });

  afterAll(async () => { await prisma?.$disconnect(); });

  it('new tenants get the catalog, INR as base and default', async () => {
    const s = await as(a).get('/settings/currencies');
    expect(s.status).toBe(200);
    expect(s.body.baseCurrency).toBe('INR');
    expect(s.body.defaultCurrency).toBe('INR');
    const codes = s.body.currencies.filter((c: { enabled: boolean }) => c.enabled).map((c: { code: string }) => c.code);
    for (const c of ['INR', 'USD', 'GBP', 'EUR', 'AUD', 'AED', 'CAD', 'SGD']) expect(codes).toContain(c);
    const meta = await as(a).get('/finance/meta');
    expect(meta.body.defaultCurrency).toBe('INR');
    expect(meta.body.currencies.find((c: { code: string }) => c.code === 'AED').symbol).toBe('د.إ');
  });

  it('uses INR by default and keeps per-invoice currencies independent', async () => {
    const inr = await as(a).post('/invoices', { customerId: indian, items: line(50000), issue: true });
    expect(inr.status).toBe(201);
    expect(inr.body.currency).toBe('INR');
    expect(Number(inr.body.exchangeRate)).toBe(1);
    expect(Number(inr.body.total)).toBe(59000);

    // A foreign currency needs a rate the first time.
    expect((await as(a).post('/invoices', { customerId: indian, currency: 'USD', items: line(1000) })).status).toBe(400);
    const usd = await as(a).post('/invoices', { customerId: indian, currency: 'USD', exchangeRate: 83.5, items: line(1000), issue: true });
    expect(usd.status).toBe(201);
    expect(usd.body.currency).toBe('USD');
    // Tax follows the customer (Indian, intra-state), not the currency.
    expect(Number(usd.body.cgstTotal)).toBe(90);
    expect(Number(usd.body.total)).toBe(1180);
    // The rate is remembered for the next USD document.
    const usd2 = await as(a).post('/invoices', { customerId: indian, currency: 'USD', items: line(10) });
    expect(Number(usd2.body.exchangeRate)).toBe(83.5);
    // The INR invoice is untouched.
    expect((await as(a).get(`/invoices/${inr.body.id}`)).body.currency).toBe('INR');
  });

  it('zero-rates exports regardless of currency', async () => {
    const exp = await as(a).post('/invoices', { customerId: overseas, currency: 'USD', exchangeRate: 84, items: line(1000), issue: true });
    expect(exp.status).toBe(201);
    expect(exp.body.placeOfSupply).toBe('96');
    expect(exp.body.isInterState).toBe(true);
    expect(Number(exp.body.igstTotal) + Number(exp.body.cgstTotal)).toBe(0);
    expect(Number(exp.body.total)).toBe(1000);
    const month = new Date().toISOString().slice(0, 7);
    const g = await as(a).get(`/gst/returns?month=${month}`);
    const row = g.body.gstr1.exp.find((r: { number: string }) => r.number === exp.body.number);
    expect(row.taxable).toBe(84000); // reported in INR at the invoice's rate
    expect(g.body.gstr3b.zeroRated.taxable).toBeGreaterThanOrEqual(84000);
    const pdf = await as(a).get(`/invoices/${exp.body.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });

  it('keeps a quote currency when converting it to an invoice', async () => {
    const q = await as(a).post('/quotations', { customerId: overseas, currency: 'GBP', exchangeRate: 105.25, items: line(2000) });
    expect(q.status).toBe(201);
    expect(q.body.currency).toBe('GBP');
    const conv = await as(a).post(`/quotations/${q.body.id}/convert`);
    expect(conv.status).toBe(201);
    expect(conv.body.currency).toBe('GBP');
    expect(Number(conv.body.exchangeRate)).toBe(105.25);
    expect(Number(conv.body.total)).toBe(Number(q.body.total));
  });

  it('converts a draft only on explicit request, with a stated rate', async () => {
    const d = await as(a).post('/invoices', { customerId: indian, items: line(8350) });
    expect(d.body.currency).toBe('INR');
    // Changing currency in an edit never converts amounts.
    const edit = await as(a).patch(`/invoices/${d.body.id}`, { customerId: indian, currency: 'USD', items: line(8350) });
    expect(edit.status).toBe(200);
    expect(Number(edit.body.subtotal)).toBe(8350);
    // Back to INR, then an explicit conversion INR -> USD at 0.012.
    await as(a).patch(`/invoices/${d.body.id}`, { customerId: indian, currency: 'INR', items: line(8350) });
    expect((await as(a).post(`/invoices/${d.body.id}/convert-currency`, { to: 'USD', rate: 0.012 })).status).toBe(400); // needs confirmation
    const c = await as(a).post(`/invoices/${d.body.id}/convert-currency`, { to: 'USD', rate: 0.012, confirm: true });
    expect(c.status).toBe(200);
    expect(c.body.currency).toBe('USD');
    expect(Number(c.body.subtotal)).toBe(100.2);
    expect(Number(c.body.exchangeRate)).toBeCloseTo(83.3333, 3);
  });

  it('changes the default currency without touching existing documents', async () => {
    const before = await as(a).get('/invoices?pageSize=100');
    const snapshot = before.body.items.map((i: { id: string; currency: string; total: string }) => [i.id, i.currency, i.total]);
    expect((await as(a).put('/settings/default-currency', { code: 'EUR' })).status).toBe(200);
    const after = await as(a).get('/invoices?pageSize=100');
    for (const [id, cur, total] of snapshot) {
      const now = after.body.items.find((i: { id: string }) => i.id === id);
      expect(now.currency).toBe(cur);
      expect(now.total).toBe(total);
    }
    const eur = await as(a).post('/invoices', { customerId: indian, exchangeRate: 90.1, items: line(100) });
    expect(eur.body.currency).toBe('EUR');
    // The default and base currencies cannot be switched off.
    expect((await as(a).patch('/settings/currencies/EUR', { enabled: false })).status).toBe(400);
    expect((await as(a).patch('/settings/currencies/INR', { enabled: false })).status).toBe(400);
    await as(a).put('/settings/default-currency', { code: 'INR' });
    // A disabled currency cannot be used on new documents.
    expect((await as(a).patch('/settings/currencies/SGD', { enabled: false })).status).toBe(200);
    expect((await as(a).post('/invoices', { customerId: indian, currency: 'SGD', exchangeRate: 60, items: line(100) })).status).toBe(400);
    expect((await as(a).put('/settings/default-currency', { code: 'SGD' })).status).toBe(400);
  });

  it('records payments in the invoice currency and rejects mixed currencies', async () => {
    const usd = await as(a).post('/invoices', { customerId: indian, currency: 'USD', exchangeRate: 83.5, items: line(500), issue: true });
    const inr = await as(a).post('/invoices', { customerId: indian, items: line(500), issue: true });
    const mixed = await as(a).post('/payments', { customerId: indian, amount: 1000, paidAt: new Date().toISOString(), method: 'BANK_TRANSFER', allocations: [{ invoiceId: usd.body.id, amount: 590 }, { invoiceId: inr.body.id, amount: 100 }] });
    expect(mixed.status).toBe(400);
    const pay = await as(a).post('/payments', { customerId: indian, amount: 590, paidAt: new Date().toISOString(), method: 'BANK_TRANSFER', allocations: [{ invoiceId: usd.body.id, amount: 590 }] });
    expect(pay.status).toBe(201);
    expect(pay.body.currency).toBe('USD');
    expect((await as(a).get(`/invoices/${usd.body.id}`)).body.status).toBe('PAID');
    // Customer receivables are stated in INR.
    const cust = await as(a).get(`/customers/${indian}`);
    expect(typeof cust.body.receivables).toBe('number');
  });

  it('uploads, shows and snapshots the seal and signature', async () => {
    const png = await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 30, g: 60, b: 200, alpha: 0.6 } } }).png().toBuffer();
    const webp = await sharp({ create: { width: 400, height: 120, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).webp().toBuffer();

    // Invalid uploads
    expect((await as(a).upload('/settings/authorization/seal', Buffer.from('not an image'), 'seal.txt', 'text/plain')).status).toBe(400);
    expect((await as(a).upload('/settings/authorization/seal', Buffer.from('fake png bytes'), 'seal.png', 'image/png')).status).toBe(400);
    expect((await as(a).upload('/settings/authorization/seal', Buffer.alloc(2 * 1024 * 1024 + 10, 1), 'big.png', 'image/png')).status).toBe(400);
    expect((await as(a).upload('/settings/authorization/stamp', png, 'x.png', 'image/png')).status).toBe(404);

    expect((await as(a).upload('/settings/authorization/seal', png, 'seal.png', 'image/png')).status).toBe(201);
    expect((await as(a).upload('/settings/authorization/signature', webp, 'sign.webp', 'image/webp')).status).toBe(201);
    const img = await as(a).get('/settings/authorization/signature/image');
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png'); // WebP is converted for PDFs

    const set = await as(a).patch('/settings/authorization', { signatoryName: 'Asha Rao', signatoryDesignation: 'Director', showSealOnQuote: false });
    expect(set.body.signatoryName).toBe('Asha Rao');
    expect(set.body.showSealOnQuote).toBe(false);

    // Issuing freezes the details on the invoice.
    const inv = await as(a).post('/invoices', { customerId: indian, items: line(100), issue: true });
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.body.id } });
    const snap = row.authorization as { signatoryName: string; sealFileId: string | null; signatureFileId: string | null };
    expect(snap.signatoryName).toBe('Asha Rao');
    expect(snap.sealFileId).toBeTruthy();
    expect(snap.signatureFileId).toBeTruthy();
    const pdf = await as(a).get(`/invoices/${inv.body.id}/pdf`);
    expect(pdf.status).toBe(200);

    // The quote hides the seal (per its own toggle).
    const q = await as(a).post('/quotations', { customerId: indian, items: line(100) });
    await as(a).post(`/quotations/${q.body.id}/status`, { status: 'SENT' });
    const qrow = await prisma.quotation.findUniqueOrThrow({ where: { id: q.body.id } });
    expect((qrow.authorization as { sealFileId: string | null }).sealFileId).toBeNull();
    expect((await as(a).get(`/quotations/${q.body.id}/pdf`)).status).toBe(200);

    // Later changes do not alter the issued invoice's snapshot.
    await as(a).patch('/settings/authorization', { signatoryName: 'New Person' });
    await as(a).delete('/settings/authorization/seal');
    const again = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.body.id } });
    expect((again.authorization as { signatoryName: string }).signatoryName).toBe('Asha Rao');
    expect((await as(a).get(`/invoices/${inv.body.id}/pdf`)).status).toBe(200);
    expect((await as(a).get('/settings/authorization/seal/image')).status).toBe(404);

    // Empty optional fields: a PDF still renders with nothing configured.
    await as(a).patch('/settings/authorization', { signatoryName: '', signatoryDesignation: '' });
    await as(a).delete('/settings/authorization/signature');
    const plain = await as(a).post('/invoices', { customerId: indian, items: line(100) });
    expect((await as(a).get(`/invoices/${plain.body.id}/pdf`)).status).toBe(200);
  });

  it('keeps currency settings, seals and signatures inside their tenant', async () => {
    const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 200, g: 0, b: 0 } } }).png().toBuffer();
    await as(a).upload('/settings/authorization/seal', png, 'seal.png', 'image/png');
    const sealId = (await prisma.tenant.findUniqueOrThrow({ where: { id: a.tenantId } })).sealFileId!;
    // B cannot act inside A's workspace.
    expect((await as(b, a.tenantId).get('/settings/authorization')).status).toBe(403);
    expect((await as(b, a.tenantId).put('/settings/default-currency', { code: 'USD' })).status).toBe(403);
    // B sees only its own (empty) settings and cannot fetch A's file through the files API.
    expect((await as(b).get('/settings/authorization/seal/image')).status).toBe(404);
    expect([400, 403, 404]).toContain((await as(b).get(`/files/${sealId}/download`)).status);
    // Even A's members cannot list or download the private seal through the generic files API.
    const files = await as(a).get('/files?pageSize=100');
    expect(files.body.items.some((f: { id: string }) => f.id === sealId)).toBe(false);
    expect([400, 403, 404]).toContain((await as(a).get(`/files/${sealId}/download`)).status);
    // B's default currency is unaffected by A's changes.
    expect((await as(b).get('/settings/currencies')).body.defaultCurrency).toBe('INR');
  });

  it('lets the platform admin extend the catalog', async () => {
    const admin = await prisma.user.create({ data: { email: `root-${Date.now()}@test.local`, name: 'Root', passwordHash: await bcrypt.hash(PASSWORD, 4), isSuperAdmin: true } });
    const login = await request(app).post('/api/v1/auth/login').set(H).send({ email: admin.email, password: PASSWORD });
    expect(login.status).toBe(200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const code = 'JPY';
    // Test database only: reset the test currency from earlier runs.
    await prisma.tenantCurrency.deleteMany({ where: { currencyCode: code } });
    await prisma.currency.deleteMany({ where: { code } });
    const created = await request(app).post('/api/v1/platform/currencies').set(H).set('Cookie', cookie).send({ code, name: 'Japanese Yen', symbol: '¥', decimals: 0 });
    expect(created.status).toBe(201);
    // Tenants can then enable it and bill in it; 0-decimal totals are rounded to whole yen.
    expect((await as(a).patch(`/settings/currencies/${code}`, { enabled: true })).status).toBe(200);
    const yen = await as(a).post('/invoices', { customerId: overseas, currency: code, exchangeRate: 0.56, items: [{ description: 'x', quantity: 3, rate: 333.33, taxRate: 0 }] });
    expect(yen.status).toBe(201);
    expect(Number(yen.body.total) % 1).toBe(0);
    // Tenants cannot use the platform API.
    expect((await request(app).post('/api/v1/platform/currencies').set(H).set('Cookie', a.cookie).send({ code: 'XYZ', name: 'Test', symbol: 'X', decimals: 2 })).status).toBe(403);
  });
});
