import dns from 'node:dns/promises';
import net from 'node:net';
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { prisma } from './db.js';
import { decryptSecret } from './secrets.js';

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
  /** Organization sending the email: its own SMTP server is used when it has one. */
  tenantId?: string | null;
}

// ── Which mail server sends an email ──
// 1. the organization's own server (Settings → Email), 2. the platform default (Platform → Settings),
// 3. SMTP_* in the server environment. Without any of them, emails are logged instead of sent.

export type SmtpSecurity = 'TLS' | 'STARTTLS' | 'NONE';
export interface SmtpSettings {
  source: 'tenant' | 'platform' | 'environment';
  host: string; port: number; security: SmtpSecurity | 'AUTO';
  username?: string | null; password?: string | null;
  fromEmail: string; fromName?: string | null; replyTo?: string | null;
  /** A stored password could not be decrypted (encryption key changed). */
  passwordUnreadable?: boolean;
}

/** Platform default server, stored in PlatformSetting "smtp" (password encrypted). */
export interface PlatformSmtpValue {
  enabled: boolean; host: string; port: number; security: SmtpSecurity; username?: string | null; passwordEnc?: string | null;
  fromEmail: string; fromName?: string | null; replyTo?: string | null; lastTestAt?: string | null; lastTestOk?: boolean | null; lastTestError?: string | null;
}

export async function platformSmtp(): Promise<PlatformSmtpValue | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key: 'smtp' } });
  return (row?.value as unknown as PlatformSmtpValue | null) ?? null;
}

function envSmtp(): SmtpSettings | null {
  if (!config.smtp.host) return null;
  const fromEmail = config.smtp.from.match(/<([^>]+)>/)?.[1] ?? config.smtp.from;
  const fromName = config.smtp.from.match(/^\s*"?([^"<]+?)"?\s*</)?.[1] ?? null;
  return { source: 'environment', host: config.smtp.host, port: config.smtp.port, security: config.smtp.port === 465 ? 'TLS' : 'AUTO', username: config.smtp.user, password: config.smtp.pass, fromEmail, fromName };
}

export async function resolveSmtp(tenantId?: string | null): Promise<SmtpSettings | null> {
  if (tenantId) {
    const t = await prisma.tenantMailServer.findUnique({ where: { tenantId } });
    if (t?.enabled) {
      const password = decryptSecret(t.passwordEnc);
      return { source: 'tenant', host: t.host, port: t.port, security: t.security as SmtpSecurity, username: t.username, password, fromEmail: t.fromEmail, fromName: t.fromName, replyTo: t.replyTo, passwordUnreadable: !!t.passwordEnc && password === null };
    }
  }
  const p = await platformSmtp();
  if (p?.enabled && p.host) {
    const password = decryptSecret(p.passwordEnc);
    return { source: 'platform', host: p.host, port: p.port, security: p.security, username: p.username, password, fromEmail: p.fromEmail, fromName: p.fromName, replyTo: p.replyTo, passwordUnreadable: !!p.passwordEnc && password === null };
  }
  return envSmtp();
}

/** Whether emails from this organization (or platform emails, without one) are actually sent. */
export const mailConfigured = async (tenantId?: string | null) => !!(await resolveSmtp(tenantId));

// ── Private-address guard for organization-managed servers ──

function isPrivateIp(ip: string) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

export class SmtpHostError extends Error {}

/**
 * Resolves an organization's SMTP host to a public address. Organization admins must not be able to make the
 * server connect to its own network (localhost, private ranges, cloud metadata). The checked address is what
 * the connection uses, so a DNS change between the check and the connection cannot bypass it.
 */
export async function publicSmtpAddress(host: string): Promise<string> {
  let addresses: string[];
  try {
    addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new SmtpHostError(`The mail server ${host} could not be found`);
  }
  if (!addresses.length) throw new SmtpHostError(`The mail server ${host} could not be found`);
  if (!config.allowPrivateSmtpHosts && addresses.some(isPrivateIp)) throw new SmtpHostError('The mail server must have a public address');
  return addresses[0];
}

const transporters = new Map<string, ReturnType<typeof nodemailer.createTransport>>();

async function transportFor(s: SmtpSettings) {
  // Organization servers connect to the checked public address; TLS still verifies the certificate for the host name.
  const connectHost = s.source === 'tenant' ? await publicSmtpAddress(s.host) : s.host;
  const key = JSON.stringify([connectHost, s.host, s.port, s.security, s.username, s.password]);
  let t = transporters.get(key);
  if (!t) {
    t = nodemailer.createTransport({
      host: connectHost, port: s.port, secure: s.security === 'TLS', requireTLS: s.security === 'STARTTLS', ignoreTLS: s.security === 'NONE',
      auth: s.username ? { user: s.username, pass: s.password ?? '' } : undefined,
      tls: { servername: s.host },
      connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 30_000,
    });
    if (transporters.size > 50) transporters.clear();
    transporters.set(key, t);
  }
  return t;
}

/** Short, safe description of a mail server error for the people who configured it. */
export function smtpErrorMessage(err: unknown) {
  const e = err as { code?: string; responseCode?: number; message?: string };
  if (err instanceof SmtpHostError) return err.message;
  if (e.code === 'EAUTH') return 'The mail server rejected the username or password';
  if (e.code === 'ECONNREFUSED') return 'The mail server refused the connection (check the host and port)';
  if (e.code === 'ETIMEDOUT' || e.code === 'ETIMEOUT' || e.code === 'ECONNECTION') return 'Could not connect to the mail server (check the host, port and security setting)';
  if (e.code === 'ESOCKET' || e.code === 'ETLS') return 'Secure connection failed (check the security setting and port)';
  return (e.message ?? 'Sending failed').replace(/\s+/g, ' ').slice(0, 300);
}

/** Sends immediately. Prefer enqueueEmail() from lib/queue.ts in request handlers. */
export async function sendMailNow(msg: MailMessage) {
  const smtp = await resolveSmtp(msg.tenantId);
  if (!smtp) {
    if (!config.isTest) {
      const to = Array.isArray(msg.to) ? msg.to.join(', ') : msg.to;
      const files = msg.attachments?.filter((a) => !a.cid).map((a) => a.filename).join(', ');
      console.log(`[mail:console] to=${to}${msg.cc?.length ? ` cc=${msg.cc.join(', ')}` : ''} subject="${msg.subject}"${files ? ` attachments=[${files}]` : ''}\n${msg.text}\n`);
    }
    return { delivered: false, reason: 'smtp_not_configured' as const };
  }
  if (smtp.passwordUnreadable) throw new Error('The stored SMTP password cannot be decrypted; enter it again in the email settings');
  const transporter = await transportFor(smtp);
  const info = await transporter.sendMail({
    from: { name: msg.fromName ?? smtp.fromName ?? '', address: smtp.fromEmail },
    to: msg.to, cc: msg.cc, bcc: msg.bcc, replyTo: msg.replyTo ?? smtp.replyTo ?? undefined, subject: msg.subject, text: msg.text, html: msg.html,
    attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: Buffer.from(a.contentBase64, 'base64'), contentType: a.contentType, cid: a.cid })),
  });
  // "delivered" here means the SMTP server accepted the message; final delivery is not known.
  return { delivered: true as const, messageId: info.messageId as string | undefined };
}

/** Checks a server configuration: connects and authenticates, then sends a test email to `to`. */
export async function testSmtp(settings: SmtpSettings, to: string) {
  try {
    const transporter = await transportFor(settings);
    await transporter.verify();
    await transporter.sendMail({
      from: { name: settings.fromName ?? '', address: settings.fromEmail }, to, replyTo: settings.replyTo ?? undefined,
      subject: 'Test email from Nexonweb',
      text: `This is a test email.\n\nYour mail server (${settings.host}:${settings.port}) is set up correctly for sending quotations, invoices and other documents.`,
    });
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: smtpErrorMessage(err) };
  }
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
