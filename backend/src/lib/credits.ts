import { prisma } from "./prisma";
import { logger } from "./logger";

const MONTHLY_CREDIT_LIMIT = Number(process.env.MONTHLY_CREDIT_LIMIT) || 999999;

export async function checkCredits(
  userId: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const profile = await prisma.userProfile.findUnique({
    where: { userId },
    select: { messageCreditsUsed: true, creditsResetDate: true },
  });
  if (!profile) return { ok: true };

  if (profile.creditsResetDate && new Date() > new Date(profile.creditsResetDate)) {
    const creditsResetDate = new Date();
    creditsResetDate.setDate(creditsResetDate.getDate() + 30);
    await prisma.userProfile.update({
      where: { userId },
      data: { messageCreditsUsed: 0, creditsResetDate },
    });
    return { ok: true };
  }

  if ((profile.messageCreditsUsed ?? 0) >= MONTHLY_CREDIT_LIMIT) {
    return {
      ok: false,
      detail: "Monthly message credit limit reached. Please upgrade or wait for reset.",
    };
  }
  return { ok: true };
}

export async function incrementCredits(userId: string): Promise<void> {
  try {
    await prisma.userProfile.updateMany({
      where: { userId },
      data: { messageCreditsUsed: { increment: 1 } },
    });
  } catch (err) {
    logger.warn({ err, userId }, "[credits] failed to increment credits");
  }
}
