import { Router, type Request } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { enqueueEmail } from '../lib/queue.js';
import { htmlToText, mailConfigured, sanitizeEmailHtml, type MailAttachment } from '../lib/mail.js';
import { renderStatementPdf } from '../lib/pdf.js';
import { currencyInfo, formatMoney } from '../lib/currency.js';
import { getObjectStream } from '../lib/storage.js';
import { can, tid } from '../middleware/tenant.js';
import { parse } from '../middleware/validate.js';
import { buyerOf, getInvoice, getQuotation, invoicePdfBuffer, markQuotationSent, quotationPdfBuffer, refreshInvoiceBalance, sellerOf } from './finance.js';
import { buildStatement } from './customers.js';
import { getProforma, markProformaSent, proformaPdfBuffer } from './proforma.js';

export const commsRouter = Router();

type Kind = 'invoice' | 'quote' | 'payment' | 'proforma';
const KIND_PERMS: Record<Kind, { read: string; send: string }> = {
  proforma: { read: 'proforma.read', send: 'proforma.send' },
  invoice: { read: 'invoices.read', send: 'invoices.issue' },
  quote: { read: 'quotations.read', send: 'quotations.send' },
  payment: { read: 'payments.read', send: 'payments.record' },
};

/** Amount in the document's own currency, e.g. "$1,100.00" or "₹59,000.00". */
const moneyIn = async (v: unknown, code: string) => formatMoney(v, await currencyInfo(code));
const fmt = (d?: Date | null) => (d ? d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function emailShell(o: { brandColor: string; hasLogo: boolean; heading: string; greeting: string; intro: string; amountLabel: string; amount: string; rows: [string, string][]; closing: string; sender: string; company: string; signoff?: string }) {
  return `<div style="background:#f6f7f9;padding:24px 0;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
  <table role="presentation" width="100%" style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e6e8ec;border-radius:8px;border-collapse:separate">
    <tr><td style="padding:20px 28px">${o.hasLogo ? '<img src="cid:org-logo" alt="" style="max-height:48px;max-width:200px">' : `<strong style="font-size:18px">${esc(o.company)}</strong>`}</td></tr>
    <tr><td style="background:${o.brandColor};color:#ffffff;text-align:center;padding:22px 28px;font-size:22px">${esc(o.heading)}</td></tr>
    <tr><td style="padding:28px 40px;font-size:15px;line-height:1.6">
      <p>${esc(o.greeting)}</p>
      <p>${esc(o.intro)}</p>
      <table role="presentation" width="100%" style="margin:20px 0;background:#fefce8;border:1px solid #fde68a;border-radius:6px">
        <tr><td style="padding:18px;text-align:center"><div style="font-size:12px;letter-spacing:1px;color:#64748b;text-transform:uppercase">${esc(o.amountLabel)}</div>
        <div style="font-size:26px;font-weight:bold;color:#b45309;margin-top:4px">${esc(o.amount)}</div>
        <table role="presentation" style="margin:12px auto 0;font-size:14px">${o.rows.map(([k, v]) => `<tr><td style="padding:2px 12px;color:#64748b;text-align:right">${esc(k)}</td><td style="padding:2px 12px;font-weight:bold">${esc(v)}</td></tr>`).join('')}</table>
        </td></tr>
      </table>
      <p>${esc(o.closing)}</p>
      <p>${esc(o.signoff ?? 'Regards,')}<br>${o.sender ? `${esc(o.sender)}<br>` : ''}${esc(o.company)}</p>
    </td></tr>
  </table>
</div>`;
}

async function loadContext(req: Request, kind: Kind, id: string) {
  const perms = KIND_PERMS[kind];
  if (!can(req, perms.read as never)) throw forbidden();
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) } });
  if (kind === 'invoice') {
    const inv = await getInvoice(req, id);
    return { tenant, kind, inv, customer: inv.customer, contacts: inv.customer.contacts };
  }
  if (kind === 'proforma') {
    const p = await getProforma(req, id);
    return { tenant, kind, p, customer: p.customer, contacts: p.customer.contacts };
  }
  if (kind === 'quote') {
    const q = await getQuotation(req, id);
    const contacts = q.customerId ? await prisma.contact.findMany({ where: { tenantId: tid(req), customerId: q.customerId, email: { not: null } }, select: { id: true, name: true, email: true } }) : [];
    return { tenant, kind, q, customer: q.customer, lead: q.lead, contacts };
  }
  const pay = await prisma.payment.findFirst({ where: { id, tenantId: tid(req) }, include: { customer: true, allocations: { include: { invoice: { select: { number: true } } } } } });
  if (!pay) throw notFound('Payment');
  const contacts = pay.customerId ? await prisma.contact.findMany({ where: { tenantId: tid(req), customerId: pay.customerId, email: { not: null } }, select: { id: true, name: true, email: true } }) : [];
  return { tenant, kind, pay, customer: pay.customer, contacts };
}

async function draftFor(req: Request, kind: Kind, id: string) {
  const ctx = await loadContext(req, kind, id);
  const { tenant } = ctx;
  const sender = req.user!.name;
  const company = tenant.name;
  const base = { brandColor: tenant.brandColor, hasLogo: !!tenant.logoFileId, sender, company };
  const customerName = ctx.customer?.name ?? ('lead' in ctx ? ctx.lead?.name : undefined) ?? 'Customer';
  let subject: string; let html: string; let attachmentName: string | null = null; let to: string[] = [];
  if (ctx.kind === 'invoice' && 'inv' in ctx && ctx.inv) {
    const inv = ctx.inv;
    to = inv.emailRecipients.length ? inv.emailRecipients : ctx.customer?.email ? [ctx.customer.email] : [];
    subject = `Invoice - ${inv.number} from ${company}`;
    attachmentName = `${inv.number}.pdf`;
    html = emailShell({ ...base, heading: `Invoice #${inv.number}`, greeting: `Dear ${customerName},`,
      intro: 'Thank you for your business. Your invoice is attached as a PDF. Please find the details below.',
      amountLabel: 'Invoice Amount', amount: await moneyIn(inv.total, inv.currency), rows: [['Invoice No', inv.number ?? ''], ['Invoice Date', fmt(inv.issueDate)], ['Due Date', fmt(inv.dueDate)], ...(Number(inv.balanceDue) !== Number(inv.total) ? [['Balance Due', await moneyIn(inv.balanceDue, inv.currency)] as [string, string]] : [])],
      closing: 'If you have any questions, simply reply to this email.' });
  } else if (ctx.kind === 'proforma' && 'p' in ctx && ctx.p) {
    const p = ctx.p;
    to = p.emailRecipients.length ? p.emailRecipients : ctx.customer?.email ? [ctx.customer.email] : [];
    subject = `Proforma Invoice ${p.number} from ${company}`;
    attachmentName = `${p.number}.pdf`;
    html = emailShell({ ...base, sender: '', signoff: 'Best regards,', heading: `Proforma Invoice ${p.number}`, greeting: `Dear ${customerName},`,
      intro: 'Please find attached the Proforma Invoice for your review.',
      amountLabel: 'Proforma Amount', amount: await moneyIn(p.total, p.currency), rows: [['Proforma Invoice No.', p.number], ['Date', fmt(p.issueDate)], ...(p.validUntil ? [['Valid Until', fmt(p.validUntil)] as [string, string]] : [])],
      closing: 'Kindly review the details and let us know if you have any questions.' });
  } else if (ctx.kind === 'quote' && 'q' in ctx && ctx.q) {
    const q = ctx.q;
    to = ctx.customer?.email ? [ctx.customer.email] : q.lead?.email ? [q.lead.email] : [];
    subject = `Quote - ${q.number} from ${company}`;
    attachmentName = `${q.number}.pdf`;
    html = emailShell({ ...base, heading: `Quote #${q.number}`, greeting: `Dear ${customerName},`,
      intro: 'Thank you for your interest. Please find our quote attached.',
      amountLabel: 'Quote Amount', amount: await moneyIn(q.total, q.currency), rows: [['Quote No', q.number], ['Quote Date', fmt(q.issueDate)], ...(q.validUntil ? [['Valid Until', fmt(q.validUntil)] as [string, string]] : [])],
      closing: 'We look forward to working with you. Reply to this email to accept or ask any questions.' });
  } else if ('pay' in ctx && ctx.pay) {
    const pay = ctx.pay;
    to = ctx.customer?.email ? [ctx.customer.email] : [];
    subject = `Payment Receipt - ${pay.number} from ${company}`;
    html = emailShell({ ...base, heading: 'Payment Received', greeting: `Dear ${customerName},`,
      intro: 'Thank you for your payment. This email confirms we have received it.',
      amountLabel: 'Amount Received', amount: await moneyIn(pay.amount, pay.currency), rows: [['Payment No', pay.number], ['Payment Date', fmt(pay.paidAt)], ['Applied to', pay.allocations.map((a) => a.invoice.number).filter(Boolean).join(', ') || '—']],
      closing: 'We appreciate your business.' });
  } else throw notFound('Document');
  const self = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { name: true, email: true } });
  return {
    ctx,
    draft: {
      from: { name: self.name, email: self.email },
      to, cc: [self.email], bcc: [] as string[], subject, html, attachmentName,
      contacts: ctx.contacts.filter((c) => c.email).map((c) => ({ name: c.name, email: c.email! })),
      customerId: ctx.customer?.id ?? null,
      smtpConfigured: mailConfigured(),
    },
  };
}

commsRouter.get('/email/:kind/:id/draft', async (req, res) => {
  const kind = String(req.params.kind) as Kind;
  if (!KIND_PERMS[kind]) throw notFound('Document type');
  res.json((await draftFor(req, kind, String(req.params.id))).draft);
});

const sendSchema = z.object({
  to: z.array(z.string().email()).min(1, 'Add at least one recipient').max(20),
  cc: z.array(z.string().email()).max(20).default([]),
  bcc: z.array(z.string().email()).max(20).default([]),
  subject: z.string().trim().min(1).max(250),
  html: z.string().min(1).max(200_000),
  attachPdf: z.boolean().default(true),
  attachStatement: z.boolean().default(false),
  fileIds: z.array(z.string()).max(5).default([]),
});

async function fileToAttachment(tenantId: string, id: string): Promise<MailAttachment> {
  const f = await prisma.fileObject.findFirst({ where: { id, tenantId } });
  if (!f) throw badRequest('Invalid attachment');
  const chunks: Buffer[] = [];
  for await (const c of await getObjectStream(f.storageKey)) chunks.push(Buffer.from(c));
  return { filename: f.originalName, contentBase64: Buffer.concat(chunks).toString('base64'), contentType: f.mimeType };
}

commsRouter.post('/email/:kind/:id/send', async (req, res) => {
  const kind = String(req.params.kind) as Kind;
  if (!KIND_PERMS[kind]) throw notFound('Document type');
  if (!can(req, KIND_PERMS[kind].send as never)) throw forbidden(`Missing permission: ${KIND_PERMS[kind].send}`);
  const body = parse(sendSchema, req.body);
  const { ctx } = await draftFor(req, kind, String(req.params.id));
  const t = tid(req);
  const attachments: MailAttachment[] = [];

  if (ctx.tenant.logoFileId) {
    try { attachments.push({ ...(await fileToAttachment(t, ctx.tenant.logoFileId)), cid: 'org-logo' }); } catch { /* logo optional */ }
  }
  if (body.attachPdf && 'inv' in ctx && ctx.inv) {
    if (ctx.inv.status === 'DRAFT') {
      // Sending a draft marks it as sent (issued), as with "Save and Send".
      await prisma.$transaction(async (tx) => {
        await tx.invoice.update({ where: { id: ctx.inv!.id }, data: { status: 'ISSUED', issuedAt: new Date() } });
        await refreshInvoiceBalance(tx, ctx.inv!.id);
      });
    }
    const fresh = await getInvoice(req, ctx.inv.id);
    attachments.push({ filename: `${fresh.number}.pdf`, contentBase64: (await invoicePdfBuffer(t, fresh)).toString('base64'), contentType: 'application/pdf' });
  }
  if (body.attachPdf && 'p' in ctx && ctx.p) {
    const fresh = await getProforma(req, ctx.p.id);
    attachments.push({ filename: `${fresh.number}.pdf`, contentBase64: (await proformaPdfBuffer(t, fresh)).toString('base64'), contentType: 'application/pdf' });
  }
  if (body.attachPdf && 'q' in ctx && ctx.q) {
    const fresh = await getQuotation(req, ctx.q.id);
    attachments.push({ filename: `${fresh.number}.pdf`, contentBase64: (await quotationPdfBuffer(t, fresh)).toString('base64'), contentType: 'application/pdf' });
  }
  if (body.attachStatement && ctx.customer) {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth() < 3 ? -9 : 3, 1); // start of the financial year
    // The statement is in the currency of the document being sent.
    const docCurrency = 'inv' in ctx && ctx.inv ? ctx.inv.currency : 'q' in ctx && ctx.q ? ctx.q.currency : 'p' in ctx && ctx.p ? ctx.p.currency : 'pay' in ctx && ctx.pay ? ctx.pay.currency : undefined;
    const st = await buildStatement(t, ctx.customer.id, from, now, docCurrency);
    const pdf = await renderStatementPdf({ seller: await sellerOf(ctx.tenant), customer: buyerOf(ctx.customer), from, to: now, ...st });
    attachments.push({ filename: `statement-${ctx.customer.code}.pdf`, contentBase64: pdf.toString('base64'), contentType: 'application/pdf' });
  }
  for (const id of body.fileIds) attachments.push(await fileToAttachment(t, id));

  const html = sanitizeEmailHtml(body.html);
  const files = attachments.filter((a) => !a.cid).map((a) => a.filename);
  // The log starts as QUEUED; the sender updates it with what the mail server reports.
  const log = await prisma.emailLog.create({ data: { tenantId: t, entityType: kind, entityId: String(req.params.id), to: body.to, cc: body.cc, subject: body.subject, attachments: files, sentById: req.user!.id } });
  await enqueueEmail({ to: body.to, cc: body.cc, bcc: body.bcc, subject: body.subject, html, text: htmlToText(html), attachments, fromName: `${req.user!.name} (${ctx.tenant.name})`, replyTo: req.user!.email, tenantId: t, logId: log.id });

  if ('inv' in ctx && ctx.inv) await prisma.invoice.update({ where: { id: ctx.inv.id }, data: { lastEmailedAt: new Date(), emailRecipients: body.to } });
  if ('q' in ctx && ctx.q) await markQuotationSent(t, ctx.q, req.user!.id);
  if ('p' in ctx && ctx.p) {
    await markProformaSent(t, ctx.p);
    await prisma.proformaInvoice.update({ where: { id: ctx.p.id }, data: { lastEmailedAt: new Date(), emailRecipients: body.to } });
  }
  await audit(req, { action: `${kind}.emailed`, entityType: kind, entityId: String(req.params.id), meta: { to: body.to, cc: body.cc, attachments: files, emailLogId: log.id } });
  // Queued, not delivered: the status on the email log changes once the mail server responds.
  res.json({ ok: true, delivered: mailConfigured(), status: 'QUEUED', emailLogId: log.id, smtpConfigured: mailConfigured(), attachments: files });
});

/** Emails a statement of accounts for a period. */
commsRouter.post('/email/statement/:customerId', async (req, res) => {
  if (!can(req, 'invoices.read')) throw forbidden();
  const body = parse(z.object({ to: z.array(z.string().email()).min(1), cc: z.array(z.string().email()).default([]), from: z.coerce.date(), toDate: z.coerce.date(), currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(), subject: z.string().min(1).max(250).optional(), message: z.string().max(5000).optional() }), req.body);
  const customer = await prisma.customer.findFirst({ where: { id: String(req.params.customerId), tenantId: tid(req) } });
  if (!customer) throw notFound('Customer');
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) } });
  const st = await buildStatement(tid(req), customer.id, body.from, body.toDate, body.currency);
  const pdf = await renderStatementPdf({ seller: await sellerOf(tenant), customer: buyerOf(customer), from: body.from, to: body.toDate, ...st });
  const text = body.message ?? `Dear ${customer.name},\n\nPlease find attached your statement of accounts from ${fmt(body.from)} to ${fmt(body.toDate)}. Balance due: ${formatMoney(st.closing, st.currency)}.\n\nRegards,\n${req.user!.name}\n${tenant.name}`;
  await enqueueEmail({ to: body.to, cc: body.cc, subject: body.subject ?? `Statement of accounts from ${tenant.name}`, text, attachments: [{ filename: `statement-${customer.code}.pdf`, contentBase64: pdf.toString('base64'), contentType: 'application/pdf' }], fromName: `${req.user!.name} (${tenant.name})`, replyTo: req.user!.email });
  await audit(req, { action: 'customers.statement_emailed', entityType: 'customer', entityId: customer.id, meta: { to: body.to } });
  res.json({ ok: true, delivered: mailConfigured() });
});
