import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { auditLog } from "../lib/audit";

export const workflowsRouter = Router();

type WorkflowRecord = {
  id: string;
  userId: string | null;
  isSystem: boolean;
  [key: string]: unknown;
};

type WorkflowAccess = {
  workflow: WorkflowRecord;
  allowEdit: boolean;
  isOwner: boolean;
} | null;

type AsyncRoute = (req: Request, res: Response) => Promise<unknown>;

function asyncRoute(handler: AsyncRoute) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

function withWorkflowAccess<T extends Record<string, unknown>>(
  workflow: T,
  access: { allowEdit: boolean; isOwner: boolean; sharedByName?: string | null },
) {
  return {
    ...workflow,
    allow_edit: access.allowEdit,
    is_owner: access.isOwner,
    shared_by_name: access.sharedByName ?? null,
  };
}

async function loadSharerNames(sharerIds: string[]): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(sharerIds.filter(Boolean))];
  const names = new Map<string, string>();
  if (uniqueIds.length === 0) return names;

  try {
    const profiles = await prisma.userProfile.findMany({
      where: { userId: { in: uniqueIds } },
      select: { userId: true, displayName: true },
    });

    for (const profile of profiles) {
      if (profile.userId && profile.displayName) {
        names.set(profile.userId, profile.displayName);
      }
    }
  } catch (err) {
    logger.warn({ err }, "[workflows] sharer profile lookup threw");
  }

  // For missing profiles, we can't look up emails without Supabase auth.
  // In future, consider a user table or auth integration.
  // For now, just return what we have from profiles.

  return names;
}

async function resolveWorkflowAccess(
  workflowId: string,
  userId: string,
  userEmail: string | null | undefined,
): Promise<WorkflowAccess> {
  const workflow = await prisma.workflow.findUnique({
    where: { id: workflowId },
  });
  if (!workflow) return null;
  const workflowRecord = workflow as unknown as WorkflowRecord;
  if (workflowRecord.userId === userId) {
    return { workflow: workflowRecord, allowEdit: true, isOwner: true };
  }

  const normalizedUserEmail = (userEmail ?? "").trim().toLowerCase();
  if (!normalizedUserEmail) return null;

  const share = await prisma.workflowShare.findFirst({
    where: {
      workflowId,
      sharedWithEmail: normalizedUserEmail,
    },
    select: { allowEdit: true },
  });
  if (!share) return null;

  return { workflow: workflowRecord, allowEdit: share.allowEdit, isOwner: false };
}

// GET /workflows
workflowsRouter.get(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string;
    const { type } = req.query as { type?: string };

    // Own workflows
    const ownWhere: Record<string, unknown> = {
      userId,
      isSystem: false,
    };
    if (type) ownWhere.type = type;
    const own = await prisma.workflow.findMany({
      where: ownWhere,
      orderBy: { createdAt: "desc" },
    });

    // Shared workflows (where the current user's email appears in workflow_shares)
    const normalizedUserEmail = userEmail.trim().toLowerCase();
    const shares = await prisma.workflowShare.findMany({
      where: { sharedWithEmail: normalizedUserEmail },
      select: { workflowId: true, sharedByUserId: true, allowEdit: true },
    });

    let sharedWorkflows: Record<string, unknown>[] = [];
    if (shares.length > 0) {
      const sharedIds = shares.map((s) => s.workflowId);
      const sharedWhere: Record<string, unknown> = {
        id: { in: sharedIds },
      };
      if (type) sharedWhere.type = type;
      const wfs = await prisma.workflow.findMany({
        where: sharedWhere,
      });

      if (wfs.length > 0) {
        const sharerIds = [...new Set(shares.map((s) => s.sharedByUserId).filter(Boolean))];
        const sharerNames = await loadSharerNames(sharerIds);

        sharedWorkflows = wfs.map((wf) => {
          const share = shares.find((s) => s.workflowId === wf.id);
          const sharerId = share?.sharedByUserId;
          const shared_by_name = sharerId ? (sharerNames.get(sharerId) ?? null) : null;
          return withWorkflowAccess(wf as unknown as Record<string, unknown>, {
            allowEdit: !!share?.allowEdit,
            isOwner: false,
            sharedByName: shared_by_name,
          });
        });
      }
    }

    const ownWithFlag = own.map((wf) =>
      withWorkflowAccess(wf as unknown as Record<string, unknown>, {
        allowEdit: true,
        isOwner: true,
      }),
    );
    res.json([...ownWithFlag, ...sharedWorkflows]);
  }),
);

// POST /workflows
workflowsRouter.post(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const { title, type, prompt_md, columns_config, practice } = req.body as {
      title: string;
      type: string;
      prompt_md?: string;
      columns_config?: unknown;
      practice?: string | null;
    };
    if (!title?.trim()) return void res.status(400).json({ detail: "title is required" });
    if (!["assistant", "tabular"].includes(type))
      return void res.status(400).json({ detail: "type must be 'assistant' or 'tabular'" });

    const workflow = await prisma.workflow.create({
      data: {
        userId,
        title: title.trim(),
        type,
        promptMd: prompt_md ?? null,
        columnsConfig: columns_config ?? undefined,
        practice: practice ?? null,
        isSystem: false,
      },
    });

    await auditLog({
      userId,
      action: "create",
      entity: "workflow",
      entityId: workflow.id,
    });

    res.status(201).json(workflow);
  }),
);

async function handleWorkflowUpdate(req: Request, res: Response) {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const updates: Record<string, unknown> = {};
  if (req.body.title != null) updates.title = req.body.title;
  if (req.body.prompt_md != null) updates.promptMd = req.body.prompt_md;
  if (req.body.columns_config != null) updates.columnsConfig = req.body.columns_config;
  if ("practice" in req.body) updates.practice = req.body.practice ?? null;

  const access = await resolveWorkflowAccess(workflowId, userId, userEmail);
  if (!access || access.workflow.isSystem || !access.allowEdit) {
    return void res.status(404).json({ detail: "Workflow not found or not editable" });
  }

  const data = await prisma.workflow.update({
    where: { id: workflowId },
    data: updates,
  });

  await auditLog({
    userId,
    action: "update",
    entity: "workflow",
    entityId: workflowId,
  });

  res.json(
    withWorkflowAccess(data as unknown as Record<string, unknown>, {
      allowEdit: access.allowEdit,
      isOwner: access.isOwner,
    }),
  );
}

// POST /workflows/import
workflowsRouter.post(
  "/import",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const body = req.body;

    if (!body || typeof body !== "object" || body.version !== 1)
      return void res.status(400).json({ detail: "Invalid workflow file format" });
    if (!body.title?.trim())
      return void res.status(400).json({ detail: "Workflow title is required" });
    if (!["assistant", "tabular"].includes(body.type))
      return void res.status(400).json({ detail: "type must be 'assistant' or 'tabular'" });

    const workflow = await prisma.workflow.create({
      data: {
        userId,
        title: body.title.trim(),
        type: body.type,
        promptMd: body.prompt_md ?? null,
        columnsConfig: body.columns_config ?? undefined,
        practice: body.practice ?? null,
        isSystem: false,
      },
    });

    await auditLog({ userId, action: "import", entity: "workflow", entityId: workflow.id });
    res.status(201).json(workflow);
  }),
);

// PUT /workflows/:workflowId
workflowsRouter.put("/:workflowId", requireAuth, asyncRoute(handleWorkflowUpdate));

// PATCH /workflows/:workflowId
workflowsRouter.patch("/:workflowId", requireAuth, asyncRoute(handleWorkflowUpdate));

// DELETE /workflows/:workflowId
workflowsRouter.delete(
  "/:workflowId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const { workflowId } = req.params;

    // Verify ownership + non-system before deleting
    const wf = await prisma.workflow.findFirst({
      where: { id: workflowId, userId, isSystem: false },
    });
    if (!wf) return void res.status(404).json({ detail: "Workflow not found" });

    await prisma.workflow.delete({ where: { id: workflowId } });

    await auditLog({
      userId,
      action: "delete",
      entity: "workflow",
      entityId: workflowId,
    });

    res.status(204).send();
  }),
);

// GET /workflows/:workflowId/export
workflowsRouter.get(
  "/:workflowId/export",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { workflowId } = req.params;

    const access = await resolveWorkflowAccess(workflowId, userId, userEmail);
    if (!access) return void res.status(404).json({ detail: "Workflow not found" });

    const wf = access.workflow as Record<string, unknown>;
    const exportData = {
      version: 1,
      type: wf.type,
      title: wf.title,
      prompt_md: wf.promptMd ?? null,
      columns_config: wf.columnsConfig ?? null,
      practice: wf.practice ?? null,
      exported_at: new Date().toISOString(),
    };

    const safeTitle =
      String(wf.title ?? "workflow")
        .replace(/[^a-zA-Z0-9 _-]/g, "")
        .trim()
        .slice(0, 64) || "workflow";
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.mikeworkflow.json"`);
    res.json(exportData);
  }),
);

// GET /workflows/hidden
workflowsRouter.get(
  "/hidden",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const hidden = await prisma.hiddenWorkflow.findMany({
      where: { userId },
      select: { workflowId: true },
    });
    res.json(hidden.map((r) => r.workflowId));
  }),
);

// POST /workflows/hidden
workflowsRouter.post(
  "/hidden",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const { workflow_id } = req.body as { workflow_id: string };
    if (!workflow_id?.trim())
      return void res.status(400).json({ detail: "workflow_id is required" });

    await prisma.hiddenWorkflow.upsert({
      where: { userId_workflowId: { userId, workflowId: workflow_id } },
      create: { userId, workflowId: workflow_id },
      update: {},
    });
    res.status(204).send();
  }),
);

// DELETE /workflows/hidden/:workflowId
workflowsRouter.delete(
  "/hidden/:workflowId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const { workflowId } = req.params;
    await prisma.hiddenWorkflow.deleteMany({
      where: { userId, workflowId },
    });
    res.status(204).send();
  }),
);

// GET /workflows/:workflowId
workflowsRouter.get(
  "/:workflowId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { workflowId } = req.params;
    const access = await resolveWorkflowAccess(workflowId, userId, userEmail);
    if (!access) return void res.status(404).json({ detail: "Workflow not found" });
    res.json(
      withWorkflowAccess(access.workflow as unknown as Record<string, unknown>, {
        allowEdit: access.allowEdit,
        isOwner: access.isOwner,
      }),
    );
  }),
);

// GET /workflows/:workflowId/shares
workflowsRouter.get(
  "/:workflowId/shares",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const { workflowId } = req.params;

    const wf = await prisma.workflow.findFirst({
      where: { id: workflowId, userId, isSystem: false },
    });
    if (!wf) return void res.status(404).json({ detail: "Workflow not found or not editable" });

    const shares = await prisma.workflowShare.findMany({
      where: { workflowId },
      select: { id: true, sharedWithEmail: true, allowEdit: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    res.json(shares);
  }),
);

// DELETE /workflows/:workflowId/shares/:shareId
workflowsRouter.delete(
  "/:workflowId/shares/:shareId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const { workflowId, shareId } = req.params;

    const wf = await prisma.workflow.findFirst({
      where: { id: workflowId, userId },
    });
    if (!wf) return void res.status(404).json({ detail: "Workflow not found" });

    await prisma.workflowShare.deleteMany({
      where: { id: shareId, workflowId },
    });
    res.status(204).send();
  }),
);

// POST /workflows/:workflowId/share
workflowsRouter.post(
  "/:workflowId/share",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { workflowId } = req.params;
    const { emails, allow_edit } = req.body as { emails: string[]; allow_edit: boolean };

    if (!emails?.length) return void res.status(400).json({ detail: "emails is required" });
    const normalizedEmails = [
      ...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean)),
    ];
    if (normalizedEmails.length === 0) {
      return void res.status(400).json({ detail: "emails is required" });
    }
    const normalizedUserEmail = userEmail?.trim().toLowerCase();
    if (normalizedUserEmail && normalizedEmails.includes(normalizedUserEmail)) {
      return void res.status(400).json({ detail: "You cannot share a workflow with yourself." });
    }

    // Verify ownership
    const wf = await prisma.workflow.findFirst({
      where: { id: workflowId, userId, isSystem: false },
    });
    if (!wf) return void res.status(404).json({ detail: "Workflow not found or not editable" });

    for (const email of normalizedEmails) {
      await prisma.workflowShare.upsert({
        where: {
          workflowId_sharedWithEmail: { workflowId, sharedWithEmail: email },
        },
        create: {
          workflowId,
          sharedByUserId: userId,
          sharedWithEmail: email,
          allowEdit: allow_edit ?? false,
        },
        update: {
          allowEdit: allow_edit ?? false,
        },
      });
    }

    res.status(204).send();
  }),
);

workflowsRouter.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  logger.error({ err }, "[workflows] unhandled route error");
  res.status(500).json({ detail: "Failed to process workflow request" });
});
