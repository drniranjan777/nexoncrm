import multer from 'multer';
import type { Request } from 'express';
import { prisma, type Tx } from './db.js';
import { badRequest, HttpError } from './errors.js';
import { ALLOWED_MIME, buildKey, MAX_FILE_BYTES, putObject, sniffMatches } from './storage.js';

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 10 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) return cb(badRequest(`File type not allowed: ${file.originalname}`));
    cb(null, true);
  },
});

/** Validates, checks the tenant's storage quota, stores and records uploaded files. */
export async function storeUploads(
  tenantId: string,
  files: Express.Multer.File[],
  meta: { entityType: string; entityId?: string; uploadedById?: string | null; visibility?: string },
  tx: Tx = prisma,
) {
  if (!files.length) return [];
  for (const f of files) {
    if (!sniffMatches(f.buffer, f.mimetype)) throw badRequest(`File content does not match its type: ${f.originalname}`);
  }
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, include: { plan: true } });
  const incoming = files.reduce((s, f) => s + f.size, 0);
  const limitBytes = BigInt(tenant.plan?.storageMb ?? 1024) * 1024n * 1024n;
  if (tenant.storageUsedBytes + BigInt(incoming) > limitBytes) {
    throw new HttpError(413, 'Storage limit for this workspace has been reached');
  }
  const records = [];
  for (const f of files) {
    const key = buildKey(tenantId, f.originalname);
    await putObject(key, f.buffer, f.mimetype);
    records.push(
      await tx.fileObject.create({
        data: {
          tenantId, storageKey: key, originalName: f.originalname.slice(0, 200), mimeType: f.mimetype, sizeBytes: f.size,
          entityType: meta.entityType, entityId: meta.entityId, uploadedById: meta.uploadedById ?? null, visibility: meta.visibility ?? 'internal',
        },
        select: { id: true, originalName: true, mimeType: true, sizeBytes: true, createdAt: true, entityType: true, entityId: true },
      }),
    );
  }
  await tx.tenant.update({ where: { id: tenantId }, data: { storageUsedBytes: { increment: BigInt(incoming) } } });
  return records;
}

export const filesOf = (req: Request) => (Array.isArray(req.files) ? req.files : []) as Express.Multer.File[];
