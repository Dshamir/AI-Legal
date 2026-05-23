import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding development data...");

  const profile = await prisma.userProfile.upsert({
    where: { userId: "00000000-0000-0000-0000-000000000001" },
    update: {},
    create: {
      userId: "00000000-0000-0000-0000-000000000001",
      displayName: "Dev User",
      organisation: "Mike Dev",
      tier: "Free",
    },
  });

  const project = await prisma.project.upsert({
    where: { id: "00000000-0000-0000-0000-000000000010" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000010",
      userId: profile.userId,
      name: "Sample Project",
      visibility: "private_",
    },
  });

  console.log("Seeded: profile=" + profile.id + ", project=" + project.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
