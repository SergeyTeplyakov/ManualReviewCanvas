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
export const LESSON_STATUSES = ["proposed", "saved", "declined"];
export const SCOPES = ["all", "pending"];
const PENDING_SUFFIX = " (pending changes)";
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

// "all" reviews the whole branch or PR (working tree vs merge-base); "pending" reviews only uncommitted work (working tree vs HEAD).
export function checkScope(value) {
    if (value == null) return "all";
    if (!SCOPES.includes(value)) throw invalid(`scope must be one of ${SCOPES.join(", ")}.`);
    return value;
}

// Reviews saved before scopes existed have no scope field and are "all" reviews.
export function scopeOf(review) {
    return review?.scope === "pending" ? "pending" : "all";
}

// The "all" id must stay identical to the pre-scope computation so existing reviews keep their threads.
export function computeReviewId({ repoRoot, branch, base, paths = [], exclude = [], scope = "all" }) {
    const parts = [path.resolve(repoRoot).toLowerCase(), branch, base, [...paths].sort().join(","), [...exclude].sort().join(",")];
    if (scope === "pending") parts.push("pending");
    const hash = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 8);
    const label = scope === "pending" ? `${path.basename(repoRoot)}-${branch}-pending` : `${path.basename(repoRoot)}-${branch}-vs-${base}`;
    const readable = slug(label).slice(0, 80) || "review";
    return `${readable}-${hash}`;
}

function defaultTitle({ branch, base, scope }) {
    return scope === "pending" ? `${branch}${PENDING_SUFFIX}` : `${branch} vs ${base}`;
}

function applyOpenOptions(review, input) {
    if (input.title) review.title = input.title;
    if (input.includeUntracked !== undefined) review.includeUntracked = input.includeUntracked;
    if (input.context !== undefined) review.contextLines = input.context;
    return review;
}

// A default title is regenerated for the target scope; a custom title is carried over with the pending suffix toggled.
function siblingTitle(source, targetScope) {
    const origin = source.originBranch ?? source.branch;
    if (source.title === defaultTitle({ branch: origin, base: source.base, scope: scopeOf(source) })) {
        return defaultTitle({ branch: source.branch, base: source.base, scope: targetScope });
    }
    const hasSuffix = source.title.endsWith(PENDING_SUFFIX);
    if (targetScope === "pending") return hasSuffix ? source.title : `${source.title}${PENDING_SUFFIX}`;
    return hasSuffix ? source.title.slice(0, -PENDING_SUFFIX.length) : source.title;
}

// originBranch is the branch the id was computed from; branch is the live label refreshed on every capture.
function newReviewRecord({ reviewId, title, repoRoot, base, paths, exclude, includeUntracked, contextLines, branch, originBranch = branch, scope }) {
    return {
        schema: 1,
        reviewId,
        title,
        repoRoot,
        base,
        paths,
        exclude,
        includeUntracked,
        contextLines,
        branch,
        originBranch,
        scope,
        git: null,
        currentRevisionId: null,
        revisions: [],
        threads: [],
        lessons: [],
        createdAt: nowIso(),
    };
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

const normalizeRule = (rule) => rule.toLowerCase().replace(/\s+/g, " ").replace(/[\s.;:!,]+$/, "").trim();

// Records a guideline the agent reported. A decision on a guideline proposed earlier in the thread (by lessonId,
// or by the same rule text) updates that lesson in place instead of adding a duplicate. Lessons without a
// status are legacy records and count as saved.
function applyLesson(review, { reviewId, threadId, messageId }, input) {
    const status = input.status ?? "saved";
    const rule = typeof input.rule === "string" ? input.rule.trim() : "";
    let lesson;
    if (input.lessonId) {
        lesson = review.lessons.find((l) => l.lessonId === input.lessonId && l.threadId === threadId);
        if (!lesson) throw notFound(`Lesson ${input.lessonId} not found in thread ${threadId}.`);
    } else {
        lesson = review.lessons.find((l) => l.threadId === threadId && (l.status ?? "saved") === "proposed" && normalizeRule(l.rule) === normalizeRule(rule));
    }
    if (!lesson) {
        lesson = {
            lessonId: `l-${randomUUID().slice(0, 8)}`,
            reviewId,
            threadId,
            messageId,
            scope: input.scope ?? "repo",
            rule,
            status,
            savedTo: status === "saved" ? input.savedTo ?? null : null,
            createdAt: nowIso(),
        };
        review.lessons.push(lesson);
        return lesson;
    }
    if (rule) lesson.rule = rule;
    if (input.scope) lesson.scope = input.scope;
    lesson.status = status;
    lesson.savedTo = status === "saved" ? input.savedTo ?? lesson.savedTo ?? null : null;
    lesson.updatedAt = nowIso();
    return lesson;
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

// A draft is held by the reviewer and has not been offered to the agent yet.
const DELIVERY_RANK = { draft: -1, saving: 0, failed: 1, queued: 2, processing: 3, "no-reply": 4, replied: 5 };
const REVIEW_DELIVERY_CHOICES = ["immediate", "batch"];

// Signal 0 only probes the process; EPERM means it exists but belongs to another user.
function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err?.code === "EPERM";
    }
}

export class ReviewService extends EventEmitter {
    /**
     * @param {object} p
     * @param {number} [p.pid] process recorded on delivery claims
     * @param {(pid: number) => boolean} [p.isProcessAlive] whether a claiming process is still running
     */
    constructor({ store, git = gitDefault, log = () => {}, pid = process.pid, isProcessAlive = processAlive }) {
        super();
        this.store = store;
        this.git = git;
        this.log = log;
        this.pid = pid;
        this.isProcessAlive = isProcessAlive;
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
    // An explicit scope that differs from an existing review's scope opens its sibling review instead.
    async ensureReview(input = {}, { cwd = process.cwd() } = {}) {
        const requestedScope = input.scope == null ? null : checkScope(input.scope);
        if (input.reviewId) {
            const existing = await this.getReview(input.reviewId);
            const switching = requestedScope !== null && requestedScope !== scopeOf(existing);
            const reviewId = switching ? await this.openSibling(input.reviewId, requestedScope, { base: input.base }) : input.reviewId;
            const hasOptions = input.title || input.includeUntracked !== undefined || input.context !== undefined;
            if (hasOptions) {
                await this.store.updateReview(reviewId, (r) => ({ review: applyOpenOptions(r, input) }));
            }
            if (!switching || hasOptions) await this.refresh(reviewId);
            return reviewId;
        }

        let repoRoot;
        try {
            repoRoot = await this.git.resolveRepoRoot(input.repoPath || cwd);
        } catch (err) {
            throw invalid(`Not a git repository: ${input.repoPath || cwd} (${err.message})`);
        }
        const scope = requestedScope ?? "all";
        const base = input.base || (scope === "pending" ? null : await this.git.defaultBase(repoRoot));
        const branch = (await this.git.runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
        const paths = input.paths ?? [];
        const exclude = input.exclude ?? [];
        const reviewId = computeReviewId({ repoRoot, branch, base, paths, exclude, scope });

        await this.store.updateReview(reviewId, (existing) => {
            if (existing) {
                return { review: applyOpenOptions(existing, input) };
            }
            return {
                review: newReviewRecord({
                    reviewId,
                    title: input.title || defaultTitle({ branch, base, scope }),
                    repoRoot,
                    base,
                    paths,
                    exclude,
                    includeUntracked: input.includeUntracked ?? true,
                    contextLines: input.context ?? 5,
                    branch,
                    scope,
                }),
            };
        });
        await this.refresh(reviewId);
        return reviewId;
    }

    // Opens the other-scope review of the same repository, branch, base, and pathspecs, creating it on first use.
    async openSibling(reviewId, scope, { base: requestedBase } = {}) {
        const target = checkScope(scope);
        const source = await this.getReview(reviewId);
        if (target === scopeOf(source)) return reviewId;
        if (source.siblingReviewId && !requestedBase) {
            await this.refresh(source.siblingReviewId);
            return source.siblingReviewId;
        }
        const base = requestedBase || source.base || (target === "all" ? await this.git.defaultBase(source.repoRoot) : null);
        const originBranch = source.originBranch ?? source.branch;
        const siblingId = computeReviewId({
            repoRoot: source.repoRoot,
            branch: originBranch,
            base,
            paths: source.paths,
            exclude: source.exclude,
            scope: target,
        });
        await this.store.updateReview(siblingId, (existing) => {
            if (existing) return { review: Object.assign(existing, { siblingReviewId: reviewId }) };
            return {
                review: { ...newReviewRecord({
                    reviewId: siblingId,
                    title: siblingTitle({ ...source, base }, target),
                    repoRoot: source.repoRoot,
                    base,
                    paths: source.paths,
                    exclude: source.exclude,
                    includeUntracked: source.includeUntracked,
                    contextLines: source.contextLines,
                    branch: source.branch,
                    originBranch,
                    scope: target,
                }), siblingReviewId: reviewId },
            };
        });
        await this.refresh(siblingId);
        await this.store.updateReview(reviewId, (review) => ({ review: Object.assign(review, { siblingReviewId: siblingId }) }));
        return siblingId;
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
                scope: scopeOf(before),
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
        const endsWithNewline = lines[lines.length - 1] === "";
        if (lines[lines.length - 1] === "") lines.pop();
        const finalRow = file.hunks.flatMap((h) => h.rows).find((r) => r.n === lines.length);
        if (finalRow && Boolean(finalRow.noNewlineAtEnd) === endsWithNewline) {
            return { ...base, available: false, reason: "stale", stale: true };
        }
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
        if (!snapshot) throw notFound(`Revision ${rev} not found for review ${review.reviewId}.`);

        if (kind === "file") {
            const base = { revisionId: rev, path: filePath, oldPath: file?.oldPath ?? null };
            return { anchor: base, location: { revisionId: rev, path: filePath, state: "current" } };
        }
        if (!file) throw notFound(`${filePath} is not part of revision ${rev}.`);

        const s = side === "old" ? "old" : "new";
        checkLine(startLine, "startLine");
        checkLine(endLine ?? startLine, "endLine");
        const end = endLine ?? startLine;
        if (end < startLine) throw invalid("endLine must be >= startLine.");
        if (end - startLine + 1 > MAX_RANGE) throw invalid(`Range exceeds ${MAX_RANGE} lines.`);

        let selected = file ? selectedLines(file, s, startLine, end) : [];
        if (selected.length !== end - startLine + 1) {
            const content = s === "old"
                ? await this.git.readCommitFile(review.repoRoot, snapshot.baseCommit, file.oldPath ?? filePath)
                : await this.revisionLines(review.reviewId, rev, filePath);
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

    async buildThread(review, input) {
        const kind = input.kind ?? "line";
        if (!THREAD_KINDS.includes(kind)) throw invalid(`kind must be one of ${THREAD_KINDS.join(", ")}.`);
        const author = input.author === "agent" ? "agent" : "user";
        const body = checkBody(input.body);
        const { anchor, location } = await this.buildAnchor(review, { ...input, kind });
        const message = {
            messageId: `m-${randomUUID()}`,
            author,
            body,
            createdAt: nowIso(),
            clientRequestId: input.clientRequestId ?? null,
            ...(author === "user" ? { delivery: input.hold ? { state: "draft", attempts: 0 } : { state: "saving", attempts: 0, claimPid: this.pid } } : { outcome: input.outcome ?? null }),
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
        return { thread, message };
    }

    async createThread(reviewId, input) {
        const result = await this.store.updateReview(reviewId, async (review) => {
            if (!review) throw notFound(`Review ${reviewId} not found.`);
            const dup = findDuplicate(review, input.clientRequestId);
            if (dup) return { write: false, value: { thread: dup.thread, message: dup.message, duplicate: true } };
            const { thread, message } = await this.buildThread(review, input);
            review.threads.push(thread);
            if (thread.location && thread.location.revisionId !== review.currentRevisionId) {
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
            const hasRule = typeof l?.rule === "string" && l.rule.trim();
            if (!l || (!hasRule && !l.lessonId)) throw invalid("Each lesson needs a non-empty rule or the lessonId of an existing guideline.");
            if (l.scope && !["repo", "personal"].includes(l.scope)) throw invalid("lesson.scope must be repo or personal.");
            if (l.status != null && !LESSON_STATUSES.includes(l.status)) throw invalid(`lesson.status must be one of ${LESSON_STATUSES.join(", ")}.`);
        }

        const touchedLessons = new Map();
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
                message.delivery = input.hold ? { state: "draft", attempts: 0 } : { state: "saving", attempts: 0, claimPid: this.pid };
                if (thread.status !== "active") thread.status = "active";
            } else {
                message.outcome = input.outcome ?? null;
                message.verification = input.verification ?? null;
                message.inReplyTo = input.inReplyTo ?? null;
                const target = input.inReplyTo
                    ? thread.messages.find((m) => m.messageId === input.inReplyTo)
                    : [...thread.messages].reverse().find((m) => m.author === "user" && m.delivery && !["replied", "draft"].includes(m.delivery.state));
                if (input.inReplyTo && !target) throw notFound(`Message ${input.inReplyTo} not found in thread ${threadId}.`);
                if (target?.delivery?.state === "draft") {
                    throw new ReviewError("conflict", `Message ${input.inReplyTo} is a draft the reviewer has not sent yet; reply after it is delivered.`);
                }
                if (target?.delivery) {
                    const repliedAt = nowIso();
                    target.delivery = { ...target.delivery, state: "replied", repliedAt };
                    // One reply answers every comment the same submitted review added to this thread.
                    const batchId = target.delivery.batchId;
                    for (const m of batchId ? thread.messages : []) {
                        if (m !== target && m.author === "user" && m.delivery?.batchId === batchId && m.delivery.state !== "replied") {
                            m.delivery = { ...m.delivery, state: "replied", repliedAt };
                        }
                    }
                }
                message.lessonIds = [];
                for (const l of lessonsInput) {
                    const lesson = applyLesson(review, { reviewId, threadId, messageId: message.messageId }, l);
                    if (!message.lessonIds.includes(lesson.lessonId)) message.lessonIds.push(lesson.lessonId);
                    touchedLessons.set(lesson.lessonId, { ...lesson });
                }
            }
            thread.messages.push(message);
            return { review, value: { thread, message, duplicate: false } };
        });
        for (const lesson of touchedLessons.values()) await this.store.appendLesson(lesson);
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

    // Claim before doing any async prompt work or sending; only one provider may send an attempt.
    async claimDelivery(reviewId, threadId, messageId, { retry = false, senderSessionId } = {}) {
        const claim = await this.store.updateReview(reviewId, (review) => {
            if (!review) throw notFound(`Review ${reviewId} not found.`);
            const message = findThread(review, threadId).messages.find((m) => m.messageId === messageId);
            if (!message || message.author !== "user") throw invalid(`Message ${messageId} is not a user message in ${threadId}.`);
            const current = message.delivery;
            const initial = current?.state === "draft" || (current?.state === "saving" && !current.attempts);
            if (!initial && !(retry && ["failed", "no-reply"].includes(current?.state))) return { write: false, value: null };
            const attempt = { attemptId: randomUUID(), attempts: (current.attempts ?? 0) + 1 };
            message.delivery = { state: "saving", ...attempt, senderSessionId, claimPid: this.pid, error: null, updatedAt: nowIso() };
            return { review, value: attempt };
        });
        if (claim) this.changed(reviewId, "delivery");
        return claim;
    }

    // Claims every draft in one atomic update so a submitted review is sent once, as one batch.
    async claimDrafts(reviewId, { senderSessionId } = {}) {
        const claims = await this.store.updateReview(reviewId, (review) => {
            if (!review) throw notFound(`Review ${reviewId} not found.`);
            const drafts = allMessages(review).filter((e) => e.message.author === "user" && e.message.delivery?.state === "draft");
            if (!drafts.length) return { write: false, value: [] };
            const batchId = randomUUID();
            const value = drafts.map(({ thread, message }) => {
                const attempt = { attemptId: randomUUID(), attempts: (message.delivery.attempts ?? 0) + 1 };
                message.delivery = { state: "saving", ...attempt, batchId, senderSessionId, claimPid: this.pid, error: null, updatedAt: nowIso() };
                return { threadId: thread.threadId, messageId: message.messageId, ...attempt };
            });
            return { review, value };
        });
        if (claims.length) this.changed(reviewId, "delivery");
        return claims;
    }

    // Records how an ask-mode review delivers comments; null asks the reviewer again.
    async setDeliveryChoice(reviewId, mode) {
        if (mode !== null && !REVIEW_DELIVERY_CHOICES.includes(mode)) {
            throw invalid(`mode must be one of ${REVIEW_DELIVERY_CHOICES.join(", ")}, or null.`);
        }
        const changed = await this.store.updateReview(reviewId, (review) => {
            if (!review) throw notFound(`Review ${reviewId} not found.`);
            if ((review.deliveryMode ?? null) === mode) return { write: false, value: false };
            if (mode) review.deliveryMode = mode;
            else delete review.deliveryMode;
            return { review, value: true };
        });
        if (changed) this.changed(reviewId, "delivery-mode");
        return mode;
    }

    // Removes a draft the agent has never seen; a thread left without messages goes with it.
    async discardDraft(reviewId, messageId) {
        const result = await this.store.updateReview(reviewId, (review) => {
            if (!review) throw notFound(`Review ${reviewId} not found.`);
            const entry = allMessages(review).find((e) => e.message.messageId === messageId);
            if (!entry) throw notFound(`Message ${messageId} not found.`);
            if (entry.message.author !== "user" || entry.message.delivery?.state !== "draft") {
                throw new ReviewError("conflict", `Message ${messageId} is not a draft; only drafts can be discarded.`);
            }
            const { thread } = entry;
            thread.messages = thread.messages.filter((m) => m !== entry.message);
            const threadRemoved = thread.messages.length === 0;
            if (threadRemoved) review.threads = review.threads.filter((t) => t !== thread);
            return { review, value: { threadId: thread.threadId, threadRemoved } };
        });
        this.changed(reviewId, "message");
        return result;
    }

    // A marker is only a lookup hint, never permission to release a draft or transfer processing ownership.
    async processDelivery(reviewId, messageId, { attemptId, sessionMessageId, sessionId, finished = false }) {
        const applied = await this.store.updateReview(reviewId, (review) => {
            const current = review && allMessages(review).find((e) => e.message.messageId === messageId)?.message.delivery;
            // Older queued attempts have no sender field. Only their exact persisted transport event
            // may establish one; a marker by itself (including while saving) cannot do so.
            const legacyQueued = !current?.senderSessionId && current?.state === "queued"
                && sessionMessageId && current.sessionMessageId === sessionMessageId;
            if (!current?.attemptId || !sessionId || (!legacyQueued && current.senderSessionId !== sessionId)
                || !["saving", "queued", "processing"].includes(current.state)
                || (current.processedBy && current.processedBy !== sessionId)
                || (attemptId ? current.attemptId !== attemptId : !sessionMessageId || current.sessionMessageId !== sessionMessageId)
                || (current.sessionMessageId && current.sessionMessageId !== sessionMessageId)) {
                return { write: false, value: false };
            }
            Object.assign(current, { state: finished ? "no-reply" : "processing", senderSessionId: sessionId, processedBy: sessionId, processingAt: nowIso(), updatedAt: nowIso() });
            return { review, value: true };
        });
        if (applied) this.changed(reviewId, "delivery");
        return applied;
    }

    // Applies a delivery transition; later states win within the claimed attempt.
    // Non-state fields (e.g. sessionMessageId) are merged even when the state change is ignored.
    async setDelivery(reviewId, messageId, patch, { attemptId } = {}) {
        const applied = await this.store.updateReview(reviewId, (review) => {
            if (!review) return { write: false, value: false };
            const entry = allMessages(review).find((e) => e.message.messageId === messageId);
            if (!entry || !entry.message.delivery) return { write: false, value: false };
            const current = entry.message.delivery;
            if (attemptId && current.attemptId !== attemptId) return { write: false, value: false };
            const { state, ...rest } = patch;
            if (state === "failed" && !["saving", "failed"].includes(current.state)) return { write: false, value: false };
            const allowState = Boolean(state) && current.state !== "replied"
                && (state === "failed" || DELIVERY_RANK[state] >= DELIVERY_RANK[current.state]);
            if (!allowState && Object.keys(rest).length === 0) return { write: false, value: false };
            entry.message.delivery = { ...current, ...rest, ...(allowState ? { state } : {}), updatedAt: nowIso() };
            return { review, value: true };
        });
        if (applied) this.changed(reviewId, "delivery");
        return applied;
    }

    // Marks user messages still "processing" as unanswered (called when the agent goes idle).
    // With a sessionId, only messages that session was processing are settled; another session's turn may still be running.
    async settleProcessing(reviewId, { sessionId } = {}) {
        const ids = await this.store.updateReview(reviewId, (review) => {
            if (!review) return { write: false, value: [] };
            const hits = allMessages(review).filter(({ message }) => message.delivery?.state === "processing"
                && (!sessionId || !message.delivery.processedBy || message.delivery.processedBy === sessionId));
            for (const { message } of hits) message.delivery = { ...message.delivery, state: "no-reply", updatedAt: nowIso() };
            return hits.length ? { review, value: hits.map((h) => h.message.messageId) } : { write: false, value: [] };
        });
        if (ids.length) this.changed(reviewId, "delivery");
        return ids;
    }

    // A comment claimed by a provider process that has since stopped can never be sent, so it is failed
    // and the reviewer can resend it. Claims held by running providers, including other sessions', are left alone.
    async recoverAbandonedClaims(reviewId) {
        const ids = await this.store.updateReview(reviewId, (review) => {
            if (!review) return { write: false, value: [] };
            const hits = allMessages(review).filter(({ message }) => {
                const d = message.delivery;
                return d?.state === "saving" && Number.isInteger(d.claimPid) && d.claimPid !== this.pid && !this.isProcessAlive(d.claimPid);
            });
            for (const { message } of hits) {
                message.delivery = { ...message.delivery, state: "failed", error: "The extension stopped before this comment was sent. Resend it.", updatedAt: nowIso() };
            }
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

    async revisionLines(reviewId, revisionId, filePath) {
        const content = await this.getFileContent(reviewId, revisionId, filePath);
        if (!content.available) {
            throw new ReviewError("conflict", `Cannot use ${filePath} from revision ${revisionId}: ${content.reason}. Refresh the review and check the selection before retrying.`);
        }
        return content.lines;
    }

    // Everything the agent prompt needs for one message, resolved against the current revision.
    async promptContext(reviewId, threadId) {
        const review = await this.getReview(reviewId);
        const thread = findThread(review, threadId);
        let excerpt = null;
        let selected = null;
        const loc = thread.location;
        if (loc && (thread.kind === "line" || thread.kind === "change") && loc.state !== "outdated") {
            const snapshot = await this.store.readSnapshot(reviewId, loc.revisionId);
            const file = snapshot?.files.find((f) => f.path === loc.path);
            if (file) {
                excerpt = hunkExcerpt(file, loc.side, loc.startLine, loc.endLine);
                selected = selectedLines(file, loc.side, loc.startLine, loc.endLine);
            }
            if (!selected || selected.length !== loc.endLine - loc.startLine + 1) {
                const content = loc.side === "old"
                    ? await this.git.readCommitFile(review.repoRoot, snapshot?.baseCommit, thread.anchor.oldPath ?? loc.path)
                    : await this.revisionLines(reviewId, loc.revisionId, loc.path);
                selected = content ? content.slice(loc.startLine - 1, loc.endLine) : selected;
            }
        }
        if (loc && thread.kind === "file") {
            const snapshot = await this.store.readSnapshot(reviewId, loc.revisionId);
            const file = snapshot?.files.find((f) => f.path === loc.path);
            if (file && file.oldMode !== file.newMode && (file.oldMode || file.newMode)) {
                excerpt = { text: `File mode: ${file.oldMode ?? "(absent)"} to ${file.newMode ?? "(absent)"}` };
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

    // The agent's view of a review. Drafts are still held by the reviewer, so only their count is shown.
    summarize(review, { threadId, includeResolved = false, maxBody = 2000 } = {}) {
        const isDraft = (m) => m.author === "user" && m.delivery?.state === "draft";
        const visible = review.threads.filter((t) => t.messages.some((m) => !isDraft(m)));
        const threads = visible.filter((t) => (threadId ? t.threadId === threadId : includeResolved || t.status === "active"));
        return {
            reviewId: review.reviewId,
            title: review.title,
            description: review.description ?? null,
            repoRoot: review.repoRoot,
            branch: review.branch,
            base: review.base,
            scope: scopeOf(review),
            currentRevisionId: review.currentRevisionId,
            git: review.git,
            counts: {
                total: visible.length,
                active: visible.filter((t) => t.status === "active").length,
                awaitingAgent: allMessages(review).filter((e) => ["queued", "processing", "failed", "no-reply"].includes(e.message.delivery?.state)).length,
                drafts: allMessages(review).filter((e) => isDraft(e.message)).length,
            },
            threads: threads.map((t) => ({
                threadId: t.threadId,
                kind: t.kind,
                agentReview: t.agentReview,
                status: t.status,
                location: t.location,
                originalLocation: t.anchor ? { revisionId: t.anchor.revisionId, path: t.anchor.path, side: t.anchor.side, startLine: t.anchor.startLine, endLine: t.anchor.endLine } : null,
                messages: t.messages.filter((m) => !isDraft(m)).map((m) => ({
                    messageId: m.messageId,
                    author: m.author,
                    createdAt: m.createdAt,
                    body: m.body.length > maxBody ? `${m.body.slice(0, maxBody)}...` : m.body,
                    delivery: m.delivery?.state,
                    outcome: m.outcome,
                })),
            })),
            lessons: review.lessons.map((l) => ({ ...l, status: l.status ?? "saved" })),
        };
    }
}
