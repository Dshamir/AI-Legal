import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const SOFT_DELETE_MODELS = new Set([
  "Project",
  "Document",
  "DocumentVersion",
  "Chat",
  "Workflow",
  "TabularReview",
]);

const adapter = new PrismaPg(process.env.DATABASE_URL!);

const basePrisma = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === "development" ? ["query", "warn", "error"] : ["warn", "error"],
} as any);

export const prisma = basePrisma.$extends({
  query: {
    $allOperations({ model, operation, args, query }) {
      if (!model || !SOFT_DELETE_MODELS.has(model)) {
        return query(args);
      }

      if (operation === "findMany" || operation === "findFirst" || operation === "count") {
        args.where = { ...args.where, deletedAt: null };
        return query(args);
      }

      if (operation === "delete") {
        return (basePrisma as any)[model[0].toLowerCase() + model.slice(1)].update({
          ...args,
          data: { deletedAt: new Date() },
        });
      }

      if (operation === "deleteMany") {
        return (basePrisma as any)[model[0].toLowerCase() + model.slice(1)].updateMany({
          ...args,
          data: { deletedAt: new Date() },
        });
      }

      return query(args);
    },
  },
});

export type PrismaClientExtended = typeof prisma;
