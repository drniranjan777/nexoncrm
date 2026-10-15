import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { config } from '../lib/config.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { nextNumber } from '../lib/numbering.js';
import { analyzeFeedback } from '../lib/ai/index.js';
import { enqueueEmail } from '../lib/queue.js';
import { notify, usersWithPermission } from '../lib/notify.js';
import { storeUploads, upload, filesOf } from '../lib/uploads.js';
import { tenantSettings } from '../lib/tenants.js';
import {
  EXPECTATION_STATUSES, PROJECT_STATUSES, SERVICE_CATEGORIES, SERVICE_QUESTIONS, TECHNICAL_SERVICES, sanitizeServiceAnswers,
} from '../lib/feedbackForms.js';
import { parse } from '../middleware/validate.js';

// Unauthenticated endpoints. They must never reveal private records: only the minimum needed to render
// the form and track a submission with its secret tracking token.
export const publicRouter = Router();

const submitLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: config.isTest ? 10_000 : 20, standardHeaders: true, legacyHeaders: false });
const readLimiter = rateLimit({ windowMs: 60 * 1000, limit: config.isTest ? 10_000 : 60, standardHeaders: true, legacyHeaders: false });

async function defaultTenantSlug() {
  const s = await prisma.platformSetting.findUnique({ where: { key: 'defaultFeedbackTenant' } });
  return (s?.value as string | undefined) ?? 'nexonweb';
}

/** Resolve the tenant (and optional link context) from a secure link token or a public tenant slug. */
async function resolveContext(token?: string, slug?: string) {
  if (token) {
    const link = await prisma.feedbackLink.findUnique({
      where: { token },
      include: { tenant: true, project: { select: { id: true, name: true, code: true, customerId: true, serviceCategory: true } } },
    });
    if (!link || !link.active || (link.expiresAt && link.expiresAt < new Date())) throw notFound('Feedback link');
    return { tenant: link.tenant, link };
  }
  const tenant = await prisma.tenant.findUnique({ where: { slug: slug || (await defaultTenantSlug()) } });
  if (!tenant || tenant.status === 'SUSPENDED' || tenant.status === 'CANCELLED') throw notFound('Workspace');
  return { tenant, link: null };
}

publicRouter.get('/feedback/form', readLimiter, async (req, res) => {
  const { tenant, link } = await resolveContext(
    typeof req.query.token === 'string' ? req.query.token : undefined,
    typeof req.query.tenant === 'string' ? req.query.tenant : undefined,
  );
  let customer: { name: string; company: string | null } | null = null;
  const customerId = link?.customerId ?? link?.project?.customerId;
  if (customerId) {
    customer = await prisma.customer.findFirst({ where: { id: customerId, tenantId: tenant.id }, select: { name: true, company: true } });
  }
  res.json({
    tenant: { name: tenant.name, slug: tenant.slug, brandColor: tenant.brandColor, hasLogo: !!tenant.logoFileId },
    link: link
      ? {
          projectName: link.project?.name ?? null,
          projectCode: link.project?.code ?? null,
          serviceCategory: link.serviceCategory ?? link.project?.serviceCategory ?? null,
          customerName: customer?.name ?? null,
          company: customer?.company ?? null,
        }
      : null,
    serviceCategories: SERVICE_CATEGORIES,
    serviceQuestions: SERVICE_QUESTIONS,
    technicalServices: [...TECHNICAL_SERVICES],
    projectStatuses: PROJECT_STATUSES,
    expectationStatuses: EXPECTATION_STATUSES,
  });
});

publicRouter.get('/tenants/:slug/logo', readLimiter, async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { slug: String(req.params.slug) } });
  if (!tenant?.logoFileId) throw notFound('Logo');
  const file = await prisma.fileObject.findFirst({ where: { id: tenant.logoFileId, tenantId: tenant.id } });
  if (!file || !file.mimeType.startsWith('image/')) throw notFound('Logo');
  const { getObjectStream } = await import('../lib/storage.js');
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  (await getObjectStream(file.storageKey)).pipe(res);
});

const rating = z.coerce.number().int().min(1).max(5);
const optRating = z.preprocess((v) => (v === '' || v === null || v === undefined ? undefined : v), rating.optional());
const text = (max = 5000) => z.string().max(max).optional().nullable().transform((v) => (v?.trim() ? v.trim() : null));

const submissionSchema = z.object({
  token: z.string().optional(),
  tenant: z.string().optional(),
  website: z.string().max(0, 'Spam detected').optional(), // honeypot: real users leave it empty
  name: z.string().trim().min(2).max(120),
  company: text(160),
  email: z.string().trim().email().max(200).toLowerCase(),
  phone: text(40),
  projectReference: text(120),
  serviceCategory: z.enum(SERVICE_CATEGORIES),
  projectStatus: z.enum(PROJECT_STATUSES as [string, ...string[]]).optional().nullable(),
  ratingOverall: rating,
  ratingCommunication: optRating,
  ratingQuality: optRating,
  ratingTimeliness: optRating,
  ratingTechnical: optRating,
  serviceAnswers: z.preprocess((v) => (typeof v === 'string' ? JSON.parse(v || '{}') : v), z.record(z.unknown()).optional()),
  workingWell: text(),
  needsImprovement: text(),
  requestedChanges: text(),
  urgentIssues: text(),
  expectationStatus: z.enum(EXPECTATION_STATUSES as [string, ...string[]]).optional().nullable(),
  comments: text(),
  consent: z.preprocess((v) => v === true || v === 'true' || v === 'on', z.literal(true, { errorMap: () => ({ message: 'Please confirm consent to process your feedback' }) })),
});

publicRouter.post('/feedback', submitLimiter, upload.array('attachments', 5), async (req: Request, res) => {
  const body = parse(submissionSchema, req.body);
  const { tenant, link } = await resolveContext(body.token, body.tenant);

  // Link the submission to a customer: from the secure link, from a logged-in portal user, or by matching email.
  let customerId = link?.customerId ?? link?.project?.customerId ?? null;
  let submittedByUserId: string | null = null;
  if (req.user) {
    const m = await prisma.membership.findUnique({ where: { tenantId_userId: { tenantId: tenant.id, userId: req.user.id } } });
    if (m?.status === 'ACTIVE') {
      submittedByUserId = req.user.id;
      customerId ??= m.customerId;
    }
  }
  customerId ??= (await prisma.customer.findFirst({ where: { tenantId: tenant.id, email: { equals: body.email, mode: 'insensitive' } }, select: { id: true } }))?.id ?? null;

  const analysis = analyzeFeedback({
    ratingOverall: body.ratingOverall,
    ratings: [body.ratingCommunication, body.ratingQuality, body.ratingTimeliness, body.ratingTechnical],
    texts: [body.workingWell, body.needsImprovement, body.requestedChanges, body.urgentIssues, body.comments],
    urgentIssues: body.urgentIssues,
  });
  const trackingToken = randomToken(18);
  const files = filesOf(req);

  const feedback = await prisma.$transaction(async (tx) => {
    const referenceNo = await nextNumber(tx, tenant.id, 'FEEDBACK');
    const fb = await tx.feedback.create({
      data: {
        tenantId: tenant.id, referenceNo, trackingTokenHash: sha256(trackingToken),
        customerId, projectId: link?.projectId ?? null, linkId: link?.id ?? null, submittedByUserId,
        name: body.name, company: body.company, email: body.email, phone: body.phone,
        serviceCategory: body.serviceCategory, projectStatus: body.projectStatus,
        ratingOverall: body.ratingOverall, ratingCommunication: body.ratingCommunication, ratingQuality: body.ratingQuality,
        ratingTimeliness: body.ratingTimeliness,
        ratingTechnical: TECHNICAL_SERVICES.has(body.serviceCategory) ? body.ratingTechnical : null,
        serviceAnswers: { ...sanitizeServiceAnswers(body.serviceCategory, body.serviceAnswers), ...(body.projectReference ? { projectReference: body.projectReference } : {}) },
        workingWell: body.workingWell, needsImprovement: body.needsImprovement, requestedChanges: body.requestedChanges,
        urgentIssues: body.urgentIssues, expectationStatus: body.expectationStatus, comments: body.comments,
        sentiment: analysis.sentiment, sentimentScore: analysis.sentimentScore, aiCategories: analysis.categories, isUrgent: analysis.isUrgent,
      },
    });
    await tx.feedbackEvent.create({ data: { feedbackId: fb.id, kind: 'SYSTEM', body: 'Feedback submitted', isInternal: false } });
    if (link) await tx.feedbackLink.update({ where: { id: link.id }, data: { useCount: { increment: 1 } } });
    await storeUploads(tenant.id, files, { entityType: 'feedback', entityId: fb.id, visibility: 'customer' }, tx);
    return fb;
  });

  const settings = tenantSettings(tenant.settings);
  const managers = await usersWithPermission(tenant.id, 'feedback.resolve');
  await notify(tenant.id, managers, {
    title: `${feedback.isUrgent ? 'URGENT ' : ''}New feedback ${feedback.referenceNo}`,
    body: `${feedback.name} rated ${feedback.ratingOverall}/5 for ${feedback.serviceCategory}`,
    link: `/feedback/${feedback.id}`,
  });
  const trackUrl = `${config.feedbackPublicUrl}/track?ref=${encodeURIComponent(feedback.referenceNo)}&t=${trackingToken}&tenant=${tenant.slug}`;
  if (settings.notifications.emailCustomerOnFeedback) {
    await enqueueEmail({
      tenantId: tenant.id,
      to: feedback.email,
      subject: `We received your feedback (${feedback.referenceNo})`,
      text: `Hi ${feedback.name},\n\nThank you for your feedback to ${tenant.name}. Your reference number is ${feedback.referenceNo}.\n\nYou can track its status here:\n${trackUrl}\n\nRegards,\n${tenant.name}`,
    });
  }
  res.status(201).json({ referenceNo: feedback.referenceNo, trackingToken, trackUrl, tenantSlug: tenant.slug });
});

publicRouter.get('/feedback/track', readLimiter, async (req, res) => {
  const q = parse(z.object({ ref: z.string().min(3).max(40), t: z.string().min(10).max(100), tenant: z.string().optional() }), req.query);
  const fb = await prisma.feedback.findUnique({
    where: { trackingTokenHash: sha256(q.t) },
    include: { events: { where: { isInternal: false }, orderBy: { createdAt: 'asc' } }, tenant: { select: { name: true, slug: true, brandColor: true, logoFileId: true } } },
  });
  // Require both the reference and the secret token to match.
  if (!fb || fb.referenceNo !== q.ref) throw notFound('Feedback');
  res.json({
    referenceNo: fb.referenceNo, tenantName: fb.tenant.name, tenantSlug: fb.tenant.slug, brandColor: fb.tenant.brandColor,
    hasLogo: !!fb.tenant.logoFileId, status: fb.status, serviceCategory: fb.serviceCategory,
    submittedAt: fb.createdAt, updatedAt: fb.updatedAt, resolvedAt: fb.resolvedAt,
    timeline: fb.events.map((e) => ({ kind: e.kind, body: e.body, at: e.createdAt })),
  });
});

publicRouter.post('/feedback/track/reply', submitLimiter, async (req, res) => {
  const body = parse(z.object({ ref: z.string(), t: z.string().min(10), message: z.string().trim().min(1).max(5000) }), req.body);
  const fb = await prisma.feedback.findUnique({ where: { trackingTokenHash: sha256(body.t) } });
  if (!fb || fb.referenceNo !== body.ref) throw notFound('Feedback');
  if (fb.status === 'CLOSED') throw badRequest('This feedback is closed. Please submit new feedback.');
  await prisma.$transaction([
    prisma.feedbackEvent.create({ data: { feedbackId: fb.id, kind: 'CUSTOMER_REPLY', body: body.message, isInternal: false } }),
    prisma.feedback.update({ where: { id: fb.id }, data: { status: fb.status === 'WAITING_FOR_CUSTOMER' || fb.status === 'RESOLVED' ? 'UNDER_REVIEW' : fb.status } }),
  ]);
  await notify(fb.tenantId, [fb.assignedToId ?? (await usersWithPermission(fb.tenantId, 'feedback.resolve'))[0]], {
    title: `Customer replied on ${fb.referenceNo}`, body: body.message.slice(0, 120), link: `/feedback/${fb.id}`,
  });
  res.json({ ok: true });
});
