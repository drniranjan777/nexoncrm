import { Queue, Worker, type Job } from 'bullmq';
import { config } from './config.js';
import { sendMailNow, type MailMessage } from './mail.js';
import { prisma } from './db.js';
import { runMaintenance } from '../jobs/maintenance.js';

// BullMQ when REDIS_URL is configured; otherwise jobs run in-process so local dev and tests need no Redis.

/** `logId` links the job to an EmailLog row whose status follows the send result. */
type EmailJob = MailMessage & { tenantId?: string; logId?: string };
const EMAIL_ATTEMPTS = 5;

/** Records what the mail server reported. Never throws: logging must not affect sending. */
async function recordEmail(logId: string | undefined, data: { status: string; error?: string | null; providerMessageId?: string | null; sentAt?: Date }) {
  if (!logId) return;
  try {
    await prisma.emailLog.update({ where: { id: logId }, data });
  } catch (err) {
    console.error('[mail] could not update email log', logId, err);
  }
}

async function sendAndRecord(msg: EmailJob) {
  const r = await sendMailNow(msg);
  await recordEmail(msg.logId, r.delivered
    ? { status: 'SENT', sentAt: new Date(), providerMessageId: r.messageId ?? null, error: null }
    : { status: 'NOT_CONFIGURED', error: 'Outgoing email (SMTP) is not configured on the server' });
}


let emailQueue: Queue<EmailJob> | null = null;
let maintenanceQueue: Queue | null = null;
const workers: Worker[] = [];
let interval: NodeJS.Timeout | null = null;

const connection = () => {
  const url = new URL(config.redisUrl!);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  };
};

export async function enqueueEmail(msg: EmailJob) {
  if (emailQueue) {
    await emailQueue.add('send', msg, { attempts: EMAIL_ATTEMPTS, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: 500 });
    return;
  }
  // In-process fallback: fire and forget, never fail the request because email failed.
  sendAndRecord(msg).catch(async (err) => {
    console.error('[mail] send failed', err);
    await recordEmail(msg.logId, { status: 'FAILED', error: String((err as Error)?.message ?? err).slice(0, 500) });
  });
}

export async function startJobs() {
  if (config.isTest) return;
  if (config.redisUrl) {
    try {
      const conn = connection();
      emailQueue = new Queue<EmailJob>('email', { connection: conn });
      maintenanceQueue = new Queue('maintenance', { connection: conn });
      const emailWorker = new Worker<EmailJob>('email', async (job: Job<EmailJob>) => { await sendAndRecord(job.data); }, { connection: conn });
      // A failed attempt is retried; only the last failure marks the email as failed.
      emailWorker.on('failed', (job, err) => {
        if (!job) return;
        const final = job.attemptsMade >= (job.opts.attempts ?? EMAIL_ATTEMPTS);
        recordEmail(job.data.logId, { status: final ? 'FAILED' : 'QUEUED', error: String(err?.message ?? err).slice(0, 500) });
      });
      workers.push(emailWorker);
      workers.push(new Worker('maintenance', async () => runMaintenance(), { connection: conn }));
      await maintenanceQueue.upsertJobScheduler('hourly-maintenance', { every: 60 * 60 * 1000 }, { name: 'run' });
      console.log('[jobs] BullMQ queues started');
      return;
    } catch (err) {
      console.warn('[jobs] Redis unavailable, falling back to in-process jobs', err);
      emailQueue = null;
      maintenanceQueue = null;
    }
  }
  interval = setInterval(() => runMaintenance().catch((e) => console.error('[jobs] maintenance failed', e)), 60 * 60 * 1000);
  setTimeout(() => runMaintenance().catch(() => {}), 5_000);
  console.log('[jobs] in-process scheduler started');
}

export async function stopJobs() {
  if (interval) clearInterval(interval);
  await Promise.all(workers.map((w) => w.close()));
  await emailQueue?.close();
  await maintenanceQueue?.close();
}
