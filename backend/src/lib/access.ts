/**
 * Project / document access helpers.
 *
 * Sharing makes the previous "scope by user_id" pattern incorrect — a doc
 * can belong to user A's project that A has shared with B's email, and B
 * must still be able to read/edit it. These helpers centralize the
 * "owner OR shared project member" check so every route uses the same
 * logic instead of re-implementing the join.
 *
 * Returned `isOwner` lets callers gate operations that should stay
 * owner-only (delete, rename, member management).
 */

import { prisma } from "./prisma";

export type ProjectAccess =
    | {
          ok: true;
          isOwner: boolean;
          project: {
              id: string;
              userId: string;
              sharedWith: string[] | null;
          };
      }
    | { ok: false };

export async function checkProjectAccess(
    projectId: string,
    userId: string,
    userEmail: string | null | undefined,
): Promise<ProjectAccess> {
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, userId: true, sharedWith: true },
    });
    if (!project) return { ok: false };
    const sharedWith = Array.isArray(project.sharedWith)
        ? (project.sharedWith as string[])
        : [];
    if (project.userId === userId) {
        return {
            ok: true,
            isOwner: true,
            project: { id: project.id, userId: project.userId, sharedWith },
        };
    }
    const email = (userEmail ?? "").toLowerCase();
    if (
        email &&
        sharedWith.some((e) => (e ?? "").toLowerCase() === email)
    ) {
        return {
            ok: true,
            isOwner: false,
            project: { id: project.id, userId: project.userId, sharedWith },
        };
    }
    return { ok: false };
}

/**
 * Check whether the current user can access a document the caller has
 * already loaded (saves a round-trip vs. having the helper re-fetch).
 * Owner-of-doc passes immediately; otherwise we fall through to a
 * project-membership check via `shared_with`.
 */
export async function ensureDocAccess(
    doc: { userId: string; projectId: string | null },
    userId: string,
    userEmail: string | null | undefined,
): Promise<{ ok: true; isOwner: boolean } | { ok: false }> {
    if (doc.userId === userId) return { ok: true, isOwner: true };
    if (!doc.projectId) return { ok: false };
    const access = await checkProjectAccess(
        doc.projectId,
        userId,
        userEmail,
    );
    if (access.ok) return { ok: true, isOwner: false };
    return { ok: false };
}

/**
 * Same shape as `ensureDocAccess`, for tabular_reviews. A review can be
 * shared in two ways:
 *   1. Indirectly — if `project_id` is set, everyone with project access
 *      can read/operate on it.
 *   2. Directly — `tabular_reviews.shared_with` is a per-review email list
 *      so standalone reviews (project_id null) can also be shared.
 * The owner (review.user_id) always has access.
 */
export async function ensureReviewAccess(
    review: {
        userId: string;
        projectId: string | null;
        sharedWith?: unknown;
    },
    userId: string,
    userEmail: string | null | undefined,
): Promise<{ ok: true; isOwner: boolean } | { ok: false }> {
    if (review.userId === userId) return { ok: true, isOwner: true };
    const email = (userEmail ?? "").toLowerCase();
    const sharedWith = Array.isArray(review.sharedWith) ? review.sharedWith as string[] : [];
    if (email && sharedWith.length > 0) {
        if (sharedWith.some((e) => (e ?? "").toLowerCase() === email)) {
            return { ok: true, isOwner: false };
        }
    }
    if (!review.projectId) return { ok: false };
    const access = await checkProjectAccess(
        review.projectId,
        userId,
        userEmail,
    );
    if (access.ok) return { ok: true, isOwner: false };
    return { ok: false };
}

/**
 * Filter user-supplied document IDs down to documents the caller can read.
 *
 * Tabular review routes accept document IDs from request bodies. Without this
 * check, a caller with access to any review could attach arbitrary document
 * UUIDs and later cause /generate or /regenerate-cell to extract those bytes.
 */
export async function filterAccessibleDocumentIds(
    documentIds: string[],
    userId: string,
    userEmail: string | null | undefined,
): Promise<string[]> {
    if (documentIds.length === 0) return [];
    const docs = await prisma.document.findMany({
        where: { id: { in: documentIds } },
        select: { id: true, userId: true, projectId: true },
    });
    if (docs.length === 0) return [];

    const accessibleProjectIds = new Set(
        await listAccessibleProjectIds(userId, userEmail),
    );
    const allowed: string[] = [];
    for (const doc of docs) {
        if (doc.userId === userId) {
            allowed.push(doc.id);
        } else if (
            doc.projectId &&
            accessibleProjectIds.has(doc.projectId)
        ) {
            allowed.push(doc.id);
        }
    }
    return allowed;
}

/**
 * Returns the set of project IDs the user can access — own projects plus
 * any project where their email is in `shared_with`. Used to scope chat
 * lists and similar collection queries.
 */
export async function listAccessibleProjectIds(
    userId: string,
    userEmail: string | null | undefined,
): Promise<string[]> {
    const ownProjects = await prisma.project.findMany({
        where: { userId },
        select: { id: true },
    });

    let sharedProjects: { id: string }[] = [];
    if (userEmail) {
        sharedProjects = await prisma.project.findMany({
            where: {
                sharedWith: { path: [], array_contains: [userEmail] },
                userId: { not: userId },
            },
            select: { id: true },
        });
    }

    const ids = new Set<string>();
    for (const p of ownProjects) ids.add(p.id);
    for (const p of sharedProjects) ids.add(p.id);
    return [...ids];
}
