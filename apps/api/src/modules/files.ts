import { Router, type Request } from 'express';
import { z } from 'zod';
import type { FileObject, Prisma } from '@prisma/client';
import { prisma } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { listParams, paged, qstr, searchAny } from '../lib/list.js';
import { deleteObject, getObjectStream } from '../lib/storage.js';
import { filesOf, storeUploads, upload } from '../lib/uploads.js';
import { can, requirePerm, tid } from '../middleware/tenant.js';
import { parse } from '../middleware/validate.js';
import { projectScope } from './projects.js';
import { ticketScope } from './support.js';

export const filesRouter = Router();

const ENTITY_TYPES = ['project', 'customer', 'ticket', 'feedback', 'invoice', 'quotation', 'proforma', 'expense', 'payment', 'email', 'general', 'branding'] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

/** Checks that the caller can see the record a file is attached to. Files inherit their parent's access rules. */
async function assertEntityAccess(req: Request, entityType: string | null, entityId: string | null) {
  const t = tid(req);
  switch (entityType as EntityType | null) {
    case 'project': {
      const p = await prisma.project.findFirst({ where: { AND: [projectScope(req), { id: entityId ?? '' }] }, select: { id: true } });
      if (!p) throw notFound('Project');
      return;
    }
    case 'ticket': {
      const tk = await prisma.ticket.findFirst({ where: { AND: [ticketScope(req), { id: entityId ?? '' }] }, select: { id: true } });
      if (!tk) throw notFound('Ticket');
      return;
    }
    case 'customer':
      if (!can(req, 'customers.read')) throw forbidden();
      if (!(await prisma.customer.findFirst({ where: { id: entityId ?? '', tenantId: t }, select: { id: true } }))) throw notFound('Customer');
      return;
    case 'feedback':
      if (!can(req, 'feedback.read')) throw forbidden();
      if (!(await prisma.feedback.findFirst({ where: { id: entityId ?? '', tenantId: t }, select: { id: true } }))) throw notFound('Feedback');
      return;
    case 'invoice':
      if (!can(req, 'invoices.read')) throw forbidden();
      if (!(await prisma.invoice.findFirst({ where: { id: entityId ?? '', tenantId: t }, select: { id: true } }))) throw notFound('Invoice');
      return;
    case 'proforma':
      if (!can(req, 'proforma.read')) throw forbidden();
      if (!(await prisma.proformaInvoice.findFirst({ where: { id: entityId ?? '', tenantId: t }, select: { id: true } }))) throw notFound('Proforma invoice');
      return;
    case 'quotation':
      if (!can(req, 'quotations.read')) throw forbidden();
      if (!(await prisma.quotation.findFirst({ where: { id: entityId ?? '', tenantId: t }, select: { id: true } }))) throw notFound('Quotation');
      return;
    case 'expense':
      if (!can(req, 'invoices.read')) throw forbidden();
      if (!(await prisma.expense.findFirst({ where: { id: entityId ?? '', tenantId: t }, select: { id: true } }))) throw notFound('Expense');
      return;
    case 'payment':
      if (!can(req, 'payments.read')) throw forbidden();
      if (!(await prisma.payment.findFirst({ where: { id: entityId ?? '', tenantId: t }, select: { id: true } }))) throw notFound('Payment');
      return;
    case 'email':
      // Ad-hoc email attachments are tied to the uploader only.
      if (!can(req, 'files.upload')) throw forbidden();
      return;
    case 'branding':
    case 'general':
    case null:
      return;
    default:
      throw badRequest('Unknown entity type');
  }
}

/** Restricts a file listing to entity types the caller may see. */
async function visibleFilesWhere(req: Request): Promise<Prisma.FileObjectWhereInput> {
  const t = tid(req);
  const or: Prisma.FileObjectWhereInput[] = [{ entityType: { in: ['general', 'branding'] } }, { entityType: null }];
  if (can(req, 'customers.read')) or.push({ entityType: 'customer' });
  if (can(req, 'feedback.read')) or.push({ entityType: 'feedback' });
  if (can(req, 'invoices.read')) or.push({ entityType: 'invoice' });
  if (can(req, 'quotations.read')) or.push({ entityType: 'quotation' });
  if (can(req, 'proforma.read')) or.push({ entityType: 'proforma' });
  if (can(req, 'invoices.read')) or.push({ entityType: 'expense' });
  if (can(req, 'payments.read')) or.push({ entityType: 'payment' });
  or.push({ entityType: 'email', uploadedById: req.user!.id });
  if (can(req, 'projects.read')) or.push({ entityType: 'project' });
  else if (can(req, 'projects.read_assigned')) {
    const ids = (await prisma.project.findMany({ where: projectScope(req), select: { id: true } })).map((p) => p.id);
    or.push({ entityType: 'project', entityId: { in: ids } });
  }
  if (can(req, 'tickets.read')) or.push({ entityType: 'ticket' });
  else if (can(req, 'tickets.read_assigned')) {
    const ids = (await prisma.ticket.findMany({ where: ticketScope(req), select: { id: true } })).map((x) => x.id);
    or.push({ entityType: 'ticket', entityId: { in: ids } });
  }
  return { tenantId: t, OR: or };
}

filesRouter.get('/files', requirePerm('files.read'), async (req, res) => {
  const p = listParams(req, ['createdAt', 'originalName', 'sizeBytes']);
  const entityType = qstr(req.query.entityType);
  const entityId = qstr(req.query.entityId);
  if (entityType && entityId) await assertEntityAccess(req, entityType, entityId);
  const where: Prisma.FileObjectWhereInput = {
    AND: [
      await visibleFilesWhere(req),
      searchAny(p.q, ['originalName']),
      entityType ? { entityType } : {},
      entityId ? { entityId } : {},
    ],
  };
  const [items, total] = await Promise.all([
    prisma.fileObject.findMany({ where, orderBy: { [p.sort ?? 'createdAt']: p.dir }, skip: p.skip, take: p.pageSize, omit: { storageKey: true } }),
    prisma.fileObject.count({ where }),
  ]);
  res.json(paged(items, total, p));
});

filesRouter.post('/files', requirePerm('files.upload'), upload.array('files', 10), async (req, res) => {
  const body = parse(z.object({
    entityType: z.enum(ENTITY_TYPES).default('general'),
    entityId: z.string().optional(),
    visibility: z.enum(['internal', 'customer']).default('internal'),
  }), req.body);
  if (body.entityType === 'branding' && !can(req, 'settings.manage')) throw forbidden();
  await assertEntityAccess(req, body.entityType, body.entityId ?? null);
  const files = filesOf(req);
  if (!files.length) throw badRequest('No files received');
  const stored = await storeUploads(tid(req), files, { ...body, uploadedById: req.user!.id });
  await audit(req, { action: 'files.upload', entityType: body.entityType, entityId: body.entityId, meta: { count: stored.length } });
  res.status(201).json(stored);
});

async function findFile(req: Request, id: string): Promise<FileObject> {
  const file = await prisma.fileObject.findFirst({ where: { id, tenantId: tid(req) } });
  if (!file) throw notFound('File');
  if (file.entityType === 'branding') return file;
  await assertEntityAccess(req, file.entityType, file.entityId);
  return file;
}

filesRouter.get('/files/:id/download', async (req, res) => {
  // Portal users may download customer-visible files on their own records (checked in portal.ts);
  // here require normal file permission.
  if (!can(req, 'files.read') && !can(req, 'feedback.read') && !can(req, 'invoices.read')) throw forbidden();
  const file = await findFile(req, String(req.params.id));
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const inline = req.query.inline === '1' && (file.mimeType.startsWith('image/') || file.mimeType === 'application/pdf');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(file.originalName)}"`);
  (await getObjectStream(file.storageKey)).on('error', () => res.destroy()).pipe(res);
});

filesRouter.delete('/files/:id', requirePerm('files.upload'), async (req, res) => {
  const file = await findFile(req, String(req.params.id));
  if (file.uploadedById !== req.user!.id && !can(req, 'settings.manage') && !can(req, 'projects.update')) {
    throw forbidden('Only the uploader or a manager can delete this file');
  }
  await prisma.$transaction([
    prisma.fileObject.delete({ where: { id: file.id } }),
    prisma.tenant.update({ where: { id: tid(req) }, data: { storageUsedBytes: { decrement: BigInt(file.sizeBytes) } } }),
  ]);
  await deleteObject(file.storageKey).catch((e) => console.error('[files] delete failed', e));
  await audit(req, { action: 'files.delete', entityType: 'file', entityId: file.id, meta: { name: file.originalName } });
  res.json({ ok: true });
});
