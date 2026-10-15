import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Prisma, TaskStatus } from '@prisma/client';
import { prisma } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { forbidden, notFound } from '../lib/errors.js';
import { listParams, orderBy, paged, qstr, searchAny } from '../lib/list.js';
import { assertTenantRefs } from '../lib/tenantRefs.js';
import { notify } from '../lib/notify.js';
import { can, requirePerm, tid } from '../middleware/tenant.js';
import { parse } from '../middleware/validate.js';

export const tasksRouter = Router();

const date = z.coerce.date().optional().nullable().or(z.literal('').transform(() => null));
const taskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(10000).optional().nullable(),
  type: z.enum(['GENERAL', 'FOLLOW_UP', 'PROJECT', 'FEEDBACK']).optional(),
  status: z.enum(['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE', 'CANCELLED']).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  dueDate: date,
  assigneeId: z.string().optional().nullable(),
  projectId: z.string().optional().nullable(),
  milestoneId: z.string().optional().nullable(),
  leadId: z.string().optional().nullable(),
  customerId: z.string().optional().nullable(),
  feedbackId: z.string().optional().nullable(),
});

/**
 * Visibility: managers with tasks.assign see all tenant tasks. Everyone else sees tasks assigned to
 * or created by them. Developers never see CRM follow-ups, which carry commercial context.
 */
export function taskScope(req: Request): Prisma.TaskWhereInput {
  const base: Prisma.TaskWhereInput = { tenantId: tid(req) };
  if (can(req, 'tasks.assign')) return base;
  return { ...base, OR: [{ assigneeId: req.user!.id }, { createdById: req.user!.id }], ...(can(req, 'leads.read') ? {} : { type: { not: 'FOLLOW_UP' } }) };
}

const include = {
  project: { select: { id: true, code: true, name: true } },
  lead: { select: { id: true, name: true, company: true } },
  customer: { select: { id: true, name: true } },
  milestone: { select: { id: true, title: true } },
} satisfies Prisma.TaskInclude;

tasksRouter.get('/tasks', requirePerm('tasks.read'), async (req, res) => {
  const p = listParams(req, ['dueDate', 'createdAt', 'priority']);
  const status = qstr(req.query.status);
  const where: Prisma.TaskWhereInput = {
    AND: [
      taskScope(req),
      searchAny(p.q, ['title', 'description']),
      status === 'open' ? { status: { in: ['TODO', 'IN_PROGRESS', 'REVIEW'] } } : status ? { status: status as TaskStatus } : {},
      qstr(req.query.type) ? { type: req.query.type as 'FOLLOW_UP' } : {},
      qstr(req.query.projectId) ? { projectId: String(req.query.projectId) } : {},
      req.query.assignee === 'me' ? { assigneeId: req.user!.id } : qstr(req.query.assigneeId) ? { assigneeId: String(req.query.assigneeId) } : {},
      req.query.due === 'overdue' ? { dueDate: { lt: new Date() }, status: { in: ['TODO', 'IN_PROGRESS', 'REVIEW'] } } : {},
      req.query.due === 'today' ? { dueDate: { gte: new Date(new Date().setHours(0, 0, 0, 0)), lt: new Date(new Date().setHours(24, 0, 0, 0)) } } : {},
    ],
  };
  const [items, total] = await Promise.all([
    prisma.task.findMany({ where, include, orderBy: p.sort === 'dueDate' ? [{ dueDate: { sort: p.dir, nulls: 'last' } }] : orderBy(p), skip: p.skip, take: p.pageSize }),
    prisma.task.count({ where }),
  ]);
  res.json(paged(items, total, p));
});

tasksRouter.post('/tasks', requirePerm('tasks.read'), async (req, res) => {
  const body = parse(taskSchema, req.body);
  const assigneeId = body.assigneeId ?? req.user!.id;
  if (assigneeId !== req.user!.id && !can(req, 'tasks.assign')) throw forbidden('You can only create tasks for yourself');
  if (body.leadId && !can(req, 'leads.update')) throw forbidden();
  await assertTenantRefs(tid(req), {
    user: assigneeId, project: body.projectId, milestone: body.milestoneId, lead: body.leadId, customer: body.customerId, feedback: body.feedbackId,
  });
  const task = await prisma.task.create({
    data: {
      ...body, tenantId: tid(req), assigneeId, createdById: req.user!.id,
      type: body.type ?? (body.projectId ? 'PROJECT' : body.leadId ? 'FOLLOW_UP' : 'GENERAL'),
      completedAt: body.status === 'DONE' ? new Date() : null,
    },
    include,
  });
  if (assigneeId !== req.user!.id) await notify(tid(req), [assigneeId], { title: 'New task assigned', body: task.title, link: `/tasks?open=${task.id}` });
  await audit(req, { action: 'tasks.create', entityType: 'task', entityId: task.id });
  res.status(201).json(task);
});

tasksRouter.patch('/tasks/:id', requirePerm('tasks.read'), async (req, res) => {
  const task = await prisma.task.findFirst({ where: { AND: [taskScope(req), { id: String(req.params.id) }] } });
  if (!task) throw notFound('Task');
  const body = parse(taskSchema.partial(), req.body);
  const isManager = can(req, 'tasks.assign');
  if (!isManager) {
    // Assignees can update progress and details but cannot reassign.
    if (body.assigneeId && body.assigneeId !== task.assigneeId) throw forbidden('You cannot reassign tasks');
  }
  await assertTenantRefs(tid(req), { user: body.assigneeId, project: body.projectId, milestone: body.milestoneId, lead: body.leadId, customer: body.customerId });
  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { ...body, ...(body.status ? { completedAt: body.status === 'DONE' ? new Date() : null } : {}) },
    include,
  });
  if (body.assigneeId && body.assigneeId !== task.assigneeId) {
    await notify(tid(req), [body.assigneeId], { title: 'Task assigned to you', body: updated.title, link: `/tasks?open=${task.id}` });
  }
  if (body.status === 'DONE' && task.createdById && task.createdById !== req.user!.id) {
    await notify(tid(req), [task.createdById], { title: 'Task completed', body: updated.title, link: `/tasks?open=${task.id}` });
  }
  await audit(req, { action: 'tasks.update', entityType: 'task', entityId: task.id, meta: { fields: Object.keys(body) } });
  res.json(updated);
});

tasksRouter.delete('/tasks/:id', requirePerm('tasks.read'), async (req, res) => {
  const task = await prisma.task.findFirst({ where: { AND: [taskScope(req), { id: String(req.params.id) }] } });
  if (!task) throw notFound('Task');
  if (!can(req, 'tasks.assign') && task.createdById !== req.user!.id) throw forbidden('Only the creator or a manager can delete this task');
  await prisma.task.delete({ where: { id: task.id } });
  await audit(req, { action: 'tasks.delete', entityType: 'task', entityId: task.id });
  res.json({ ok: true });
});
