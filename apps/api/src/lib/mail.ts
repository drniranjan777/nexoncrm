import nodemailer from 'nodemailer';
import { config } from './config.js';

export interface MailAttachment {
  filename: string;
  /** Base64 content, so messages stay JSON-serialisable for the job queue. */
  contentBase64: string;
  contentType?: string;
  /** Content-ID for inline images referenced as cid:... in the HTML body. */
  cid?: string;
}

export interface MailMessage {
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  /** Display name for the From header; the address is always the configured sender. */
  fromName?: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: MailAttachment[];
}

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

export const mailConfigured = () => !!config.smtp.host;

/** Sends immediately. Prefer enqueueEmail() from lib/queue.ts in request handlers. */
export async function sendMailNow(msg: MailMessage) {
  if (!config.smtp.host) {
    if (!config.isTest) {
      const to = Array.isArray(msg.to) ? msg.to.join(', ') : msg.to;
      const files = msg.attachments?.filter((a) => !a.cid).map((a) => a.filename).join(', ');
      console.log(`[mail:console] to=${to}${msg.cc?.length ? ` cc=${msg.cc.join(', ')}` : ''} subject="${msg.subject}"${files ? ` attachments=[${files}]` : ''}\n${msg.text}\n`);
    }
    return { delivered: false, reason: 'smtp_not_configured' as const };
  }
  transporter ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  const fromAddress = config.smtp.from.match(/<([^>]+)>/)?.[1] ?? config.smtp.from;
  const info = await transporter.sendMail({
    from: msg.fromName ? { name: msg.fromName, address: fromAddress } : config.smtp.from,
    to: msg.to, cc: msg.cc, bcc: msg.bcc, replyTo: msg.replyTo, subject: msg.subject, text: msg.text, html: msg.html,
    attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: Buffer.from(a.contentBase64, 'base64'), contentType: a.contentType, cid: a.cid })),
  });
  // "delivered" here means the SMTP server accepted the message; final delivery is not known.
  return { delivered: true as const, messageId: info.messageId as string | undefined };
}

/** Removes scripts, event handlers and javascript: URLs from user-edited email HTML. */
export function sanitizeEmailHtml(html: string) {
  return html
    .replace(/<\s*(script|style|iframe|object|embed|form)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|iframe|object|embed|link|meta)[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
}

export const htmlToText = (html: string) =>
  html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|h\d)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
