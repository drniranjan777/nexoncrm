import { prisma } from '../lib/db.js';
import { notify } from '../lib/notify.js';
import { runDueRecurringProfiles } from '../modules/billing.js';

/**
 * Periodic housekeeping. Every query is scoped per tenant via the rows it touches;
 * notifications are created with the owning tenantId of each record.
 */
export async function runMaintenance(now = new Date()) {
  // 1. Overdue invoices
  const overdue = await prisma.invoice.updateMany({
    where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] }, dueDate: { lt: now } },
    data: { status: 'OVERDUE' },
  });

  // 2. Follow-up reminders for tasks due in the next 24h that have not been reminded yet.
  const soon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const dueTasks = await prisma.task.findMany({
    where: { status: { in: ['TODO', 'IN_PROGRESS'] }, dueDate: { gte: now, lte: soon }, assigneeId: { not: null } },
    select: { id: true, tenantId: true, title: true, assigneeId: true },
  });
  for (const t of dueTasks) {
    const already = await prisma.notification.findFirst({
      where: { tenantId: t.tenantId, userId: t.assigneeId!, link: `/tasks?open=${t.id}` },
      select: { id: true },
    });
    if (!already) {
      await notify(t.tenantId, [t.assigneeId], { title: 'Task due soon', body: t.title, link: `/tasks?open=${t.id}` });
    }
  }

  // 3. Expire quotations past validity
  const expired = await prisma.quotation.updateMany({
    where: { status: { in: ['DRAFT', 'SENT'] }, validUntil: { lt: now } },
    data: { status: 'EXPIRED' },
  });

  // 3b. Expire proforma invoices past validity (accepted ones stay open for conversion)
  const expiredProforma = await prisma.proformaInvoice.updateMany({
    where: { status: { in: ['SENT', 'VIEWED'] }, validUntil: { lt: now } },
    data: { status: 'EXPIRED' },
  });

  // 4. Trial expiry → PAST_DUE so the platform admin can follow up
  const trials = await prisma.tenant.updateMany({
    where: { status: 'TRIAL', trialEndsAt: { lt: now } },
    data: { status: 'PAST_DUE' },
  });

  // 5. Recurring invoices that are due
  const recurringCreated = await runDueRecurringProfiles(now);

  return { recurringCreated, overdueInvoices: overdue.count, reminders: dueTasks.length, expiredQuotations: expired.count, expiredProforma: expiredProforma.count, expiredTrials: trials.count };
}
