import fs from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { config } from './config.js';
import { randomToken } from './crypto.js';

// Private object storage. Keys are always prefixed with the tenant id; files are only served
// through authorised API routes, never via public URLs.

export const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv',
  'application/zip',
]);

export const MAX_FILE_BYTES = 15 * 1024 * 1024;

export function buildKey(tenantId: string, originalName: string) {
  const ext = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
  const d = new Date();
  return `tenants/${tenantId}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${randomToken(16)}${ext}`;
}

let s3: S3Client | null = null;
const client = () =>
  (s3 ??= new S3Client({
    region: config.storage.s3.region,
    endpoint: config.storage.s3.endpoint,
    forcePathStyle: !!config.storage.s3.endpoint,
    credentials: { accessKeyId: config.storage.s3.accessKeyId, secretAccessKey: config.storage.s3.secretAccessKey },
  }));

const localPath = (key: string) => {
  const root = path.resolve(config.storage.localDir);
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep)) throw new Error('Invalid storage key');
  return full;
};

export async function putObject(key: string, body: Buffer, contentType: string) {
  if (config.storage.driver === 's3') {
    await client().send(new PutObjectCommand({ Bucket: config.storage.s3.bucket, Key: key, Body: body, ContentType: contentType }));
    return;
  }
  const full = localPath(key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body);
}

export async function getObjectStream(key: string): Promise<Readable> {
  if (config.storage.driver === 's3') {
    const out = await client().send(new GetObjectCommand({ Bucket: config.storage.s3.bucket, Key: key }));
    return out.Body as Readable;
  }
  return createReadStream(localPath(key));
}

export async function deleteObject(key: string) {
  if (config.storage.driver === 's3') {
    await client().send(new DeleteObjectCommand({ Bucket: config.storage.s3.bucket, Key: key }));
    return;
  }
  await fs.rm(localPath(key), { force: true });
}

/** Lightweight magic-byte check so a renamed executable cannot pass as a PDF or image. */
export function sniffMatches(buf: Buffer, mime: string) {
  const startsWith = (...bytes: number[]) => bytes.every((b, i) => buf[i] === b);
  if (mime === 'application/pdf') return startsWith(0x25, 0x50, 0x44, 0x46);
  if (mime === 'image/png') return startsWith(0x89, 0x50, 0x4e, 0x47);
  if (mime === 'image/jpeg') return startsWith(0xff, 0xd8, 0xff);
  if (mime === 'image/gif') return startsWith(0x47, 0x49, 0x46);
  if (mime === 'image/webp') return startsWith(0x52, 0x49, 0x46, 0x46);
  if (mime.includes('openxmlformats') || mime === 'application/zip') return startsWith(0x50, 0x4b);
  if (buf[0] === 0x4d && buf[1] === 0x5a) return false; // Windows PE executable
  return true;
}
