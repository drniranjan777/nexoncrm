import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { testDbConfigured } from './db.js';

// Customer CSV import: column aliases, GST rules, duplicates, plan limits and permissions.
const run = testDbConfigured();
const H = { 'x-requested-with': 'nexonweb' };
const PASSWORD = 'Test-Password-123';
let app: Express;
let prisma: typeof import('../src/lib/db.js')['prisma'];

type Agent = { cookie: string; tenantId: string };
const as = (ag: Agent) => ({
  get: (url: string) => request(app).get(`/api/v1${url}`).set('Cookie', ag.cookie).set('x-tenant-id', ag.tenantId),
  post: (url: string, body: object = {}) => request(app).post(`/api/v1${url}`).set(H).set('Cookie', ag.cookie).set('x-tenant-id', ag.tenantId).send(body),
});
let n = 0;
async function register(company: string): Promise<Agent> {
  const res = await request(app).post('/api/v1/auth/register').set(H).send({ name: `${company} Owner`, email: `cimp-${Date.now()}-${++n}@test.local`, password: PASSWORD, companyName: company });
  expect(res.status).toBe(201);
  return { cookie: res.headers['set-cookie'][0].split(';')[0], tenantId: res.body.memberships[0].tenant.id };
}

// Tab-separated, with the column names other billing tools use.
const TSV = [
  'Customer Name\tCompany Name\tEmail ID\tMobile\tGST Number\tBilling Address\tCity\tPincode\tGST Treatment\tPayment Terms\tCustomer Type',
  'Rohit Sharma\tAcme Retail Pvt Ltd\trohit@acme.test\t+91 90000 11111\t27AAACA1234B1Z2\t12 MG Road\tMumbai\t400001\tRegistered Business - Regular\tNet 30\tBusiness',
  '\tGreenleaf Organics\tkavya@greenleaf.test\t9000022222\t\t\tBengaluru\t560001\tUnregistered\tDue on Receipt\t',
  'Arjun Mehta\t\t\t9000033333\t\t\tPune\t\tConsumer\t\tIndividual',
  'Overseas Buyer\tAcme Inc (USA)\tap@acme-us.test\t+1 650 555 0100\t\t\tSan Francisco\t\tOverseas\tNet 45\tBusiness',
  'Dup Email\t\tROHIT@acme.test\t\t\t\t\t\t\t\t',
  'Dup GSTIN\tAcme branch\t\t\t27AAACA1234B1Z2\t\t\t\t\t\t',
  'Dup Phone\t\t\t9000022222\t\t\t\t\t\t\t',
  'Bad GSTIN\t\t\t9000044444\tNOT-A-GSTIN\t\t\t\t\t\t',
  'No GSTIN\tRegistered Co\t\t9000055555\t\t\t\t\tRegistered Business - Regular\t\t',
  'Odd Terms\t\t\t9000066666\t\t\t\t\t\tWhenever\t',
  '',
].join('\r\n');

describe.skipIf(!run)('customer CSV import', () => {
  let a: Agent;
  beforeAll(async () => {
    app = (await import('../src/app.js')).createApp();
    prisma = (await import('../src/lib/db.js')).prisma;
    await prisma.plan.upsert({ where: { code: 'starter' }, create: { code: 'starter', name: 'Starter', maxUsers: 20, modules: [] }, update: {} });
    a = await register('Customer Import Co');
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('imports common column names, applies GST rules and explains skipped rows', async () => {
    const res = await as(a).post('/customers/import', { csv: TSV });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(4);
    expect(res.body.skipped).toEqual([
      { row: 6, reason: 'Duplicate email rohit@acme.test' },
      { row: 7, reason: 'Duplicate GSTIN 27AAACA1234B1Z2' },
      { row: 8, reason: 'Duplicate phone 9000022222' },
      { row: 9, reason: 'gstin: Invalid GSTIN format' },
      { row: 10, reason: 'A GSTIN is required for registered customers' },
      { row: 11, reason: 'Unknown payment terms "Whenever"' },
    ]);
    const list = await prisma.customer.findMany({ where: { tenantId: a.tenantId }, orderBy: { code: 'asc' } });
    const by = Object.fromEntries(list.map((c) => [c.name, c]));
    expect(by['Rohit Sharma']).toMatchObject({
      company: 'Acme Retail Pvt Ltd', email: 'rohit@acme.test', mobile: '+91 90000 11111', gstin: '27AAACA1234B1Z2', stateCode: '27', state: 'Maharashtra',
      pan: 'AAACA1234B', gstTreatment: 'REGISTERED_REGULAR', paymentTerms: 'NET_30', customerType: 'BUSINESS', billingAddress: '12 MG Road', postalCode: '400001',
    });
    // A row without a person's name uses the company name.
    expect(by['Greenleaf Organics']).toMatchObject({ company: 'Greenleaf Organics', gstTreatment: 'UNREGISTERED', paymentTerms: 'DUE_ON_RECEIPT' });
    expect(by['Arjun Mehta']).toMatchObject({ customerType: 'INDIVIDUAL', gstTreatment: 'CONSUMER' });
    // Without a GSTIN, the state name gives the GST state code (it decides CGST+SGST vs IGST).
    expect((await as(a).post('/customers/import', { csv: 'name,state\nState Only,Karnataka\nDelhi Co,New Delhi\nNowhere,Atlantis\n' })).body.created).toBe(3);
    const states = await prisma.customer.findMany({ where: { tenantId: a.tenantId, name: { in: ['State Only', 'Delhi Co', 'Nowhere'] } }, orderBy: { name: 'asc' } });
    expect(states.map((c) => [c.name, c.stateCode])).toEqual([['Delhi Co', '07'], ['Nowhere', null], ['State Only', '29']]);
    expect(by['Overseas Buyer']).toMatchObject({ gstTreatment: 'OVERSEAS', paymentTerms: 'NET_45' });
    // Each gets its own customer code.
    expect(new Set(list.map((c) => c.code)).size).toBe(4);
  });

  it('re-imports its own CSV export without creating duplicates', async () => {
    const exported = await as(a).get('/customers?format=csv');
    expect(exported.status).toBe(200);
    const res = await as(a).post('/customers/import', { csv: exported.text });
    expect(res.body.created).toBe(0);
    expect(res.body.skipped).toHaveLength(7);
  });

  it('stops at the plan’s customer limit', async () => {
    const small = await register('Tiny Plan Co');
    await prisma.plan.upsert({ where: { code: 'tiny-test' }, create: { code: 'tiny-test', name: 'Tiny', maxUsers: 2, maxCustomers: 2, modules: [] }, update: { maxCustomers: 2 } });
    const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'tiny-test' } });
    await prisma.tenant.update({ where: { id: small.tenantId }, data: { planId: plan.id } });
    const res = await as(small).post('/customers/import', { csv: 'name,phone\nOne,9100000001\nTwo,9100000002\nThree,9100000003\n' });
    expect(res.body.created).toBe(2);
    expect(res.body.skipped[0].reason).toMatch(/plan allows 2 customers/);
  });

  it('rejects a file without a name or company column, and needs permission', async () => {
    const res = await as(a).post('/customers/import', { csv: 'email|phone\na@test.local|1\n' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No "name" or "company" column found/);
    const roles = (await as(a).get('/roles')).body.roles;
    const inv = await as(a).post('/invitations', { email: `cimp-dev-${Date.now()}@test.local`, roleId: roles.find((r: { key: string }) => r.key === 'developer').id });
    const token = new URL(inv.body.inviteLink).searchParams.get('token');
    const acc = await request(app).post(`/api/v1/auth/invitations/${token}/accept`).set(H).send({ name: 'Dev', password: PASSWORD });
    const dev = { cookie: acc.headers['set-cookie'][0].split(';')[0], tenantId: a.tenantId };
    expect((await as(dev).post('/customers/import', { csv: 'name\nX\n' })).status).toBe(403);
  });
});
