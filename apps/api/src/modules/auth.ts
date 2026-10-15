import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { config } from '../lib/config.js';
import { badRequest, conflict, notFound, unauthorized } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { enqueueEmail } from '../lib/queue.js';
import { provisionTenant } from '../lib/tenants.js';
import { requireAuth, SESSION_COOKIE, sessionCookieOptions } from '../middleware/auth.js';
import { parse } from '../middleware/validate.js';
import type { Request, Response } from 'express';

export const authRouter = Router();

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.isTest ? 10_000 : 20, standardHeaders: true, legacyHeaders: false });

let DUMMY_HASH: string | undefined;

const password = z.string().min(10, 'Use at least 10 characters').max(200);

async function startSession(req: Request, res: Response, userId: string) {
  const token = randomToken();
  await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      userAgent: req.headers['user-agent']?.slice(0, 300),
      ip: req.ip,
      expiresAt: new Date(Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000),
    },
  });
  await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
  return token;
}

export async function loadMe(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true, email: true, name: true, isSuperAdmin: true, defaultTenantId: true,
      memberships: {
        where: { status: 'ACTIVE' },
        select: {
          id: true, customerId: true,
          role: { select: { key: true, name: true, permissions: true } },
          tenant: { select: { id: true, name: true, slug: true, status: true, brandColor: true, logoFileId: true, trialEndsAt: true, orgCode: true, createdAt: true, plan: { select: { name: true, modules: true } } } },
        },
      },
    },
  });
  return user;
}

// Self-service signup creates a user and a new workspace (tenant) they own.
authRouter.post('/register', limiter, async (req, res) => {
  const body = parse(z.object({
    name: z.string().min(2).max(100),
    email: z.string().email().toLowerCase(),
    password,
    companyName: z.string().min(2).max(120),
  }), req.body);
  const signup = await prisma.platformSetting.findUnique({ where: { key: 'signupEnabled' } });
  if (signup?.value === false) throw badRequest('Self-service signup is currently disabled');
  if (await prisma.user.findUnique({ where: { email: body.email } })) throw conflict('An account with this email already exists');
  const passwordHash = await bcrypt.hash(body.password, 12);
  const { user, tenant } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { email: body.email, name: body.name, passwordHash } });
    const tenant = await provisionTenant({ name: body.companyName, ownerUserId: user.id }, tx);
    return { user, tenant };
  });
  await startSession(req, res, user.id);
  req.user = { id: user.id, email: user.email, name: user.name, isSuperAdmin: false, sessionId: '' };
  await audit(req, { action: 'tenant.signup', entityType: 'tenant', entityId: tenant.id, tenantId: tenant.id });
  res.status(201).json(await loadMe(user.id));
});

authRouter.post('/login', limiter, async (req, res) => {
  const body = parse(z.object({ email: z.string().email().toLowerCase(), password: z.string().min(1) }), req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  // Compare against a dummy hash when the user does not exist to keep timing similar.
  const ok = await bcrypt.compare(body.password, user?.passwordHash ?? (DUMMY_HASH ??= await bcrypt.hash('dummy-password', 12)));
  if (!user || !ok || !user.isActive) {
    await prisma.auditLog.create({ data: { action: 'auth.login_failed', actorEmail: body.email, ip: req.ip } });
    throw unauthorized('Invalid email or password');
  }
  await startSession(req, res, user.id);
  await prisma.auditLog.create({ data: { action: 'auth.login', actorId: user.id, actorEmail: user.email, ip: req.ip } });
  res.json(await loadMe(user.id));
});

authRouter.post('/logout', requireAuth, async (req, res) => {
  await prisma.session.update({ where: { id: req.user!.sessionId }, data: { revokedAt: new Date() } });
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.post('/logout-all', requireAuth, async (req, res) => {
  await prisma.session.updateMany({ where: { userId: req.user!.id, revokedAt: null }, data: { revokedAt: new Date() } });
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  await audit(req, { action: 'auth.logout_all', tenantId: null });
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  res.json(await loadMe(req.user!.id));
});

// ── Organizations the signed-in user belongs to ──

authRouter.post('/organizations', requireAuth, async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(2).max(120),
    stateCode: z.string().regex(/^\d{2}$/).optional().nullable(),
    gstin: z.string().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN format').optional().nullable(),
  }), req.body);
  const signup = await prisma.platformSetting.findUnique({ where: { key: 'signupEnabled' } });
  if (signup?.value === false && !req.user!.isSuperAdmin) throw badRequest('Creating organizations is currently disabled');
  const owned = await prisma.membership.count({ where: { userId: req.user!.id, role: { key: 'owner' } } });
  if (owned >= 10) throw badRequest('You can own at most 10 organizations');
  const tenant = await prisma.$transaction(async (tx) => {
    const t = await provisionTenant({ name: body.name, ownerUserId: req.user!.id }, tx);
    const stateCode = body.stateCode ?? body.gstin?.slice(0, 2) ?? null;
    return tx.tenant.update({ where: { id: t.id }, data: { stateCode, gstin: body.gstin ?? null, legalName: body.name } });
  });
  await audit(req, { action: 'tenant.created_by_user', entityType: 'tenant', entityId: tenant.id, tenantId: tenant.id });
  res.status(201).json(await loadMe(req.user!.id));
});

authRouter.post('/organizations/:id/default', requireAuth, async (req, res) => {
  const m = await prisma.membership.findUnique({ where: { tenantId_userId: { tenantId: String(req.params.id), userId: req.user!.id } } });
  if (!m || m.status !== 'ACTIVE') throw notFound('Organization');
  await prisma.user.update({ where: { id: req.user!.id }, data: { defaultTenantId: m.tenantId } });
  res.json(await loadMe(req.user!.id));
});

authRouter.patch('/me', requireAuth, async (req, res) => {
  const body = parse(z.object({ name: z.string().min(2).max(100) }), req.body);
  await prisma.user.update({ where: { id: req.user!.id }, data: { name: body.name } });
  res.json(await loadMe(req.user!.id));
});

authRouter.get('/sessions', requireAuth, async (req, res) => {
  const sessions = await prisma.session.findMany({
    where: { userId: req.user!.id, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, userAgent: true, ip: true, createdAt: true, lastSeenAt: true },
    orderBy: { lastSeenAt: 'desc' },
  });
  res.json(sessions.map((s) => ({ ...s, current: s.id === req.user!.sessionId })));
});

authRouter.delete('/sessions/:id', requireAuth, async (req, res) => {
  const r = await prisma.session.updateMany({
    where: { id: String(req.params.id), userId: req.user!.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (!r.count) throw notFound('Session');
  res.json({ ok: true });
});

authRouter.post('/change-password', requireAuth, async (req, res) => {
  const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: password }), req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  if (!(await bcrypt.compare(body.currentPassword, user.passwordHash))) throw badRequest('Current password is incorrect');
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(body.newPassword, 12) } });
  // Revoke all other sessions.
  await prisma.session.updateMany({ where: { userId: user.id, revokedAt: null, id: { not: req.user!.sessionId } }, data: { revokedAt: new Date() } });
  await audit(req, { action: 'auth.password_changed', tenantId: null });
  res.json({ ok: true });
});

authRouter.post('/forgot-password', limiter, async (req, res) => {
  const body = parse(z.object({ email: z.string().email().toLowerCase() }), req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  if (user && user.isActive) {
    const token = randomToken();
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    const link = `${config.appUrl}/reset-password?token=${token}`;
    await enqueueEmail({
      to: user.email,
      subject: 'Reset your Nexonweb password',
      text: `Hi ${user.name},\n\nUse this link to reset your password. It expires in 1 hour:\n${link}\n\nIf you did not request this, you can ignore this email.`,
    });
  }
  // Same response either way so the endpoint cannot be used to discover accounts.
  res.json({ ok: true, message: 'If an account exists for that email, a reset link has been sent.' });
});

authRouter.post('/reset-password', limiter, async (req, res) => {
  const body = parse(z.object({ token: z.string().min(10), password }), req.body);
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(body.token) } });
  if (!record || record.usedAt || record.expiresAt < new Date()) throw badRequest('This reset link is invalid or has expired');
  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash: await bcrypt.hash(body.password, 12) } }),
    prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.session.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await prisma.auditLog.create({ data: { action: 'auth.password_reset', actorId: record.userId, ip: req.ip } });
  res.json({ ok: true });
});

// ── Invitations ──

authRouter.get('/invitations/:token', async (req, res) => {
  const inv = await prisma.invitation.findUnique({
    where: { tokenHash: sha256(String(req.params.token)) },
    include: { tenant: { select: { name: true } }, role: { select: { name: true } } },
  });
  if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) throw notFound('Invitation');
  const existing = await prisma.user.findUnique({ where: { email: inv.email }, select: { id: true } });
  res.json({ email: inv.email, tenantName: inv.tenant.name, roleName: inv.role.name, hasAccount: !!existing });
});

authRouter.post('/invitations/:token/accept', limiter, async (req, res) => {
  const inv = await prisma.invitation.findUnique({ where: { tokenHash: sha256(String(req.params.token)) } });
  if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) throw notFound('Invitation');
  let user = await prisma.user.findUnique({ where: { email: inv.email } });
  if (user) {
    // Existing account: must prove ownership with their password (or already be logged in as them).
    if (req.user?.id !== user.id) {
      const body = parse(z.object({ password: z.string().min(1) }), req.body);
      if (!(await bcrypt.compare(body.password, user.passwordHash))) throw unauthorized('Incorrect password');
    }
  } else {
    const body = parse(z.object({ name: z.string().min(2).max(100), password }), req.body);
    user = await prisma.user.create({ data: { email: inv.email, name: body.name, passwordHash: await bcrypt.hash(body.password, 12) } });
  }
  await prisma.$transaction([
    prisma.membership.upsert({
      where: { tenantId_userId: { tenantId: inv.tenantId, userId: user.id } },
      create: { tenantId: inv.tenantId, userId: user.id, roleId: inv.roleId, customerId: inv.customerId },
      update: { roleId: inv.roleId, status: 'ACTIVE', customerId: inv.customerId },
    }),
    prisma.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } }),
  ]);
  await prisma.auditLog.create({
    data: { tenantId: inv.tenantId, action: 'users.invite_accepted', actorId: user.id, actorEmail: user.email, entityType: 'invitation', entityId: inv.id, ip: req.ip },
  });
  if (!req.user || req.user.id !== user.id) await startSession(req, res, user.id);
  res.json(await loadMe(user.id));
});
