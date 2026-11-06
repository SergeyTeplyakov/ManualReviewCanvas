// Delivers user review comments to the agent conversation and tracks their lifecycle:
// saving -> queued -> processing -> replied | no-reply, or failed (retryable).
import { EventEmitter } from "node:events";
import { buildCommentPrompt } from "./prompt.mjs";

const MARKER_RE = /\[manual-review mr:([a-z0-9][a-z0-9._-]{0,100}):(m-[0-9a-f-]{36})\]/;

const nowIso = () => new Date().toISOString();

export class Delivery extends EventEmitter {
    /**
     * @param {object} p
     * @param {import("./review-service.mjs").ReviewService} p.service
     * @param {(options: object) => Promise<string>} p.send session.send
     * @param {(msg: string, level?: string) => void} p.log
     * @param {() => Iterable<string>} p.reviewIds reviews to settle when the agent goes idle
     * @param {(repoRoot: string) => Promise<string>} [p.learning] guideline-learning mode for a repository; failures fall back to off
     */
    constructor({ service, send, log = () => {}, reviewIds = () => [], learning = async () => "off" }) {
        super();
        this.service = service;
        this.send = send;
        this.log = log;
        this.reviewIds = reviewIds;
        this.learning = learning;
        this.busy = null;
        this.bySessionMessageId = new Map();
        this.seenSessionMessageIds = new Set();
        this.touched = new Set();
    }

    async deliver(reviewId, threadId, messageId, instanceId, { retry = false } = {}) {
        this.touched.add(reviewId);
        const ctx = await this.service.promptContext(reviewId, threadId);
        const message = ctx.thread.messages.find((m) => m.messageId === messageId);
        if (!message || message.author !== "user") throw new Error(`Message ${messageId} is not a user message in ${threadId}.`);
        const attempts = (message.delivery?.attempts ?? 0) + 1;
        if (retry) {
            await this.service.setDelivery(reviewId, messageId, { state: "saving", error: null }, { force: true });
        }

        let learning = "off";
        try {
            learning = await this.learning(ctx.review.repoRoot);
        } catch (err) {
            this.log(`manual-review: could not read the learning setting, using off: ${err?.message ?? err}`, "warning");
        }

        const { prompt, displayPrompt } = buildCommentPrompt({ ...ctx, message, instanceId, learning });
        let sessionMessageId;
        try {
            sessionMessageId = await this.send({ prompt, displayPrompt, mode: "enqueue" });
        } catch (err) {
            this.log(`manual-review: failed to deliver ${messageId}: ${err?.message ?? err}`, "warning");
            await this.service.setDelivery(reviewId, messageId, { state: "failed", attempts, error: String(err?.message ?? err) });
            return { delivered: false, error: String(err?.message ?? err) };
        }

        const target = { reviewId, messageId };
        if (sessionMessageId) this.bySessionMessageId.set(sessionMessageId, target);
        await this.service.setDelivery(reviewId, messageId, {
            state: "queued",
            attempts,
            sessionMessageId: sessionMessageId ?? null,
            queuedAt: nowIso(),
            error: null,
        });
        // The user.message event can arrive before send() resolves.
        if (sessionMessageId && this.seenSessionMessageIds.delete(sessionMessageId)) {
            await this.service.setDelivery(reviewId, messageId, { state: "processing", processingAt: nowIso() });
        }
        return { delivered: true, sessionMessageId };
    }

    async onUserMessage(event) {
        const data = event?.data ?? {};
        let target = data.messageId ? this.bySessionMessageId.get(data.messageId) : undefined;
        if (!target) {
            const m = MARKER_RE.exec(`${data.transformedContent ?? ""}\n${data.content ?? ""}`);
            if (m) target = { reviewId: m[1], messageId: m[2] };
        }
        if (!target) {
            if (data.messageId) {
                this.seenSessionMessageIds.add(data.messageId);
                if (this.seenSessionMessageIds.size > 200) this.seenSessionMessageIds.delete(this.seenSessionMessageIds.values().next().value);
            }
            return;
        }
        this.touched.add(target.reviewId);
        await this.service.setDelivery(target.reviewId, target.messageId, { state: "processing", processingAt: nowIso() });
    }

    setBusy(busy) {
        if (this.busy === busy) return;
        this.busy = busy;
        this.emit("session", { busy });
    }

    async onIdle() {
        this.setBusy(false);
        const ids = new Set([...this.touched, ...this.reviewIds()]);
        for (const reviewId of ids) {
            try {
                await this.service.settleProcessing(reviewId);
            } catch (err) {
                this.log(`manual-review: settle failed for ${reviewId}: ${err?.message ?? err}`, "warning");
            }
        }
    }
}
