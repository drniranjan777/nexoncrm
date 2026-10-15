import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { testDbConfigured } from './db.js';

// These tests exercise the real HTTP API against the dedicated test database.
const run = testDbConfigured();

type Agent = { cookie: string; tenantId: string; userId: string };
let app: Express;
let prisma: typeof import('../src/lib/db.js')['prisma'];

const PASSWORD = 'Test-Password-123';
const H = { 'x-requested-with': 'nexonweb' };

async function register(company: string, email: string): Promise<Agent> {
  const res = await request(app).post('/api/v1/auth/register').set(H).send({ name: `${company} Owner`, email, password: PASSWORD, companyName: company });
  expect(res.status).toBe(201);
  return { cookie: res.headers['set-cookie'][0].split(';')[0], tenantId: res.body.memberships[0].tenant.id, userId: res.body.id };
}

const as = (a: Agent, tenantId = a.tenantId) => ({
  get: (url: string) => request(app).get(`/api/v1${url}`).set('Cookie', a.cookie).set('x-tenant-id', tenantId),
  post: (url: string, body: object = {}) => request(app).post(`/api/v1${url}`).set(H).set('Cookie', a.cookie).set('x-tenant-id', tenantId).send(body),
  patch: (url: string, body: object = {}) => request(app).patch(`/api/v1${url}`).set(H).set('Cookie', a.cookie).set('x-tenant-id', tenantId).send(body),
  delete: (url: string) => request(app).delete(`/api/v1${url}`).set(H).set('Cookie', a.cookie).set('x-tenant-id', tenantId),
});

/** Adds a user to the tenant with a given system role and returns a logged-in agent. */
async function member(owner: Agent, roleKey: string, email: string, customerId?: string): Promise<Agent> {
  const roles = await as(owner).get('/roles');
  const role = roles.body.roles.find((r: { key: string }) => r.key === roleKey);
  const inv = await as(owner).post('/invitations', { email, roleId: role.id, customerId });
  expect(inv.status).toBe(201);
  const token = new URL(inv.body.inviteLink).searchParams.get('token');
  const acc = await request(app).post(`/api/v1/auth/invitations/${token}/accept`).set(H).send({ name: roleKey, password: PASSWORD });
  expect(acc.status).toBe(200);
  return { cookie: acc.headers['set-cookie'][0].split(';')[0], tenantId: owner.tenantId, userId: acc.body.id };
}

describe.skipIf(!run)('API integration', () => {
  let a: Agent;
  let b: Agent;
  let customerA: string;

  beforeAll(async () => {
    const mod = await import('../src/app.js');
    app = mod.createApp();
    prisma = (await import('../src/lib/db.js')).prisma;
    await prisma.plan.upsert({ where: { code: 'starter' }, create: { code: 'starter', name: 'Starter', maxUsers: 20, modules: [] }, update: {} });
    a = await register('Tenant A', `a-${Date.now()}@test.local`);
    b = await register('Tenant B', `b-${Date.now()}@test.local`);
    await as(a).patch('/settings/company', { stateCode: '27', gstin: '27ABCDE1234F1Z5', legalName: 'Tenant A Pvt Ltd' });
    const c = await as(a).post('/customers', { name: 'Alpha Customer', email: 'alpha@cust.in', stateCode: '29' });
    expect(c.status).toBe(201);
    customerA = c.body.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  describe('authentication', () => {
    it('rejects unauthenticated tenant requests', async () => {
      const res = await request(app).get('/api/v1/customers').set('x-tenant-id', a.tenantId);
      expect(res.status).toBe(401);
    });
    it('rejects mutations without the CSRF header', async () => {
      const res = await request(app).post('/api/v1/customers').set('Cookie', a.cookie).set('x-tenant-id', a.tenantId).send({ name: 'x' });
      expect(res.status).toBe(403);
    });
    it('rejects a wrong password', async () => {
      const res = await request(app).post('/api/v1/auth/login').set(H).send({ email: 'nobody@test.local', password: 'wrong' });
      expect(res.status).toBe(401);
    });
  });

  describe('tenant isolation', () => {
    it('denies selecting a workspace the user is not a member of', async () => {
      const res = await as(b, a.tenantId).get('/customers');
      expect(res.status).toBe(403);
    });
    it('hides another tenant\'s record by id', async () => {
      expect((await as(b).get(`/customers/${customerA}`)).status).toBe(404);
      expect((await as(b).patch(`/customers/${customerA}`, { name: 'hacked' })).status).toBe(404);
      expect((await as(b).delete(`/customers/${customerA}`)).status).toBe(404);
      const still = await as(a).get(`/customers/${customerA}`);
      expect(still.body.name).toBe('Alpha Customer');
    });
    it('excludes other tenants from list and search results', async () => {
      const list = await as(b).get('/customers?q=Alpha');
      expect(list.body.total).toBe(0);
      const search = await as(b).get('/search?q=Alpha');
      expect(search.body).toEqual([]);
    });
    it('rejects cross-tenant foreign keys on create', async () => {
      const res = await as(b).post('/projects', { name: 'Sneaky', customerId: customerA });
      expect(res.status).toBe(400);
      const inv = await as(b).post('/invoices', { customerId: customerA, items: [{ description: 'x', quantity: 1, rate: 1, taxRate: 18 }] });
      expect(inv.status).toBe(400);
    });
    it('rejects assigning work to a user from another tenant', async () => {
      const res = await as(b).post('/tasks', { title: 'x', assigneeId: a.userId });
      expect(res.status).toBe(400);
    });
  });

  describe('role-based access control', () => {
    it('keeps developers out of commercial data and shows only assigned projects', async () => {
      const dev = await member(a, 'developer', `dev-${Date.now()}@test.local`);
      expect((await as(dev).get('/invoices')).status).toBe(403);
      expect((await as(dev).get('/leads')).status).toBe(403);
      expect((await as(dev).get('/customers')).status).toBe(403);
      const p1 = await as(a).post('/projects', { name: 'Assigned', customerId: customerA, budget: 100000 });
      await as(a).post('/projects', { name: 'Not assigned', customerId: customerA });
      await as(a).post(`/projects/${p1.body.id}/members`, { userId: dev.userId });
      const list = await as(dev).get('/projects');
      expect(list.status).toBe(200);
      expect(list.body.items.map((p: { name: string }) => p.name)).toEqual(['Assigned']);
      expect(list.body.items[0].budget).toBeNull();
    });
    it('prevents sales executives from issuing invoices', async () => {
      const sales = await member(a, 'sales', `sales-${Date.now()}@test.local`);
      const draft = await as(a).post('/invoices', { customerId: customerA, items: [{ description: 'Work', quantity: 1, rate: 1000, taxRate: 18 }] });
      expect((await as(sales).post(`/invoices/${draft.body.id}/issue`)).status).toBe(403);
    });
    it('prevents privilege escalation through custom roles', async () => {
      const crm = await member(a, 'crm_manager', `crm-${Date.now()}@test.local`);
      // crm_manager lacks users.manage entirely
      expect((await as(crm).post('/roles', { name: 'Evil', permissions: ['users.manage'] })).status).toBe(403);
    });
    it('limits portal customers to their own records', async () => {
      const other = await as(a).post('/customers', { name: 'Other Customer' });
      await as(a).post('/projects', { name: 'Other project', customerId: other.body.id });
      const client = await member(a, 'customer', `client-${Date.now()}@test.local`, customerA);
      expect((await as(client).get('/customers')).status).toBe(403);
      const overview = await as(client).get('/portal/overview');
      expect(overview.status).toBe(200);
      expect(overview.body.customer.id).toBe(customerA);
      expect(overview.body.projects.every((p: { name: string }) => p.name !== 'Other project')).toBe(true);
    });
  });

  describe('finance flow', () => {
    it('issues a GST invoice, records payments and credit notes, and keeps balances consistent', async () => {
      // Tenant in 27 (Maharashtra), customer in 29 (Karnataka) => IGST
      const draft = await as(a).post('/invoices', { customerId: customerA, items: [{ description: 'Website', quantity: 1, rate: 100000, taxRate: 18 }] });
      expect(draft.status).toBe(201);
      expect(draft.body.isInterState).toBe(true);
      expect(Number(draft.body.igstTotal)).toBe(18000);
      // Invoices are numbered when created (drafts included) and keep that number when issued.
      expect(draft.body.number).toMatch(/^INV-\d{4}$/);

      const issued = await as(a).post(`/invoices/${draft.body.id}/issue`);
      expect(issued.status).toBe(200);
      expect(issued.body.number).toBe(draft.body.number);

      const overpay = await as(a).post('/payments', { invoiceId: draft.body.id, amount: 200000, paidAt: new Date().toISOString(), method: 'UPI' });
      expect(overpay.status).toBe(400);
      const pay = await as(a).post('/payments', { invoiceId: draft.body.id, amount: 50000, paidAt: new Date().toISOString(), method: 'UPI' });
      expect(pay.status).toBe(201);

      const cn = await as(a).post('/credit-notes', { invoiceId: draft.body.id, reason: 'Scope reduced', taxableAmount: 10000 });
      expect(cn.status).toBe(201);
      expect(Number(cn.body.igstTotal)).toBe(1800);
      // Sent invoices can be edited, but not while a credit note is issued against them.
      expect((await as(a).patch(`/invoices/${draft.body.id}`, { customerId: customerA, items: [{ description: 'x', quantity: 1, rate: 1, taxRate: 18 }] })).status).toBe(409);

      const inv = await as(a).get(`/invoices/${draft.body.id}`);
      expect(inv.body.status).toBe('PARTIALLY_PAID');
      expect(Number(inv.body.balanceDue)).toBe(118000 - 50000 - 11800);
      expect((await as(a).post(`/invoices/${draft.body.id}/cancel`, { reason: 'test cancel' })).status).toBe(409);

      const pdf = await as(a).get(`/invoices/${draft.body.id}/pdf`);
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
    });

    it('converts a quotation into a draft invoice exactly once', async () => {
      const q = await as(a).post('/quotations', { customerId: customerA, items: [{ description: 'SEO', quantity: 2, rate: 20000, taxRate: 18 }] });
      expect(q.status).toBe(201);
      const conv = await as(a).post(`/quotations/${q.body.id}/convert`);
      expect(conv.status).toBe(201);
      expect(Number(conv.body.total)).toBe(Number(q.body.total));
      expect((await as(a).post(`/quotations/${q.body.id}/convert`)).status).toBe(409);
    });
  });

  describe('CRM', () => {
    it('scores leads, creates follow-up tasks and converts without duplicating customers', async () => {
      const lead = await as(a).post('/leads', { name: 'Lead One', email: 'alpha@cust.in', serviceInterest: 'SEO and Digital Marketing', estimatedValue: 250000 });
      expect(lead.status).toBe(201);
      expect(lead.body.score).toBeGreaterThan(0);
      expect(lead.body.scoreDetails.model).toBe('heuristic-v1');
      const tasks = await as(a).get(`/tasks?type=FOLLOW_UP`);
      expect(tasks.body.items.some((t: { title: string }) => t.title.includes('Lead One'))).toBe(true);
      const conv = await as(a).post(`/leads/${lead.body.id}/convert`, { createProject: true });
      expect(conv.status).toBe(200);
      expect(conv.body.reused).toBe(true);
      expect(conv.body.customer.id).toBe(customerA);
      expect((await as(a).post(`/leads/${lead.body.id}/convert`, {})).status).toBe(409);
    });
  });

  describe('public feedback portal', () => {
    it('accepts a submission, then tracks it only with the secret token', async () => {
      const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: a.tenantId } });
      const res = await request(app).post('/api/v1/public/feedback').send({
        tenant: tenant.slug, name: 'Happy Client', email: 'happy@client.in', serviceCategory: 'eCommerce', ratingOverall: 2,
        serviceAnswers: { checkout: 2, payments: 'No' }, urgentIssues: 'Payments failing at checkout', consent: true,
      });
      expect(res.status).toBe(201);
      expect(res.body.referenceNo).toMatch(/^FB-/);
      const wrong = await request(app).get(`/api/v1/public/feedback/track?ref=${res.body.referenceNo}&t=wrong-token-123456`);
      expect(wrong.status).toBe(404);
      const ok = await request(app).get(`/api/v1/public/feedback/track?ref=${res.body.referenceNo}&t=${res.body.trackingToken}`);
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('NEW');
      // Tracking must not expose internal fields
      expect(ok.body.email).toBeUndefined();

      const internal = await as(a).get(`/feedback?q=${res.body.referenceNo}`);
      expect(internal.body.items[0].isUrgent).toBe(true);
      expect(internal.body.items[0].sentiment).toBe('negative');
      expect((await as(b).get(`/feedback/${internal.body.items[0].id}`)).status).toBe(404);
    });
    it('rejects honeypot spam', async () => {
      const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: a.tenantId } });
      const res = await request(app).post('/api/v1/public/feedback').send({ tenant: tenant.slug, website: 'spam', name: 'Bot', email: 'b@b.in', serviceCategory: 'Other', ratingOverall: 5, consent: true });
      expect(res.status).toBe(400);
    });
  });

  describe('platform administration', () => {
    it('is restricted to super admins', async () => {
      const res = await request(app).get('/api/v1/platform/tenants').set('Cookie', a.cookie);
      expect(res.status).toBe(403);
    });
  });
});
