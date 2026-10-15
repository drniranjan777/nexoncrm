import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { latestRate } from '../lib/currency.js';
import { AUTH_IMAGE_MAX_BYTES, AUTH_IMAGE_TYPES, normalizeAuthorizationImage } from '../lib/authorization.js';
import { storeUploads } from '../lib/uploads.js';
import { getObjectStream } from '../lib/storage.js';
import { requirePerm, tid } from '../middleware/tenant.js';
import { parse } from '../middleware/validate.js';

// Company finance settings: currencies, exchange rates, company seal and authorized signature.
// Everything here is scoped to the caller's tenant and changes require settings.manage.
export const companyFinanceRouter = Router();

// ───────────────────────── Currencies ─────────────────────────

companyFinanceRouter.get('/settings/currencies', requirePerm('settings.manage'), async (req, res) => {
  const t = tid(req);
  const [tenant, catalog, enabled] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: t }, select: { currency: true, defaultCurrency: true } }),
    prisma.currency.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] }),
    prisma.tenantCurrency.findMany({ where: { tenantId: t } }),
  ]);
  const usage = await prisma.invoice.groupBy({ by: ['currency'], where: { tenantId: t }, _count: true });
  const currencies = await Promise.all(catalog.map(async (c) => ({
    ...c,
    enabled: enabled.find((e) => e.currencyCode === c.code)?.isActive ?? false,
    isDefault: c.code === tenant.defaultCurrency,
    isBase: c.code === tenant.currency,
    invoices: usage.find((u) => u.currency === c.code)?._count ?? 0,
    latestRate: c.code === tenant.currency ? 1 : await latestRate(t, c.code),
  })));
  res.json({ baseCurrency: tenant.currency, defaultCurrency: tenant.defaultCurrency, currencies });
});

companyFinanceRouter.patch('/settings/currencies/:code', requirePerm('settings.manage'), async (req, res) => {
  const t = tid(req);
  const code = String(req.params.code).toUpperCase();
  const body = parse(z.object({ enabled: z.boolean() }), req.body);
  const [tenant, currency] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: t }, select: { currency: true, defaultCurrency: true } }),
    prisma.currency.findUnique({ where: { code } }),
  ]);
  if (!currency || !currency.isActive) throw notFound('Currency');
  if (!body.enabled && (code === tenant.defaultCurrency || code === tenant.currency)) {
    throw badRequest(`${code} is your ${code === tenant.currency ? 'base' : 'default'} currency and cannot be turned off`);
  }
  // Turning a currency off only hides it for new documents; existing documents keep it.
  await prisma.tenantCurrency.upsert({
    where: { tenantId_currencyCode: { tenantId: t, currencyCode: code } },
    create: { tenantId: t, currencyCode: code, isActive: body.enabled },
    update: { isActive: body.enabled },
  });
  await audit(req, { action: 'settings.currency_toggle', meta: { code, enabled: body.enabled } });
  res.json({ ok: true });
});

companyFinanceRouter.put('/settings/default-currency', requirePerm('settings.manage'), async (req, res) => {
  const t = tid(req);
  const body = parse(z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/) }), req.body);
  const enabled = await prisma.tenantCurrency.findUnique({ where: { tenantId_currencyCode: { tenantId: t, currencyCode: body.code } }, include: { currency: true } });
  if (!enabled?.isActive || !enabled.currency.isActive) throw badRequest(`Enable ${body.code} before making it the default`);
  const before = await prisma.tenant.findUniqueOrThrow({ where: { id: t }, select: { defaultCurrency: true } });
  // Only new documents pick up the default. Existing quotes and invoices are not touched.
  await prisma.tenant.update({ where: { id: t }, data: { defaultCurrency: body.code } });
  await audit(req, { action: 'settings.default_currency', meta: { from: before.defaultCurrency, to: body.code } });
  res.json({ defaultCurrency: body.code });
});

companyFinanceRouter.get('/settings/exchange-rates', requirePerm('settings.manage', 'invoices.create', 'quotations.create'), async (req, res) => {
  const code = typeof req.query.currency === 'string' ? req.query.currency.toUpperCase() : undefined;
  const rows = await prisma.exchangeRate.findMany({ where: { tenantId: tid(req), ...(code ? { currencyCode: code } : {}) }, orderBy: [{ rateDate: 'desc' }, { createdAt: 'desc' }], take: 50 });
  res.json(rows);
});

companyFinanceRouter.post('/settings/exchange-rates', requirePerm('settings.manage'), async (req, res) => {
  const t = tid(req);
  const body = parse(z.object({ currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/), rate: z.coerce.number().positive().max(1_000_000), rateDate: z.coerce.date().optional() }), req.body);
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: t }, select: { currency: true } });
  if (body.currency === tenant.currency) throw badRequest('The base currency always has a rate of 1');
  if (!(await prisma.currency.findUnique({ where: { code: body.currency } }))) throw notFound('Currency');
  const row = await prisma.exchangeRate.create({ data: { tenantId: t, currencyCode: body.currency, baseCurrency: tenant.currency, rate: body.rate, rateDate: body.rateDate ?? new Date(), createdById: req.user!.id } });
  await audit(req, { action: 'settings.exchange_rate', meta: { currency: body.currency, rate: body.rate } });
  res.status(201).json(row);
});

// ───────────────────────── Seal & authorized signature ─────────────────────────

const KINDS = { seal: 'sealFileId', signature: 'signatureFileId' } as const;
type Kind = keyof typeof KINDS;
const kindOf = (v: unknown): Kind => {
  if (v !== 'seal' && v !== 'signature') throw notFound('Image');
  return v;
};

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AUTH_IMAGE_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!AUTH_IMAGE_TYPES.includes(file.mimetype)) return cb(badRequest('Upload a PNG, JPG or WebP image'));
    cb(null, true);
  },
});

const authSelect = {
  legalName: true, name: true, sealFileId: true, signatureFileId: true, signatoryName: true, signatoryDesignation: true,
  showSignatureOnInvoice: true, showSealOnInvoice: true, showSignatureOnQuote: true, showSealOnQuote: true,
} as const;

companyFinanceRouter.get('/settings/authorization', requirePerm('settings.manage'), async (req, res) => {
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) }, select: authSelect });
  res.json({ ...t, companyName: t.legalName ?? t.name });
});

companyFinanceRouter.patch('/settings/authorization', requirePerm('settings.manage'), async (req, res) => {
  const body = parse(z.object({
    signatoryName: z.string().trim().max(120).nullable().optional().transform((v) => v || null),
    signatoryDesignation: z.string().trim().max(120).nullable().optional().transform((v) => v || null),
    showSignatureOnInvoice: z.boolean().optional(), showSealOnInvoice: z.boolean().optional(),
    showSignatureOnQuote: z.boolean().optional(), showSealOnQuote: z.boolean().optional(),
  }), req.body);
  const t = await prisma.tenant.update({ where: { id: tid(req) }, data: body, select: authSelect });
  await audit(req, { action: 'settings.authorization', meta: body });
  res.json({ ...t, companyName: t.legalName ?? t.name });
});

companyFinanceRouter.post('/settings/authorization/:kind', requirePerm('settings.manage'), (req, res, next) => {
  imageUpload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return next(badRequest('The image must be 2 MB or smaller'));
    next(err);
  });
}, async (req, res) => {
  const kind = kindOf(req.params.kind);
  if (!req.file) throw badRequest('Choose an image to upload');
  const png = await normalizeAuthorizationImage(req.file.buffer);
  const [stored] = await storeUploads(tid(req), [{ ...req.file, buffer: png, size: png.length, mimetype: 'image/png', originalname: `${kind}.png` }], {
    entityType: 'authorization', entityId: kind, uploadedById: req.user!.id,
  });
  // The previous image is kept (not deleted) so documents already sent with it still render it.
  await prisma.tenant.update({ where: { id: tid(req) }, data: { [KINDS[kind]]: stored.id } });
  await audit(req, { action: `settings.${kind}_upload`, entityType: 'file', entityId: stored.id });
  res.status(201).json({ fileId: stored.id });
});

companyFinanceRouter.delete('/settings/authorization/:kind', requirePerm('settings.manage'), async (req, res) => {
  const kind = kindOf(req.params.kind);
  await prisma.tenant.update({ where: { id: tid(req) }, data: { [KINDS[kind]]: null } });
  await audit(req, { action: `settings.${kind}_remove` });
  res.json({ ok: true });
});

companyFinanceRouter.get('/settings/authorization/:kind/image', requirePerm('settings.manage'), async (req, res) => {
  const kind = kindOf(req.params.kind);
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) }, select: { sealFileId: true, signatureFileId: true } });
  const fileId = t[KINDS[kind]];
  const file = fileId ? await prisma.fileObject.findFirst({ where: { id: fileId, tenantId: tid(req), entityType: 'authorization' } }) : null;
  if (!file) throw notFound('Image');
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  (await getObjectStream(file.storageKey)).on('error', () => res.destroy()).pipe(res);
});
