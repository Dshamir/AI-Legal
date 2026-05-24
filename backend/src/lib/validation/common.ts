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

export const zodProjectChatBody = z.object({
  params: z.object({ projectId: zodUUID }),
  body: z.object({
    messages: z
      .array(
        z.object({
          role: z.string(),
          content: z.string().nullable().optional(),
          files: z
            .array(
              z.object({
                filename: z.string(),
                document_id: z.string().optional(),
              }),
            )
            .optional(),
          workflow: z
            .object({
              id: z.string(),
              title: z.string(),
            })
            .optional(),
        }),
      )
      .min(1),
    chat_id: z.string().uuid().optional(),
    model: z.string().optional(),
    displayed_doc: z
      .object({
        filename: z.string(),
        document_id: z.string(),
      })
      .optional(),
    attached_documents: z
      .array(
        z.object({
          filename: z.string(),
          document_id: z.string(),
        }),
      )
      .optional(),
  }),
});
