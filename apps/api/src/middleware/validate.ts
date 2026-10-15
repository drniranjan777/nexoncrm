import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { badRequest } from '../lib/errors.js';

/** Parse a request body with a zod schema, raising a 400 with field errors on failure. */
export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) throw badRequest('Validation failed', result.error.flatten());
  return result.data;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const e = err as { status?: number; message?: string; details?: unknown; code?: string };
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Validation failed', details: err.flatten() });
  }
  // Prisma known errors
  if (e.code === 'P2002') return res.status(409).json({ error: 'A record with these details already exists' });
  if (e.code === 'P2025') return res.status(404).json({ error: 'Record not found' });
  if (e.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large' });

  const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({
    error: status >= 500 ? 'Something went wrong. Please try again.' : e.message,
    ...(e.details ? { details: e.details } : {}),
  });
}
