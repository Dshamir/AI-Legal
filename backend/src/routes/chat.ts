import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../lib/prisma";
import {
  buildDocContext,
  buildMessages,
  enrichWithPriorEvents,
  buildWorkflowStore,
  extractAnnotations,
  runLLMStream,
  type ChatMessage,
} from "../lib/chatTools";
import { completeText } from "../lib/llm";
import { getUserApiKeys, getUserModelSettings } from "../lib/userSettings";
import { checkProjectAccess } from "../lib/access";
import { logger } from "../lib/logger";
import { auditLog } from "../lib/audit";
import { withStreamTimeout, StreamTimeoutError } from "../lib/streamTimeout";
import { checkCredits, incrementCredits } from "../lib/credits";

export const chatRouter = Router();

const isDev = process.env.NODE_ENV !== "production";
const devLog = (msg: string, data?: Record<string, unknown>) => {
  if (isDev) logger.debug(data ?? {}, msg);
};

type AccessibleChat = {
  id: string;
  title: string | null;
  userId: string;
  projectId: string | null;
} & Record<string, unknown>;

function parseOptionalProjectId(
  value: unknown,
): { ok: true; provided: boolean; projectId: string | null } | { ok: false; detail: string } {
  if (value === undefined) return { ok: true, provided: false, projectId: null };
  if (value === null) return { ok: true, provided: true, projectId: null };
  if (typeof value !== "string" || !value.trim()) {
    return {
      ok: false,
      detail: "project_id must be a non-empty string or null",
    };
  }
  return { ok: true, provided: true, projectId: value.trim() };
}

function parseOptionalChatId(
  value: unknown,
): { ok: true; chatId: string | null } | { ok: false; detail: string } {
  if (value === undefined || value === null) return { ok: true, chatId: null };
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, detail: "chat_id must be a non-empty string" };
  }
  return { ok: true, chatId: value.trim() };
}

function parseChatMessages(
  value: unknown,
): { ok: true; messages: ChatMessage[] } | { ok: false; detail: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, detail: "messages must be a non-empty array" };
  }

  for (const message of value) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return { ok: false, detail: "messages must contain objects" };
    }
    const row = message as Record<string, unknown>;
    if (typeof row.role !== "string") {
      return { ok: false, detail: "message.role must be a string" };
    }
    if (row.content !== null && typeof row.content !== "string") {
      return {
        ok: false,
        detail: "message.content must be a string or null",
      };
    }
  }

  return { ok: true, messages: value as ChatMessage[] };
}

function parseOptionalModel(
  value: unknown,
): { ok: true; model: string | undefined } | { ok: false; detail: string } {
  if (value === undefined) return { ok: true, model: undefined };
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, detail: "model must be a non-empty string" };
  }
  return { ok: true, model: value.trim() };
}

async function validateAccessibleProjectId(
  projectId: string | null,
  userId: string,
  userEmail: string | null | undefined,
): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
  if (!projectId) return { ok: true };
  const access = await checkProjectAccess(projectId, userId, userEmail);
  if (!access.ok) return { ok: false, status: 404, detail: "Project not found" };
  return { ok: true };
}

async function getAccessibleChat(
  chatId: string,
  userId: string,
  userEmail: string | null | undefined,
): Promise<AccessibleChat | null> {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
  });
  if (!chat) return null;

  const row = chat as unknown as AccessibleChat;
  if (row.userId === userId) return row;

  if (row.projectId) {
    const access = await checkProjectAccess(row.projectId, userId, userEmail);
    if (access.ok) return row;
  }

  return null;
}

// GET /chat
// Visible chats = the user's own chats + every chat under a project the
// user owns (so a project owner sees all collaborator chats in their
// own projects in the global recent-chats list). Chats in projects that
// are merely *shared with* the user are NOT included here — those are
// listed per-project via GET /projects/:projectId/chats.
chatRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const requestedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;

  const before = typeof req.query.before === "string" ? new Date(req.query.before) : null;
  const isValidBefore = before && !isNaN(before.getTime());

  const ownProjects = await prisma.project.findMany({
    where: { userId },
    select: { id: true },
  });
  const ownProjectIds = ownProjects.map((p) => p.id);

  const whereClause: any = {
    OR: [{ userId }, ...(ownProjectIds.length > 0 ? [{ projectId: { in: ownProjectIds } }] : [])],
  };
  if (isValidBefore) {
    whereClause.createdAt = { lt: before };
  }

  const chats = await prisma.chat.findMany({
    where: whereClause,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  res.json(chats);
});

// POST /chat/create
chatRouter.post("/create", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const parsedProjectId = parseOptionalProjectId(req.body?.project_id);
  if (!parsedProjectId.ok) {
    return void res.status(400).json({ detail: parsedProjectId.detail });
  }
  const projectId = parsedProjectId.projectId;
  const projectAccess = await validateAccessibleProjectId(projectId, userId, userEmail);
  if (!projectAccess.ok)
    return void res.status(projectAccess.status).json({ detail: projectAccess.detail });

  const chat = await prisma.chat.create({
    data: { userId, projectId: projectId ?? null },
    select: { id: true },
  });

  await auditLog({
    userId,
    action: "create",
    entity: "chat",
    entityId: chat.id,
  });

  res.json({ id: chat.id });
});

// GET /chat/:chatId
chatRouter.get("/:chatId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { chatId } = req.params;

  const chat = await getAccessibleChat(chatId, userId, userEmail);
  if (!chat) return void res.status(404).json({ detail: "Chat not found" });

  const messages = await prisma.chatMessage.findMany({
    where: { chatId },
    orderBy: { createdAt: "asc" },
  });

  const hydrated = await hydrateEditStatuses(messages as unknown as Record<string, unknown>[]);
  res.json({ chat, messages: hydrated });
});

// Stored message annotations/events capture the `status` at the time the
// assistant produced the edit (always "pending"). If the user later accepts
// or rejects, `document_edits.status` is updated but the stored message
// annotation is not. On chat load we merge the current DB status in so
// EditCards render with the real state.
async function hydrateEditStatuses(
  messages: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const editIds = new Set<string>();
  const versionIds = new Set<string>();
  const collectFromAnnList = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const a of list as Record<string, unknown>[]) {
      if (typeof a?.edit_id === "string") editIds.add(a.edit_id);
      if (typeof a?.version_id === "string") versionIds.add(a.version_id);
    }
  };
  for (const m of messages) {
    collectFromAnnList(m.annotations);
    const content = m.content;
    if (Array.isArray(content)) {
      for (const ev of content as Record<string, unknown>[]) {
        if (ev?.type === "doc_edited") {
          collectFromAnnList(ev.annotations);
          if (typeof ev.version_id === "string") versionIds.add(ev.version_id);
        }
      }
    }
  }
  if (editIds.size === 0 && versionIds.size === 0) return messages;

  // Edit status patch.
  const statusById = new Map<string, "pending" | "accepted" | "rejected">();
  if (editIds.size > 0) {
    const rows = await prisma.documentEdit.findMany({
      where: { id: { in: Array.from(editIds) } },
      select: { id: true, status: true },
    });
    for (const r of rows) {
      if (r.status === "pending" || r.status === "accepted" || r.status === "rejected") {
        statusById.set(r.id, r.status);
      }
    }
  }

  // Version-number patch — old stored events don't carry `version_number`
  // because they predate the schema change. Look it up from
  // document_versions so the UI can render "V3" chips + download filenames.
  const versionNumberById = new Map<string, number | null>();
  if (versionIds.size > 0) {
    const vrows = await prisma.documentVersion.findMany({
      where: { id: { in: Array.from(versionIds) } },
      select: { id: true, versionNumber: true },
    });
    for (const r of vrows) {
      versionNumberById.set(r.id, r.versionNumber ?? null);
    }
  }

  const patchAnnList = (list: unknown): unknown => {
    if (!Array.isArray(list)) return list;
    return (list as Record<string, unknown>[]).map((a) => {
      let next = a;
      if (typeof a?.edit_id === "string" && statusById.has(a.edit_id)) {
        next = { ...next, status: statusById.get(a.edit_id) };
      }
      if (typeof a?.version_id === "string" && versionNumberById.has(a.version_id)) {
        next = {
          ...next,
          version_number: versionNumberById.get(a.version_id) ?? null,
        };
      }
      return next;
    });
  };
  return messages.map((m) => {
    const next: Record<string, unknown> = { ...m };
    next.annotations = patchAnnList(m.annotations);
    if (Array.isArray(m.content)) {
      next.content = (m.content as Record<string, unknown>[]).map((ev) => {
        if (ev?.type !== "doc_edited") return ev;
        let patched: Record<string, unknown> = {
          ...ev,
          annotations: patchAnnList(ev.annotations),
        };
        if (typeof ev.version_id === "string" && versionNumberById.has(ev.version_id)) {
          patched = {
            ...patched,
            version_number: versionNumberById.get(ev.version_id) ?? null,
          };
        }
        return patched;
      });
    }
    return next;
  });
}

// PATCH /chat/:chatId
chatRouter.patch("/:chatId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { chatId } = req.params;
  const title = (req.body.title ?? "").trim();
  if (!title) return void res.status(400).json({ detail: "title is required" });

  // Only the chat owner can rename
  const existing = await prisma.chat.findFirst({
    where: { id: chatId, userId },
  });
  if (!existing) return void res.status(404).json({ detail: "Chat not found" });

  const data = await prisma.chat.update({
    where: { id: chatId },
    data: { title },
    select: { id: true, title: true },
  });

  res.json(data);
});

// DELETE /chat/:chatId
chatRouter.delete("/:chatId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { chatId } = req.params;

  const existing = await prisma.chat.findFirst({
    where: { id: chatId, userId },
  });
  if (!existing) return void res.status(404).json({ detail: "Chat not found" });

  await prisma.chat.delete({ where: { id: chatId } });

  await auditLog({
    userId,
    action: "delete",
    entity: "chat",
    entityId: chatId,
  });

  res.status(204).send();
});

// POST /chat/:chatId/generate-title
chatRouter.post("/:chatId/generate-title", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { chatId } = req.params;
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) return void res.status(400).json({ detail: "message is required" });

  const chat = await getAccessibleChat(chatId, userId, userEmail);
  if (!chat) return void res.status(404).json({ detail: "Chat not found" });

  try {
    const { title_model, api_keys } = await getUserModelSettings(userId);
    const titleText = await completeText({
      model: title_model,
      user: `Generate a concise title (3–6 words) for a chat in an AI Legal Platform that starts with this message. The title should describe the topic or document — do NOT include words like "Legal Assistant", "AI", "Chat", or any similar prefix. Return only the title, no quotes or punctuation.\n\nMessage: ${message.slice(0, 500)}`,
      maxTokens: 64,
      apiKeys: api_keys,
    });
    const title = titleText.trim() || message.slice(0, 60);

    await prisma.chat.update({
      where: { id: chatId },
      data: { title },
    });

    res.json({ title });
  } catch (err) {
    logger.error({ err }, "[generate-title]");
    res.status(500).json({ detail: "Failed to generate title" });
  }
});

// POST /chat — streaming
chatRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  const parsedMessages = parseChatMessages(body.messages);
  if (!parsedMessages.ok) {
    return void res.status(400).json({ detail: parsedMessages.detail });
  }
  const parsedChatId = parseOptionalChatId(body.chat_id);
  if (!parsedChatId.ok) {
    return void res.status(400).json({ detail: parsedChatId.detail });
  }
  const parsedProjectId = parseOptionalProjectId(body.project_id);
  if (!parsedProjectId.ok) {
    return void res.status(400).json({ detail: parsedProjectId.detail });
  }
  const parsedModel = parseOptionalModel(body.model);
  if (!parsedModel.ok) {
    return void res.status(400).json({ detail: parsedModel.detail });
  }

  const messages = parsedMessages.messages;
  const chat_id = parsedChatId.chatId;
  const project_id = parsedProjectId.projectId;
  const model = parsedModel.model;

  devLog("[chat/stream] incoming request", {
    userId,
    chat_id,
    project_id,
    model,
    messageCount: messages?.length,
  });

  const userEmail = res.locals.userEmail as string | undefined;
  let chatId = chat_id ?? null;
  let chatTitle: string | null = null;
  let resolvedProjectId: string | null = parsedProjectId.projectId;

  if (chatId) {
    const existing = await getAccessibleChat(chatId, userId, userEmail);
    if (!existing) return void res.status(404).json({ detail: "Chat not found" });

    const existingProjectId = existing.projectId ?? null;
    if (parsedProjectId.provided && parsedProjectId.projectId !== existingProjectId) {
      return void res.status(400).json({ detail: "project_id does not match chat" });
    }
    resolvedProjectId = existingProjectId;
    chatTitle = existing.title;
  }

  if (!chatId) {
    // If creating a chat tied to a project, the user must have access
    // to the project (own or shared).
    const projectAccess = await validateAccessibleProjectId(resolvedProjectId, userId, userEmail);
    if (!projectAccess.ok)
      return void res.status(projectAccess.status).json({ detail: projectAccess.detail });

    const newChat = await prisma.chat.create({
      data: { userId, projectId: resolvedProjectId },
      select: { id: true, title: true },
    });
    chatId = newChat.id;
    chatTitle = newChat.title;
  }

  devLog("[chat/stream] resolved chatId", { chatId });

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (lastUser) {
    await prisma.chatMessage.create({
      data: {
        chatId,
        role: "user",
        content: lastUser.content ?? undefined,
        files: (lastUser.files as any) ?? undefined,
      },
    });
  }

  const { docIndex, docStore } = await buildDocContext(messages, userId, chatId);
  const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
    doc_id,
    filename: info.filename,
  }));
  const enrichedMessages = await enrichWithPriorEvents(messages, chatId, docIndex);
  const apiMessages = buildMessages(enrichedMessages, docAvailability);

  const workflowStore = await buildWorkflowStore(userId, userEmail);

  const creditCheck = await checkCredits(userId);
  if (!creditCheck.ok) {
    return void res.status(429).json({ detail: creditCheck.detail });
  }

  devLog("[chat/stream] starting LLM stream", {
    apiMessageCount: apiMessages.length,
    docCount: Object.keys(docIndex).length,
    workflowCount: Object.keys(workflowStore).length,
  });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const write = (line: string) => res.write(line);

  const apiKeys = await getUserApiKeys(userId);

  try {
    write(`data: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`);

    const { fullText, events } = await withStreamTimeout(
      runLLMStream({
        apiMessages,
        docStore,
        docIndex,
        userId,
        write,
        workflowStore,
        model,
        apiKeys,
        projectId: resolvedProjectId,
      }),
    );

    devLog("[chat/stream] LLM stream finished", {
      fullTextLen: fullText?.length ?? 0,
      eventCount: events?.length ?? 0,
    });

    const annotations = extractAnnotations(fullText, docIndex, events);
    await prisma.chatMessage.create({
      data: {
        chatId,
        role: "assistant",
        content: events.length ? (events as any) : undefined,
        annotations: annotations.length ? (annotations as any) : undefined,
      },
    });

    if (!chatTitle && lastUser?.content) {
      await prisma.chat.update({
        where: { id: chatId },
        data: { title: lastUser.content.slice(0, 120) },
      });
    }

    await incrementCredits(userId);
  } catch (err) {
    if (err instanceof StreamTimeoutError) {
      logger.warn({ chatId }, "[chat/stream] LLM stream timed out");
    } else {
      logger.error({ err }, "[chat/stream] error");
    }
    try {
      const msg =
        err instanceof StreamTimeoutError
          ? "Response timed out. Please try again."
          : "Stream error";
      write(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`);
      write("data: [DONE]\n\n");
    } catch {
      /* ignore */
    }
  } finally {
    res.end();
  }
});
