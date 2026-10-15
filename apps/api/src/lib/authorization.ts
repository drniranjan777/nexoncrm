import sharp from 'sharp';
import { prisma, type Tx } from './db.js';
import { badRequest } from './errors.js';
import { getObjectStream } from './storage.js';

export type DocKind = 'invoice' | 'quote';

/** What a document shows in its "Authorized Signatory" block. Frozen on the document when it is sent. */
export type AuthorizationSnapshot = {
  company: string;
  signatoryName: string | null;
  designation: string | null;
  sealFileId: string | null;
  signatureFileId: string | null;
  capturedAt: string;
};

export interface AuthorizationBlock {
  company: string;
  signatoryName: string | null;
  designation: string | null;
  seal: Buffer | null;
  signature: Buffer | null;
}

/** The tenant's current authorization settings, filtered by the per-document visibility toggles. */
export async function authorizationSnapshot(tenantId: string, kind: DocKind, tx: Tx = prisma): Promise<AuthorizationSnapshot> {
  const t = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const showSeal = kind === 'invoice' ? t.showSealOnInvoice : t.showSealOnQuote;
  const showSignature = kind === 'invoice' ? t.showSignatureOnInvoice : t.showSignatureOnQuote;
  return {
    company: t.legalName ?? t.name,
    signatoryName: t.signatoryName,
    designation: t.signatoryDesignation,
    sealFileId: showSeal ? t.sealFileId : null,
    signatureFileId: showSignature ? t.signatureFileId : null,
    capturedAt: new Date().toISOString(),
  };
}

async function readImage(tenantId: string, fileId: string | null): Promise<Buffer | null> {
  if (!fileId) return null;
  // Tenant-scoped lookup: a snapshot can only ever resolve files of its own tenant.
  const file = await prisma.fileObject.findFirst({ where: { id: fileId, tenantId, entityType: 'authorization' } });
  if (!file) return null;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of await getObjectStream(file.storageKey)) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } catch {
    return null; // missing object: the PDF is still produced, without the image
  }
}

/**
 * Loads the block for a PDF. Sent documents use their snapshot; drafts use the live settings.
 * Returns null when there is nothing to show, so no empty space is reserved.
 */
export async function loadAuthorizationBlock(tenantId: string, kind: DocKind, snapshot: unknown): Promise<AuthorizationBlock | null> {
  const s = (snapshot as AuthorizationSnapshot | null) ?? (await authorizationSnapshot(tenantId, kind));
  const [seal, signature] = await Promise.all([readImage(tenantId, s.sealFileId), readImage(tenantId, s.signatureFileId)]);
  if (!seal && !signature && !s.signatoryName) return null;
  return { company: s.company, signatoryName: s.signatoryName, designation: s.designation, seal, signature };
}

export const AUTH_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const AUTH_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Normalizes an uploaded seal/signature to a PNG (PDFs support PNG/JPEG only; WebP is converted),
 * keeping transparency and aspect ratio, capped at 1200x600, with metadata stripped.
 */
export async function normalizeAuthorizationImage(buffer: Buffer): Promise<Buffer> {
  try {
    const img = sharp(buffer, { failOn: 'error', limitInputPixels: 40_000_000 });
    const meta = await img.metadata();
    if (!meta.format || !['png', 'jpeg', 'webp'].includes(meta.format)) throw new Error('format');
    return await img.rotate().resize({ width: 1200, height: 600, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
  } catch {
    throw badRequest('The image could not be read. Upload a PNG, JPG or WebP file.');
  }
}
