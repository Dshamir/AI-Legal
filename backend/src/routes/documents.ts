import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import {
  buildContentDisposition,
  downloadFile,
  deleteFile,
  getSignedUrl,
  storageKey,
  uploadFile,
  versionStorageKey,
} from "../lib/storage";
import { docxToPdf, convertedPdfKey } from "../lib/convert";
import { extractTrackedChangeIds, resolveTrackedChange } from "../lib/docxTrackedChanges";
import { buildDownloadUrl } from "../lib/downloadTokens";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
  loadActiveVersion,
} from "../lib/documentVersions";
import { ensureDocAccess } from "../lib/access";
import { singleFileUpload } from "../lib/upload";
import { auditLog } from "../lib/audit";

export const documentsRouter = Router();
const ALLOWED_TYPES = new Set(["pdf", "docx", "doc"]);

// GET /single-documents
documentsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const docs = await prisma.document.findMany({
    where: { userId, projectId: null },
    orderBy: { createdAt: "desc" },
  });
  const docsTyped = docs as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(docsTyped);
  await attachActiveVersionPaths(docsTyped);
  res.json(docsTyped);
});

// POST /single-documents
documentsRouter.post("/", requireAuth, singleFileUpload("file"), async (req, res) => {
  const userId = res.locals.userId as string;
  await handleDocumentUpload(req, res, userId, null);
});

// DELETE /single-documents/:documentId
documentsRouter.delete("/:documentId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { documentId } = req.params;

  const doc = await prisma.document.findFirst({
    where: { id: documentId, userId },
    select: { id: true },
  });
  if (!doc) return void res.status(404).json({ detail: "Document not found" });

  // Storage now lives on document_versions — fan out and delete each
  // version's bytes (DOCX + PDF rendition) before dropping rows.
  const versions = await prisma.documentVersion.findMany({
    where: { documentId },
    select: { storagePath: true, pdfStoragePath: true },
  });
  await Promise.all(
    versions.flatMap((v) =>
      [v.storagePath, v.pdfStoragePath]
        .filter((p): p is string => typeof p === "string" && p.length > 0)
        .map((p) => deleteFile(p).catch(() => {})),
    ),
  );
  await prisma.document.delete({ where: { id: documentId } });

  await auditLog({
    userId,
    action: "delete",
    entity: "document",
    entityId: documentId,
  });

  res.status(204).send();
});

// GET /single-documents/:documentId/display
documentsRouter.get("/:documentId/display", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { documentId } = req.params;
  const versionIdParam = typeof req.query.version_id === "string" ? req.query.version_id : null;

  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, filename: true, fileType: true, userId: true, projectId: true },
  });
  if (!doc) return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail);
  if (!access.ok) return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, versionIdParam);
  if (!active) return void res.status(404).json({ detail: "No file available" });

  const fileType = doc.fileType ?? "";
  const isDocx = fileType === "docx" || fileType === "doc";

  // For DOCX, prefer the per-version PDF rendition if one exists.
  const servePath =
    isDocx && active.pdf_storage_path ? active.pdf_storage_path : active.storage_path;
  const raw = await downloadFile(servePath);
  if (!raw) return void res.status(404).json({ detail: "Document not found in storage" });

  if (fileType === "pdf" || (isDocx && active.pdf_storage_path)) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", buildContentDisposition("inline", doc.filename));
    res.send(Buffer.from(raw));
  } else {
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    res.setHeader("Content-Disposition", buildContentDisposition("inline", doc.filename));
    res.send(Buffer.from(raw));
  }
});

// POST /single-documents/download-zip
documentsRouter.post("/download-zip", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { document_ids } = req.body as { document_ids?: string[] };

  if (!Array.isArray(document_ids) || document_ids.length === 0)
    return void res.status(400).json({ detail: "document_ids is required" });

  const MAX_ZIP_DOCUMENTS = 50;
  if (document_ids.length > MAX_ZIP_DOCUMENTS)
    return void res
      .status(400)
      .json({ detail: `Too many documents. Maximum is ${MAX_ZIP_DOCUMENTS}.` });

  const rawDocs = await prisma.document.findMany({
    where: { id: { in: document_ids } },
    select: {
      id: true,
      filename: true,
      fileType: true,
      currentVersionId: true,
      userId: true,
      projectId: true,
    },
  });

  // Filter to docs the user actually has access to (own + shared-project).
  const accessChecks = await Promise.all(
    rawDocs.map(async (d) => ({
      doc: d,
      access: await ensureDocAccess(d, userId, userEmail),
    })),
  );
  const docs = accessChecks.filter((x) => x.access.ok).map((x) => x.doc);
  if (docs.length === 0) return void res.status(404).json({ detail: "No documents found" });

  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  await Promise.all(
    docs.map(async (doc) => {
      const active = await loadActiveVersion(doc.id);
      if (!active) return;
      const raw = await downloadFile(active.storage_path);
      if (!raw) return;
      zip.file(doc.filename, Buffer.from(raw));
    }),
  );

  const content = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="documents.zip"');
  res.send(content);
});

// GET /single-documents/:documentId/url
documentsRouter.get("/:documentId/url", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam = typeof req.query.version_id === "string" ? req.query.version_id : null;

  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, filename: true, userId: true, projectId: true },
  });
  if (!doc) return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail);
  if (!access.ok) return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, versionIdParam);
  if (!active) return void res.status(404).json({ detail: "No file available" });

  const downloadFilename = resolveDownloadFilename(
    doc.filename,
    active.display_name,
    active.version_number,
  );
  const url = await getSignedUrl(active.storage_path, 3600, downloadFilename);
  if (!url) return void res.status(503).json({ detail: "Storage not configured" });

  res.json({
    url,
    document_id: documentId,
    filename: downloadFilename,
    version_id: active.id,
    has_pdf_rendition: !!active.pdf_storage_path,
  });
});

// GET /single-documents/:documentId/docx
documentsRouter.get("/:documentId/docx", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam = typeof req.query.version_id === "string" ? req.query.version_id : null;

  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, filename: true, userId: true, projectId: true },
  });
  if (!doc) return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail);
  if (!access.ok) return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, versionIdParam);
  if (!active) return void res.status(404).json({ detail: "No file available" });

  const raw = await downloadFile(active.storage_path);
  if (!raw) return void res.status(404).json({ detail: "Document bytes not available" });

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition(
      "inline",
      resolveDownloadFilename(doc.filename, active.display_name, active.version_number),
    ),
  );
  res.send(Buffer.from(raw));
});

function versionedFilename(filename: string, version: number | null): string {
  if (!version || version < 1) return filename;
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : ".docx";
  return `${stem} [Edited V${version}]${ext}`;
}

function resolveDownloadFilename(
  originalFilename: string,
  displayName: string | null | undefined,
  versionNumber: number | null,
): string {
  const dot = originalFilename.lastIndexOf(".");
  const origExt = dot > 0 ? originalFilename.slice(dot) : "";
  if (displayName && displayName.trim()) {
    const trimmed = displayName.trim();
    const trimmedDot = trimmed.lastIndexOf(".");
    const hasExt =
      trimmedDot > 0 &&
      trimmed
        .slice(trimmedDot)
        .toLowerCase()
        .match(/^\.[a-z0-9]{1,6}$/);
    if (hasExt) return trimmed;
    return origExt ? `${trimmed}${origExt}` : trimmed;
  }
  return versionedFilename(originalFilename, versionNumber);
}

// GET /single-documents/:documentId/versions
documentsRouter.get("/:documentId/versions", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;

  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, currentVersionId: true, userId: true, projectId: true },
  });
  if (!doc) return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail);
  if (!access.ok) return void res.status(404).json({ detail: "Document not found" });

  const rows = await prisma.documentVersion.findMany({
    where: { documentId },
    select: { id: true, versionNumber: true, source: true, createdAt: true, displayName: true },
    orderBy: { createdAt: "asc" },
  });

  res.json({
    current_version_id: doc.currentVersionId,
    versions: rows,
  });
});

// POST /single-documents/:documentId/versions
documentsRouter.post(
  "/:documentId/versions",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;

    const file = req.file;
    if (!file) return void res.status(400).json({ detail: "file is required" });

    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, filename: true, fileType: true, userId: true, projectId: true },
    });
    if (!doc) return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail);
    if (!access.ok) return void res.status(404).json({ detail: "Document not found" });

    const suffix = file.originalname.includes(".")
      ? file.originalname.split(".").pop()!.toLowerCase()
      : "";
    if (doc.fileType && suffix && doc.fileType !== suffix) {
      return void res.status(400).json({
        detail: `Uploaded file type (${suffix}) does not match document type (${doc.fileType}).`,
      });
    }

    const versionSlug = crypto.randomUUID().replace(/-/g, "");
    const key = versionStorageKey(userId, documentId, versionSlug, file.originalname);
    const contentType =
      suffix === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    try {
      await uploadFile(
        key,
        file.buffer.buffer.slice(
          file.buffer.byteOffset,
          file.buffer.byteOffset + file.buffer.byteLength,
        ) as ArrayBuffer,
        contentType,
      );
    } catch (e) {
      logger.error({ err: e }, "[versions/upload] storage write failed");
      return void res.status(500).json({ detail: "Failed to upload new version." });
    }

    let pdfStoragePath: string | null = null;
    if (suffix === "docx" || suffix === "doc") {
      try {
        const pdfBuf = await docxToPdf(file.buffer);
        const pdfKey = `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`;
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
        logger.error(
          { err, filename: file.originalname },
          "[versions/upload] DOCX→PDF conversion failed",
        );
      }
    } else if (suffix === "pdf") {
      pdfStoragePath = key;
    }

    // Per-document sequential version_number
    const maxRow = await prisma.documentVersion.findFirst({
      where: {
        documentId,
        source: { in: ["upload", "user_upload", "assistant_edit"] },
      },
      orderBy: { versionNumber: "desc" },
      select: { versionNumber: true },
    });
    const nextVersionNumber = ((maxRow?.versionNumber as number | null) ?? 1) + 1;

    const defaultDisplayName =
      typeof req.body?.display_name === "string" && req.body.display_name.trim()
        ? req.body.display_name.trim().slice(0, 200)
        : file.originalname;

    const versionRow = await prisma.documentVersion.create({
      data: {
        documentId,
        storagePath: key,
        pdfStoragePath,
        source: "user_upload",
        versionNumber: nextVersionNumber,
        displayName: defaultDisplayName,
      },
      select: { id: true, versionNumber: true, source: true, createdAt: true, displayName: true },
    });

    // Propagate display_name to parent doc's filename
    const documentsUpdate: Record<string, unknown> = {
      currentVersionId: versionRow.id,
    };
    const providedDisplayName =
      typeof req.body?.display_name === "string" && req.body.display_name.trim()
        ? req.body.display_name.trim().slice(0, 200)
        : null;
    if (providedDisplayName) {
      const hasExt = /\.[a-z0-9]{1,6}$/i.test(providedDisplayName);
      const existingExt = doc.filename?.match(/\.[a-z0-9]{1,6}$/i)?.[0];
      const uploadedExt = suffix ? `.${suffix}` : "";
      const ext = hasExt ? "" : uploadedExt || existingExt || "";
      documentsUpdate.filename = `${providedDisplayName}${ext}`;
    }
    await prisma.document.update({
      where: { id: documentId },
      data: documentsUpdate,
    });

    res.status(201).json(versionRow);
  },
);

// PATCH /single-documents/:documentId/versions/:versionId
documentsRouter.patch("/:documentId/versions/:versionId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId, versionId } = req.params;

  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, userId: true, projectId: true },
  });
  if (!doc) return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail);
  if (!access.ok) return void res.status(404).json({ detail: "Document not found" });

  const raw = req.body?.display_name;
  const displayName = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 200) : null;

  const existing = await prisma.documentVersion.findFirst({
    where: { id: versionId, documentId },
  });
  if (!existing) {
    return void res.status(404).json({ detail: "Version not found" });
  }

  const updated = await prisma.documentVersion.update({
    where: { id: versionId },
    data: { displayName },
    select: { id: true, versionNumber: true, source: true, createdAt: true, displayName: true },
  });
  res.json(updated);
});

// GET /single-documents/:documentId/tracked-change-ids
documentsRouter.get("/:documentId/tracked-change-ids", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam = typeof req.query.version_id === "string" ? req.query.version_id : null;

  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, userId: true, projectId: true },
  });
  if (!doc) return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail);
  if (!access.ok) return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, versionIdParam);
  if (!active) return void res.status(404).json({ detail: "No file available" });

  const rawBytes = await downloadFile(active.storage_path);
  if (!rawBytes) return void res.status(404).json({ detail: "Document bytes not available" });

  const ids = await extractTrackedChangeIds(Buffer.from(rawBytes));
  res.json({ ids });
});

// POST /single-documents/:documentId/edits/:editId/accept
// POST /single-documents/:documentId/edits/:editId/reject
async function handleEditResolution(
  req: import("express").Request,
  res: import("express").Response,
  mode: "accept" | "reject",
) {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId, editId } = req.params;

  logger.info({ mode, userId, documentId, editId }, "[edit-resolution] incoming");

  const edit = await prisma.documentEdit.findFirst({
    where: { id: editId, documentId },
    select: {
      id: true,
      documentId: true,
      changeId: true,
      delWId: true,
      insWId: true,
      status: true,
    },
  });
  logger.info({ edit }, "[edit-resolution] fetched edit row");
  if (!edit) {
    logger.info(`[edit-resolution] edit not found, returning 404`);
    return void res.status(404).json({ detail: "Edit not found" });
  }
  // Idempotent: if the edit is already resolved, return the current doc state
  if (edit.status !== "pending") {
    logger.info({ editId, status: edit.status }, "[edit-resolution] edit already resolved");
    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      select: { currentVersionId: true, filename: true, userId: true, projectId: true },
    });
    if (!doc) {
      return void res.status(404).json({ detail: "Document not found" });
    }
    const accessResolved = await ensureDocAccess(doc, userId, userEmail);
    if (!accessResolved.ok) {
      return void res.status(404).json({ detail: "Document not found" });
    }
    const activeForResolved = await loadActiveVersion(documentId);
    const payload = {
      ok: true,
      already_resolved: true,
      status: edit.status,
      version_id: doc.currentVersionId ?? null,
      download_url: activeForResolved
        ? buildDownloadUrl(activeForResolved.storage_path, doc.filename ?? "document.docx")
        : null,
      remaining_pending: 0,
    };
    return void res.status(200).json(payload);
  }

  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, currentVersionId: true, userId: true, projectId: true },
  });
  if (!doc) return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail);
  if (!access.ok) return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId);
  const latestPath = active?.storage_path ?? null;
  if (!latestPath) return void res.status(404).json({ detail: "No file to edit" });

  const rawBytes = await downloadFile(latestPath);
  if (!rawBytes) return void res.status(404).json({ detail: "Document bytes not available" });

  const wIds = [edit.delWId, edit.insWId].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const { bytes: resolvedBytes, found } = await resolveTrackedChange(
    Buffer.from(rawBytes),
    wIds,
    mode,
  );
  if (!found) {
    // Still update DB status so the UI reflects the decision
    await prisma.documentEdit.update({
      where: { id: editId },
      data: {
        status: mode === "accept" ? "accepted" : "rejected",
        resolvedAt: new Date(),
      },
    });
    const filenameRow = await prisma.document.findUnique({
      where: { id: documentId },
      select: { filename: true },
    });
    const payload = {
      ok: true,
      version_id: doc.currentVersionId,
      download_url: buildDownloadUrl(latestPath, filenameRow?.filename ?? "document.docx"),
      remaining_pending: 0,
    };
    return void res.status(200).json(payload);
  }

  // Overwrite bytes in place at the current version's storage path
  const ab = resolvedBytes.buffer.slice(
    resolvedBytes.byteOffset,
    resolvedBytes.byteOffset + resolvedBytes.byteLength,
  ) as ArrayBuffer;
  await uploadFile(
    latestPath,
    ab,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );

  await prisma.documentEdit.update({
    where: { id: editId },
    data: {
      status: mode === "accept" ? "accepted" : "rejected",
      resolvedAt: new Date(),
    },
  });

  const remainingPending = await prisma.documentEdit.count({
    where: { documentId, status: "pending" },
  });

  const filenameRow = await prisma.document.findUnique({
    where: { id: documentId },
    select: { filename: true },
  });
  const payload = {
    ok: true,
    version_id: doc.currentVersionId,
    download_url: buildDownloadUrl(latestPath, filenameRow?.filename ?? "document.docx"),
    remaining_pending: remainingPending,
  };
  res.json(payload);
}

documentsRouter.post(
  "/:documentId/edits/:editId/accept",
  requireAuth,
  (req, res) => void handleEditResolution(req, res, "accept"),
);

documentsRouter.post(
  "/:documentId/edits/:editId/reject",
  requireAuth,
  (req, res) => void handleEditResolution(req, res, "reject"),
);

async function handleDocumentUpload(
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
    const tree = await extractStructureTree(rawBuf, suffix);
    const pageCount = suffix === "pdf" ? await countPdfPages(rawBuf) : null;

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
      ? { ...updated, storage_path: key, pdf_storage_path: pdfStoragePath }
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
      if (outline?.length)
        return outline.map((item, i) => ({
          id: `h1-${i}`,
          title: item.title ?? `Item ${i + 1}`,
          level: 1,
          page_number: null,
          children: [],
        }));
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
