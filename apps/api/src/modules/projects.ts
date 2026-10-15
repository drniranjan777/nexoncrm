import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Prisma, ProjectStatus } from '@prisma/client';
import { prisma } from '../lib/db.js';
import { audit } from '../lib/audit.js';
import { forbidden, notFound } from '../lib/errors.js';
import { listParams, orderBy, paged, qstr, searchAny } from '../lib/list.js';
import { nextNumber } from '../lib/numbering.js';
import { assertTenantRefs } from '../lib/tenantRefs.js';
import { notify } from '../lib/notify.js';
import { can, requirePerm, tid } from '../middleware/tenant.js';
import { parse } from '../middleware/validate.js';

export const projectsRouter = Router();

const date = z.coerce.date().optional().nullable().or(z.literal('').transform(() => null));
const projectSchema = z.object({
  name: z.string().min(1).max(160),
  customerId: z.string().optional().nullable(),
  serviceCategory: z.string().max(80).optional().nullable(),
  status: z.enum(['PLANNING', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).optional(),
  description: z.string().max(10000).optional().nullable(),
  startDate: date,
  dueDate: date,
  budget: z.coerce.number().min(0).optional().nullable(),
  managerId: z.string().optional().nullable(),
  billingMethod: z.enum(['FIXED', 'PROJECT_HOURS']).optional(),
  hourlyRate: z.coerce.number().min(0).optional().nullable(),
});

/** Members with only projects.read_assigned (e.g. developers) see projects they belong to. */
export function projectScope(req: Request): Prisma.ProjectWhereInput {
  if (can(req, 'projects.read')) return { tenantId: tid(req) };
  if (can(req, 'projects.read_assigned')) {
    return { tenantId: tid(req), OR: [{ members: { some: { userId: req.user!.id } } }, { managerId: req.user!.id }] };
  }
  throw forbidden('Missing permission: projects.read');
}

/** Budget and commercial fields are hidden from members without financial or project-management access. */
function redact<T extends { budget?: unknown }>(req: Request, p: T): T {
  if (can(req, 'projects.update') || can(req, 'invoices.read')) return p;
  return { ...p, budget: null };
}

async function findProject(req: Request, id: string) {
  const project = await prisma.project.findFirst({ where: { AND: [projectScope(req), { id }] } });
  if (!project) throw notFound('Project');
  return project;
}

projectsRouter.get('/projects', requirePerm('projects.read', 'projects.read_assigned'), async (req, res) => {
  const p = listParams(req, ['createdAt', 'name', 'dueDate', 'code']);
  const where: Prisma.ProjectWhereInput = {
    AND: [
      projectScope(req),
      searchAny(p.q, ['name', 'code', 'description']),
      qstr(req.query.status) ? { status: req.query.status as ProjectStatus } : {},
      qstr(req.query.customerId) ? { customerId: String(req.query.customerId) } : {},
    ],
  };
  const [items, total] = await Promise.all([
    prisma.project.findMany({
      where, orderBy: orderBy(p), skip: p.skip, take: p.pageSize,
      include: {
        customer: { select: { id: true, name: true, company: true } },
        _count: { select: { tasks: true, members: true, milestones: true } },
        tasks: { select: { status: true } },
      },
    }),
    prisma.project.count({ where }),
  ]);
  res.json(paged(items.map(({ tasks, ...pr }) => redact(req, {
    ...pr,
    progress: tasks.length ? Math.round((tasks.filter((t) => t.status === 'DONE').length / tasks.filter((t) => t.status !== 'CANCELLED').length || 0) * 100) : 0,
  })), total, p));
});

projectsRouter.get('/projects/options', requirePerm('projects.read', 'projects.read_assigned', 'tickets.read', 'feedback.read', 'invoices.read'), async (req, res) => {
  const scope = can(req, 'projects.read') || !can(req, 'projects.read_assigned') ? { tenantId: tid(req) } : projectScope(req);
  const items = await prisma.project.findMany({
    where: { AND: [scope, qstr(req.query.customerId) ? { customerId: String(req.query.customerId) } : {}] },
    select: { id: true, code: true, name: true, customerId: true },
    orderBy: { createdAt: 'desc' }, take: 200,
  });
  res.json(items);
});

projectsRouter.post('/projects', requirePerm('projects.update'), async (req, res) => {
  const body = parse(projectSchema, req.body);
  await assertTenantRefs(tid(req), { customer: body.customerId, user: body.managerId });
  const project = await prisma.$transaction(async (tx) => {
    const created = await tx.project.create({
      data: { ...body, tenantId: tid(req), code: await nextNumber(tx, tid(req), 'PROJECT'), managerId: body.managerId ?? req.user!.id },
    });
    await tx.projectMember.create({ data: { projectId: created.id, userId: created.managerId!, role: 'Project Manager' } });
    return created;
  });
  await audit(req, { action: 'projects.create', entityType: 'project', entityId: project.id });
  res.status(201).json(project);
});

projectsRouter.get('/projects/:id', requirePerm('projects.read', 'projects.read_assigned'), async (req, res) => {
  const project = await findProject(req, String(req.params.id));
  const [full, users] = await Promise.all([
    prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      include: {
        customer: { select: { id: true, name: true, company: true, email: true } },
        members: true,
        milestones: { orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }], include: { _count: { select: { tasks: true } } } },
        _count: { select: { tickets: true, feedback: true } },
      },
    }),
    prisma.membership.findMany({ where: { tenantId: tid(req) }, select: { userId: true, user: { select: { name: true, email: true } } } }),
  ]);
  const names = new Map(users.map((u) => [u.userId, u.user]));
  const taskStats = await prisma.task.groupBy({ by: ['status'], where: { tenantId: tid(req), projectId: project.id }, _count: true });
  res.json(redact(req, {
    ...full,
    members: full.members.map((m) => ({ ...m, user: names.get(m.userId) ?? null })),
    taskStats: Object.fromEntries(taskStats.map((t) => [t.status, t._count])),
  }));
});

projectsRouter.patch('/projects/:id', requirePerm('projects.update'), async (req, res) => {
  const project = await findProject(req, String(req.params.id));
  const body = parse(projectSchema.partial(), req.body);
  await assertTenantRefs(tid(req), { customer: body.customerId, user: body.managerId });
  const updated = await prisma.project.update({ where: { id: project.id }, data: body });
  if (body.managerId) {
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: project.id, userId: body.managerId } },
      create: { projectId: project.id, userId: body.managerId, role: 'Project Manager' }, update: {},
    });
  }
  await audit(req, { action: 'projects.update', entityType: 'project', entityId: project.id, meta: { fields: Object.keys(body) } });
  res.json(updated);
});

projectsRouter.delete('/projects/:id', requirePerm('projects.update'), async (req, res) => {
  const project = await findProject(req, String(req.params.id));
  const invoices = await prisma.invoice.count({ where: { tenantId: tid(req), projectId: project.id } });
  if (invoices) {
    await prisma.project.update({ where: { id: project.id }, data: { status: 'CANCELLED' } });
    return res.json({ ok: true, cancelled: true });
  }
  await prisma.project.delete({ where: { id: project.id } });
  await audit(req, { action: 'projects.delete', entityType: 'project', entityId: project.id, meta: { name: project.name } });
  res.json({ ok: true });
});

// ── Members (team assignments) ──

projectsRouter.get('/team-assignments', requirePerm('projects.read'), async (req, res) => {
  const [members, users, openTasks] = await Promise.all([
    prisma.projectMember.findMany({
      where: { project: { tenantId: tid(req), status: { in: ['PLANNING', 'IN_PROGRESS', 'ON_HOLD'] } } },
      include: { project: { select: { id: true, code: true, name: true, status: true } } },
    }),
    prisma.membership.findMany({
      where: { tenantId: tid(req), status: 'ACTIVE', role: { key: { not: 'customer' } } },
      select: { userId: true, title: true, user: { select: { name: true, email: true } }, role: { select: { name: true } } },
    }),
    prisma.task.groupBy({ by: ['assigneeId'], where: { tenantId: tid(req), status: { in: ['TODO', 'IN_PROGRESS', 'REVIEW'] } }, _count: true }),
  ]);
  const taskCount = new Map(openTasks.map((t) => [t.assigneeId, t._count]));
  res.json(users.map((u) => ({
    userId: u.userId, name: u.user.name, email: u.user.email, role: u.role.name, title: u.title,
    openTasks: taskCount.get(u.userId) ?? 0,
    projects: members.filter((m) => m.userId === u.userId).map((m) => ({ ...m.project, memberRole: m.role })),
  })));
});

projectsRouter.post('/projects/:id/members', requirePerm('projects.update'), async (req, res) => {
  const project = await findProject(req, String(req.params.id));
  const body = parse(z.object({ userId: z.string(), role: z.string().max(80).optional() }), req.body);
  await assertTenantRefs(tid(req), { user: body.userId });
  const member = await prisma.projectMember.upsert({
    where: { projectId_userId: { projectId: project.id, userId: body.userId } },
    create: { projectId: project.id, userId: body.userId, role: body.role }, update: { role: body.role },
  });
  await notify(tid(req), [body.userId], { title: 'Added to project', body: `${project.code} ${project.name}`, link: `/projects/${project.id}` });
  await audit(req, { action: 'projects.member_add', entityType: 'project', entityId: project.id, meta: { userId: body.userId } });
  res.status(201).json(member);
});

projectsRouter.delete('/projects/:id/members/:userId', requirePerm('projects.update'), async (req, res) => {
  const project = await findProject(req, String(req.params.id));
  await prisma.projectMember.deleteMany({ where: { projectId: project.id, userId: String(req.params.userId) } });
  await audit(req, { action: 'projects.member_remove', entityType: 'project', entityId: project.id, meta: { userId: req.params.userId } });
  res.json({ ok: true });
});

// ── Milestones ──

const milestoneSchema = z.object({
  projectId: z.string(),
  title: z.string().min(1).max(200),
  dueDate: date,
  status: z.enum(['PENDING', 'IN_PROGRESS', 'DONE']).optional(),
});

projectsRouter.get('/milestones', requirePerm('projects.read', 'projects.read_assigned'), async (req, res) => {
  const items = await prisma.milestone.findMany({
    where: {
      tenantId: tid(req),
      project: projectScope(req),
      ...(qstr(req.query.projectId) ? { projectId: String(req.query.projectId) } : {}),
      ...(qstr(req.query.status) ? { status: req.query.status as 'PENDING' } : {}),
    },
    include: { project: { select: { id: true, code: true, name: true } }, tasks: { select: { status: true } } },
    orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }],
    take: 500,
  });
  res.json(items.map(({ tasks, ...m }) => ({ ...m, taskCount: tasks.length, doneCount: tasks.filter((t) => t.status === 'DONE').length })));
});

projectsRouter.post('/milestones', requirePerm('projects.update'), async (req, res) => {
  const body = parse(milestoneSchema, req.body);
  await findProject(req, body.projectId);
  const m = await prisma.milestone.create({ data: { ...body, tenantId: tid(req) } });
  res.status(201).json(m);
});

projectsRouter.patch('/milestones/:id', requirePerm('projects.update'), async (req, res) => {
  const body = parse(milestoneSchema.omit({ projectId: true }).partial(), req.body);
  const r = await prisma.milestone.updateMany({ where: { id: String(req.params.id), tenantId: tid(req) }, data: body });
  if (!r.count) throw notFound('Milestone');
  res.json(await prisma.milestone.findUnique({ where: { id: String(req.params.id) } }));
});

projectsRouter.delete('/milestones/:id', requirePerm('projects.update'), async (req, res) => {
  const r = await prisma.milestone.deleteMany({ where: { id: String(req.params.id), tenantId: tid(req) } });
  if (!r.count) throw notFound('Milestone');
  res.json({ ok: true });
});
