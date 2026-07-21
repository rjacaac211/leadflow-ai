import { Prisma, PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

export async function recordEvent(
  leadId: string,
  type: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await prisma.leadEvent.create({
    data: {
      leadId,
      type,
      detail: detail ? (detail as Prisma.InputJsonValue) : undefined,
    },
  });
}
