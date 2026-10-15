import { prisma, type Tx } from './db.js';

export async function notify(
  tenantId: string,
  userIds: (string | null | undefined)[],
  n: { title: string; body?: string; link?: string },
  tx: Tx = prisma,
) {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (!ids.length) return;
  await tx.notification.createMany({ data: ids.map((userId) => ({ tenantId, userId, ...n })) });
}

/** Users in the tenant whose role holds the permission (used for "notify all managers" style events). */
export async function usersWithPermission(tenantId: string, perm: string) {
  const members = await prisma.membership.findMany({
    where: { tenantId, status: 'ACTIVE', role: { permissions: { has: perm } } },
    select: { userId: true },
  });
  return members.map((m) => m.userId);
}
