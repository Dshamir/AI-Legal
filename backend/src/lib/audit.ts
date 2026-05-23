import { prisma } from "./prisma";
import { logger } from "./logger";

export async function auditLog(params: {
  userId: string;
  action: "create" | "update" | "delete" | "restore";
  entity: string;
  entityId: string;
  changes?: Record<string, unknown>;
  ipAddress?: string;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: params.userId,
        action: params.action,
        entity: params.entity,
        entityId: params.entityId,
        changes: (params.changes as any) ?? undefined,
        ipAddress: params.ipAddress ?? null,
      },
    });
  } catch (err) {
    logger.error({ err, ...params }, "Failed to write audit log");
  }
}
