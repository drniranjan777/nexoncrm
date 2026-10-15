import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { testDbConfigured } from './db.js';
import { decryptSecret, encryptSecret } from '../src/lib/secrets.js';

describe('stored secret encryption', () => {
  it('round-trips and never stores the plain value', () => {
    const enc = encryptSecret('s3cret-smtp-pass');
    expect(enc).not.toContain('s3cret');
    expect(decryptSecret(enc)).toBe('s3cret-smtp-pass');
    expect(encryptSecret('same')).not.toBe(encryptSecret('same')); // random IV
  });
  it('returns null for tampered values', () => {
    const [v, iv, tag, data] = encryptSecret('value').split(':');
    expect(decryptSecret([v, iv, tag, data.slice(0, -2) + (data.endsWith('A') ? 'BB' : 'AA')].join(':'))).toBeNull();
    expect(decryptSecret('garbage')).toBeNull();
  });
});

// Outgoing mail server settings for organizations and the platform default.
const run = testDbConfigured();
const H = { 'x-requested-with': 'nexonweb' };
const PASSWORD = 'Test-Password-123';
let app: Express;
let prisma: typeof import('../src/lib/db.js')['prisma'];

type Agent = { cookie: string; tenantId: string; userId: string };
const as = (ag: Agent) => ({
  get: (url: string) => request(app).get(`/api/v1${url}`).set('Cookie', ag.cookie).set('x-tenant-id', ag.tenantId),
  put: (url: string, body: object = {}) => request(app).put(`/api/v1${url}`).set(H).set('Cookie', ag.cookie).set('x-tenant-id', ag.tenantId).send(body),
  post: (url: string, body: object = {}) => request(app).post(`/api/v1${url}`).set(H).set('Cookie', ag.cookie).set('x-tenant-id', ag.tenantId).send(body),
  delete: (url: string) => request(app).delete(`/api/v1${url}`).set(H).set('Cookie', ag.cookie).set('x-tenant-id', ag.tenantId),
});
let n = 0;
async function register(company: string): Promise<Agent> {
  const res = await request(app).post('/api/v1/auth/register').set(H).send({ name: `${company} Owner`, email: `mail-${Date.now()}-${++n}@test.local`, password: PASSWORD, companyName: company });
  expect(res.status).toBe(201);
  return { cookie: res.headers['set-cookie'][0].split(';')[0], tenantId: res.body.memberships[0].tenant.id, userId: res.body.id };
}

// A public documentation address (TEST-NET-3): accepted as a public host, never contacted by these tests.
const server = { host: '203.0.113.10', port: 587, security: 'STARTTLS', username: 'mailer@acme.test', password: 'smtp-pass-123', fromEmail: 'billing@acme.test', fromName: 'Acme Billing' };

describe.skipIf(!run)('mail server settings', () => {
  let a: Agent;
  let b: Agent;
  let admin: Agent;

  beforeAll(async () => {
    app = (await import('../src/app.js')).createApp();
    prisma = (await import('../src/lib/db.js')).prisma;
    await prisma.plan.upsert({ where: { code: 'starter' }, create: { code: 'starter', name: 'Starter', maxUsers: 20, modules: [] }, update: {} });
    await prisma.platformSetting.deleteMany({ where: { key: 'smtp' } });
    a = await register('Mail Co A');
    b = await register('Mail Co B');
    admin = await register('Mail Platform');
    await prisma.user.update({ where: { id: admin.userId }, data: { isSuperAdmin: true } });
  });
  afterAll(async () => {
    await prisma?.platformSetting.deleteMany({ where: { key: 'smtp' } });
    await prisma?.$disconnect();
  });

  it('starts with no server: emails are logged, not sent', async () => {
    const r = await as(a).get('/settings/email');
    expect(r.status).toBe(200);
    expect(r.body.own).toBeNull();
    expect(r.body.effective.source).toBe('none');
  });

  it('rejects servers on private or local addresses', async () => {
    for (const host of ['127.0.0.1', '10.0.0.5', '192.168.1.10', '169.254.169.254', 'localhost']) {
      const r = await as(a).put('/settings/email', { ...server, host });
      expect([host, r.status]).toEqual([host, 400]);
    }
  });

  it('saves the organization server with an encrypted, write-only password', async () => {
    const r = await as(a).put('/settings/email', server);
    expect(r.status).toBe(200);
    expect(r.body.own).toMatchObject({ host: '203.0.113.10', port: 587, security: 'STARTTLS', fromEmail: 'billing@acme.test', hasPassword: true, passwordReadable: true });
    expect(JSON.stringify(r.body)).not.toContain('smtp-pass-123');
    expect(r.body.effective.source).toBe('tenant');
    const row = await prisma.tenantMailServer.findUniqueOrThrow({ where: { tenantId: a.tenantId } });
    expect(row.passwordEnc).not.toContain('smtp-pass-123');
    expect(decryptSecret(row.passwordEnc)).toBe('smtp-pass-123');
    // Document emails now report that SMTP is configured for this organization only.
    expect((await as(a).get('/settings/integrations')).body.find((i: { key: string }) => i.key === 'email').connected).toBe(true);
    expect((await as(b).get('/settings/integrations')).body.find((i: { key: string }) => i.key === 'email').connected).toBe(false);
  });

  it('keeps the saved password when it is left blank, and removes it on request', async () => {
    await as(a).put('/settings/email', { ...server, password: '', fromName: 'Renamed' });
    let row = await prisma.tenantMailServer.findUniqueOrThrow({ where: { tenantId: a.tenantId } });
    expect(decryptSecret(row.passwordEnc)).toBe('smtp-pass-123');
    expect(row.fromName).toBe('Renamed');
    await as(a).put('/settings/email', { ...server, password: undefined, clearPassword: true });
    row = await prisma.tenantMailServer.findUniqueOrThrow({ where: { tenantId: a.tenantId } });
    expect(row.passwordEnc).toBeNull();
  });

  it('validates input', async () => {
    expect((await as(a).put('/settings/email', { ...server, port: 70000 })).status).toBe(400);
    expect((await as(a).put('/settings/email', { ...server, fromEmail: 'nope' })).status).toBe(400);
    expect((await as(a).put('/settings/email', { ...server, security: 'SSL3' })).status).toBe(400);
    expect((await as(a).post('/settings/email/test', { to: 'bad' })).status).toBe(400);
  });

  it('keeps organizations isolated and needs settings permission', async () => {
    expect((await as(b).get('/settings/email')).body.own).toBeNull();
    const roles = (await as(a).get('/roles')).body.roles;
    const inv = await as(a).post('/invitations', { email: `sales-${Date.now()}@test.local`, roleId: roles.find((r: { key: string }) => r.key === 'sales').id });
    // With its own server configured, organization A no longer shows invite links (emails are sent instead).
    expect(inv.status).toBe(201);
    expect(inv.body.inviteLink).toBeUndefined();
    const inv2 = await as(b).post('/invitations', { email: `sales-${Date.now()}@test.local`, roleId: (await as(b).get('/roles')).body.roles.find((r: { key: string }) => r.key === 'sales').id });
    const t2 = new URL(inv2.body.inviteLink).searchParams.get('token');
    const acc = await request(app).post(`/api/v1/auth/invitations/${t2}/accept`).set(H).send({ name: 'Sales', password: PASSWORD });
    const sales = { cookie: acc.headers['set-cookie'][0].split(';')[0], tenantId: b.tenantId, userId: acc.body.id };
    expect((await as(sales).get('/settings/email')).status).toBe(403);
    expect((await as(sales).put('/settings/email', server)).status).toBe(403);
  });

  it('only platform administrators manage the platform default, which other organizations then use', async () => {
    expect((await request(app).get('/api/v1/platform/email').set('Cookie', a.cookie)).status).toBe(403);
    const put = await request(app).put('/api/v1/platform/email').set(H).set('Cookie', admin.cookie).send({ ...server, host: 'smtp.platform.test', fromEmail: 'no-reply@platform.test' });
    expect(put.status).toBe(200);
    expect(put.body.server.hasPassword).toBe(true);
    expect(JSON.stringify(put.body)).not.toContain('smtp-pass-123');
    // B has no server of its own: the platform default applies. A keeps its own.
    expect((await as(b).get('/settings/email')).body.effective).toMatchObject({ source: 'platform', host: 'smtp.platform.test' });
    expect((await as(a).get('/settings/email')).body.effective.source).toBe('tenant');
    // Turning A's server off, or removing it, falls back to the platform default.
    await as(a).put('/settings/email', { ...server, enabled: false });
    expect((await as(a).get('/settings/email')).body.effective.source).toBe('platform');
    const del = await as(a).delete('/settings/email');
    expect(del.body.own).toBeNull();
    expect(del.body.effective.source).toBe('platform');
    expect((await request(app).delete('/api/v1/platform/email').set(H).set('Cookie', admin.cookie)).status).toBe(200);
    expect((await as(b).get('/settings/email')).body.effective.source).toBe('none');
  });
});
