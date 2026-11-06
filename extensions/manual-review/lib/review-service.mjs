// Review lifecycle: snapshots/revisions, threads, messages, delivery state, lessons.
// Pure persistence + domain logic; agent delivery and HTTP live elsewhere.
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import * as gitDefault from "./git.mjs";
import { relocate } from "./anchors.mjs";
import { hunkExcerpt, selectedLines } from "./diff.mjs";

export const THREAD_KINDS = ["overview", "file", "change", "line"];
export const THREAD_STATUSES = ["active", "resolved", "wontfix", "closed"];
export const OUTCOMES = ["answered", "changed", "blocked", "disagreed", "needs-input"];
const MAX_BODY = 20000;
const MAX_RANGE = 2000;
const MAX_ANCHOR_LINES = 400;
const MAX_FULL_FILE_LINES = 20000;

export class ReviewError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

const invalid = (msg) => new ReviewError("invalid_input", msg);
const notFound = (msg) => new ReviewError("not_found", msg);

function slug(value) {
    return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

export function computeReviewId({ repoRoot, branch, base, paths = [], exclude = [] }) {
    const hash = createHash("sha256")
        .update([path.resolve(repoRoot).toLowerCase(), branch, base, [...paths].sort().join(","), [...exclude].sort().join(",")].join("|"))
        .digest("hex")
        .slice(0, 8);
    const readable = slug(`${path.basename(repoRoot)}-${branch}-vs-${base}`).slice(0, 80) || "review";
    return `${readable}-${hash}`;
}

function nowIso() {
    return new Date().toISOString();
}

function checkBody(body) {
    if (typeof body !== "string" || !body.trim()) throw invalid("Comment body is required.");
    if (body.length > MAX_BODY) throw invalid(`Comment body exceeds ${MAX_BODY} characters.`);
    return body.trim();
}

function checkLine(value, name) {
    if (!Number.isInteger(value) || value < 1) throw invalid(`${name} must be a positive integer.`);
    return value;
}

function allMessages(review) {
    return review.threads.flatMap((t) => t.messages.map((m) => ({ thread: t, message: m })));
}

function findDuplicate(review, clientRequestId) {
    if (!clientRequestId) return null;
    return allMessages(review).find((e) => e.message.clientRequestId === clientRequestId) ?? null;
}

function findThread(review, threadId) {
    const thread = review.threads.find((t) => t.threadId === threadId);
    if (!thread) throw notFound(`Thread ${threadId} not found in review ${review.reviewId}.`);
    return thread;
}

function matchesRevision(file, oldLines, newLines) {
    let oldIndex = 0;
    let newIndex = 0;
    for (const hunk of file.hunks) {
        const oldStart = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
        const newStart = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
        if (oldStart < oldIndex || newStart < newIndex || oldStart - oldIndex !== newStart - newIndex) return false;
        while (oldIndex < oldStart) {
            if (oldLines[oldIndex++] !== newLines[newIndex++]) return false;
        }
        for (const row of hunk.rows) {
            if (row.o != null) {
                if (row.o !== oldIndex + 1 || oldLines[oldIndex] !== row.s) return false;
                oldIndex++;
            }
            if (row.n != null) {
                if (row.n !== newIndex + 1 || newLines[newIndex] !== row.s) return false;
                newIndex++;
            }
        }
        if (oldIndex !== oldStart + hunk.oldLines || newIndex !== newStart + hunk.newLines) return false;
    }
    if (oldLines.length - oldIndex !== newLines.length - newIndex) return false;
    while (oldIndex < oldLines.length) {
        if (oldLines[oldIndex++] !== newLines[newIndex++]) return false;
    }
    return true;
}

const DELIVERY_RANK = { saving: 0, failed: 1, queued: 2, processing: 3, "no-reply": 4, replied: 5 };

export class ReviewService extends EventEmitter {
    constructor({ store, git = gitDefault, log = () => {} }) {
        super();
        this.store = store;
        this.git = git;
        this.log = log;
        this.refreshes = new Map();
    }

    changed(reviewId, reason) {
        this.emit("changed", { reviewId, reason });
    }

    async getReview(reviewId) {
        const review = await this.store.readReview(reviewId);
        if (!review) throw notFound(`Review ${reviewId} not found.`);
        return review;
    }

    async updateDescription(reviewId, { body, expectedVersion }) {
        const text = checkBody(body);
        if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw invalid("expectedVersion must be a non-negative integer.");
        const description = await this.store.updateReview(reviewId, (review) => {
            if (!review) throw notFound(`Review ${reviewId} not found.`);
            const current = review.description;
            if ((current?.version ?? 0) !== expectedVersion) {
                throw new ReviewError("conflict", "Description changed. Read the current description before revising it.");
            }
            if (current?.body === text) return { write: false, value: current };
            review.description = { body: text, version: expectedVersion + 1, revisionId: review.currentRevisionId, updatedAt: nowIso() };
            return { review, value: review.description };
        });
        this.changed(reviewId, "description");
        return description;
    }

    descriptionContext(review, input) {
        if (input.descriptionVersion !== undefined && input.descriptionVersion !== (review.description?.version ?? 0)) {
            throw new ReviewError("conflict", "Description changed since you read it. Refresh and review it before posting.");
        }
        return review.description ? { ...review.description } : null;
    }

    // Creates the review on first open, then captures a fresh snapshot.
    async ensureReview(input = {}, { cwd = process.cwd() } = {}) {
        if (input.reviewId) {
            await this.getReview(input.reviewId);
            if (input.title) {
                await this.store.updateReview(input.reviewId, (r) => ({ review: Object.assign(r, { title: input.title }) }));
            }
            await this.refresh(input.reviewId);
            return input.reviewId;
        }

        let repoRoot;
        try {
            repoRoot = await this.git.resolveRepoRoot(input.repoPath || cwd);
        } catch (err) {
            throw invalid(`Not a git repository: ${input.repoPath || cwd} (${err.message})`);
        }
        const base = input.base || (await this.git.defaultBase(repoRoot));
        const branch = (await this.git.runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
        const paths = input.paths ?? [];
        const exclude = input.exclude ?? [];
        const reviewId = computeReviewId({ repoRoot, branch, base, paths, exclude });

        await this.store.updateReview(reviewId, (existing) => {
            if (existing) {
                if (input.title && existing.title !== input.title) return { review: Object.assign(existing, { title: input.title }) };
                return { write: false };
            }
            return {
                review: {
                    schema: 1,
                    reviewId,
                    title: input.title || `${branch} vs ${base}`,
                    repoRoot,
                    base,
                    paths,
                    exclude,
                    includeUntracked: input.includeUntracked ?? true,
                    contextLines: input.context ?? 5,
                    branch,
                    git: null,
                    currentRevisionId: null,
                    revisions: [],
                    threads: [],
                    lessons: [],
                    createdAt: nowIso(),
                },
            };
        });
        await this.refresh(reviewId);
        return reviewId;
    }

    // Coalesces overlapping refreshes; a refresh requested mid-capture triggers one more pass.
    refresh(reviewId) {
        const running = this.refreshes.get(reviewId);
        if (running) {
            running.again = true;
            return running.promise;
        }
        const entry = { again: false };
        entry.promise = (async () => {
            try {
                let result;
                do {
                    entry.again = false;
                    result = await this.refreshOnce(reviewId);
                } while (entry.again);
                return result;
            } finally {
                this.refreshes.delete(reviewId);
            }
        })();
        this.refreshes.set(reviewId, entry);
        return entry.promise;
    }

    async refreshOnce(reviewId) {
        const before = await this.getReview(reviewId);
        let snapshot;
        try {
            snapshot = await this.git.captureSnapshot({
                repoRoot: before.repoRoot,
                base: before.base,
                paths: before.paths,
                exclude: before.exclude,
                includeUntracked: before.includeUntracked,
                contextLines: before.contextLines,
            });
        } catch (err) {
            throw new ReviewError("git_error", err.message);
        }

        const result = await this.store.updateReview(reviewId, async (review) => {
            const git = {
                branch: snapshot.branch,
                headCommit: snapshot.headCommit,
                baseCommit: snapshot.baseCommit,
                upstream: snapshot.upstream,
                uncommittedFiles: snapshot.uncommittedFiles.length,
                capturedAt: nowIso(),
            };
            const latest = review.revisions[review.revisions.length - 1];
            let created = false;
            let revisionId = latest?.revisionId;
            if (!latest || latest.fingerprint !== snapshot.fingerprint) {
                revisionId = `r${review.revisions.length + 1}`;
                const stats = snapshot.files.reduce((a, f) => ({ additions: a.additions + f.additions, deletions: a.deletions + f.deletions }), { additions: 0, deletions: 0 });
                await this.store.writeSnapshot(reviewId, revisionId, { revisionId, ...snapshot });
                review.revisions.push({
                    revisionId,
                    fingerprint: snapshot.fingerprint,
                    createdAt: nowIso(),
                    headCommit: snapshot.headCommit,
                    baseCommit: snapshot.baseCommit,
                    files: snapshot.files.length,
                    ...stats,
                });
                review.currentRevisionId = revisionId;
                created = true;
            }
            review.git = git;
            review.branch = snapshot.branch;
            const moved = await this.relocateThreads(review, revisionId, snapshot.baseCommit);
            return { review, value: { revisionId, created, moved } };
        });
        if (result.created || result.moved) this.changed(reviewId, "revision");
        else this.changed(reviewId, "git");
        return result;
    }

    async relocateThreads(review, revisionId, baseCommit) {
        const cache = new Map();
        const contentFor = async (side, filePath) => {
            const key = `${side}\0${filePath}`;
            if (!cache.has(key)) {
                cache.set(key, side === "old"
                    ? await this.git.readCommitFile(review.repoRoot, baseCommit, filePath)
                    : await this.git.readWorkingFile(review.repoRoot, filePath));
            }
            return cache.get(key);
        };
        let moved = 0;
        for (const thread of review.threads) {
            if (!thread.location || thread.location.revisionId === revisionId) continue;
            if (thread.kind === "line" || thread.kind === "change") {
                const side = thread.location.side;
                const lines = await contentFor(side, side === "old" ? (thread.anchor.oldPath ?? thread.anchor.path) : thread.location.path);
                const next = relocate(thread.anchor, thread.location.startLine, lines);
                if (next.startLine !== thread.location.startLine || next.state !== thread.location.state) moved++;
                thread.location = { ...thread.location, ...next, revisionId };
            } else {
                thread.location = { ...thread.location, revisionId };
            }
        }
        return moved;
    }

    async getSnapshot(reviewId, revisionId) {
        const review = await this.getReview(reviewId);
        const rev = revisionId ?? review.currentRevisionId;
        const snapshot = await this.store.readSnapshot(reviewId, rev);
        if (!snapshot) throw notFound(`Revision ${rev} not found for review ${reviewId}.`);
        return snapshot;
    }

    // Validate gaps against the saved base as well as hunks so newer edits cannot leak into an older revision.
    async getFileContent(reviewId, revisionId, filePath) {
        const review = await this.getReview(reviewId);
        if (typeof filePath !== "string" || !filePath) throw invalid("path is required.");
        this.git.safeJoin(review.repoRoot, filePath);
        const rev = revisionId ?? review.currentRevisionId;
        const snapshot = await this.store.readSnapshot(reviewId, rev);
        if (!snapshot) throw notFound(`Revision ${rev} not found for review ${reviewId}.`);
        const file = snapshot.files.find((f) => f.path === filePath);
        if (!file) throw notFound(`${filePath} is not part of revision ${rev}.`);
        const base = { revisionId: rev, path: filePath };
        if (file.binary) return { ...base, available: false, reason: "binary" };
        if (file.status === "deleted") return { ...base, available: false, reason: "deleted" };

        const lines = await this.git.readWorkingFile(review.repoRoot, filePath);
        if (!lines) return { ...base, available: false, reason: "missing", stale: true };
        if (lines[lines.length - 1] === "") lines.pop();
        if (lines.length > MAX_FULL_FILE_LINES) return { ...base, available: false, reason: "too-large" };
        const oldLines = file.status === "added"
            ? []
            : await this.git.readCommitFile(review.repoRoot, snapshot.baseCommit, file.oldPath ?? file.path);
        if (!oldLines) return { ...base, available: false, reason: "base-unavailable" };
        if (oldLines[oldLines.length - 1] === "") oldLines.pop();
        if (oldLines.length > MAX_FULL_FILE_LINES) return { ...base, available: false, reason: "too-large" };
        if (!matchesRevision(file, oldLines, lines)) return { ...base, available: false, reason: "stale", stale: true };
        return { ...base, available: true, lines };
    }

    async buildAnchor(review, { kind, path: filePath, side, startLine, endLine, revisionId }) {
        if (kind === "overview") return { anchor: null, location: null };
        if (typeof filePath !== "string" || !filePath) throw invalid("path is required for file, change, and line threads.");
        this.git.safeJoin(review.repoRoot, filePath);
        const rev = revisionId ?? review.currentRevisionId;
        const snapshot = await this.store.readSnapshot(review.reviewId, rev);
        const file = snapshot?.files.find((f) => f.path === filePath) ?? null;

        if (kind === "file") {
            const base = { revisionId: rev, path: filePath, oldPath: file?.oldPath ?? null };
            return { anchor: base, location: { revisionId: rev, path: filePath, state: "current" } };
        }

        const s = side === "old" ? "old" : "new";
        checkLine(startLine, "startLine");
        checkLine(endLine ?? startLine, "endLine");
        const end = endLine ?? startLine;
        if (end < startLine) throw invalid("endLine must be >= startLine.");
        if (end - startLine + 1 > MAX_RANGE) throw invalid(`Range exceeds ${MAX_RANGE} lines.`);

        let selected = file ? selectedLines(file, s, startLine, end) : [];
        if (selected.length !== end - startLine + 1) {
            const content = s === "old"
                ? await this.git.readCommitFile(review.repoRoot, snapshot?.baseCommit ?? review.git?.baseCommit, file?.oldPath ?? filePath)
                : await this.git.readWorkingFile(review.repoRoot, filePath);
            if (!content || end > content.length) throw invalid(`Lines ${startLine}-${end} are outside ${filePath} (${s} side).`);
            selected = content.slice(startLine - 1, end);
        }
        const excerpt = file ? hunkExcerpt(file, s, startLine, end) : null;
        const anchor = {
            revisionId: rev,
            path: filePath,
            oldPath: file?.oldPath ?? null,
            side: s,
            startLine,
            endLine: end,
            selectedLines: selected.slice(0, MAX_ANCHOR_LINES),
            hunkHeader: excerpt?.header ?? null,
            hunkText: excerpt?.text ?? null,
        };
        return { anchor, location: { revisionId: rev, path: filePath, side: s, startLine, endLine: end, state: "current" } };
    }

    async createThread(reviewId, input) {
        const kind = input.kind ?? "line";
        if (!THREAD_KINDS.includes(kind)) throw invalid(`kind must be one of ${THREAD_KINDS.join(", ")}.`);
        const author = input.author === "agent" ? "agent" : "user";
        const body = checkBody(input.body);

        const result = await this.store.updateReview(reviewId, async (review) => {
            if (!review) throw notFound(`Review ${reviewId} not found.`);
            const dup = findDuplicate(review, input.clientRequestId);
            if (dup) return { write: false, value: { thread: dup.thread, message: dup.message, duplicate: true } };

            const { anchor, location } = await this.buildAnchor(review, { ...input, kind });
            const message = {
                messageId: `m-${randomUUID()}`,
                author,
                body,
                createdAt: nowIso(),
                clientRequestId: input.clientRequestId ?? null,
                ...(author === "user" ? { delivery: { state: "saving", attempts: 0 } } : { outcome: input.outcome ?? null }),
                ...(kind === "overview" ? { descriptionContext: this.descriptionContext(review, input) } : {}),
            };
            const thread = {
                threadId: `t-${randomUUID().slice(0, 8)}`,
                kind,
                status: "active",
                author,
                createdAt: nowIso(),
                anchor,
                location,
                messages: [message],
            };
            review.threads.push(thread);
            if (location && location.revisionId !== review.currentRevisionId) {
                await this.relocateThreads(review, review.currentRevisionId, review.git?.baseCommit);
            }
            return { review, value: { thread, message, duplicate: false } };
        });
        this.changed(reviewId, "thread");
        return result;
    }

    async addMessage(reviewId, threadId, input) {
        const author = input.author === "agent" ? "agent" : "user";
        const body = checkBody(input.body);
        if (author === "agent" && input.outcome && !OUTCOMES.includes(input.outcome)) {
            throw invalid(`outcome must be one of ${OUTCOMES.join(", ")}.`);
        }
        const lessonsInput = Array.isArray(input.lessons) ? input.lessons : [];
        for (const l of lessonsInput) {
            if (!l || typeof l.rule !== "string" || !l.rule.trim()) throw invalid("Each lesson needs a non-empty rule.");
            if (l.scope && !["repo", "personal"].includes(l.scope)) throw invalid("lesson.scope must be repo or personal.");
        }

        const newLessons = [];
        const result = await this.store.updateReview(reviewId, async (review) => {
            if (!review) throw notFound(`Review ${reviewId} not found.`);
            const dup = findDuplicate(review, input.clientRequestId);
            if (dup) return { write: false, value: { thread: dup.thread, message: dup.message, duplicate: true } };
            const thread = findThread(review, threadId);

            const message = {
                messageId: `m-${randomUUID()}`,
                author,
                body,
                createdAt: nowIso(),
                clientRequestId: input.clientRequestId ?? null,
                ...(thread.kind === "overview" && author === "user" ? { descriptionContext: this.descriptionContext(review, input) } : {}),
            };
            if (author === "user") {
                message.delivery = { state: "saving", attempts: 0 };
                if (thread.status !== "active") thread.status = "active";
            } else {
                message.outcome = input.outcome ?? null;
                message.verification = input.verification ?? null;
                message.inReplyTo = input.inReplyTo ?? null;
                const target = input.inReplyTo
                    ? thread.messages.find((m) => m.messageId === input.inReplyTo)
                    : [...thread.messages].reverse().find((m) => m.author === "user" && m.delivery && m.delivery.state !== "replied");
                if (input.inReplyTo && !target) throw notFound(`Message ${input.inReplyTo} not found in thread ${threadId}.`);
                if (target?.delivery) target.delivery = { ...target.delivery, state: "replied", repliedAt: nowIso() };
                message.lessonIds = [];
                for (const l of lessonsInput) {
                    const lesson = {
                        lessonId: `l-${randomUUID().slice(0, 8)}`,
                        reviewId,
                        threadId,
                        messageId: message.messageId,
                        scope: l.scope ?? "repo",
                        rule: l.rule.trim(),
                        savedTo: l.savedTo ?? null,
                        createdAt: nowIso(),
                    };
                    review.lessons.push(lesson);
                    message.lessonIds.push(lesson.lessonId);
                    newLessons.push(lesson);
                }
            }
            thread.messages.push(message);
            return { review, value: { thread, message, duplicate: false } };
        });
        for (const lesson of newLessons) await this.store.appendLesson(lesson);
        this.changed(reviewId, "message");
        return result;
    }

    async setThreadStatus(reviewId, threadId, status) {
        if (!THREAD_STATUSES.includes(status)) throw invalid(`status must be one of ${THREAD_STATUSES.join(", ")}.`);
        const thread = await this.store.updateReview(reviewId, (review) => {
            if (!review) throw notFound(`Review ${reviewId} not found.`);
            const t = findThread(review, threadId);
            t.status = status;
            return { review, value: t };
        });
        this.changed(reviewId, "status");
        return thread;
    }

    // Applies a delivery transition; later states win unless `force` (used by retry).
    // Non-state fields (e.g. sessionMessageId) are merged even when the state change is ignored.
    async setDelivery(reviewId, messageId, patch, { force = false } = {}) {
        const applied = await this.store.updateReview(reviewId, (review) => {
            if (!review) return { write: false, value: false };
            const entry = allMessages(review).find((e) => e.message.messageId === messageId);
            if (!entry || !entry.message.delivery) return { write: false, value: false };
            const current = entry.message.delivery;
            const { state, ...rest } = patch;
            const allowState = Boolean(state) && (force || (current.state !== "replied"
                && (state === "failed" || DELIVERY_RANK[state] >= DELIVERY_RANK[current.state])));
            if (!allowState && Object.keys(rest).length === 0) return { write: false, value: false };
            entry.message.delivery = { ...current, ...rest, ...(allowState ? { state } : {}), updatedAt: nowIso() };
            return { review, value: true };
        });
        if (applied) this.changed(reviewId, "delivery");
        return applied;
    }

    // Marks every user message still "processing" as unanswered (called when the agent goes idle).
    async settleProcessing(reviewId) {
        const ids = await this.store.updateReview(reviewId, (review) => {
            if (!review) return { write: false, value: [] };
            const hits = allMessages(review).filter((e) => e.message.delivery?.state === "processing");
            for (const { message } of hits) message.delivery = { ...message.delivery, state: "no-reply", updatedAt: nowIso() };
            return hits.length ? { review, value: hits.map((h) => h.message.messageId) } : { write: false, value: [] };
        });
        if (ids.length) this.changed(reviewId, "delivery");
        return ids;
    }

    async findMessage(reviewId, messageId) {
        const review = await this.getReview(reviewId);
        const entry = allMessages(review).find((e) => e.message.messageId === messageId);
        if (!entry) throw notFound(`Message ${messageId} not found.`);
        return { review, thread: entry.thread, message: entry.message };
    }

    // Everything the agent prompt needs for one message, resolved against the current revision.
    async promptContext(reviewId, threadId) {
        const review = await this.getReview(reviewId);
        const thread = findThread(review, threadId);
        let excerpt = null;
        let selected = null;
        const loc = thread.location;
        if (loc && (thread.kind === "line" || thread.kind === "change") && loc.state !== "outdated") {
            const snapshot = await this.store.readSnapshot(reviewId, review.currentRevisionId);
            const file = snapshot?.files.find((f) => f.path === loc.path);
            if (file) {
                excerpt = hunkExcerpt(file, loc.side, loc.startLine, loc.endLine);
                selected = selectedLines(file, loc.side, loc.startLine, loc.endLine);
            }
            if (!selected || selected.length !== loc.endLine - loc.startLine + 1) {
                const content = loc.side === "old"
                    ? await this.git.readCommitFile(review.repoRoot, review.git?.baseCommit, thread.anchor.oldPath ?? loc.path)
                    : await this.git.readWorkingFile(review.repoRoot, loc.path);
                selected = content ? content.slice(loc.startLine - 1, loc.endLine) : selected;
            }
        }
        return {
            review: {
                ...review,
                headCommit: review.git?.headCommit,
                baseCommit: review.git?.baseCommit,
            },
            thread,
            excerpt,
            selected,
        };
    }

    summarize(review, { threadId, includeResolved = false, maxBody = 2000 } = {}) {
        const threads = review.threads.filter((t) => (threadId ? t.threadId === threadId : includeResolved || t.status === "active"));
        return {
            reviewId: review.reviewId,
            title: review.title,
            description: review.description ?? null,
            repoRoot: review.repoRoot,
            branch: review.branch,
            base: review.base,
            currentRevisionId: review.currentRevisionId,
            git: review.git,
            counts: {
                total: review.threads.length,
                active: review.threads.filter((t) => t.status === "active").length,
                awaitingAgent: allMessages(review).filter((e) => ["queued", "processing", "failed", "no-reply"].includes(e.message.delivery?.state)).length,
            },
            threads: threads.map((t) => ({
                threadId: t.threadId,
                kind: t.kind,
                status: t.status,
                location: t.location,
                originalLocation: t.anchor ? { revisionId: t.anchor.revisionId, path: t.anchor.path, side: t.anchor.side, startLine: t.anchor.startLine, endLine: t.anchor.endLine } : null,
                messages: t.messages.map((m) => ({
                    messageId: m.messageId,
                    author: m.author,
                    createdAt: m.createdAt,
                    body: m.body.length > maxBody ? `${m.body.slice(0, maxBody)}...` : m.body,
                    delivery: m.delivery?.state,
                    outcome: m.outcome,
                })),
            })),
            lessons: review.lessons,
        };
    }
}
