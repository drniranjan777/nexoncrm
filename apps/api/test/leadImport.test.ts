import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { parseAmount, parseCsv } from '../src/lib/list.js';
import { testDbConfigured } from './db.js';

describe('parseCsv', () => {
  it('reads tab-separated files (spreadsheet exports)', () => {
    const rows = parseCsv('name\tcompany\tphone\tvalue\r\nAsha Rao\tAcme\t98765 43210\t"? 35,000.00"\r\n');
    expect(rows).toEqual([{ name: 'Asha Rao', company: 'Acme', phone: '98765 43210', value: '? 35,000.00' }]);
  });
  it('reads semicolon-separated files and keeps commas inside values', () => {
    expect(parseCsv('name;value\nAsha;"1,30,000"\n')).toEqual([{ name: 'Asha', value: '1,30,000' }]);
  });
  it('still reads comma-separated files, with quoted commas and a byte-order mark', () => {
    expect(parseCsv('﻿name,company\n"Rao, Asha","Acme, Inc"\n')).toEqual([{ name: 'Rao, Asha', company: 'Acme, Inc' }]);
  });
});

describe('parseAmount', () => {
  it.each([
    ['35000', 35000], ['35,000.00', 35000], ['? 35,000.00', 35000], ['₹ 1,30,000.00', 130000], ['₹6,999', 6999],
    ['Rs. 25,000/-', 25000], ['INR 9,000', 9000], ['$1,250.50', 1250.5], ['A$ 100', 100], ['60,001 INR', 60001],
  ])('%s → %d', (raw, expected) => expect(parseAmount(raw)).toBe(expected));
  it('treats blanks as no value and rejects text', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('  ')).toBeNull();
    expect(parseAmount('about 20k')).toBeNaN();
    expect(parseAmount('call me')).toBeNaN();
  });
});

const run = testDbConfigured();
const H = { 'x-requested-with': 'nexonweb' };
let app: Express;
let prisma: typeof import('../src/lib/db.js')['prisma'];
let cookie = '';
let tenantId = '';
const post = (url: string, body: object) => request(app).post(`/api/v1${url}`).set(H).set('Cookie', cookie).set('x-tenant-id', tenantId).send(body);

// Same shape as a real export: tab-separated, "?" where ₹ was lost, Indian grouping, spaced phones, missing emails.
const TSV = [
  'name\tcompany\temail\tphone\tsource\tservice\tbudget\tvalue\tnotes',
  'Asha Reddy\tAsha Services\tasha.reddy@test.local\t9000011111\tGoogle\t\t\t"? 35,000.00"\t',
  'Ravi Sir\t\t\t90000 22222\tGoogle\t\t\t"? 1,30,000.00"\t',
  'Test Sir\t\t\t+91 900 003 3333\tFacebook\t\t\t"? 6,999.00"\t',
  'Usha\t\t\t\tGoogle\t\t\t\t',
  'Repeat Phone\t\t\t9000022222\tGoogle\t\t\t\t',
  'Repeat Email\t\tASHA.REDDY@test.local\t\tGoogle\t\t\t\t',
  'Bad Value\t\t\t9000000001\tGoogle\t\t\tabout 20k\t',
  '\t\tno-name@test.local\t9000000002\tGoogle\t\t\t\t',
  '',
].join('\r\n');

describe.skipIf(!run)('lead CSV import', () => {
  beforeAll(async () => {
    app = (await import('../src/app.js')).createApp();
    prisma = (await import('../src/lib/db.js')).prisma;
    await prisma.plan.upsert({ where: { code: 'starter' }, create: { code: 'starter', name: 'Starter', maxUsers: 20, modules: [] }, update: {} });
    const reg = await request(app).post('/api/v1/auth/register').set(H).send({ name: 'Import Owner', email: `import-${Date.now()}@test.local`, password: 'Test-Password-123', companyName: 'Import Co' });
    cookie = reg.headers['set-cookie'][0].split(';')[0];
    tenantId = reg.body.memberships[0].tenant.id;
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  it('imports a tab-separated export with symbol-prefixed values and reports every skipped row', async () => {
    const res = await post('/leads/import', { csv: TSV });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(4);
    expect(res.body.skipped).toEqual([
      { row: 6, reason: 'Duplicate phone 9000022222' },
      { row: 7, reason: 'Duplicate email asha.reddy@test.local' },
      { row: 8, reason: 'Value "about 20k" is not an amount' },
      { row: 9, reason: expect.stringMatching(/^name: /) },
    ]);
    const leads = await prisma.lead.findMany({ where: { tenantId }, orderBy: { name: 'asc' } });
    const by = Object.fromEntries(leads.map((l) => [l.name, l]));
    expect(Number(by['Asha Reddy'].estimatedValue)).toBe(35000);
    expect(by['Asha Reddy'].company).toBe('Asha Services');
    expect(Number(by['Ravi Sir'].estimatedValue)).toBe(130000);
    expect(by['Ravi Sir'].phone).toBe('90000 22222');
    expect(Number(by['Test Sir'].estimatedValue)).toBe(6999);
    expect(by['Test Sir'].source).toBe('Facebook');
    expect(by.Usha.estimatedValue).toBeNull();
  });

  it('skips leads that already exist when the same file is imported again', async () => {
    const res = await post('/leads/import', { csv: TSV });
    expect(res.body.created).toBe(0);
    expect(await prisma.lead.count({ where: { tenantId } })).toBe(4);
  });

  it('explains a file without a name column instead of skipping every row', async () => {
    const res = await post('/leads/import', { csv: 'full name|email\nAsha|a@test.local\n' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No "name" column found/);
  });
});
