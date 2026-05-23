import { z } from "zod";

export const zodUUID = z.string().uuid();
export const zodNonEmptyString = z.string().min(1).max(10000);
export const zodOptionalString = z.string().max(10000).optional();
export const zodPagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const zodParamsWithId = z.object({
  params: z.object({ id: zodUUID }),
});

export const zodParamsWithProjectId = z.object({
  params: z.object({ projectId: zodUUID }),
});
