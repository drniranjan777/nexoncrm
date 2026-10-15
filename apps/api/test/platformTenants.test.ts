import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { testDbConfigured } from './db.js';

// Platform administration of tenants: edit, activate/deactivate and permanent deletion.
const run = testDbConfigured();
const H = { 'x-requested-with': 'nexonweb' };
const PASSWORD = 'Test-Password-123';
let app: Express;
let prisma: typeof import('../src/lib/db.js')['prisma'];

type Agent = { cookie: string; tenantId: string; userId: string };
const as = (ag: Agent) => ({
  get: (url: string) => request(app).get(`/api/v1${url}`).set('Cookie', ag.cookie).set('x-tenant-id', ag.tenantId),
  post: (url: string, body: object = {}) => request(app).post(`/api/v1${url}`).set(H).set('Cookie', ag.cookie).set('x-tenant-id', ag.tenantId).send(body),
  put: (url: string, body: object = {}) => request(app).put(`/api/v1${url}`).set(H).set('Cookie', ag.cookie).set('x-tenant-id', ag.tenantId).send(body),
  patch: (url: string, body: object = {}) => request(app).patch(`/api/v1${url}`).set(H).set('Cookie', ag.cookie).set('x-tenant-id', ag.tenantId).send(body),
  upload: (url: string, buf: Buffer, name: string, type: string) => request(app).post(`/api/v1${url}`).set(H).set('Cookie', ag.cookie).set('x-tenant-id', ag.tenantId).attach('files', buf, { filename: name, contentType: type }),
});
const platform = (admin: Agent) => ({
  patch: (url: string, body: object) => request(app).patch(`/api/v1/platform${url}`).set(H).set('Cookie', admin.cookie).send(body),
  delete: (url: string, body: object) => request(app).delete(`/api/v1/platform${url}`).set(H).set('Cookie', admin.cookie).send(body),
  get: (url: string) => request(app).get(`/api/v1/platform${url}`).set('Cookie', admin.cookie),
});
let n = 0;
async function register(company: string): Promise<Agent> {
  const res = await request(app).post('/api/v1/auth/register').set(H).send({ name: `${company} Owner`, email: `ptn-${Date.now()}-${++n}@test.local`, password: PASSWORD, companyName: company });
  expect(res.status).toBe(201);
  return { cookie: res.headers['set-cookie'][0].split(';')[0], tenantId: res.body.memberships[0].tenant.id, userId: res.body.id };
}
const slugOf = async (id: string) => (await prisma.tenant.findUniqueOrThrow({ where: { id } })).slug;

describe.skipIf(!run)('platform tenant management', () => {
  let admin: Agent;
  let keep: Agent;

  beforeAll(async () => {
    app = (await import('../src/app.js')).createApp();
    prisma = (await import('../src/lib/db.js')).prisma;
    await prisma.plan.upsert({ where: { code: 'starter' }, create: { code: 'starter', name: 'Starter', maxUsers: 20, modules: [] }, update: {} });
    admin = await register('Platform Ops');
    await prisma.user.update({ where: { id: admin.userId }, data: { isSuperAdmin: true } });
    keep = await register('Unrelated Tenant');
    await as(keep).post('/customers', { name: 'Keep me' });
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('edits name, slug and contact details; slugs stay unique', async () => {
    const t = await register('Edit Me Ltd');
    const slug = `edited-${Date.now()}`;
    const r = await platform(admin).patch(`/tenants/${t.tenantId}`, { name: 'Edited Name', slug, legalName: 'Edited Pvt Ltd', email: 'Billing@Edited.test', phone: '+91 90000 00000' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: 'Edited Name', slug, legalName: 'Edited Pvt Ltd', email: 'billing@edited.test', phone: '+91 90000 00000' });
    expect((await platform(admin).patch(`/tenants/${t.tenantId}`, { slug: await slugOf(keep.tenantId) })).status).toBe(400);
    expect((await platform(admin).patch(`/tenants/${t.tenantId}`, { slug: 'Bad Slug!' })).status).toBe(400);
  });

  it('deactivates (blocks the workspace immediately) and reactivates', async () => {
    const t = await register('Toggle Co');
    expect((await as(t).get('/customers')).status).toBe(200);
    expect((await platform(admin).patch(`/tenants/${t.tenantId}`, { status: 'SUSPENDED', reason: 'Unpaid' })).status).toBe(200);
    expect((await as(t).get('/customers')).status).toBe(423);
    expect(await prisma.notification.count({ where: { tenantId: t.tenantId, userId: t.userId, title: 'Workspace suspended' } })).toBe(1);
    expect((await platform(admin).patch(`/tenants/${t.tenantId}`, { status: 'ACTIVE' })).status).toBe(200);
    expect((await as(t).get('/customers')).status).toBe(200);
  });

  it('only deletes a deactivated workspace, after typing its slug', async () => {
    const t = await register('Guarded Co');
    const slug = await slugOf(t.tenantId);
    expect((await platform(admin).delete(`/tenants/${t.tenantId}`, { confirm: slug })).status).toBe(409);
    await platform(admin).patch(`/tenants/${t.tenantId}`, { status: 'SUSPENDED' });
    expect((await platform(admin).delete(`/tenants/${t.tenantId}`, { confirm: 'wrong' })).status).toBe(400);
    // The workspace behind the public feedback form cannot be deleted.
    await prisma.platformSetting.upsert({ where: { key: 'defaultFeedbackTenant' }, create: { key: 'defaultFeedbackTenant', value: slug }, update: { value: slug } });
    expect((await platform(admin).delete(`/tenants/${t.tenantId}`, { confirm: slug })).status).toBe(409);
    await prisma.platformSetting.deleteMany({ where: { key: 'defaultFeedbackTenant' } });
    expect(await prisma.tenant.count({ where: { id: t.tenantId } })).toBe(1);
  });

  it('deletes a workspace with all its business data and files, and nothing else', async () => {
    const t = await register('Doomed Co');
    await as(t).patch('/settings/company', { stateCode: '27', gstin: '27ABCDE1234F1Z5' });
    const customer = (await as(t).post('/customers', { name: 'Big Customer', email: 'big@doomed.test' })).body.id;
    const line = [{ description: 'Work', quantity: 1, rate: 1000, taxRate: 18 }];
    const q = await as(t).post('/quotations', { customerId: customer, items: line });
    const inv = (await as(t).post(`/quotations/${q.body.id}/convert`)).body;
    await as(t).post(`/invoices/${inv.id}/issue`);
    expect((await as(t).post('/payments', { customerId: customer, amount: 500, paidAt: '2026-10-15', method: 'UPI', allocations: [{ invoiceId: inv.id, amount: 500 }] })).status).toBe(201);
    expect((await as(t).post('/credit-notes', { invoiceId: inv.id, reason: 'Discount agreed', taxableAmount: 100 })).status).toBe(201);
    expect((await as(t).post('/proforma-invoices', { customerId: customer, items: line })).status).toBe(201);
    expect((await as(t).post('/projects', { name: 'Site', customerId: customer })).status).toBe(201);
    expect((await as(t).post('/leads', { name: 'A lead' })).status).toBe(201);
    expect((await as(t).post('/tickets', { subject: 'Help', description: 'Broken', customerId: customer })).status).toBe(201);
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    expect((await as(t).upload('/files', png, 'note.png', 'image/png')).status).toBe(201);
    expect((await as(t).put('/settings/email', { host: '203.0.113.10', port: 587, security: 'STARTTLS', fromEmail: 'a@doomed.test' })).status).toBe(200);
    const storageKeys = (await prisma.fileObject.findMany({ where: { tenantId: t.tenantId } })).map((f) => f.storageKey);
    expect(storageKeys.length).toBeGreaterThan(0);

    await platform(admin).patch(`/tenants/${t.tenantId}`, { status: 'CANCELLED' });
    const del = await platform(admin).delete(`/tenants/${t.tenantId}`, { confirm: await slugOf(t.tenantId) });
    expect(del.status).toBe(200);
    expect(del.body.filesRemoved).toBe(storageKeys.length);

    const where = { tenantId: t.tenantId };
    const left = await Promise.all([
      prisma.tenant.count({ where: { id: t.tenantId } }), prisma.customer.count({ where }), prisma.invoice.count({ where }), prisma.payment.count({ where }),
      prisma.creditNote.count({ where }), prisma.quotation.count({ where }), prisma.proformaInvoice.count({ where }), prisma.project.count({ where }),
      prisma.lead.count({ where }), prisma.ticket.count({ where }), prisma.fileObject.count({ where }), prisma.membership.count({ where }), prisma.taxRate.count({ where }),
      prisma.tenantMailServer.count({ where }), prisma.role.count({ where }),
    ]);
    expect(left.every((c) => c === 0)).toBe(true);
    // The owner's account remains (they may belong to other workspaces), and the deletion is audited.
    expect(await prisma.user.count({ where: { id: t.userId } })).toBe(1);
    const log = await prisma.auditLog.findFirst({ where: { action: 'platform.tenant_delete', entityId: t.tenantId } });
    expect(log?.meta).toMatchObject({ name: 'Doomed Co', customers: 1, invoices: 1 });
    // Another workspace is untouched.
    expect((await as(keep).get('/customers')).body.total).toBe(1);
  });

  it('is limited to platform administrators', async () => {
    const t = await register('Not Admin');
    expect((await request(app).patch(`/api/v1/platform/tenants/${t.tenantId}`).set(H).set('Cookie', t.cookie).send({ status: 'SUSPENDED' })).status).toBe(403);
    expect((await request(app).delete(`/api/v1/platform/tenants/${keep.tenantId}`).set(H).set('Cookie', t.cookie).send({ confirm: 'x' })).status).toBe(403);
  });
});
