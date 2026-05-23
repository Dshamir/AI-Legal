import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { downloadFile } from "../lib/storage";
import { loadActiveVersion } from "../lib/documentVersions";
import { normalizeDocxZipPaths } from "../lib/convert";
import {
    runLLMStream,
    TABULAR_TOOLS,
    type ChatMessage,
    type TabularCellStore,
} from "../lib/chatTools";
import {
    completeText,
    providerForModel,
    streamChatWithTools,
    type Provider,
    type UserApiKeys,
} from "../lib/llm";
import { getUserModelSettings } from "../lib/userSettings";
import {
    checkProjectAccess,
    ensureReviewAccess,
    filterAccessibleDocumentIds,
    listAccessibleProjectIds,
} from "../lib/access";
import { auditLog } from "../lib/audit";
import { createClient } from "@supabase/supabase-js";

function formatPromptSuffix(format?: string, tags?: string[]): string {
    switch (format) {
        case "bulleted_list":
            return ' The "summary" field in your JSON response must be a markdown bulleted list only — no prose. Format: each item on its own line, prefixed with "* " (asterisk + single space), e.g.\n* First item\n* Second item\n* Third item';
        case "number":
            return ' The "summary" field in your JSON response must be a single number only. No units or explanation.';
        case "percentage":
            return ' The "summary" field in your JSON response must be a single percentage value only (e.g. 42%). No explanation.';
        case "monetary_amount":
            return ' The "summary" field in your JSON response must be the monetary value only, including currency symbol (e.g. $1,234.56). No explanation.';
        case "currency":
            return ' The "summary" field in your JSON response must contain only the currency code(s). Wrap each code in double square brackets, e.g. [[USD]] or [[EUR]]. No other text.';
        case "yes_no":
            return ' The "summary" field in your JSON response must be [[Yes]] or [[No]] only. The "reasoning" field MUST include an inline citation [[page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact language in the document that supports the Yes/No answer.';
        case "date":
            return ' The "summary" field in your JSON response must be the date only in DD Month YYYY format (e.g. 1 January 2024). If a range, give both dates separated by an em dash. The "reasoning" field MUST include an inline citation [[page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact place in the document where the date is found.';
        case "tag":
            return tags?.length
                ? ` The \"summary\" field in your JSON response must contain exactly one tag wrapped in double square brackets. Available tags: ${tags.map((t) => `[[${t}]]`).join(", ")}. No other text. The \"reasoning\" field MUST include an inline citation [[page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact language in the document that supports the chosen tag.`
                : "";
        default:
            return "";
    }
}

export const tabularRouter = Router();

function providerLabel(provider: Provider): string {
    if (provider === "claude") return "Anthropic";
    if (provider === "openai") return "OpenAI";
    return "Gemini";
}

function missingModelApiKey(model: string, apiKeys: UserApiKeys) {
    const provider = providerForModel(model);
    if (apiKeys[provider]?.trim()) return null;
    return {
        provider,
        model,
        detail: `${providerLabel(provider)} API key is required to use ${model}. Add an API key or select a different tabular review model.`,
    };
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

// GET /tabular-review
tabularRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;

    const projectIdFilter =
        typeof req.query.project_id === "string" && req.query.project_id
            ? (req.query.project_id as string)
            : null;

    const projectIds = await listAccessibleProjectIds(userId, userEmail);

    if (projectIdFilter && !projectIds.includes(projectIdFilter)) {
        return void res.json([]);
    }

    // Own reviews
    const ownWhere: Record<string, unknown> = { userId };
    if (projectIdFilter) ownWhere.projectId = projectIdFilter;
    const own = await prisma.tabularReview.findMany({
        where: ownWhere,
        orderBy: { createdAt: "desc" },
    });

    const sharedProjectIds = projectIdFilter ? [projectIdFilter] : projectIds;
    // Shared via project
    let shared: any[] = [];
    if (sharedProjectIds.length > 0) {
        shared = await prisma.tabularReview.findMany({
            where: {
                projectId: { in: sharedProjectIds },
                userId: { not: userId },
            },
            orderBy: { createdAt: "desc" },
        });
    }

    // Shared directly via email
    let sharedDirect: any[] = [];
    if (userEmail && !projectIdFilter) {
        try {
            sharedDirect = await prisma.tabularReview.findMany({
                where: {
                    sharedWith: { path: [], array_contains: [userEmail] },
                    userId: { not: userId },
                },
                orderBy: { createdAt: "desc" },
            });
        } catch (err) {
            logger.warn({ err }, "[tabular] shared-by-email query failed");
        }
    }

    const seen = new Set<string>();
    const reviews: Record<string, unknown>[] = [];
    for (const r of [...own, ...shared, ...sharedDirect]) {
        const id = (r as { id: string }).id;
        if (seen.has(id)) continue;
        seen.add(id);
        reviews.push(r as Record<string, unknown>);
    }

    // Fetch distinct document counts per review
    const reviewIds = reviews.map((r) => (r as { id: string }).id);
    let docCounts: Record<string, number> = {};
    const reviewsWithExplicitDocs = new Set<string>();
    for (const review of reviews) {
        const id = (review as { id: string }).id;
        if (Array.isArray(review.documentIds)) {
            reviewsWithExplicitDocs.add(id);
            docCounts[id] = new Set(review.documentIds as string[]).size;
        }
    }
    if (reviewIds.length > 0) {
        const cells = await prisma.tabularCell.findMany({
            where: { reviewId: { in: reviewIds } },
            select: { reviewId: true, documentId: true },
        });
        const cellSeen = new Set<string>();
        for (const cell of cells) {
            const key = `${cell.reviewId}:${cell.documentId}`;
            if (!cellSeen.has(key)) {
                cellSeen.add(key);
                if (!reviewsWithExplicitDocs.has(cell.reviewId)) {
                    docCounts[cell.reviewId] =
                        (docCounts[cell.reviewId] ?? 0) + 1;
                }
            }
        }
    }

    res.json(
        reviews.map((r) => {
            const id = (r as { id: string }).id;
            return { ...r, document_count: docCounts[id] ?? 0 };
        }),
    );
});

// POST /tabular-review
tabularRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { title, document_ids, columns_config, workflow_id, project_id } =
        req.body as {
            title?: string;
            document_ids: string[];
            columns_config: { index: number; name: string; prompt: string }[];
            workflow_id?: string;
            project_id?: string;
        };

    if (project_id) {
        const access = await checkProjectAccess(
            project_id,
            userId,
            userEmail,
        );
        if (!access.ok)
            return void res.status(404).json({ detail: "Project not found" });
    }
    const allowedDocumentIds = Array.isArray(document_ids)
        ? await filterAccessibleDocumentIds(
              document_ids,
              userId,
              userEmail,
          )
        : [];
    const review = await prisma.tabularReview.create({
        data: {
            userId,
            title: title ?? null,
            columnsConfig: columns_config,
            documentIds: allowedDocumentIds,
            projectId: project_id ?? null,
            workflowId: workflow_id ?? null,
        },
    });

    const cells = allowedDocumentIds.flatMap((docId) =>
        columns_config.map((col) => ({
            reviewId: review.id,
            documentId: docId,
            columnIndex: col.index,
            status: "pending" as const,
        })),
    );
    if (cells.length) {
        await prisma.tabularCell.createMany({ data: cells });
    }

    await auditLog({
        userId,
        action: "create",
        entity: "tabularReview",
        entityId: review.id,
    });

    res.status(201).json(review);
});

// POST /tabular-review/prompt (must come before /:reviewId routes)
tabularRouter.post("/prompt", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const title =
        typeof req.body.title === "string" ? req.body.title.trim() : "";
    if (!title)
        return void res.status(400).json({ detail: "title is required" });

    const format: string =
        typeof req.body.format === "string" ? req.body.format : "text";
    const documentName: string =
        typeof req.body.documentName === "string"
            ? req.body.documentName.trim()
            : "";
    const tags: string[] = Array.isArray(req.body.tags)
        ? req.body.tags.filter((t: unknown) => typeof t === "string")
        : [];

    const formatDescriptions: Record<string, string> = {
        text: "free-form text",
        bulleted_list: "a bulleted list",
        number: "a single number",
        percentage: "a percentage value",
        monetary_amount: "a monetary amount",
        currency: "a currency code",
        yes_no: "Yes or No",
        date: "a date",
        tag: tags.length ? `one of these tags: ${tags.join(", ")}` : "a tag",
    };
    const formatHint = formatDescriptions[format] ?? "free-form text";
    const tagsNote =
        format === "tag" && tags.length
            ? `\nAvailable tags: ${tags.join(", ")}`
            : "";
    const docNote = documentName ? `\nDocument type/name: ${documentName}` : "";

    const userMessage =
        `Column title: ${title}` +
        docNote +
        `\nExpected response format: ${formatHint}` +
        tagsNote +
        `\n\nWrite the best extraction prompt for a legal tabular review column with this title. ` +
        `Do NOT include any instruction about the response format in the prompt — ` +
        `format handling is applied separately and must not be duplicated inside the prompt text.`;

    try {
        const { title_model, api_keys } = await getUserModelSettings(userId);
        const raw = await completeText({
            model: title_model,
            systemPrompt:
                'You write high-quality column prompts for legal tabular review workflows. Return only valid JSON with a single field: {"prompt": string}. The prompt you write must focus solely on what to extract — never on how to format the response.',
            user: userMessage,
            maxTokens: 512,
            apiKeys: api_keys,
        });
        const parsed = JSON.parse(
            raw
                .replace(/^```(?:json)?\n?/i, "")
                .replace(/\n?```$/, "")
                .trim(),
        ) as { prompt?: unknown };
        if (typeof parsed.prompt === "string" && parsed.prompt.trim()) {
            res.json({ prompt: parsed.prompt.trim(), source: "llm" });
        } else {
            res.status(502).json({ detail: "LLM returned an empty prompt" });
        }
    } catch {
        res.status(502).json({ detail: "Failed to generate prompt from LLM" });
    }
});

// GET /tabular-review/:reviewId
tabularRouter.get("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;

    const review = await prisma.tabularReview.findUnique({
        where: { id: reviewId },
    });
    if (!review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const cells = await prisma.tabularCell.findMany({
        where: { reviewId },
    });
    const cellDocIds = [...new Set(cells.map((c) => c.documentId))];
    const hasExplicitDocIds = Array.isArray(review.documentIds);
    const explicitDocIds = hasExplicitDocIds
        ? (review.documentIds as string[])
        : [];
    const docIds = hasExplicitDocIds ? explicitDocIds : cellDocIds;
    const documents =
        docIds.length > 0
            ? await prisma.document.findMany({ where: { id: { in: docIds } } })
            : [];

    res.json({
        review: { ...review, is_owner: access.isOwner },
        cells: cells.map((cell) => ({
            ...cell,
            content: parseCellContent(cell.content),
        })),
        documents,
    });
});

// GET /tabular-review/:reviewId/people
tabularRouter.get("/:reviewId/people", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;

    const review = await prisma.tabularReview.findUnique({
        where: { id: reviewId },
        select: { id: true, userId: true, projectId: true, sharedWith: true },
    });
    if (!review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const sharedWith: string[] = (
        Array.isArray(review.sharedWith)
            ? (review.sharedWith as string[])
            : []
    ).map((e) => (e ?? "").toLowerCase());

    // Auth user listing still uses Supabase admin API
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

    const profileIds = [review.userId, ...memberUserIds].filter(
        (x, i, arr) => arr.indexOf(x) === i,
    );

    const profileByUserId = new Map<string, string | null>();
    if (profileIds.length > 0) {
        const profiles = await prisma.userProfile.findMany({
            where: { userId: { in: profileIds } },
            select: { userId: true, displayName: true },
        });
        for (const p of profiles) {
            profileByUserId.set(p.userId, p.displayName ?? null);
        }
    }

    const ownerInfo = userById.get(review.userId);
    res.json({
        owner: {
            user_id: review.userId,
            email: ownerInfo?.email ?? null,
            display_name: profileByUserId.get(review.userId) ?? null,
        },
        members: sharedWith.map((email) => {
            const u = userByEmail.get(email);
            const display_name = u ? (profileByUserId.get(u.id) ?? null) : null;
            return { email, display_name };
        }),
    });
});

// PATCH /tabular-review/:reviewId
tabularRouter.patch("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const updates: Record<string, unknown> = {};
    if (req.body.title != null) updates.title = req.body.title;
    if (req.body.columns_config != null)
        updates.columnsConfig = req.body.columns_config;
    if (req.body.project_id !== undefined)
        updates.projectId = req.body.project_id;
    let sharedWithUpdate: string[] | undefined;
    if (Array.isArray(req.body.shared_with)) {
        const normalizedUserEmail = userEmail?.trim().toLowerCase();
        const seen = new Set<string>();
        const cleaned: string[] = [];
        for (const raw of req.body.shared_with) {
            if (typeof raw !== "string") continue;
            const e = raw.trim().toLowerCase();
            if (!e || seen.has(e)) continue;
            if (normalizedUserEmail && e === normalizedUserEmail) {
                return void res.status(400).json({
                    detail: "You cannot share a tabular review with yourself.",
                });
            }
            seen.add(e);
            cleaned.push(e);
        }
        sharedWithUpdate = cleaned;
    }

    const existingReview = await prisma.tabularReview.findUnique({
        where: { id: reviewId },
    });
    if (!existingReview)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(
        existingReview,
        userId,
        userEmail,
    );
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });
    if (sharedWithUpdate !== undefined) {
        if (!access.isOwner)
            return void res
                .status(403)
                .json({ detail: "Only the review owner can change sharing" });
        updates.sharedWith = sharedWithUpdate;
    }

    const updatedReview = await prisma.tabularReview.update({
        where: { id: reviewId },
        data: updates,
    });

    let persistedDocumentIds: string[] | undefined;
    if (
        Array.isArray(req.body.columns_config) ||
        Array.isArray(req.body.document_ids)
    ) {
        const existingCells = await prisma.tabularCell.findMany({
            where: { reviewId },
            select: { documentId: true, columnIndex: true },
        });
        const existingKeys = new Set(
            existingCells.map(
                (cell) => `${cell.documentId}:${cell.columnIndex}`,
            ),
        );

        let documentIds: string[];

        if (Array.isArray(req.body.document_ids)) {
            const requestedDocIds = req.body.document_ids as string[];
            const existingDocIds = existingCells.map(
                (cell) => cell.documentId,
            );
            const existingDocIdSet = new Set(existingDocIds);
            const newDocCandidates = requestedDocIds.filter(
                (id) => !existingDocIdSet.has(id),
            );
            const newDocAllowed = await filterAccessibleDocumentIds(
                newDocCandidates,
                userId,
                userEmail,
            );
            const newDocAllowedSet = new Set(newDocAllowed);
            const newDocIds = requestedDocIds.filter(
                (id) => existingDocIdSet.has(id) || newDocAllowedSet.has(id),
            );
            const removedDocIds = existingDocIds.filter(
                (id) => !newDocIds.includes(id),
            );

            if (removedDocIds.length > 0) {
                await prisma.tabularCell.deleteMany({
                    where: {
                        reviewId,
                        documentId: { in: removedDocIds },
                    },
                });
            }

            documentIds = newDocIds;
        } else {
            documentIds = [
                ...new Set(existingCells.map((cell) => cell.documentId)),
            ];
        }

        if (Array.isArray(req.body.document_ids)) {
            persistedDocumentIds = documentIds;
            await prisma.tabularReview.update({
                where: { id: reviewId },
                data: { documentIds: documentIds },
            });
        }

        const activeColumns = Array.isArray(req.body.columns_config)
            ? req.body.columns_config
            : ((updatedReview.columnsConfig ?? []) as any[]);
        const newCells = documentIds.flatMap((documentId) =>
            activeColumns
                .filter(
                    (column: { index: number }) =>
                        !existingKeys.has(`${documentId}:${column.index}`),
                )
                .map((column: { index: number }) => ({
                    reviewId,
                    documentId,
                    columnIndex: column.index,
                    status: "pending" as const,
                })),
        );

        if (newCells.length > 0) {
            await prisma.tabularCell.createMany({ data: newCells });
        }
    }

    await auditLog({
        userId,
        action: "update",
        entity: "tabularReview",
        entityId: reviewId,
    });

    res.json({
        ...updatedReview,
        ...(persistedDocumentIds ? { document_ids: persistedDocumentIds } : {}),
    });
});

// DELETE /tabular-review/:reviewId
tabularRouter.delete("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { reviewId } = req.params;

    const existing = await prisma.tabularReview.findFirst({
        where: { id: reviewId, userId },
    });
    if (!existing)
        return void res.status(404).json({ detail: "Review not found" });

    await prisma.tabularReview.delete({ where: { id: reviewId } });

    await auditLog({
        userId,
        action: "delete",
        entity: "tabularReview",
        entityId: reviewId,
    });

    res.status(204).send();
});

// POST /tabular-review/:reviewId/clear-cells
tabularRouter.post("/:reviewId/clear-cells", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const { document_ids } = req.body as { document_ids?: string[] };

    if (!Array.isArray(document_ids) || document_ids.length === 0)
        return void res
            .status(400)
            .json({ detail: "document_ids is required" });

    const review = await prisma.tabularReview.findUnique({
        where: { id: reviewId },
        select: { id: true, userId: true, projectId: true },
    });
    if (!review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    await prisma.tabularCell.updateMany({
        where: {
            reviewId,
            documentId: { in: document_ids },
        },
        data: { content: null, status: "pending" },
    });
    res.status(204).send();
});

// POST /tabular-review/:reviewId/regenerate-cell
tabularRouter.post(
    "/:reviewId/regenerate-cell",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId } = req.params;
        const { document_id, column_index } = req.body as {
            document_id: string;
            column_index: number;
        };

        if (!document_id || column_index == null)
            return void res
                .status(400)
                .json({ detail: "document_id and column_index are required" });

        const review = await prisma.tabularReview.findUnique({
            where: { id: reviewId },
        });
        if (!review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        const column = (
            review.columnsConfig as {
                index: number;
                name: string;
                prompt: string;
                format?: string;
                tags?: string[];
            }[]
        ).find((c) => c.index === column_index);
        if (!column)
            return void res.status(400).json({ detail: "Column not found" });

        const docAllowed = await filterAccessibleDocumentIds(
            [document_id],
            userId,
            userEmail,
        );
        if (docAllowed.length === 0)
            return void res.status(404).json({ detail: "Document not found" });
        const doc = await prisma.document.findUnique({
            where: { id: document_id },
            select: { id: true, filename: true, fileType: true },
        });
        if (!doc)
            return void res.status(404).json({ detail: "Document not found" });
        const docActive = await loadActiveVersion(document_id);

        const { tabular_model, api_keys } = await getUserModelSettings(userId);
        const missingKey = missingModelApiKey(tabular_model, api_keys);
        if (missingKey) {
            return void res.status(422).json({
                code: "missing_api_key",
                ...missingKey,
            });
        }

        await prisma.tabularCell.updateMany({
            where: {
                reviewId,
                documentId: document_id,
                columnIndex: column_index,
            },
            data: { status: "generating", content: null },
        });

        let markdown = "";
        if (docActive) {
            const buf = await downloadFile(docActive.storage_path);
            if (buf) {
                try {
                    markdown =
                        doc.fileType === "pdf"
                            ? await extractPdfMarkdown(buf)
                            : await extractDocxMarkdown(buf);
                } catch (err) {
                    logger.error(
                        { err, document_id },
                        "[regenerate-cell] extraction error",
                    );
                }
            }
        }

        const result = await queryTabularCell(
            tabular_model,
            doc.filename,
            markdown,
            column.prompt,
            column.format,
            column.tags,
            api_keys,
        );

        if (!result) {
            await prisma.tabularCell.updateMany({
                where: {
                    reviewId,
                    documentId: document_id,
                    columnIndex: column_index,
                },
                data: { status: "failed" },
            });
            return void res.status(500).json({ detail: "Generation failed" });
        }

        await prisma.tabularCell.updateMany({
            where: {
                reviewId,
                documentId: document_id,
                columnIndex: column_index,
            },
            data: { content: JSON.stringify(result), status: "complete" },
        });

        res.json(result);
    },
);

// POST /tabular-review/:reviewId/generate
tabularRouter.post("/:reviewId/generate", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;

    const review = await prisma.tabularReview.findUnique({
        where: { id: reviewId },
    });
    if (!review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const columns: {
        index: number;
        name: string;
        prompt: string;
        format?: string;
        tags?: string[];
    }[] = (review.columnsConfig as any[]) ?? [];
    if (columns.length === 0)
        return void res.status(400).json({ detail: "No columns configured" });

    const cells = await prisma.tabularCell.findMany({
        where: { reviewId },
    });
    const cellMap = new Map<string, Record<string, unknown>>();
    for (const cell of cells)
        cellMap.set(`${cell.documentId}:${cell.columnIndex}`, cell as unknown as Record<string, unknown>);

    const docIds = [...new Set(cells.map((c) => c.documentId))];
    const allowedDocIds = new Set(
        await filterAccessibleDocumentIds(docIds, userId, userEmail),
    );
    let docs: { id: string; filename: string; fileType: string | null; pageCount: number | null }[] = [];
    if (docIds.length > 0) {
        const filteredIds = docIds.filter((id) => allowedDocIds.has(id));
        if (filteredIds.length > 0) {
            docs = await prisma.document.findMany({
                where: { id: { in: filteredIds } },
                select: { id: true, filename: true, fileType: true, pageCount: true },
            });
        }
    } else if (review.projectId) {
        docs = await prisma.document.findMany({
            where: { projectId: review.projectId },
            select: { id: true, filename: true, fileType: true, pageCount: true },
            orderBy: { createdAt: "asc" },
        });
    }

    const { tabular_model, api_keys } = await getUserModelSettings(userId);
    const missingKey = missingModelApiKey(tabular_model, api_keys);
    if (missingKey) {
        return void res.status(422).json({
            code: "missing_api_key",
            ...missingKey,
        });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = (line: string) => res.write(line);

    try {
        await Promise.all(
            docs.map(async (doc) => {
                const docId = doc.id;
                const filename = doc.filename;
                let markdown = "";

                const active = await loadActiveVersion(docId);
                if (active) {
                    const buf = await downloadFile(active.storage_path);
                    if (buf) {
                        try {
                            markdown =
                                doc.fileType === "pdf"
                                    ? await extractPdfMarkdown(buf)
                                    : await extractDocxMarkdown(buf);
                        } catch (err) {
                            logger.error(
                                { err, docId },
                                "[tabular/generate] extraction error",
                            );
                        }
                    }
                }

                const columnsToProcess = columns.filter((col) => {
                    const cell = cellMap.get(`${docId}:${col.index}`);
                    return !(cell?.status === "complete" && cell?.content);
                });
                if (columnsToProcess.length === 0) return;

                for (const col of columnsToProcess) {
                    write(
                        `data: ${JSON.stringify({ type: "cell_update", document_id: docId, column_index: col.index, content: null, status: "generating" })}\n\n`,
                    );
                    const existingCell = cellMap.get(`${docId}:${col.index}`);
                    if (existingCell) {
                        await prisma.tabularCell.update({
                            where: { id: existingCell.id as string },
                            data: { status: "generating", content: null },
                        });
                    } else {
                        await prisma.tabularCell.create({
                            data: {
                                reviewId,
                                documentId: docId,
                                columnIndex: col.index,
                                status: "generating",
                            },
                        });
                    }
                }

                const receivedColumns = new Set<number>();
                try {
                    await queryTabularAllColumns(
                        tabular_model,
                        filename,
                        markdown,
                        columnsToProcess,
                        async (columnIndex, result) => {
                            receivedColumns.add(columnIndex);
                            await prisma.tabularCell.updateMany({
                                where: {
                                    reviewId,
                                    documentId: docId,
                                    columnIndex,
                                },
                                data: {
                                    content: JSON.stringify(result),
                                    status: "complete",
                                },
                            });
                            write(
                                `data: ${JSON.stringify({ type: "cell_update", document_id: docId, column_index: columnIndex, content: result, status: "done" })}\n\n`,
                            );
                        },
                        api_keys,
                    );
                } catch (err) {
                    logger.error(
                        { err, docId },
                        "[tabular/generate] queryTabularAllColumns error",
                    );
                }

                for (const col of columnsToProcess) {
                    if (!receivedColumns.has(col.index)) {
                        await prisma.tabularCell.updateMany({
                            where: {
                                reviewId,
                                documentId: docId,
                                columnIndex: col.index,
                            },
                            data: { status: "failed" },
                        });
                        write(
                            `data: ${JSON.stringify({ type: "cell_update", document_id: docId, column_index: col.index, content: null, status: "error" })}\n\n`,
                        );
                    }
                }
            }),
        );

        write("data: [DONE]\n\n");
    } catch (err) {
        logger.error({ err }, "[tabular/generate] stream error");
        try {
            write(
                `data: ${JSON.stringify({ type: "error", message: String(err) })}\n\ndata: [DONE]\n\n`,
            );
        } catch {
            /* ignore */
        }
    } finally {
        res.end();
    }
});

// GET /tabular-review/:reviewId/chats
tabularRouter.get("/:reviewId/chats", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;

    const review = await prisma.tabularReview.findUnique({
        where: { id: reviewId },
        select: { id: true, userId: true, projectId: true },
    });
    if (!review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const chats = await prisma.tabularReviewChat.findMany({
        where: { reviewId },
        select: { id: true, title: true, createdAt: true, updatedAt: true, userId: true },
        orderBy: { updatedAt: "desc" },
    });

    res.json(chats);
});

// DELETE /tabular-review/:reviewId/chats/:chatId
tabularRouter.delete(
    "/:reviewId/chats/:chatId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const { chatId } = req.params;
        // Owner-only delete
        const existing = await prisma.tabularReviewChat.findFirst({
            where: { id: chatId, userId },
        });
        if (!existing)
            return void res.status(404).json({ detail: "Chat not found" });

        await prisma.tabularReviewChat.delete({ where: { id: chatId } });
        res.status(204).send();
    },
);

// GET /tabular-review/:reviewId/chats/:chatId/messages
tabularRouter.get(
    "/:reviewId/chats/:chatId/messages",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId, chatId } = req.params;

        const review = await prisma.tabularReview.findUnique({
            where: { id: reviewId },
            select: { id: true, userId: true, projectId: true },
        });
        if (!review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        const chat = await prisma.tabularReviewChat.findUnique({
            where: { id: chatId },
            select: { id: true, reviewId: true },
        });
        if (!chat || chat.reviewId !== reviewId)
            return void res.status(404).json({ detail: "Chat not found" });

        const messages = await prisma.tabularReviewChatMessage.findMany({
            where: { chatId },
            select: { id: true, role: true, content: true, annotations: true, createdAt: true },
            orderBy: { createdAt: "asc" },
        });

        res.json(messages);
    },
);

// ---------------------------------------------------------------------------
// Tabular citation parsing
// ---------------------------------------------------------------------------

type TabularParsedCitation = {
    ref: number;
    col_index: number;
    row_index: number;
    quote: string;
};

const TABULAR_CITATIONS_BLOCK_RE = /<CITATIONS>\s*([\s\S]*?)\s*<\/CITATIONS>/;

function parseTabularCitations(text: string): TabularParsedCitation[] {
    const match = text.match(TABULAR_CITATIONS_BLOCK_RE);
    if (!match) return [];
    try {
        return JSON.parse(match[1]) as TabularParsedCitation[];
    } catch {
        return [];
    }
}

function extractTabularAnnotations(
    fullText: string,
    tabularStore: TabularCellStore,
) {
    return parseTabularCitations(fullText).map((c) => ({
        type: "tabular_citation" as const,
        ref: c.ref,
        col_index: c.col_index,
        row_index: c.row_index,
        col_name:
            tabularStore.columns[c.col_index]?.name ?? `Col ${c.col_index}`,
        doc_name:
            tabularStore.documents[c.row_index]?.filename ??
            `Row ${c.row_index}`,
        quote: c.quote,
    }));
}

// ---------------------------------------------------------------------------
// Build messages for tabular chat
// ---------------------------------------------------------------------------

function buildTabularMessages(
    messages: ChatMessage[],
    tabularStore: TabularCellStore,
    reviewTitle: string,
): unknown[] {
    const docList = tabularStore.documents
        .map((d, i) => `- ROW:${i} "${d.filename}"`)
        .join("\n");
    const colList = tabularStore.columns
        .map((c, i) => `- COL:${i} "${c.name}"`)
        .join("\n");

    const systemContent = `You are Mike, an AI legal assistant. You are helping with the tabular review titled "${reviewTitle}".

The review extracts specific fields from multiple legal documents into a structured table.
You do NOT have the cell content yet — call read_table_cells to fetch the cells you need before answering.

DOCUMENTS (rows):
${docList || "- (none)"}

COLUMNS (fields):
${colList || "- (none)"}

TABULAR CITATION INSTRUCTIONS:
When you reference specific cell content, place a numbered marker [1], [2], etc. inline in your prose at the point of reference.

After your complete response, append a <CITATIONS> block containing a JSON array with one entry per marker:

<CITATIONS>
[
  {"ref": 1, "col_index": 0, "row_index": 2, "quote": "verbatim text from the cell"},
  {"ref": 2, "col_index": 1, "row_index": 0, "quote": "another excerpt"}
]
</CITATIONS>

Rules:
- col_index and row_index are 0-based (matching the COL/ROW numbers listed above)
- Only cite cells you have read via read_table_cells
- quote should be verbatim text from the cell's summary
- Omit <CITATIONS> if you make no citations
- Do not fabricate cell content
- Answer in clear, concise prose. You may use markdown formatting.`;

    const formatted: unknown[] = [{ role: "system", content: systemContent }];
    for (const msg of messages) {
        formatted.push({ role: msg.role, content: msg.content ?? "" });
    }
    return formatted;
}

// ---------------------------------------------------------------------------
// POST /tabular-review/:reviewId/chat — agentic streaming
// ---------------------------------------------------------------------------

tabularRouter.post("/:reviewId/chat", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const {
        messages,
        chat_id: existingChatId,
        review_title: clientReviewTitle,
        project_name: clientProjectName,
    } = req.body as {
        messages: ChatMessage[];
        chat_id?: string;
        review_title?: string;
        project_name?: string;
    };

    const lastUser = [...(messages ?? [])]
        .reverse()
        .find((m) => m.role === "user");
    if (!lastUser?.content?.trim()) {
        return void res
            .status(400)
            .json({ detail: "messages must include a user message" });
    }

    const review = await prisma.tabularReview.findUnique({
        where: { id: reviewId },
    });
    if (!review)
        return void res.status(404).json({ detail: "Review not found" });
    const reviewAccess = await ensureReviewAccess(
        review,
        userId,
        userEmail,
    );
    if (!reviewAccess.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const cells = await prisma.tabularCell.findMany({
        where: { reviewId },
    });

    const docIds = [
        ...new Set(cells.map((c) => c.documentId)),
    ];
    let docs: { id: string; filename: string }[] = [];
    if (docIds.length > 0) {
        docs = await prisma.document.findMany({
            where: { id: { in: docIds } },
            select: { id: true, filename: true },
            orderBy: { createdAt: "asc" },
        });
    }

    const sortedColumns = (
        (review.columnsConfig ?? []) as { index: number; name: string }[]
    ).sort((a, b) => a.index - b.index);

    const tabularStore: TabularCellStore = {
        columns: sortedColumns,
        documents: docs,
        cells: new Map(
            cells.map((c) => [
                `${c.columnIndex}:${c.documentId}`,
                parseCellContent(c.content),
            ]),
        ),
    };

    const { tabular_model, api_keys } = await getUserModelSettings(userId);
    const missingKey = missingModelApiKey(tabular_model, api_keys);
    if (missingKey) {
        return void res.status(422).json({
            code: "missing_api_key",
            ...missingKey,
        });
    }

    // Create or verify chat record
    let chatId = existingChatId ?? null;
    let chatTitle: string | null = null;
    const isFirstExchange =
        messages.filter((m) => m.role === "user").length === 1;

    if (chatId) {
        const existing = await prisma.tabularReviewChat.findUnique({
            where: { id: chatId },
            select: { id: true, title: true, reviewId: true, userId: true },
        });
        const canUse =
            !!existing &&
            (existing.reviewId === reviewId || existing.userId === userId);
        if (!canUse || !existing) chatId = null;
        else chatTitle = existing.title;
    }

    if (!chatId) {
        const newChat = await prisma.tabularReviewChat.create({
            data: { reviewId, userId },
            select: { id: true, title: true },
        });
        chatId = newChat.id;
        chatTitle = newChat.title;
    }

    // Persist user message
    if (chatId) {
        await prisma.tabularReviewChatMessage.create({
            data: {
                chatId,
                role: "user",
                content: lastUser.content,
            },
        });
    }

    const apiMessages = buildTabularMessages(
        messages,
        tabularStore,
        review.title || "Untitled Review",
    );

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const write = (line: string) => res.write(line);

    if (chatId) {
        write(`data: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`);
    }

    try {
        const { fullText, events } = await runLLMStream({
            apiMessages,
            docStore: new Map(),
            docIndex: {},
            userId,
            write,
            extraTools: TABULAR_TOOLS,
            tabularStore,
            buildCitations: (text) =>
                extractTabularAnnotations(text, tabularStore),
            model: tabular_model,
            apiKeys: api_keys,
        });

        const annotations = extractTabularAnnotations(fullText, tabularStore);

        if (chatId) {
            await prisma.tabularReviewChatMessage.create({
                data: {
                    chatId,
                    role: "assistant",
                    content: events.length ? events : undefined,
                    annotations: annotations.length ? annotations : undefined,
                },
            });
            await prisma.tabularReviewChat.update({
                where: { id: chatId },
                data: {},  // triggers @updatedAt
            });
        }

        // Generate title on first exchange
        if (chatId && isFirstExchange && !chatTitle && lastUser.content) {
            const { title_model } = await getUserModelSettings(userId);
            const title = await generateChatTitle(
                title_model,
                lastUser.content,
                {
                    reviewTitle: clientReviewTitle ?? review.title ?? null,
                    projectName: clientProjectName ?? null,
                },
                api_keys,
            );
            if (title) {
                await prisma.tabularReviewChat.update({
                    where: { id: chatId },
                    data: { title },
                });
                write(
                    `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                );
            }
        }
    } catch (err) {
        logger.error({ err }, "[tabular/chat] error");
        try {
            write(
                `data: ${JSON.stringify({ type: "error", message: String(err) })}\n\n`,
            );
            write("data: [DONE]\n\n");
        } catch {
            /* ignore */
        }
    } finally {
        res.end();
    }
});

function parseCellContent(
    raw: unknown,
): { summary: string; flag?: string; reasoning?: string } | null {
    if (!raw) return null;
    if (typeof raw === "object" && raw !== null && "summary" in raw) {
        const c = raw as {
            summary?: unknown;
            flag?: unknown;
            reasoning?: unknown;
        };
        return {
            summary: String(c.summary ?? ""),
            flag: (["green", "grey", "yellow", "red"] as const).includes(
                c.flag as "green",
            )
                ? (c.flag as string)
                : undefined,
            reasoning: typeof c.reasoning === "string" ? c.reasoning : "",
        };
    }
    if (typeof raw === "string") {
        try {
            const p = JSON.parse(raw) as {
                summary?: unknown;
                value?: unknown;
                flag?: unknown;
                reasoning?: unknown;
            };
            return {
                summary: String(p.summary ?? p.value ?? "").trim(),
                flag: (["green", "grey", "yellow", "red"] as const).includes(
                    p.flag as "green",
                )
                    ? (p.flag as string)
                    : undefined,
                reasoning: typeof p.reasoning === "string" ? p.reasoning : "",
            };
        } catch {
            return { summary: raw, flag: "grey", reasoning: "" };
        }
    }
    return null;
}

async function queryTabularCell(
    model: string,
    filename: string,
    documentText: string,
    columnPrompt: string,
    format?: string,
    tags?: string[],
    apiKeys?: import("../lib/llm").UserApiKeys,
) {
    const suffix = formatPromptSuffix(format as never, tags);
    const fullPrompt = `${columnPrompt}${suffix} If not found, state "Not Found". Leave all reasoning and explanation in the "reasoning" field only.`;

    const EXTRACTION_SYSTEM = `You are a legal document analyst. Return ONLY valid JSON:
{"summary": string, "flag": "green"|"grey"|"yellow"|"red", "reasoning": string}

The "summary" and "reasoning" field values may use markdown formatting (bullets, bold, italics, etc.) — the values are still plain JSON strings (escape newlines as \\n), but the text inside will be rendered as markdown in the UI.

The "summary" field must contain only the extracted value with inline citations — no explanation or reasoning. Every factual claim in "summary" must be followed immediately by a citation in the format [[page:N||quote:exact quoted text]], where N is the page number and the quote is a short verbatim excerpt (≤ 25 words). The quote must be narrowly scoped to the specific claim it supports — extract only the exact words that support that statement, not the surrounding sentence or paragraph. Do not have multiple claims share the same long quote; if two different statements need different evidence, give each its own short, narrowly-scoped quote. All reasoning and explanation belongs in "reasoning" only, which may also contain citations.`;

    let raw: string;
    try {
        raw = await completeText({
            model,
            systemPrompt: EXTRACTION_SYSTEM,
            user: `Document: ${filename}\n\n${documentText.slice(0, 120_000)}\n\n---\nInstruction: ${fullPrompt}`,
            maxTokens: 2048,
            apiKeys,
        });
    } catch (err) {
        logger.error({ err }, "[queryTabularCell] completion failed");
        return null;
    }
    try {
        const parsed = JSON.parse(
            raw
                .replace(/^```(?:json)?\n?/i, "")
                .replace(/\n?```$/, "")
                .trim(),
        ) as {
            summary?: unknown;
            value?: unknown;
            flag?: unknown;
            reasoning?: unknown;
        };
        return {
            summary:
                String(parsed.summary ?? parsed.value ?? "").trim() ||
                "Not addressed",
            flag: (["green", "grey", "yellow", "red"] as const).includes(
                parsed.flag as "green",
            )
                ? (parsed.flag as "green")
                : "grey",
            reasoning: String(parsed.reasoning ?? ""),
        };
    } catch {
        return raw.trim()
            ? {
                  summary: raw.trim().slice(0, 500),
                  flag: "grey" as const,
                  reasoning: "",
              }
            : null;
    }
}

async function generateChatTitle(
    model: string,
    firstUserMessage: string,
    context?: { reviewTitle?: string | null; projectName?: string | null },
    apiKeys?: import("../lib/llm").UserApiKeys,
): Promise<string | null> {
    try {
        const contextLines: string[] = [];
        if (context?.projectName)
            contextLines.push(`Project: ${context.projectName}`);
        if (context?.reviewTitle)
            contextLines.push(`Tabular review: ${context.reviewTitle}`);
        const contextBlock = contextLines.length
            ? `This chat is in the context of a tabular review.\n${contextLines.join("\n")}\n\n`
            : "";

        const raw = await completeText({
            model,
            user: `${contextBlock}Generate a short title (4-6 words) for a chat that starts with the message below. The title should reflect the user's specific question, not the review or project name. Return only the title, no punctuation, no quotes:\n\n${firstUserMessage}`,
            maxTokens: 64,
            apiKeys,
        });
        return raw.trim().slice(0, 80) || null;
    } catch {
        return null;
    }
}

type CellResult = {
    summary: string;
    flag: "green" | "grey" | "yellow" | "red";
    reasoning: string;
};
type Column = {
    index: number;
    name: string;
    prompt: string;
    format?: string;
    tags?: string[];
};

async function queryTabularAllColumns(
    model: string,
    filename: string,
    documentText: string,
    columns: Column[],
    onResult: (columnIndex: number, result: CellResult) => Promise<void>,
    apiKeys?: import("../lib/llm").UserApiKeys,
): Promise<void> {
    const columnsDesc = columns
        .map((col) => {
            const suffix = formatPromptSuffix(col.format as never, col.tags);
            const fullPrompt = `${col.prompt}${suffix} If not found, state "Not Found".`;
            return `Column ${col.index} — "${col.name}": ${fullPrompt}`;
        })
        .join("\n");

    const SYSTEM = `You are a legal document analyst. Extract information for each column listed below.

For each column, output exactly one minified JSON object on its own line (no line breaks inside the JSON), then a newline. Process columns in order and output each result as soon as you finish it.

Line format:
{"column_index": <N>, "summary": <string>, "flag": <"green"|"grey"|"yellow"|"red">, "reasoning": <string>}

Rules:
- "summary": the extracted value with inline citations [[page:N||quote:verbatim excerpt ≤25 words]] after every factual claim. No explanation or reasoning here. Quotes must be narrowly scoped to the specific claim — extract only the exact supporting words, not the full surrounding sentence. Do not reuse one long quote across multiple statements; give each claim its own short, precise quote.
- "flag": green = standard/favorable, yellow = needs attention, red = problematic/unfavorable, grey = neutral/not found
- "reasoning": brief explanation of the extraction
- The "summary" and "reasoning" string VALUES may use markdown (bullets, bold, italics, etc.) — escape newlines as \\n inside the JSON string. This markdown is rendered in the UI.
- Output ONLY the JSON lines themselves. Do NOT wrap the response in markdown code fences (e.g. \`\`\`json), and do not add any preamble or summary.`;

    const USER = `Document: ${filename}\n\n${documentText.slice(0, 120_000)}\n\n---\nColumns to extract:\n${columnsDesc}`;

    let contentBuffer = "";
    const pending: Promise<unknown>[] = [];

    const processLine = async (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
            const parsed = JSON.parse(trimmed) as {
                column_index?: unknown;
                summary?: unknown;
                flag?: unknown;
                reasoning?: unknown;
            };
            if (typeof parsed.column_index !== "number") return;
            const col = columns.find((c) => c.index === parsed.column_index);
            if (!col) return;
            await onResult(parsed.column_index, {
                summary: String(parsed.summary ?? "").trim() || "Not addressed",
                flag: (["green", "grey", "yellow", "red"] as const).includes(
                    parsed.flag as "green",
                )
                    ? (parsed.flag as CellResult["flag"])
                    : "grey",
                reasoning: String(parsed.reasoning ?? ""),
            });
        } catch {
            // malformed line — skip
        }
    };

    try {
        await streamChatWithTools({
            model,
            systemPrompt: SYSTEM,
            messages: [{ role: "user", content: USER }],
            tools: [],
            apiKeys,
            callbacks: {
                onContentDelta: (delta) => {
                    contentBuffer += delta;
                    let newlineIdx: number;
                    while ((newlineIdx = contentBuffer.indexOf("\n")) !== -1) {
                        const completedLine = contentBuffer.slice(
                            0,
                            newlineIdx,
                        );
                        contentBuffer = contentBuffer.slice(newlineIdx + 1);
                        pending.push(processLine(completedLine));
                    }
                },
            },
        });
    } catch (err) {
        logger.error({ err }, "[queryTabularAllColumns] stream failed");
    }

    if (contentBuffer.trim()) pending.push(processLine(contentBuffer));
    await Promise.all(pending);
}

async function extractPdfMarkdown(buf: ArrayBuffer): Promise<string> {
    try {
        const pdfjsLib = await import(
            "pdfjs-dist/legacy/build/pdf.mjs" as string
        );
        const pdf = await (
            pdfjsLib as unknown as {
                getDocument: (opts: unknown) => {
                    promise: Promise<{
                        numPages: number;
                        getPage: (n: number) => Promise<{
                            getTextContent: () => Promise<{
                                items: { str?: string; hasEOL?: boolean }[];
                            }>;
                        }>;
                    }>;
                };
            }
        ).getDocument({ data: new Uint8Array(buf) }).promise;
        const pages: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const tc = await page.getTextContent();
            const text = tc.items
                .filter((it): it is { str: string } => "str" in it)
                .map((it) => it.str)
                .join(" ")
                .trim();
            if (text) pages.push(`## Page ${i}\n\n${text}`);
        }
        return pages.join("\n\n");
    } catch {
        return "";
    }
}

async function extractDocxMarkdown(buf: ArrayBuffer): Promise<string> {
    try {
        const mammoth = await import("mammoth");
        const normalized = await normalizeDocxZipPaths(Buffer.from(buf));
        const { value: html } = await mammoth.convertToHtml({
            buffer: normalized,
        });
        return html
            .replace(
                /<h([1-6])[^>]*>(.*?)<\/h\1>/gi,
                (_, l, t) => "#".repeat(Number(l)) + " " + t + "\n\n",
            )
            .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**")
            .replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n")
            .replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    } catch {
        return "";
    }
}
