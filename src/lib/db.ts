import { PrismaClient } from "@prisma/client";
import { bus } from "./events";
export const db = new PrismaClient();
export const audit = (actorId: string | null, action: string, entity?: string, entityId?: string, meta?: object) =>
  db.auditLog.create({ data: { actorId, action, entity, entityId, meta: meta as any } });
export const notify = async (userId: string, kind: string, body: string) => {
  const n = await db.notification.create({ data: { userId, kind, body } });
  bus.emit(userId, n);
  return n;
};
