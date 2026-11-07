// Delivers user review comments to the agent conversation and tracks their lifecycle:
// saving -> queued -> processing -> replied | no-reply, or failed (retryable).
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { buildBatchPrompt, buildCommentPrompt } from "./prompt.mjs";

// Also accepts markers written before the rename to Self Review Canvas, so in-flight replies still match.
const MARKER_RE = /^\[(?:self-review sr|manual-review mr):([a-z0-9][a-z0-9._-]{0,100}):(m-[0-9a-f-]{36})\]$/;

const nowIso = () => new Date().toISOString();

export class Delivery extends EventEmitter {
    /**
     * @param {object} p
     * @param {import("./review-service.mjs").ReviewService} p.service
     * @param {(options: object) => Promise<string>} p.send session.send
     * @param {(msg: string, level?: string) => void} p.log
     * @param {() => Iterable<string>} p.reviewIds reviews to settle when the agent goes idle
     * @param {(repoRoot: string) => Promise<string>} [p.learning] guideline-learning mode for a repository; failures fall back to off
     * @param {() => string | undefined} [p.sessionId] conversation that processes the comments this instance sends
     */
    constructor({ service, send, log = () => {}, reviewIds = () => [], learning = async () => "off", sessionId = () => undefined }) {
        super();
        this.service = service;
        this.send = send;
        this.log = log;
        this.reviewIds = reviewIds;
        this.learning = learning;
        this.sessionId = sessionId;
        this.fallbackOwner = `delivery-${randomUUID()}`;
        this.busy = null;
        this.bySessionMessageId = new Map();
        // Session message ids seen before send() resolved, and whether their turn has already finished.
        this.seenSessionMessageIds = new Map();
        this.touched = new Set();
        this.inFlight = new Map();
        this.lifecycle = Promise.resolve();
    }

    deliver(reviewId, threadId, messageId, instanceId, options = {}) {
        const key = `${reviewId}:${messageId}`;
        if (this.inFlight.has(key)) return this.inFlight.get(key);
        const pending = this.deliverOnce(reviewId, threadId, messageId, instanceId, options)
            .finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, pending);
        return pending;
    }

    async deliverOnce(reviewId, threadId, messageId, instanceId, { retry = false } = {}) {
        this.touched.add(reviewId);
        const claim = await this.service.claimDelivery(reviewId, threadId, messageId, { retry, senderSessionId: this.owner() });
        if (!claim) return { delivered: false, skipped: true };
        return this.sendClaimed(reviewId, [{ threadId, messageId, ...claim }], instanceId);
    }

    // Sends every draft of a review as one prompt; drafts are claimed atomically so a review is submitted once.
    async submit(reviewId, instanceId) {
        this.touched.add(reviewId);
        const claims = await this.service.claimDrafts(reviewId, { senderSessionId: this.owner() });
        if (!claims.length) return { submitted: 0, delivered: false };
        const result = await this.sendClaimed(reviewId, claims, instanceId);
        return { submitted: claims.length, ...result };
    }

    async repoLearning(repoRoot) {
        try {
            return await this.learning(repoRoot);
        } catch (err) {
            this.log(`self-review: could not read the learning setting, using off: ${err?.message ?? err}`, "warning");
            return "off";
        }
    }

    // Builds and sends the prompt for claimed messages: one comment uses the single-comment prompt, more use the batch prompt.
    async sendClaimed(reviewId, claims, instanceId) {
        let sessionMessageId;
        try {
            const threadIds = [...new Set(claims.map((c) => c.threadId))];
            const contexts = [];
            for (const threadId of threadIds) contexts.push(await this.service.promptContext(reviewId, threadId));
            const learning = await this.repoLearning(contexts[0].review.repoRoot);
            let built;
            if (claims.length === 1) {
                const ctx = contexts[0];
                const message = ctx.thread.messages.find((m) => m.messageId === claims[0].messageId);
                built = buildCommentPrompt({ ...ctx, message, instanceId, learning });
            } else {
                const ids = new Set(claims.map((c) => c.messageId));
                const groups = contexts.map((ctx) => ({
                    thread: ctx.thread,
                    messages: ctx.thread.messages.filter((m) => ids.has(m.messageId)),
                    excerpt: ctx.excerpt,
                    selected: ctx.selected,
                }));
                built = buildBatchPrompt({ review: contexts[contexts.length - 1].review, groups, instanceId, learning });
            }
            sessionMessageId = await this.send({ prompt: built.prompt, displayPrompt: built.displayPrompt, mode: "enqueue" });
        } catch (err) {
            const error = String(err?.message ?? err);
            this.log(`self-review: failed to deliver ${claims.map((c) => c.messageId).join(", ")}: ${error}`, "warning");
            for (const c of claims) await this.service.setDelivery(reviewId, c.messageId, { state: "failed", error }, c);
            return { delivered: false, error };
        }

        const targets = claims.map((c) => ({ reviewId, messageId: c.messageId, attemptId: c.attemptId }));
        if (sessionMessageId) this.bySessionMessageId.set(sessionMessageId, targets);
        for (const c of claims) {
            await this.service.setDelivery(reviewId, c.messageId, {
                state: "queued",
                sessionMessageId: sessionMessageId ?? null,
                queuedAt: nowIso(),
                error: null,
            }, c);
        }
        // The user.message event can arrive before send() resolves, and its turn may already have finished.
        await this.enqueueLifecycle(async () => {
            const seen = sessionMessageId ? this.seenSessionMessageIds.get(sessionMessageId) : undefined;
            if (!seen) return;
            this.seenSessionMessageIds.delete(sessionMessageId);
            for (const target of targets) await this.processTarget(target, sessionMessageId, seen.finished);
        });
        return { delivered: true, sessionMessageId };
    }

    // Several conversations can share a review, so a processing comment records which one is working on it.
    owner() {
        return this.sessionId() || this.fallbackOwner;
    }

    // The returned promise reports errors to the caller; a failed event must not block later events.
    enqueueLifecycle(callback) {
        const pending = this.lifecycle.then(callback);
        this.lifecycle = pending.catch(() => {});
        return pending;
    }

    processTarget(target, sessionMessageId, finished = false) {
        return this.service.processDelivery(target.reviewId, target.messageId, {
            attemptId: target.attemptId, sessionMessageId, sessionId: this.owner(), finished,
        });
    }

    onUserMessage(event) {
        return this.enqueueLifecycle(() => this.handleUserMessage(event));
    }

    async handleUserMessage(event) {
        const data = event?.data ?? {};
        let targets = data.messageId ? this.bySessionMessageId.get(data.messageId) : undefined;
        if (!targets) {
            const seen = new Set();
            targets = [];
            for (const text of [data.transformedContent, data.content]) {
                for (const line of String(text ?? "").split(/\r?\n/)) {
                    const m = MARKER_RE.exec(line);
                    if (!m) break;
                    if (seen.has(m[2])) continue;
                    seen.add(m[2]);
                    targets.push({ reviewId: m[1], messageId: m[2] });
                }
            }
        }
        let applied = false;
        for (const target of targets) {
            if (await this.processTarget(target, data.messageId)) {
                this.touched.add(target.reviewId);
                applied = true;
            }
        }
        if (!applied) {
            if (data.messageId) {
                this.seenSessionMessageIds.set(data.messageId, { finished: false });
                if (this.seenSessionMessageIds.size > 200) this.seenSessionMessageIds.delete(this.seenSessionMessageIds.keys().next().value);
            }
            return;
        }
    }
    setBusy(busy) {
        if (this.busy === busy) return;
        this.busy = busy;
        this.emit("session", { busy });
    }

    onIdle() {
        return this.enqueueLifecycle(() => this.handleIdle());
    }

    async handleIdle() {
        this.setBusy(false);
        for (const seen of this.seenSessionMessageIds.values()) seen.finished = true;
        const ids = new Set([...this.touched, ...this.reviewIds()]);
        for (const reviewId of ids) {
            try {
                await this.service.settleProcessing(reviewId, { sessionId: this.owner() });
                await this.service.recoverAbandonedClaims(reviewId);
            } catch (err) {
                this.log(`self-review: settle failed for ${reviewId}: ${err?.message ?? err}`, "warning");
            }
        }
    }
}
