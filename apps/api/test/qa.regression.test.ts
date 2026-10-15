import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { testDbConfigured } from './db.js';

// Regression tests for defects found in the QA pass. Each block reproduces one confirmed bug.
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
});

let seq = 0;
const email = (tag: string) => `${tag}-${Date.now()}-${++seq}@test.local`;

async function register(company: string): Promise<Agent> {
  const res = await request(app).post('/api/v1/auth/register').set(H).send({ name: `${company} Owner`, email: email('owner'), password: PASSWORD, companyName: company });
  expect(res.status).toBe(201);
  return { cookie: res.headers['set-cookie'][0].split(';')[0], tenantId: res.body.memberships[0].tenant.id };
}

async function join(owner: Agent, roleId: string, customerId?: string): Promise<Agent & { membershipId: string }> {
  const inv = await as(owner).post('/invitations', { email: email('member'), roleId, customerId });
  expect(inv.status).toBe(201);
  const token = new URL(inv.body.inviteLink).searchParams.get('token');
  const acc = await request(app).post(`/api/v1/auth/invitations/${token}/accept`).set(H).send({ name: 'Member', password: PASSWORD });
  expect(acc.status).toBe(200);
  const membershipId = acc.body.memberships.find((m: { tenant: { id: string } }) => m.tenant.id === owner.tenantId).id;
  return { cookie: acc.headers['set-cookie'][0].split(';')[0], tenantId: owner.tenantId, membershipId };
}

describe.skipIf(!run)('QA regressions', () => {
  let a: Agent;
  let b: Agent;
  let roles: { id: string; key: string }[];
  let customer: string;

  beforeAll(async () => {
    app = (await import('../src/app.js')).createApp();
    prisma = (await import('../src/lib/db.js')).prisma;
    await prisma.plan.upsert({ where: { code: 'starter' }, create: { code: 'starter', name: 'Starter', maxUsers: 20, modules: [] }, update: {} });
    a = await register('QA Co A');
    b = await register('QA Co B');
    await as(a).patch('/settings/company', { stateCode: '27', gstin: '27ABCDE1234F1Z5' });
    roles = (await as(a).get('/roles')).body.roles;
    customer = (await as(a).post('/customers', { name: 'QA Customer', gstin: '27AAICB4670Q1Z1', email: 'qa-customer@test.local' })).body.id;
  });
  afterAll(async () => { await prisma?.$disconnect(); });
  const role = (key: string) => roles.find((r) => r.key === key)!.id;

  describe('privilege escalation through invitations and member updates', () => {
    let hr: Agent;
    beforeAll(async () => {
      // A people-manager role: may manage users but holds few business permissions.
      const custom = await as(a).post('/roles', { name: 'People manager', permissions: ['users.manage', 'dashboard.read'] });
      expect(custom.status).toBe(201);
      roles = (await as(a).get('/roles')).body.roles;
      hr = await join(a, custom.body.id);
    });

    it('cannot invite someone into a role with permissions it does not hold', async () => {
      const res = await as(hr).post('/invitations', { email: email('accomplice'), roleId: role('admin') });
      expect(res.status).toBe(403);
    });

    it('cannot promote an existing member to such a role', async () => {
      const dev = await join(a, role('developer'));
      expect((await as(hr).patch(`/members/${dev.membershipId}`, { roleId: role('admin') })).status).toBe(403);
    });

    it('cannot change members whose role holds more permissions than it does', async () => {
      const acct = await join(a, role('accountant'));
      expect((await as(hr).patch(`/members/${acct.membershipId}`, { status: 'DISABLED' })).status).toBe(403);
    });

    it('may still invite into roles within its own permissions', async () => {
      const own = roles.find((r) => r.key.startsWith('custom_'))!;
      expect((await as(hr).post('/invitations', { email: email('peer'), roleId: own.id })).status).toBe(201);
    });

    it('admins keep managing ordinary members', async () => {
      const dev = await join(a, role('developer'));
      expect((await as(a).patch(`/members/${dev.membershipId}`, { roleId: role('sales') })).status).toBe(200);
    });
  });

  describe('customer portal users', () => {
    let portal: Agent;
    beforeAll(async () => { portal = await join(a, role('customer'), customer); });

    it('cannot read the staff directory or internal company settings', async () => {
      for (const url of ['/members/options', '/settings/company', '/settings/preferences', '/finance/meta']) {
        expect([url, (await as(portal).get(url)).status]).toEqual([url, 403]);
      }
    });

    it('still reach their portal and the help centre', async () => {
      expect((await as(portal).get('/portal/overview')).status).toBe(200);
      expect((await as(portal).get('/kb')).status).toBe(200);
      expect((await as(portal).get('/context')).status).toBe(200);
    });
  });

  describe('expenses', () => {
    it('rejects another tenant’s category when editing', async () => {
      const foreign = await as(b).post('/expense-categories', { name: 'B secret category' });
      expect(foreign.status).toBe(201);
      const e = await as(a).post('/expenses', { date: '2026-10-01', amount: 1000, taxRate: 18 });
      expect(e.status).toBe(201);
      expect((await as(a).patch(`/expenses/${e.body.id}`, { categoryId: foreign.body.id })).status).toBe(400);
    });

    it('recomputes tax and total when only the tax rate changes', async () => {
      const e = await as(a).post('/expenses', { date: '2026-10-01', amount: 1000, taxRate: 18 });
      expect(Number(e.body.total)).toBe(1180);
      const u = await as(a).patch(`/expenses/${e.body.id}`, { taxRate: 5 });
      expect(u.status).toBe(200);
      expect([Number(u.body.amount), Number(u.body.taxAmount), Number(u.body.total)]).toEqual([1000, 50, 1050]);
    });
  });

  describe('date filters', () => {
    it('includes documents created later on the "to" day', async () => {
      const q = await as(a).post('/quotations', { customerId: customer, items: [{ description: 'Same-day', quantity: 1, rate: 100, taxRate: 18 }] });
      const inv = await as(a).post(`/quotations/${q.body.id}/convert`);
      expect(inv.status).toBe(201);
      const day = new Date(inv.body.issueDate).toISOString().slice(0, 10);
      const list = await as(a).get(`/invoices?from=${day}&to=${day}&pageSize=200`);
      expect(list.body.items.map((i: { id: string }) => i.id)).toContain(inv.body.id);
    });

    it('rejects an invalid date with a 400 instead of a server error', async () => {
      expect((await as(a).get('/invoices?from=not-a-date')).status).toBe(400);
      expect((await as(a).get(`/customers/${customer}/statement?to=garbage`)).status).toBe(400);
    });
  });

  describe('payments', () => {
    it('cannot overpay an invoice with concurrent payments', async () => {
      const inv = await as(a).post('/invoices', { customerId: customer, issue: true, items: [{ description: 'Concurrent', quantity: 1, rate: 1000, taxRate: 0 }] });
      expect(inv.status).toBe(201);
      const pay = () => as(a).post('/payments', { customerId: customer, amount: 1000, paidAt: '2026-10-15', method: 'UPI', allocations: [{ invoiceId: inv.body.id, amount: 1000 }] });
      const results = await Promise.all([pay(), pay(), pay()]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      const after = await as(a).get(`/invoices/${inv.body.id}`);
      expect(Number(after.body.amountPaid)).toBe(1000);
      expect(after.body.status).toBe('PAID');
    });
  });

  describe('amount limits', () => {
    it('rejects totals beyond what can be stored, with a clear message', async () => {
      const res = await as(a).post('/invoices', { customerId: customer, items: [{ description: 'Huge', quantity: 1_000_000, rate: 999_999_999, taxRate: 18 }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/too large/i);
    });
  });

  describe('document email failures', () => {
    let quoteId: string;
    beforeAll(async () => {
      quoteId = (await as(a).post('/quotations', { customerId: customer, items: [{ description: 'Mail test', quantity: 1, rate: 100, taxRate: 18 }] })).body.id;
    });

    it('rejects invalid recipient addresses', async () => {
      const res = await as(a).post(`/email/quote/${quoteId}/send`, { to: ['not-an-email'], subject: 'S', html: '<p>x</p>' });
      expect(res.status).toBe(400);
      expect(await prisma.emailLog.count({ where: { entityId: quoteId } })).toBe(0);
    });

    it('records FAILED (not sent) when the mail server cannot be reached', async () => {
      const { config } = await import('../src/lib/config.js');
      const saved = { ...config.smtp };
      // Nothing listens on port 1 locally: the connection is refused.
      Object.assign(config.smtp, { host: '127.0.0.1', port: 1, user: '', pass: '' });
      try {
        const res = await as(a).post(`/email/quote/${quoteId}/send`, { to: ['client@test.local'], subject: 'S', html: '<p>x</p>' });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('QUEUED');
        let log = await prisma.emailLog.findUniqueOrThrow({ where: { id: res.body.emailLogId } });
        for (let i = 0; i < 100 && log.status === 'QUEUED'; i++) {
          await new Promise((r) => setTimeout(r, 100));
          log = await prisma.emailLog.findUniqueOrThrow({ where: { id: res.body.emailLogId } });
        }
        expect(log.status).toBe('FAILED');
        expect(log.error).toBeTruthy();
        expect(log.sentAt).toBeNull();
      } finally {
        Object.assign(config.smtp, saved);
      }
    });
  });

  describe('global search', () => {
    it('finds proforma invoices by number', async () => {
      const p = await as(a).post('/proforma-invoices', { customerId: customer, items: [{ description: 'Searchable', quantity: 1, rate: 100, taxRate: 18 }] });
      expect(p.status).toBe(201);
      const r = await as(a).get(`/search?q=${p.body.number}`);
      expect(r.body.map((x: { id: string }) => x.id)).toContain(p.body.id);
    });
  });
});
