import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { config } from '../lib/config.js';
import { badRequest } from '../lib/errors.js';
import { platformSmtp, publicSmtpAddress, resolveSmtp, SmtpHostError, testSmtp, type PlatformSmtpValue, type SmtpSettings } from '../lib/mail.js';
import { canEncrypt, decryptSecret, encryptSecret } from '../lib/secrets.js';
import { requirePerm, tid } from '../middleware/tenant.js';
import { parse } from '../middleware/validate.js';

// Outgoing mail server settings. Organizations may use their own SMTP server (Settings → Email); the platform
// administrator sets the default used by everyone else (Platform → Settings). Passwords are write-only.

const SECURITY = ['TLS', 'STARTTLS', 'NONE'] as const;

const serverSchema = z.object({
  enabled: z.boolean().default(true),
  host: z.string().trim().toLowerCase().min(1).max(253).regex(/^[a-z0-9.-]+$|^\[?[0-9a-f:.]+\]?$/, 'Enter a host name such as smtp.example.com'),
  port: z.coerce.number().int().min(1).max(65535),
  security: z.enum(SECURITY),
  username: z.string().trim().max(254).optional().nullable().transform((v) => v || null),
  /** Omitted or empty: keep the saved password. */
  password: z.string().max(500).optional().nullable(),
  /** Remove the saved password (servers without authentication). */
  clearPassword: z.boolean().optional(),
  fromEmail: z.string().trim().toLowerCase().email('Enter the sender email address'),
  fromName: z.string().trim().max(120).optional().nullable().transform((v) => v || null),
  replyTo: z.string().trim().toLowerCase().email().optional().nullable().or(z.literal('').transform(() => null)),
});
type ServerInput = z.infer<typeof serverSchema>;

const testSchema = z.object({ to: z.string().trim().email('Enter the address to send the test email to') });
const testLimiter = rateLimit({ windowMs: 60_000, limit: config.isTest ? 1000 : 5, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => (req as Request).user?.id ?? 'anon' });

/** New encrypted password, the saved one, or none. */
function passwordFor(body: ServerInput, saved: string | null | undefined) {
  if (body.clearPassword) return null;
  if (body.password) {
    if (!canEncrypt()) throw badRequest('The server cannot store passwords yet: ask the administrator to set SETTINGS_ENCRYPTION_KEY');
    return encryptSecret(body.password);
  }
  return saved ?? null;
}

const describe = (s: { host: string; port: number; security: string; username?: string | null; passwordEnc?: string | null; fromEmail: string; fromName?: string | null; replyTo?: string | null; enabled?: boolean; lastTestAt?: Date | string | null; lastTestOk?: boolean | null; lastTestError?: string | null }) => ({
  enabled: s.enabled ?? true, host: s.host, port: s.port, security: s.security, username: s.username ?? null, fromEmail: s.fromEmail, fromName: s.fromName ?? null, replyTo: s.replyTo ?? null,
  hasPassword: !!s.passwordEnc, passwordReadable: !s.passwordEnc || decryptSecret(s.passwordEnc) !== null,
  lastTestAt: s.lastTestAt ?? null, lastTestOk: s.lastTestOk ?? null, lastTestError: s.lastTestError ?? null,
});

/** What an organization's emails currently go through, without secrets. */
async function effective(tenantId?: string) {
  const s = await resolveSmtp(tenantId);
  return s ? { source: s.source, host: s.host, port: s.port, fromEmail: s.fromEmail, fromName: s.fromName ?? null } : { source: 'none' as const };
}

// ── Organization (tenant) settings ──

export const tenantMailRouter = Router();

tenantMailRouter.get('/settings/email', requirePerm('settings.manage'), async (req, res) => {
  const own = await prisma.tenantMailServer.findUnique({ where: { tenantId: tid(req) } });
  const platform = await platformSmtp();
  res.json({
    own: own ? describe(own) : null,
    effective: await effective(tid(req)),
    platformDefault: platform?.enabled ? { host: platform.host, fromEmail: platform.fromEmail } : null,
    canStorePasswords: canEncrypt(),
  });
});

tenantMailRouter.put('/settings/email', requirePerm('settings.manage'), async (req, res) => {
  const body = parse(serverSchema, req.body);
  // Organization servers must be on the public internet (see publicSmtpAddress).
  try { await publicSmtpAddress(body.host); } catch (e) {
    if (e instanceof SmtpHostError) throw badRequest(e.message, { fieldErrors: { host: [e.message] } });
    throw e;
  }
  const current = await prisma.tenantMailServer.findUnique({ where: { tenantId: tid(req) } });
  const data = {
    enabled: body.enabled, host: body.host, port: body.port, security: body.security, username: body.username,
    passwordEnc: passwordFor(body, current?.passwordEnc), fromEmail: body.fromEmail, fromName: body.fromName, replyTo: body.replyTo ?? null,
    // A changed server has not been tested yet.
    lastTestAt: null, lastTestOk: null, lastTestError: null, updatedById: req.user!.id,
  };
  await prisma.tenantMailServer.upsert({ where: { tenantId: tid(req) }, create: { tenantId: tid(req), ...data }, update: data });
  await audit(req, { action: 'settings.email_server', meta: { host: body.host, port: body.port, security: body.security, enabled: body.enabled, passwordChanged: !!body.password || !!body.clearPassword } });
  const own = await prisma.tenantMailServer.findUniqueOrThrow({ where: { tenantId: tid(req) } });
  res.json({ own: describe(own), effective: await effective(tid(req)) });
});

/** Removes the organization's own server; emails go through the platform default again. */
tenantMailRouter.delete('/settings/email', requirePerm('settings.manage'), async (req, res) => {
  await prisma.tenantMailServer.deleteMany({ where: { tenantId: tid(req) } });
  await audit(req, { action: 'settings.email_server_removed' });
  res.json({ own: null, effective: await effective(tid(req)) });
});

/** Connects with the saved settings and sends a test email. */
tenantMailRouter.post('/settings/email/test', requirePerm('settings.manage'), testLimiter, async (req, res) => {
  const { to } = parse(testSchema, req.body);
  const own = await prisma.tenantMailServer.findUnique({ where: { tenantId: tid(req) } });
  if (!own) throw badRequest('Save your mail server settings first');
  const password = decryptSecret(own.passwordEnc);
  if (own.passwordEnc && password === null) throw badRequest('The saved password cannot be read any more. Enter it again and save.');
  const result = await testSmtp({ source: 'tenant', host: own.host, port: own.port, security: own.security as SmtpSettings['security'], username: own.username, password, fromEmail: own.fromEmail, fromName: own.fromName, replyTo: own.replyTo }, to);
  await prisma.tenantMailServer.update({ where: { tenantId: tid(req) }, data: { lastTestAt: new Date(), lastTestOk: result.ok, lastTestError: result.ok ? null : result.error } });
  await audit(req, { action: 'settings.email_test', meta: { to, ok: result.ok } });
  res.json(result);
});

// ── Platform default (mounted under /platform, super administrators only) ──

export const platformMailRouter = Router();

platformMailRouter.get('/email', async (_req, res) => {
  const p = await platformSmtp();
  res.json({
    server: p ? describe(p) : null,
    effective: await effective(),
    environment: config.smtp.host ? { host: config.smtp.host, port: config.smtp.port } : null,
    canStorePasswords: canEncrypt(),
  });
});

platformMailRouter.put('/email', async (req, res) => {
  const body = parse(serverSchema, req.body);
  const current = await platformSmtp();
  const value: PlatformSmtpValue = {
    enabled: body.enabled, host: body.host, port: body.port, security: body.security, username: body.username,
    passwordEnc: passwordFor(body, current?.passwordEnc), fromEmail: body.fromEmail, fromName: body.fromName, replyTo: body.replyTo ?? null,
    lastTestAt: null, lastTestOk: null, lastTestError: null,
  };
  await prisma.platformSetting.upsert({ where: { key: 'smtp' }, create: { key: 'smtp', value: value as never }, update: { value: value as never } });
  await audit(req, { action: 'platform.email_server', tenantId: null, meta: { host: body.host, port: body.port, security: body.security, enabled: body.enabled, passwordChanged: !!body.password || !!body.clearPassword } });
  res.json({ server: describe(value), effective: await effective() });
});

platformMailRouter.delete('/email', async (req, res) => {
  await prisma.platformSetting.deleteMany({ where: { key: 'smtp' } });
  await audit(req, { action: 'platform.email_server_removed', tenantId: null });
  res.json({ server: null, effective: await effective() });
});

platformMailRouter.post('/email/test', testLimiter, async (req, res) => {
  const { to } = parse(testSchema, req.body);
  const p = await platformSmtp();
  if (!p) throw badRequest('Save the mail server settings first');
  const password = decryptSecret(p.passwordEnc);
  if (p.passwordEnc && password === null) throw badRequest('The saved password cannot be read any more. Enter it again and save.');
  const result = await testSmtp({ source: 'platform', host: p.host, port: p.port, security: p.security, username: p.username, password, fromEmail: p.fromEmail, fromName: p.fromName, replyTo: p.replyTo }, to);
  const value: PlatformSmtpValue = { ...p, lastTestAt: new Date().toISOString(), lastTestOk: result.ok, lastTestError: result.ok ? null : result.error };
  await prisma.platformSetting.update({ where: { key: 'smtp' }, data: { value: value as never } });
  await audit(req, { action: 'platform.email_test', tenantId: null, meta: { to, ok: result.ok } });
  res.json(result);
});
