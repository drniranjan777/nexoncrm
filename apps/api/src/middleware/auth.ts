import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/db.js';
import { sha256 } from '../lib/crypto.js';
import { config } from '../lib/config.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export const SESSION_COOKIE = 'nx_session';

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.cookieSecure,
    path: '/',
    maxAge: config.sessionTtlDays * 24 * 60 * 60 * 1000,
  };
}

/** Resolves the session cookie (or Bearer token, for API clients) into req.user. Does not reject. */
export async function loadUser(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token: string | undefined =
    req.cookies?.[SESSION_COOKIE] ?? (header?.startsWith('Bearer ') ? header.slice(7) : undefined);
  if (!token) return next();

  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date() || !session.user.isActive) return next();

  req.user = {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    isSuperAdmin: session.user.isSuperAdmin,
    sessionId: session.id,
  };
  // Touch lastSeenAt at most once a minute to avoid a write per request.
  if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
    prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  next();
}

export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (!req.user.isSuperAdmin) return next(forbidden('Platform administrator access required'));
  next();
}
