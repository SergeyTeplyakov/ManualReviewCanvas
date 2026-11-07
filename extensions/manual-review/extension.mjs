// Extension: manual-review
// PR-style inline review of local git changes. Comments are delivered to the agent as
// conversation messages; the agent answers in-thread with the `reply` action and, depending on the
// repository's learning mode, proposes or saves guidelines drawn from the feedback.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { Store } from "./lib/store.mjs";
import { ReviewService, ReviewError, THREAD_KINDS, THREAD_STATUSES, OUTCOMES, LESSON_STATUSES, SCOPES } from "./lib/review-service.mjs";
import { SettingsService } from "./lib/settings.mjs";
import { Delivery } from "./lib/delivery.mjs";
import { AgentReview, REVIEW_FOCUSES, FINDING_ASSESSMENTS, FINDING_SEVERITIES, EVIDENCE_FIELDS } from "./lib/agent-review.mjs";
import { startReviewServer } from "./lib/server.mjs";

const CANVAS_ID = "manual-review";
const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");
const REPO_FIELDS = ["repoPath", "base", "paths", "exclude", "includeUntracked", "context"];

let session = null;
const log = (message, level = "info") => {
    try {
        const pending = session?.log(message, { level });
        pending?.catch?.(() => {});
    } catch {
        // Logging must never break a handler.
    }
};

const store = new Store();
const service = new ReviewService({ store, log });
const settings = new SettingsService({ store, log });
// instanceId -> { reviewId, server, ready }
const instances = new Map();
const openReviewIds = () => new Set([...instances.values()].map((e) => e.reviewId));
const delivery = new Delivery({
    service,
    log,
    send: (options) => session.send(options),
    reviewIds: openReviewIds,
    learning: async (repoRoot) => (await settings.get(repoRoot)).learning,
    sessionId: () => session?.sessionId,
});
const agentReview = new AgentReview({ service, send: (options) => session.send(options), sessionId: () => session?.sessionId, log });

// Comments a stopped provider claimed but never sent become failed so the reviewer can resend them.
function recoverClaims(reviewId) {
    service.recoverAbandonedClaims(reviewId).catch((err) => log(`manual-review: claim recovery failed for ${reviewId}: ${err?.message ?? err}`, "warning"));
    agentReview.recover(reviewId).catch((err) => log(`manual-review: review recovery failed for ${reviewId}: ${err?.message ?? err}`, "warning"));
}

function toCanvasError(err) {
    if (err instanceof CanvasError) return err;
    if (err instanceof ReviewError) return new CanvasError(err.code, err.message);
    return new CanvasError("internal", err?.message ?? String(err));
}

const guarded = (fn) => async (ctx) => {
    try {
        return await fn(ctx);
    } catch (err) {
        throw toCanvasError(err);
    }
};

const inputOf = (ctx) => (ctx.input && typeof ctx.input === "object" && !Array.isArray(ctx.input) ? ctx.input : {});

async function reviewIdFor(ctx, input) {
    if (input.reviewId) return input.reviewId;
    const live = instances.get(ctx.instanceId)?.reviewId;
    if (live) return live;
    const mapped = await store.getInstanceReview(ctx.instanceId);
    if (mapped) return mapped;
    throw new CanvasError("invalid_input", `No review is associated with canvas instance ${ctx.instanceId}; pass reviewId or open the canvas first.`);
}

async function ensureServer(instanceId, reviewId) {
    let entry = instances.get(instanceId);
    if (!entry) {
        entry = { reviewId, server: null, ready: null };
        instances.set(instanceId, entry);
        entry.ready = startReviewServer({
            instanceId,
            getReviewId: () => entry.reviewId,
            onReviewChange: async (nextId) => {
                entry.reviewId = nextId;
                await store.setInstanceReview(instanceId, nextId);
                recoverClaims(nextId);
            },
            service,
            delivery,
            agentReview,
            settings,
            webRoot: WEB_ROOT,
            log,
        }).then(
            (server) => {
                entry.server = server;
                return server;
            },
            (err) => {
                instances.delete(instanceId);
                throw err;
            },
        );
    }
    const switched = entry.reviewId !== reviewId;
    entry.reviewId = reviewId;
    await entry.ready;
    recoverClaims(reviewId);
    // A page that is already open keeps showing the previous review until told to reload.
    if (switched) service.changed(reviewId, "open");
    return entry;
}

async function openReview(ctx) {
    const input = inputOf(ctx);
    const cwd = ctx.session?.workingDirectory || process.cwd();
    const hasRepoFields = REPO_FIELDS.some((k) => input[k] !== undefined);
    let reviewId;
    if (input.reviewId || hasRepoFields) {
        reviewId = await service.ensureReview(input, { cwd });
    } else {
        const previous = instances.get(ctx.instanceId)?.reviewId ?? (await store.getInstanceReview(ctx.instanceId));
        if (previous) {
            try {
                reviewId = await service.ensureReview({ reviewId: previous, title: input.title, scope: input.scope }, { cwd });
            } catch (err) {
                if (err?.code !== "not_found") throw err;
            }
        }
        reviewId ??= await service.ensureReview(input, { cwd });
    }
    await store.setInstanceReview(ctx.instanceId, reviewId);
    const entry = await ensureServer(ctx.instanceId, reviewId);
    const review = await service.getReview(reviewId);
    const active = review.threads.filter((t) => t.status === "active").length;
    return {
        title: `Review: ${review.title}`,
        url: entry.server.url,
        status: `${review.currentRevisionId ?? "no revision"} · ${active} active thread${active === 1 ? "" : "s"}`,
    };
}

async function closeInstance(ctx) {
    const entry = instances.get(ctx.instanceId);
    if (!entry) return;
    instances.delete(ctx.instanceId);
    try {
        await entry.ready;
        await entry.server?.close();
    } catch (err) {
        log(`manual-review: failed to close ${ctx.instanceId}: ${err?.message ?? err}`, "warning");
    }
}

function requireString(input, name) {
    if (typeof input[name] !== "string" || !input[name].trim()) throw new CanvasError("invalid_input", `${name} is required.`);
    return input[name];
}

const reviewIdProp = { type: "string", description: "Review id. Defaults to the review shown in this canvas instance." };

const actions = [
    {
        name: "run_agent_review",
        description: "Only on an explicit user request, queue a read-only review by the exact selected models. May consume credits. Read get_review for revisionId first; results become suggestions, never automatic edits.",
        inputSchema: {
            type: "object",
            properties: {
                reviewId: reviewIdProp,
                revisionId: { type: "string" },
                models: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 120 } },
                focus: { type: "string", enum: REVIEW_FOCUSES },
                intent: { type: "string", maxLength: 4000, description: "Optional goal, acceptance criteria, spec references, or review guidance; not permission to edit." },
            },
            required: ["models", "focus", "revisionId"],
            additionalProperties: false,
        },
        handler: guarded(async (ctx) => {
            const input = inputOf(ctx);
            return agentReview.start(await reviewIdFor(ctx, input), input, ctx.instanceId);
        }),
    },
    {
        name: "get_agent_review",
        description: "Read pinned review input and base/head commits. Omit path for inventory; pass path and hunkIndex for each hunk, or side old/new and optional startLine for 400 full-file lines. Follow content.nextStartLine; unavailable content is a verification limit. Excludes held drafts.",
        inputSchema: {
            type: "object",
            properties: {
                reviewId: reviewIdProp, runId: { type: "string" }, path: { type: "string" }, hunkIndex: { type: "integer", minimum: 0 },
                side: { type: "string", enum: ["old", "new"] }, startLine: { type: "integer", minimum: 1 },
            },
            required: ["runId"],
            additionalProperties: false,
        },
        handler: guarded(async (ctx) => {
            const input = inputOf(ctx);
            return agentReview.input(await reviewIdFor(ctx, input), input);
        }),
    },
    {
        name: "report_agent_review",
        description: "Report a selected model's actual findings after the owning conversation checks the code and baseline. Include assessments, evidence, and a summary of actual coverage/verification/limits (even with no findings), or error on failure. Only confirmed actionable findings can be approved.",
        inputSchema: {
            type: "object",
            properties: {
                reviewId: reviewIdProp, runId: { type: "string" }, model: { type: "string" },
                error: { type: "string", minLength: 1, maxLength: 4000 },
                summary: { type: "string", minLength: 1, maxLength: 4000, description: "Actual coverage, skills used, checks performed, and verification limits. Required with findings, including an empty array." },
                findings: {
                    type: "array", maxItems: 20,
                    items: {
                        type: "object",
                        properties: {
                            kind: { type: "string", enum: ["overview", "file", "line"] },
                            category: { type: "string", enum: ["issue", "simplification"] },
                            severity: { type: "string", enum: FINDING_SEVERITIES },
                            assessment: { type: "string", enum: FINDING_ASSESSMENTS },
                            evidence: {
                                type: "object",
                                properties: Object.fromEntries(EVIDENCE_FIELDS.map((key) => [key, { type: "string", minLength: 1, maxLength: 2000 }])),
                                required: EVIDENCE_FIELDS,
                                additionalProperties: false,
                            },
                            body: { type: "string", minLength: 1, maxLength: 8000 },
                            path: { type: "string" }, side: { type: "string", enum: ["old", "new"] },
                            startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 },
                        },
                        required: ["kind", "category", "severity", "assessment", "evidence", "body"],
                        additionalProperties: false,
                    },
                },
            },
            required: ["runId", "model"],
            oneOf: [
                { required: ["findings", "summary"], not: { required: ["error"] } },
                { required: ["error"], not: { anyOf: [{ required: ["findings"] }, { required: ["summary"] }] } },
            ],
            additionalProperties: false,
        },
        handler: guarded(async (ctx) => {
            const input = inputOf(ctx);
            return agentReview.report(await reviewIdFor(ctx, input), input);
        }),
    },
    {
        name: "update_description",
        description: "Revise the local PR-style Overview description. Read get_review first and pass its description.version (0 if absent). Does not publish to a PR.",
        inputSchema: {
            type: "object",
            properties: {
                reviewId: reviewIdProp,
                body: { type: "string", minLength: 1, maxLength: 20000, description: "Markdown: purpose, behavior, scope, verification, and risks." },
                expectedVersion: { type: "integer", minimum: 0 },
            },
            required: ["body", "expectedVersion"],
            additionalProperties: false,
        },
        handler: guarded(async (ctx) => {
            const input = inputOf(ctx);
            return service.updateDescription(await reviewIdFor(ctx, input), input);
        }),
    },
    {
        name: "get_review",
        description: "Read the review: scope, git state, threads with messages and delivery state, lessons, and the repository's guideline-learning mode (off, suggest, auto). Use to catch up on comments or check what is still unanswered. Comments the reviewer is still holding as drafts are left out; counts.drafts says how many there are.",
        inputSchema: {
            type: "object",
            properties: {
                reviewId: reviewIdProp,
                threadId: { type: "string", description: "Return only this thread." },
                includeResolved: { type: "boolean", description: "Include resolved/closed threads (default false)." },
            },
            additionalProperties: false,
        },
        handler: guarded(async (ctx) => {
            const input = inputOf(ctx);
            const review = await service.getReview(await reviewIdFor(ctx, input));
            const summary = service.summarize(review, { threadId: input.threadId, includeResolved: input.includeResolved === true });
            return { ...summary, learning: (await settings.get(review.repoRoot)).learning };
        }),
    },
    {
        name: "reply",
        description: "Post the agent's answer to a user's review comment in its thread. Call once per delivered comment after acting on it; for a submitted review, one reply per thread answers all of that thread's new comments.",
        inputSchema: {
            type: "object",
            properties: {
                reviewId: reviewIdProp,
                threadId: { type: "string" },
                inReplyTo: { type: "string", description: "messageId of the user comment being answered." },
                body: { type: "string", description: "Markdown. What changed (files/lines) or the answer." },
                outcome: { type: "string", enum: OUTCOMES },
                verification: { type: "string", description: "How the change was verified (build/test command and result)." },
                lessons: {
                    type: "array",
                    description: "Reusable guidelines drawn from this comment, and what happened to them. Follow the learning mode in the delivered prompt.",
                    items: {
                        type: "object",
                        properties: {
                            lessonId: { type: "string", description: "A guideline already listed for this thread; use it to record the reviewer's decision on it." },
                            scope: { type: "string", enum: ["repo", "personal"] },
                            rule: { type: "string", description: "The guideline text. Required unless lessonId is given." },
                            status: { type: "string", enum: LESSON_STATUSES, description: "proposed: suggested to the reviewer; saved (default): written to savedTo; declined: the reviewer rejected it." },
                            savedTo: { type: "string", description: "Instruction file the rule was written to." },
                        },
                        additionalProperties: false,
                    },
                },
                refresh: { type: "boolean", description: "Re-capture the diff after replying (default true)." },
            },
            required: ["threadId", "body", "outcome"],
            additionalProperties: false,
        },
        handler: guarded(async (ctx) => {
            const input = inputOf(ctx);
            const reviewId = await reviewIdFor(ctx, input);
            const threadId = requireString(input, "threadId");
            const { message } = await service.addMessage(reviewId, threadId, {
                author: "agent",
                body: input.body,
                outcome: input.outcome,
                verification: input.verification,
                inReplyTo: input.inReplyTo,
                lessons: input.lessons,
            });
            let revision = null;
            if (input.refresh !== false) {
                try {
                    revision = await service.refresh(reviewId);
                } catch (err) {
                    log(`manual-review: refresh after reply failed: ${err?.message ?? err}`, "warning");
                }
            }
            return { ok: true, reviewId, threadId, messageId: message.messageId, revision };
        }),
    },
    {
        name: "start_thread",
        description: "Start an agent-authored thread (e.g. to flag a risk or ask the user a question about specific code). Not delivered back to the agent.",
        inputSchema: {
            type: "object",
            properties: {
                reviewId: reviewIdProp,
                kind: { type: "string", enum: THREAD_KINDS },
                body: { type: "string" },
                path: { type: "string", description: "Repo-relative path (required unless kind is overview)." },
                side: { type: "string", enum: ["new", "old"] },
                startLine: { type: "integer", minimum: 1 },
                endLine: { type: "integer", minimum: 1 },
            },
            required: ["kind", "body"],
            additionalProperties: false,
        },
        handler: guarded(async (ctx) => {
            const input = inputOf(ctx);
            const reviewId = await reviewIdFor(ctx, input);
            const { thread } = await service.createThread(reviewId, { ...input, author: "agent" });
            return { ok: true, reviewId, threadId: thread.threadId, location: thread.location };
        }),
    },
    {
        name: "set_thread_status",
        description: "Change a local thread's status. With user-delegated resolution (including standing instructions), resolve verified, addressed requests after replying. Never resolve just because an anchor is outdated.",
        inputSchema: {
            type: "object",
            properties: {
                reviewId: reviewIdProp,
                threadId: { type: "string" },
                status: { type: "string", enum: THREAD_STATUSES },
            },
            required: ["threadId", "status"],
            additionalProperties: false,
        },
        handler: guarded(async (ctx) => {
            const input = inputOf(ctx);
            const reviewId = await reviewIdFor(ctx, input);
            const thread = await service.setThreadStatus(reviewId, requireString(input, "threadId"), input.status);
            return { ok: true, threadId: thread.threadId, status: thread.status };
        }),
    },
    {
        name: "refresh",
        description: "Re-capture the working-tree diff so the canvas shows the latest code and threads are re-anchored.",
        inputSchema: { type: "object", properties: { reviewId: reviewIdProp }, additionalProperties: false },
        handler: guarded(async (ctx) => {
            const input = inputOf(ctx);
            const reviewId = await reviewIdFor(ctx, input);
            return { reviewId, ...(await service.refresh(reviewId)) };
        }),
    },
];

session = await joinSession({
    canvases: [
        createCanvas({
            id: CANVAS_ID,
            displayName: "Manual review",
            description: "PR-style inline review of local git changes (the whole branch or only pending changes) with threaded discussion delivered to the agent.",
            inputSchema: {
                type: "object",
                properties: {
                    reviewId: { type: "string", description: "Reopen an existing review." },
                    repoPath: { type: "string", description: "Repository path (defaults to the session working directory)." },
                    base: { type: "string", description: "Base ref; with scope all, the diff is working tree vs merge-base(base, HEAD). Defaults to origin/HEAD, main, or master." },
                    scope: { type: "string", enum: SCOPES, description: "all (default): the whole branch or PR, working tree vs merge-base(base, HEAD). pending: only uncommitted changes, working tree vs HEAD. On an open review, the other scope opens its sibling review." },
                    title: { type: "string" },
                    paths: { type: "array", items: { type: "string" }, description: "Limit the review to these pathspecs." },
                    exclude: { type: "array", items: { type: "string" }, description: "Pathspecs to exclude, e.g. agency.toml." },
                    includeUntracked: { type: "boolean", description: "Include untracked files (default true)." },
                    context: { type: "integer", minimum: 0, maximum: 50, description: "Context lines around changes (default 5)." },
                },
                additionalProperties: false,
            },
            actions,
            open: guarded(openReview),
            onClose: closeInstance,
        }),
    ],
});

session.on("user.message", (event) => {
    delivery.onUserMessage(event).catch((err) => log(`manual-review: user.message handling failed: ${err?.message ?? err}`, "warning"));
});
session.on("assistant.turn_start", () => delivery.setBusy(true));

let refreshTimer = null;
session.on("session.idle", () => {
    delivery.onIdle().catch((err) => log(`manual-review: idle handling failed: ${err?.message ?? err}`, "warning"));
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
        for (const reviewId of openReviewIds()) {
            service.refresh(reviewId).catch((err) => log(`manual-review: refresh of ${reviewId} failed: ${err?.message ?? err}`, "warning"));
        }
    }, 500);
});
