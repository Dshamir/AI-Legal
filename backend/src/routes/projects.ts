import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../lib/prisma";
import { createClient } from "@supabase/supabase-js";
import { logger } from "../lib/logger";
import { attachActiveVersionPaths, attachLatestVersionNumbers } from "../lib/documentVersions";
import { downloadFile, uploadFile, storageKey } from "../lib/storage";
import { docxToPdf, convertedPdfKey } from "../lib/convert";
import { checkProjectAccess } from "../lib/access";
import { singleFileUpload } from "../lib/upload";
import { auditLog } from "../lib/audit";

export const projectsRouter = Router();
const ALLOWED_TYPES = new Set(["pdf", "docx", "doc"]);

function normalizeDocumentFilename(nextName: unknown, currentName: string) {
  if (typeof nextName !== "string") return null;
  const trimmed = nextName.trim().slice(0, 200);
  if (!trimmed) return null;
  if (/\.[a-z0-9]{1,6}$/i.test(trimmed)) return trimmed;
  const ext = currentName.match(/\.[a-z0-9]{1,6}$/i)?.[0] ?? "";
  return `${trimmed}${ext}`;
}

/** Helper to get Supabase admin client for auth-only operations */
function getSupabaseAdmin() {
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SECRET_KEY ?? "";
  if (!supabaseUrl || !serviceKey) return null;
  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
}

// GET /projects
projectsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;

  const ownProjects = await prisma.project.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  let sharedProjects: any[] = [];
  if (userEmail) {
    sharedProjects = await prisma.project.findMany({
      where: {
        sharedWith: { path: [], array_contains: [userEmail] },
        userId: { not: userId },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  const projects = [...ownProjects, ...sharedProjects].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const result = await Promise.all(
    projects.map(async (p) => {
      const [docCount, chatCount, reviewCount] = await Promise.all([
        prisma.document.count({ where: { projectId: p.id } }),
        prisma.chat.count({ where: { projectId: p.id } }),
        prisma.tabularReview.count({ where: { projectId: p.id } }),
      ]);
      return {
        ...p,
        is_owner: p.userId === userId,
        document_count: docCount,
        chat_count: chatCount,
        review_count: reviewCount,
      };
    }),
  );
  res.json(result);
});

// POST /projects
projectsRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { name, cm_number, shared_with } = req.body as {
    name: string;
    cm_number?: string;
    shared_with?: string[];
  };
  if (!name?.trim()) return void res.status(400).json({ detail: "name is required" });
  const normalizedUserEmail = userEmail?.trim().toLowerCase();
  const cleanedSharedWith: string[] = [];
  const seenSharedEmails = new Set<string>();
  if (Array.isArray(shared_with)) {
    for (const raw of shared_with) {
      if (typeof raw !== "string") continue;
      const e = raw.trim().toLowerCase();
      if (!e || seenSharedEmails.has(e)) continue;
      if (normalizedUserEmail && e === normalizedUserEmail) {
        return void res.status(400).json({ detail: "You cannot share a project with yourself." });
      }
      seenSharedEmails.add(e);
      cleanedSharedWith.push(e);
    }
  }

  const project = await prisma.project.create({
    data: {
      userId,
      name: name.trim(),
      cmNumber: cm_number ?? null,
      sharedWith: cleanedSharedWith,
    },
  });

  await auditLog({
    userId,
    action: "create",
    entity: "project",
    entityId: project.id,
  });

  res.status(201).json({ ...project, documents: [] });
});

// GET /projects/:projectId
projectsRouter.get("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { projectId } = req.params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });
  if (!project) return void res.status(404).json({ detail: "Project not found" });

  const canAccess =
    project.userId === userId ||
    (userEmail &&
      Array.isArray(project.sharedWith) &&
      (project.sharedWith as string[]).some(
        (e) => (e ?? "").toLowerCase() === userEmail.toLowerCase(),
      ));
  if (!canAccess) return void res.status(404).json({ detail: "Project not found" });

  const [docs, folderData] = await Promise.all([
    prisma.document.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    }),
    prisma.projectSubfolder.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const docsTyped = docs as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(docsTyped);
  await attachActiveVersionPaths(docsTyped);
  res.json({
    ...project,
    is_owner: project.userId === userId,
    documents: docsTyped,
    folders: folderData,
  });
});

// GET /projects/:projectId/people
// Resolve the owner + every shared member to {email, display_name}. Used
// by the People modal so the UI can show display names where available
// and tag the current user as "You".
projectsRouter.get("/:projectId/people", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, userId: true, sharedWith: true },
  });
  if (!project) return void res.status(404).json({ detail: "Project not found" });

  const isOwner = project.userId === userId;
  const sharedWith = (
    Array.isArray(project.sharedWith) ? (project.sharedWith as string[]) : []
  ).map((e) => e.toLowerCase());
  const isShared = !!userEmail && sharedWith.includes(userEmail.toLowerCase());
  if (!isOwner && !isShared) return void res.status(404).json({ detail: "Project not found" });

  // Pull every auth user. Auth-user listing still uses Supabase admin API.
  const admin = getSupabaseAdmin();
  const allUsers: { id: string; email?: string }[] = [];
  if (admin) {
    const { data: usersData } = await admin.auth.admin.listUsers({ perPage: 1000 });
    if (usersData?.users) allUsers.push(...usersData.users);
  }

  const userByEmail = new Map<string, { id: string; email: string }>();
  const userById = new Map<string, { id: string; email: string }>();
  for (const u of allUsers) {
    if (!u.email) continue;
    const lower = u.email.toLowerCase();
    userByEmail.set(lower, { id: u.id, email: u.email });
    userById.set(u.id, { id: u.id, email: u.email });
  }

  const memberUserIds: string[] = [];
  for (const email of sharedWith) {
    const u = userByEmail.get(email);
    if (u) memberUserIds.push(u.id);
  }

  const profileIds = [project.userId as string, ...memberUserIds].filter(
    (x, i, arr) => arr.indexOf(x) === i,
  );

  const profileByUserId = new Map<
    string,
    { displayName: string | null; organisation: string | null }
  >();
  if (profileIds.length > 0) {
    const profiles = await prisma.userProfile.findMany({
      where: { userId: { in: profileIds } },
      select: { userId: true, displayName: true, organisation: true },
    });
    for (const p of profiles) {
      profileByUserId.set(p.userId, {
        displayName: p.displayName ?? null,
        organisation: p.organisation ?? null,
      });
    }
  }

  const ownerInfo = userById.get(project.userId);
  const owner = {
    user_id: project.userId,
    email: ownerInfo?.email ?? null,
    display_name: profileByUserId.get(project.userId)?.displayName ?? null,
  };
  const members = sharedWith.map((email) => {
    const u = userByEmail.get(email);
    const display_name = u ? (profileByUserId.get(u.id)?.displayName ?? null) : null;
    return { email, display_name };
  });

  res.json({ owner, members });
});

// PATCH /projects/:projectId
projectsRouter.patch("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const updates: Record<string, unknown> = {};
  if (req.body.name != null) updates.name = req.body.name;
  if (req.body.cm_number != null) updates.cmNumber = req.body.cm_number;
  if (Array.isArray(req.body.shared_with)) {
    // Normalise: lowercase + dedupe + drop empties.
    const normalizedUserEmail = userEmail?.trim().toLowerCase();
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of req.body.shared_with) {
      if (typeof raw !== "string") continue;
      const e = raw.trim().toLowerCase();
      if (!e || seen.has(e)) continue;
      if (normalizedUserEmail && e === normalizedUserEmail) {
        return void res.status(400).json({ detail: "You cannot share a project with yourself." });
      }
      seen.add(e);
      cleaned.push(e);
    }
    updates.sharedWith = cleaned;
  }

  // Verify ownership (only owner can update)
  const existing = await prisma.project.findFirst({
    where: { id: projectId, userId },
  });
  if (!existing) return void res.status(404).json({ detail: "Project not found" });

  const data = await prisma.project.update({
    where: { id: projectId },
    data: updates,
  });

  await auditLog({
    userId,
    action: "update",
    entity: "project",
    entityId: projectId,
  });

  const [docs, folderData] = await Promise.all([
    prisma.document.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    }),
    prisma.projectSubfolder.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const docsTyped = docs as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(docsTyped);
  res.json({ ...data, documents: docsTyped, folders: folderData });
});

// DELETE /projects/:projectId
projectsRouter.delete("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId } = req.params;

  const existing = await prisma.project.findFirst({
    where: { id: projectId, userId },
  });
  if (!existing) return void res.status(404).json({ detail: "Project not found" });

  await prisma.project.delete({ where: { id: projectId } });

  await auditLog({
    userId,
    action: "delete",
    entity: "project",
    entityId: projectId,
  });

  res.status(204).send();
});

// GET /projects/:projectId/documents
projectsRouter.get("/:projectId/documents", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;

  const access = await checkProjectAccess(projectId, userId, userEmail);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  const docs = await prisma.document.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
  });
  const docsTyped = docs as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(docsTyped);
  res.json(docsTyped);
});

// POST /projects/:projectId/documents/:documentId — assign or copy existing doc into project
projectsRouter.post("/:projectId/documents/:documentId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, documentId } = req.params;

  const access = await checkProjectAccess(projectId, userId, userEmail);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  // Adding-by-id pulls a doc into the project — only the doc's owner
  // is allowed to do that, so other people's standalone docs can't be
  // siphoned into a project the requester happens to share.
  const doc = await prisma.document.findFirst({
    where: { id: documentId, userId },
  });
  if (!doc) return void res.status(404).json({ detail: "Document not found" });

  // Already in this project — idempotent
  if (doc.projectId === projectId) return void res.json(doc);

  if (doc.projectId === null) {
    // Standalone → assign project_id
    const updated = await prisma.document.update({
      where: { id: documentId },
      data: { projectId },
    });
    return void res.json(updated);
  } else {
    // Belongs to another project → duplicate record AND copy the
    // underlying storage objects so each project's copy is fully
    // independent.
    const copy = await prisma.document.create({
      data: {
        projectId,
        userId,
        filename: doc.filename,
        fileType: doc.fileType,
        sizeBytes: doc.sizeBytes,
        pageCount: doc.pageCount,
        structureTree: doc.structureTree ?? undefined,
        status: doc.status,
      },
    });

    let copyVersionRowId: string | null = null;
    if (doc.currentVersionId) {
      const srcV = await prisma.documentVersion.findUnique({
        where: { id: doc.currentVersionId },
        select: {
          storagePath: true,
          pdfStoragePath: true,
          versionNumber: true,
          displayName: true,
          source: true,
        },
      });
      if (srcV?.storagePath) {
        const srcBytes = await downloadFile(srcV.storagePath);
        if (!srcBytes) {
          return void res.status(500).json({ detail: "Failed to read source document bytes" });
        }
        const newKey = storageKey(userId, copy.id, doc.filename);
        const contentType =
          doc.fileType === "pdf"
            ? "application/pdf"
            : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        await uploadFile(newKey, srcBytes, contentType);

        let newPdfPath: string | null = null;
        if (srcV.pdfStoragePath) {
          if (srcV.pdfStoragePath === srcV.storagePath) {
            newPdfPath = newKey;
          } else {
            const pdfBytes = await downloadFile(srcV.pdfStoragePath);
            if (pdfBytes) {
              const newPdfKey = convertedPdfKey(userId, copy.id);
              await uploadFile(newPdfKey, pdfBytes, "application/pdf");
              newPdfPath = newPdfKey;
            }
          }
        }

        const newV = await prisma.documentVersion.create({
          data: {
            documentId: copy.id,
            storagePath: newKey,
            pdfStoragePath: newPdfPath,
            source: srcV.source ?? "upload",
            versionNumber: srcV.versionNumber ?? 1,
            displayName: srcV.displayName ?? doc.filename,
          },
          select: { id: true },
        });
        copyVersionRowId = newV.id;
        if (copyVersionRowId) {
          await prisma.document.update({
            where: { id: copy.id },
            data: { currentVersionId: copyVersionRowId },
          });
        }
      }
    }
    return void res.status(201).json(copy);
  }
});

// PATCH /projects/:projectId/documents/:documentId — rename a project document
projectsRouter.patch("/:projectId/documents/:documentId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, documentId } = req.params;

  const access = await checkProjectAccess(projectId, userId, userEmail);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  const doc = await prisma.document.findFirst({
    where: { id: documentId, projectId },
    select: { id: true, filename: true, currentVersionId: true },
  });
  if (!doc) return void res.status(404).json({ detail: "Document not found" });

  const filename = normalizeDocumentFilename(req.body?.filename, doc.filename);
  if (!filename) return void res.status(400).json({ detail: "filename is required" });

  const updated = await prisma.document.update({
    where: { id: documentId },
    data: { filename },
  });

  if (doc.currentVersionId) {
    await prisma.documentVersion.updateMany({
      where: { id: doc.currentVersionId, documentId },
      data: { displayName: filename },
    });
  }

  res.json(updated);
});

// POST /projects/:projectId/documents
projectsRouter.post(
  "/:projectId/documents",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;

    const access = await checkProjectAccess(projectId, userId, userEmail);
    if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

    await handleDocumentUpload(req, res, userId, projectId);
  },
);

// GET /projects/:projectId/chats — every assistant chat under this project
projectsRouter.get("/:projectId/chats", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;

  const access = await checkProjectAccess(projectId, userId, userEmail);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  const chats = await prisma.chat.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
  res.json(chats);
});

// ── Folder routes ─────────────────────────────────────────────────────────────

// POST /projects/:projectId/folders
projectsRouter.post("/:projectId/folders", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const { name, parent_folder_id } = req.body as { name: string; parent_folder_id?: string | null };
  if (!name?.trim()) return void res.status(400).json({ detail: "name is required" });

  const access = await checkProjectAccess(projectId, userId, userEmail);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  // Verify parent folder belongs to this project
  if (parent_folder_id) {
    const parent = await prisma.projectSubfolder.findFirst({
      where: { id: parent_folder_id, projectId },
    });
    if (!parent) return void res.status(404).json({ detail: "Parent folder not found" });
  }

  const folder = await prisma.projectSubfolder.create({
    data: {
      projectId,
      userId,
      name: name.trim(),
      parentFolderId: parent_folder_id ?? null,
    },
  });

  await auditLog({
    userId,
    action: "create",
    entity: "projectSubfolder",
    entityId: folder.id,
  });

  res.status(201).json(folder);
});

// PATCH /projects/:projectId/folders/:folderId
projectsRouter.patch("/:projectId/folders/:folderId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;
  const body = req.body as { name?: string; parent_folder_id?: string | null };

  const access = await checkProjectAccess(projectId, userId, userEmail);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  const updates: Record<string, unknown> = {};
  if (body.name != null) updates.name = body.name.trim();
  if ("parent_folder_id" in body) {
    // Cycle check: walk up the tree from the proposed parent to ensure folderId is not an ancestor
    if (body.parent_folder_id) {
      const parent = await loadProjectFolder(projectId, body.parent_folder_id);
      if (!parent) return void res.status(404).json({ detail: "Parent folder not found" });

      let cur: string | null = body.parent_folder_id;
      while (cur) {
        if (cur === folderId)
          return void res
            .status(400)
            .json({ detail: "Cannot move a folder into itself or a descendant" });
        const p = await loadProjectFolder(projectId, cur);
        if (!p) return void res.status(404).json({ detail: "Parent folder not found" });
        cur = p?.parentFolderId ?? null;
      }
    }
    updates.parentFolderId = body.parent_folder_id ?? null;
  }

  const existing = await prisma.projectSubfolder.findFirst({
    where: { id: folderId, projectId },
  });
  if (!existing) return void res.status(404).json({ detail: "Folder not found" });

  const data = await prisma.projectSubfolder.update({
    where: { id: folderId },
    data: updates,
  });
  res.json(data);
});

// DELETE /projects/:projectId/folders/:folderId
projectsRouter.delete("/:projectId/folders/:folderId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;

  const access = await checkProjectAccess(projectId, userId, userEmail);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  const folder = await loadProjectFolder(projectId, folderId);
  if (!folder) return void res.status(404).json({ detail: "Folder not found" });

  // Move direct documents to root before cascade-deleting subfolders
  await prisma.document.updateMany({
    where: { folderId, projectId },
    data: { folderId: null },
  });

  await prisma.projectSubfolder.deleteMany({
    where: { id: folderId, projectId },
  });

  await auditLog({
    userId,
    action: "delete",
    entity: "projectSubfolder",
    entityId: folderId,
  });

  res.status(204).send();
});

// PATCH /projects/:projectId/documents/:documentId/folder — move doc to a folder
projectsRouter.patch("/:projectId/documents/:documentId/folder", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, documentId } = req.params;
  const { folder_id } = req.body as { folder_id: string | null };

  const access = await checkProjectAccess(projectId, userId, userEmail);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  if (folder_id) {
    const folder = await loadProjectFolder(projectId, folder_id);
    if (!folder) return void res.status(404).json({ detail: "Folder not found" });
  }

  const existing = await prisma.document.findFirst({
    where: { id: documentId, projectId },
  });
  if (!existing) return void res.status(404).json({ detail: "Document not found" });

  const data = await prisma.document.update({
    where: { id: documentId },
    data: { folderId: folder_id ?? null },
  });
  res.json(data);
});

async function loadProjectFolder(
  projectId: string,
  folderId: string,
): Promise<{ id: string; parentFolderId: string | null } | null> {
  const data = await prisma.projectSubfolder.findFirst({
    where: { id: folderId, projectId },
    select: { id: true, parentFolderId: true },
  });
  return data ?? null;
}

export async function handleDocumentUpload(
  req: import("express").Request,
  res: import("express").Response,
  userId: string,
  projectId: string | null,
) {
  const file = req.file;
  if (!file) return void res.status(400).json({ detail: "file is required" });

  const filename = file.originalname;
  const suffix = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  if (!ALLOWED_TYPES.has(suffix))
    return void res.status(400).json({
      detail: `Unsupported file type: ${suffix}. Allowed: pdf, docx, doc`,
    });

  const content = file.buffer;
  const doc = await prisma.document.create({
    data: {
      projectId,
      userId,
      filename,
      fileType: suffix,
      sizeBytes: content.byteLength,
      status: "processing",
    },
  });

  try {
    const docId = doc.id;
    const key = storageKey(userId, docId, filename);
    const contentType =
      suffix === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    await uploadFile(
      key,
      content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer,
      contentType,
    );

    const rawBuf = content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer;
    const tree = await extractStructureTree(rawBuf, suffix, filename);
    const pageCount = suffix === "pdf" ? await countPdfPages(rawBuf) : null;

    // Convert DOCX/DOC → PDF for display. PDFs are their own rendition.
    let pdfStoragePath: string | null = null;
    if (suffix === "docx" || suffix === "doc") {
      try {
        const pdfBuf = await docxToPdf(content);
        const pdfKey = convertedPdfKey(userId, docId);
        await uploadFile(
          pdfKey,
          pdfBuf.buffer.slice(
            pdfBuf.byteOffset,
            pdfBuf.byteOffset + pdfBuf.byteLength,
          ) as ArrayBuffer,
          "application/pdf",
        );
        pdfStoragePath = pdfKey;
      } catch (err) {
        logger.error({ err, filename }, "[upload] DOCX→PDF conversion failed");
      }
    } else if (suffix === "pdf") {
      pdfStoragePath = key;
    }

    // Storage paths live on document_versions — create the V1 row and
    // point documents.current_version_id at it.
    const versionRow = await prisma.documentVersion.create({
      data: {
        documentId: docId,
        storagePath: key,
        pdfStoragePath,
        source: "upload",
        versionNumber: 1,
        displayName: filename,
      },
      select: { id: true },
    });

    await prisma.document.update({
      where: { id: docId },
      data: {
        currentVersionId: versionRow.id,
        sizeBytes: content.byteLength,
        pageCount,
        structureTree: (tree as any) ?? undefined,
        status: "ready",
      },
    });

    const updated = await prisma.document.findUnique({
      where: { id: docId },
    });
    const responseDoc = updated
      ? {
          ...updated,
          storage_path: key,
          pdf_storage_path: pdfStoragePath,
        }
      : updated;
    return void res.status(201).json(responseDoc);
  } catch (e) {
    await prisma.document.update({
      where: { id: doc.id },
      data: { status: "failed" as any },
    });
    return void res.status(500).json({ detail: `Document processing failed: ${String(e)}` });
  }
}

async function countPdfPages(buf: ArrayBuffer): Promise<number | null> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (opts: unknown) => {
          promise: Promise<{ numPages: number }>;
        };
      }
    ).getDocument({ data: new Uint8Array(buf) }).promise;
    return pdf.numPages;
  } catch {
    return null;
  }
}

async function extractStructureTree(
  content: ArrayBuffer,
  fileType: string,
  filename: string,
): Promise<unknown[] | null> {
  try {
    if (fileType === "pdf") {
      const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
      const pdf = await (
        pdfjsLib as unknown as {
          getDocument: (opts: unknown) => {
            promise: Promise<{
              numPages: number;
              getOutline: () => Promise<{ title?: string }[]>;
            }>;
          };
        }
      ).getDocument({ data: new Uint8Array(content) }).promise;
      if (pdf.numPages <= 5) return null;
      const outline = await pdf.getOutline();
      if (outline?.length) {
        return outline.map((item, i) => ({
          id: `h1-${i}`,
          title: item.title ?? `Item ${i + 1}`,
          level: 1,
          page_number: null,
          children: [],
        }));
      }
      return Array.from({ length: pdf.numPages }, (_, i) => ({
        id: `page-${i + 1}`,
        title: `Page ${i + 1}`,
        level: 1,
        page_number: i + 1,
        children: [],
      }));
    } else {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({
        buffer: Buffer.from(content),
      });
      const lines = result.value.split("\n").filter((l) => l.trim());
      const nodes = lines.slice(0, 30).map((line, i) => ({
        id: `h1-${i}`,
        title: line.slice(0, 100),
        level: 1,
        page_number: null,
        children: [],
      }));
      return nodes.length ? nodes : null;
    }
  } catch {
    return null;
  }
}
