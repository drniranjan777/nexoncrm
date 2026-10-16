import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { testDbConfigured } from './db.js';

// Bulk stage change, reassignment and deletion of leads, and larger list pages.
const run = testDbConfigured();
const H = { 'x-requested-with': 'nexonweb' };
const PASSWORD = 'Test-Password-123';
let app: Express;
let prisma: typeof import('../src/lib/db.js')['prisma'];

type Agent = { cookie: string; tenantId: string; userId: string };
const as = (ag: Agent) => ({
  get: (url: string) => request(app).get(`/api/v1${url}`).set('Cookie', ag.cookie).set('x-tenant-id', ag.tenantId),
  post: (url: string, body: object = {}) => request(app).post(`/api/v1${url}`).set(H).set('Cookie', ag.cookie).set('x-tenant-id', ag.tenantId).send(body),
});
let n = 0;
async function register(company: string): Promise<Agent> {
  const res = await request(app).post('/api/v1/auth/register').set(H).send({ name: `${company} Owner`, email: `bulk-${Date.now()}-${++n}@test.local`, password: PASSWORD, companyName: company });
  expect(res.status).toBe(201);
  return { cookie: res.headers['set-cookie'][0].split(';')[0], tenantId: res.body.memberships[0].tenant.id, userId: res.body.id };
}
async function member(owner: Agent, roleKey: string): Promise<Agent> {
  const roles = (await as(owner).get('/roles')).body.roles;
  const inv = await as(owner).post('/invitations', { email: `bulk-${roleKey}-${Date.now()}-${++n}@test.local`, roleId: roles.find((r: { key: string }) => r.key === roleKey).id });
  const token = new URL(inv.body.inviteLink).searchParams.get('token');
  const acc = await request(app).post(`/api/v1/auth/invitations/${token}/accept`).set(H).send({ name: roleKey, password: PASSWORD });
  return { cookie: acc.headers['set-cookie'][0].split(';')[0], tenantId: owner.tenantId, userId: acc.body.id };
}
const csv = (rows: string[]) => ['name,phone,source', ...rows].join('\n');

describe.skipIf(!run)('lead bulk actions', () => {
  let a: Agent;
  let b: Agent;
  const ids = async (ag: Agent, q = '') => (await as(ag).get(`/leads?pageSize=2000&q=${q}`)).body.items.map((l: { id: string }) => l.id) as string[];

  beforeAll(async () => {
    app = (await import('../src/app.js')).createApp();
    prisma = (await import('../src/lib/db.js')).prisma;
    await prisma.plan.upsert({ where: { code: 'starter' }, create: { code: 'starter', name: 'Starter', maxUsers: 20, modules: [] }, update: {} });
    a = await register('Bulk Co A');
    b = await register('Bulk Co B');
    const rows = Array.from({ length: 230 }, (_, i) => `Lead ${String(i + 1).padStart(3, '0')},9${String(100000000 + i)},${i < 30 ? 'Facebook' : 'Google'}`);
    const imp = await as(a).post('/leads/import', { csv: csv(rows) });
    expect(imp.body.created).toBe(230);
    expect((await as(b).post('/leads/import', { csv: csv(['B Lead,9888800001,Google']) })).body.created).toBe(1);
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('lists the newest lead first by default', async () => {
    const fresh = await as(a).post('/leads', { name: 'Just Added Lead' });
    expect(fresh.status).toBe(201);
    const list = await as(a).get('/leads');
    expect(list.body.items[0].id).toBe(fresh.body.id);
    // Leads imported in the same instant still page consistently (no repeats across pages).
    const p1 = (await as(a).get('/leads?pageSize=100&page=1')).body.items.map((l: { id: string }) => l.id);
    const p2 = (await as(a).get('/leads?pageSize=100&page=2')).body.items.map((l: { id: string }) => l.id);
    expect(p1.filter((id: string) => p2.includes(id))).toEqual([]);
    await prisma.lead.delete({ where: { id: fresh.body.id } });
  });

  it('returns pages of 50, 100 and up to 2000 ("All")', async () => {
    for (const size of [50, 100]) {
      const r = await as(a).get(`/leads?pageSize=${size}`);
      expect([r.body.items.length, r.body.pageSize, r.body.pages]).toEqual([size, size, Math.ceil(230 / size)]);
    }
    const all = await as(a).get('/leads?pageSize=2000');
    expect([all.body.items.length, all.body.pages]).toEqual([230, 1]);
    expect((await as(a).get('/leads?pageSize=99999')).body.pageSize).toBe(2000);
  });

  it('changes the stage of selected leads and logs each change', async () => {
    const pick = (await ids(a, 'Lead 00')).slice(0, 3);
    const r = await as(a).post('/leads/bulk', { ids: pick, action: 'stage', stage: 'CONTACTED' });
    expect(r.status).toBe(200);
    expect([r.body.matched, r.body.changed, r.body.skipped.length]).toEqual([3, 3, 0]);
    expect(await prisma.lead.count({ where: { id: { in: pick }, stage: 'CONTACTED' } })).toBe(3);
    expect(await prisma.activity.count({ where: { leadId: { in: pick }, type: 'STAGE_CHANGE' } })).toBe(3);
    // Running it again changes nothing and says why.
    const again = await as(a).post('/leads/bulk', { ids: pick, action: 'stage', stage: 'CONTACTED' });
    expect(again.body.changed).toBe(0);
    expect(again.body.skipped[0].reason).toBe('Already contacted');
  });

  it('needs a reason to mark leads as lost', async () => {
    const pick = (await ids(a, 'Lead 01')).slice(0, 2);
    const noReason = await as(a).post('/leads/bulk', { ids: pick, action: 'stage', stage: 'LOST' });
    expect(noReason.body.changed).toBe(0);
    expect(noReason.body.skipped).toHaveLength(2);
    const withReason = await as(a).post('/leads/bulk', { ids: pick, action: 'stage', stage: 'LOST', lostReason: 'Budget too low' });
    expect(withReason.body.changed).toBe(2);
    expect((await prisma.lead.findFirstOrThrow({ where: { id: pick[0] } })).lostReason).toBe('Budget too low');
  });

  it('applies an action to every lead matching the filters', async () => {
    const r = await as(a).post('/leads/bulk', { filters: { source: 'Facebook' }, action: 'stage', stage: 'QUALIFIED' });
    expect([r.body.matched, r.body.changed]).toEqual([30, 30]);
    expect(await prisma.lead.count({ where: { tenantId: a.tenantId, source: 'Facebook', stage: 'QUALIFIED' } })).toBe(30);
    expect(await prisma.lead.count({ where: { tenantId: a.tenantId, source: 'Google', stage: 'QUALIFIED' } })).toBe(0);
  });

  it('reassigns leads to another member, and rejects outsiders', async () => {
    const sales = await member(a, 'sales');
    const pick = (await ids(a, 'Lead 02')).slice(0, 4);
    const r = await as(a).post('/leads/bulk', { ids: pick, action: 'assign', assignedToId: sales.userId });
    expect(r.body.changed).toBe(4);
    expect((await as(a).post('/leads/bulk', { ids: pick, action: 'assign', assignedToId: b.userId })).status).toBe(400);
    // The sales user sees and can act on only their own leads.
    expect((await ids(sales)).sort()).toEqual([...pick].sort());
    const del = await as(sales).post('/leads/bulk', { filters: {}, action: 'delete' });
    expect(del.body.changed).toBe(4);
    expect(await prisma.lead.count({ where: { tenantId: a.tenantId } })).toBe(226);
  });

  it('deletes selected leads but keeps converted ones', async () => {
    const pick = (await ids(a, 'Lead 03')).slice(0, 3);
    await prisma.customer.create({ data: { tenantId: a.tenantId, code: `CUS-BULK-${Date.now()}`, name: 'Converted' } }).then((c) => prisma.lead.update({ where: { id: pick[0] }, data: { customerId: c.id } }));
    const r = await as(a).post('/leads/bulk', { ids: pick, action: 'delete' });
    expect([r.body.changed, r.body.skipped.length]).toEqual([2, 1]);
    expect(r.body.skipped[0].reason).toBe('Converted to a customer');
    expect(await prisma.lead.count({ where: { id: { in: pick } } })).toBe(1);
  });

  it('cannot touch another organization’s leads and needs edit permission', async () => {
    const theirs = await ids(b);
    const r = await as(a).post('/leads/bulk', { ids: theirs, action: 'delete' });
    expect(r.status).toBe(404);
    expect(await prisma.lead.count({ where: { tenantId: b.tenantId } })).toBe(1);
    const auditor = await member(a, 'auditor');
    expect((await as(auditor).post('/leads/bulk', { ids: (await ids(a)).slice(0, 1), action: 'delete' })).status).toBe(403);
    expect((await as(a).post('/leads/bulk', { ids: [], action: 'delete' })).status).toBe(400);
    expect((await as(a).post('/leads/bulk', { filters: { stage: 'BOGUS' }, action: 'delete' })).status).toBe(400);
  });
});
