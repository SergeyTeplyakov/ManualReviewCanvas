import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGit } from "../lib/git.mjs";
import { Store } from "../lib/store.mjs";
import { ReviewService } from "../lib/review-service.mjs";
import { Delivery } from "../lib/delivery.mjs";
import { startReviewServer } from "../lib/server.mjs";
import { DEFAULT_DELIVERY, DELIVERY_MODES, SettingsService, resolveDelivery } from "../lib/settings.mjs";

const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const lines = (n, f = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";
const git = (cwd, ...args) => runGit(cwd, ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=false", ...args]);

let tmp;
let repo;
let seq = 0;

// Fixture: feature changes a.cs and b.cs relative to main.
before(async () => {
    tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "mr-delivery-")));
    repo = path.join(tmp, "proj");
    await runGit(tmp, ["init", "-q", "-b", "main", repo]);
    await writeFile(path.join(repo, "a.cs"), lines(20));
    await writeFile(path.join(repo, "b.cs"), lines(10));
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "base");
    await git(repo, "checkout", "-q", "-b", "feature");
    await writeFile(path.join(repo, "a.cs"), lines(20, (i) => (i === 5 ? "line 5 CHANGED" : `line ${i}`)));
    await writeFile(path.join(repo, "b.cs"), lines(10, (i) => (i === 3 ? "line 3 CHANGED" : `line ${i}`)));
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "feature work");
});

after(async () => {
    await rm(tmp, { recursive: true, force: true });
});

function fresh() {
    const store = new Store(path.join(tmp, `data-${++seq}`));
    return { store, service: new ReviewService({ store }) };
}

// A Delivery whose session records every prompt; set control.fail to make sending throw.
function recorder(service, control = {}) {
    const sent = [];
    const delivery = new Delivery({
        service,
        send: async (opts) => {
            if (control.fail) throw new Error("session closed");
            sent.push(opts);
            return `sm-${sent.length}`;
        },
    });
    return { sent, delivery };
}

async function waitFor(predicate, label, timeoutMs = 5000) {
    const start = Date.now();
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

function request(port, { method = "GET", pathName, headers = {}, body }) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method, path: pathName, headers }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                let json = null;
                try {
                    json = JSON.parse(text);
                } catch {}
                resolve({ status: res.statusCode, text, json });
            });
        });
        req.on("error", reject);
        if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
        req.end();
    });
}

async function withServer(options, fn) {
    const server = await startReviewServer({ webRoot: WEB_ROOT, ...options });
    try {
        const url = new URL(server.url);
        const port = Number(url.port);
        const token = url.searchParams.get("t");
        const headers = { "Content-Type": "application/json", "X-MR-Token": token };
        return await fn({
            state: async () => (await request(port, { pathName: `/api/state?t=${token}` })).json,
            post: (pathName, body) => request(port, { method: "POST", pathName, headers, body }),
        });
    } finally {
        await server.close();
    }
}

const openReview = (service) => service.ensureReview({ repoPath: repo, base: "main" });
const draftThread = (service, reviewId, filePath, body) => service.createThread(reviewId, { kind: "file", path: filePath, body, author: "user", hold: true });
const draftReply = (service, reviewId, threadId, body) => service.addMessage(reviewId, threadId, { body, author: "user", hold: true });
const stateOf = async (service, reviewId, messageId) => (await service.findMessage(reviewId, messageId)).message.delivery.state;
const MARKER_LINE = /^\[manual-review mr:[^:]+:(m-[0-9a-f-]+)\]$/gm;

test("resolveDelivery uses the repository mode and lets an ask-mode review decide for itself", () => {
    assert.deepEqual(DELIVERY_MODES, ["immediate", "batch", "ask"]);
    assert.equal(DEFAULT_DELIVERY, "immediate");
    assert.equal(resolveDelivery(undefined, null), "immediate", "no setting means immediate");
    assert.equal(resolveDelivery("bogus", {}), "immediate", "an unknown mode falls back to the default");
    assert.equal(resolveDelivery("batch", { deliveryMode: "immediate" }), "batch", "only ask mode reads the review's choice");
    assert.equal(resolveDelivery("immediate", { deliveryMode: "batch" }), "immediate");
    assert.equal(resolveDelivery("ask", {}), null, "an ask-mode review is undecided until the reviewer chooses");
    assert.equal(resolveDelivery("ask", { deliveryMode: "later" }), null);
    assert.equal(resolveDelivery("ask", { deliveryMode: "batch" }), "batch");
    assert.equal(resolveDelivery("ask", { deliveryMode: "immediate" }), "immediate");
});

test("SettingsService stores the delivery mode per repository without choosing a learning mode", async () => {
    const { store } = fresh();
    const settings = new SettingsService({ store });
    const initial = { repoName: "proj", learning: "off", delivery: "immediate", configured: false, dismissed: false };
    assert.deepEqual(await settings.update(repo, { delivery: "batch" }), { ...initial, delivery: "batch" }, "delivery alone leaves learning unconfigured");
    assert.deepEqual(await settings.update(repo, { learning: "suggest", delivery: "ask" }), { ...initial, learning: "suggest", delivery: "ask", configured: true });
    assert.deepEqual(await new SettingsService({ store }).get(repo), { ...initial, learning: "suggest", delivery: "ask", configured: true }, "the choice is stored, not cached");
    assert.equal((await settings.update(repo, { learning: "auto" })).delivery, "ask", "changing learning keeps the delivery mode");
});

test("held comments stay drafts until the review is submitted, then are claimed once as one batch", async () => {
    const { service } = fresh();
    const reviewId = await openReview(service);
    const first = await draftThread(service, reviewId, "a.cs", "Rename this");
    const second = await draftReply(service, reviewId, first.thread.threadId, "And add a test");
    const other = await draftThread(service, reviewId, "b.cs", "Why is this needed?");
    const direct = await service.createThread(reviewId, { kind: "file", path: "b.cs", body: "Sent right away", author: "user" });
    for (const m of [first.message, second.message, other.message]) assert.deepEqual(m.delivery, { state: "draft", attempts: 0 });
    assert.equal(direct.message.delivery.state, "saving");
    assert.equal(service.summarize(await service.getReview(reviewId)).counts.drafts, 3);

    const claims = await service.claimDrafts(reviewId);
    assert.deepEqual(claims.map((c) => [c.threadId, c.messageId, c.attempts]), [
        [first.thread.threadId, first.message.messageId, 1],
        [first.thread.threadId, second.message.messageId, 1],
        [other.thread.threadId, other.message.messageId, 1],
    ]);
    const deliveries = [];
    for (const c of claims) deliveries.push((await service.findMessage(reviewId, c.messageId)).message.delivery);
    assert.ok(deliveries.every((d) => d.state === "saving" && d.batchId && d.batchId === deliveries[0].batchId), "one batch id ties the submitted comments together");
    assert.equal((await service.findMessage(reviewId, direct.message.messageId)).message.delivery.batchId, undefined, "a comment that was not held is not part of the batch");
    assert.equal(service.summarize(await service.getReview(reviewId)).counts.drafts, 0);
    assert.deepEqual(await service.claimDrafts(reviewId), [], "a review is submitted once");
});

test("an agent reply answers every comment its thread received in the same submitted review, and never a draft", async () => {
    const { service } = fresh();
    const reviewId = await openReview(service);
    const first = await draftThread(service, reviewId, "a.cs", "Rename this");
    const second = await draftReply(service, reviewId, first.thread.threadId, "And add a test");
    const other = await draftThread(service, reviewId, "b.cs", "Why is this needed?");

    await assert.rejects(
        () => service.addMessage(reviewId, first.thread.threadId, { author: "agent", body: "Done", inReplyTo: second.message.messageId }),
        (e) => e.code === "conflict",
        "the agent cannot answer a comment it was never sent",
    );

    await service.claimDrafts(reviewId);
    await service.addMessage(reviewId, first.thread.threadId, { author: "agent", body: "Renamed and tested", inReplyTo: second.message.messageId, outcome: "changed" });
    assert.equal(await stateOf(service, reviewId, first.message.messageId), "replied", "the earlier comment from the same submission is answered too");
    assert.equal(await stateOf(service, reviewId, second.message.messageId), "replied");
    assert.equal(await stateOf(service, reviewId, other.message.messageId), "saving", "another thread still needs its own reply");

    const later = await draftReply(service, reviewId, first.thread.threadId, "One more thing");
    await service.addMessage(reviewId, other.thread.threadId, { author: "agent", body: "It guards a race" });
    assert.equal(await stateOf(service, reviewId, other.message.messageId), "replied", "a reply without inReplyTo answers the latest delivered comment");
    await service.addMessage(reviewId, first.thread.threadId, { author: "agent", body: "Anything else?" });
    assert.equal(await stateOf(service, reviewId, later.message.messageId), "draft", "a reply without inReplyTo skips drafts");
});

test("discarding a draft removes it, and its thread when nothing else is left", async () => {
    const { service } = fresh();
    const reviewId = await openReview(service);
    const kept = await service.createThread(reviewId, { kind: "file", path: "a.cs", body: "Delivered", author: "user" });
    const reply = await draftReply(service, reviewId, kept.thread.threadId, "Second thoughts");
    const lone = await draftThread(service, reviewId, "b.cs", "Never mind");

    assert.deepEqual(await service.discardDraft(reviewId, reply.message.messageId), { threadId: kept.thread.threadId, threadRemoved: false });
    assert.deepEqual(await service.discardDraft(reviewId, lone.message.messageId), { threadId: lone.thread.threadId, threadRemoved: true });
    const review = await service.getReview(reviewId);
    assert.deepEqual(review.threads.map((t) => [t.threadId, t.messages.length]), [[kept.thread.threadId, 1]]);

    await assert.rejects(() => service.discardDraft(reviewId, kept.message.messageId), (e) => e.code === "conflict", "a comment the agent may have seen stays");
    await assert.rejects(() => service.discardDraft(reviewId, reply.message.messageId), (e) => e.code === "not_found");
});

test("an ask-mode review records the reviewer's choice and can ask again", async () => {
    const { service } = fresh();
    const reviewId = await openReview(service);
    assert.equal((await service.getReview(reviewId)).deliveryMode, undefined);
    assert.equal(await service.setDeliveryChoice(reviewId, "batch"), "batch");
    assert.equal((await service.getReview(reviewId)).deliveryMode, "batch");
    for (const mode of ["ask", "later", undefined, 1]) {
        await assert.rejects(() => service.setDeliveryChoice(reviewId, mode), (e) => e.code === "invalid_input", String(mode));
    }
    assert.equal((await service.getReview(reviewId)).deliveryMode, "batch", "a rejected choice changes nothing");
    assert.equal(await service.setDeliveryChoice(reviewId, null), null);
    assert.equal("deliveryMode" in (await service.getReview(reviewId)), false);
});

test("submitting a review sends every draft in one prompt grouped by thread", async () => {
    const { service } = fresh();
    const { sent, delivery } = recorder(service);
    const reviewId = await openReview(service);
    const earlier = await service.createThread(reviewId, { kind: "file", path: "a.cs", body: "Earlier delivered comment", author: "user" });
    await delivery.deliver(reviewId, earlier.thread.threadId, earlier.message.messageId, "inst");
    await service.addMessage(reviewId, earlier.thread.threadId, { author: "agent", body: "Earlier agent answer", outcome: "answered" });
    const first = await draftReply(service, reviewId, earlier.thread.threadId, "Rename this");
    const second = await draftReply(service, reviewId, earlier.thread.threadId, "And add a test");
    const other = await draftThread(service, reviewId, "b.cs", "Why is this needed?");

    assert.deepEqual(await delivery.submit(reviewId, "inst"), { submitted: 3, delivered: true, sessionMessageId: "sm-2" });
    assert.equal(sent.length, 2, "one prompt for the whole review");
    const { prompt, displayPrompt, mode } = sent[1];
    assert.equal(mode, "enqueue");
    const markers = [...prompt.matchAll(MARKER_LINE)].map((m) => m[1]);
    assert.deepEqual(markers, [first.message.messageId, second.message.messageId, other.message.messageId]);
    assert.match(prompt, /with 3 comments in 2 threads\. Address every thread below\./);
    assert.match(prompt, /^## Thread 1 of 2: file a\.cs$/m);
    assert.match(prompt, /^## Thread 2 of 2: file b\.cs$/m);
    assert.match(prompt, /### New user comments\n\*\*Comment 1 of 2:\*\*\nRename this\n\n\*\*Comment 2 of 2:\*\*\nAnd add a test/);
    assert.match(prompt, /### New user comment\nWhy is this needed\?/);
    assert.ok(prompt.includes(`Reply with threadId \`${earlier.thread.threadId}\` and inReplyTo \`${second.message.messageId}\`.`));
    assert.ok(prompt.includes(`Reply with threadId \`${other.thread.threadId}\` and inReplyTo \`${other.message.messageId}\`.`));
    assert.match(prompt, /- \*\*user:\*\* Earlier delivered comment\n- \*\*agent \(answered\):\*\* Earlier agent answer/, "the history carries what the agent already saw");
    assert.equal(displayPrompt, "Review submitted · 3 comments in 2 threads: a.cs, b.cs");
    for (const id of markers) assert.equal(await stateOf(service, reviewId, id), "queued");

    assert.deepEqual(await delivery.submit(reviewId, "inst"), { submitted: 0, delivered: false });
    assert.equal(sent.length, 2);
});

test("a single submitted draft uses the comment prompt and other drafts stay out of the agent's view", async () => {
    const { service } = fresh();
    const { sent, delivery } = recorder(service);
    const reviewId = await openReview(service);
    const first = await draftThread(service, reviewId, "a.cs", "Send this one now");
    const held = await draftReply(service, reviewId, first.thread.threadId, "Still thinking about this");

    await delivery.deliver(reviewId, first.thread.threadId, first.message.messageId, "inst");
    assert.equal(sent.length, 1);
    assert.match(sent[0].prompt, /^\[manual-review mr:[^\]]+\]\nThe user posted a review comment/);
    assert.ok(!sent[0].prompt.includes("Still thinking about this"), "a held draft is not shown to the agent");
    assert.equal(await stateOf(service, reviewId, held.message.messageId), "draft");

    assert.deepEqual(await delivery.submit(reviewId, "inst"), { submitted: 1, delivered: true, sessionMessageId: "sm-2" });
    assert.match(sent[1].prompt, /^\[manual-review mr:[^\]]+\]\nThe user posted a review comment/);
    assert.ok(sent[1].prompt.includes(`[manual-review mr:${reviewId}:${held.message.messageId}]`));
    assert.match(sent[1].prompt, /- \*\*user:\*\* Send this one now/, "the comment sent earlier is now history");
});

test("a failed submission marks every comment in it as failed so each can be retried", async () => {
    const { service } = fresh();
    const control = { fail: true };
    const { sent, delivery } = recorder(service, control);
    const reviewId = await openReview(service);
    const a = await draftThread(service, reviewId, "a.cs", "One");
    const b = await draftThread(service, reviewId, "b.cs", "Two");

    assert.deepEqual(await delivery.submit(reviewId, "inst"), { submitted: 2, delivered: false, error: "session closed" });
    for (const m of [a.message, b.message]) assert.equal(await stateOf(service, reviewId, m.messageId), "failed");
    assert.deepEqual(await delivery.submit(reviewId, "inst"), { submitted: 0, delivered: false }, "failed comments are no longer drafts");

    control.fail = false;
    assert.equal((await delivery.deliver(reviewId, a.thread.threadId, a.message.messageId, "inst", { retry: true })).delivered, true);
    assert.equal(sent.length, 1);
    assert.equal(await stateOf(service, reviewId, a.message.messageId), "queued");
});

test("in batch mode the API holds comments as drafts until the review is submitted", async () => {
    const { store, service } = fresh();
    const settings = new SettingsService({ store });
    await settings.update(repo, { delivery: "batch" });
    const { sent, delivery } = recorder(service);
    const reviewId = await openReview(service);

    await withServer({ instanceId: "inst-batch", getReviewId: () => reviewId, service, delivery, settings }, async ({ state, post }) => {
        assert.equal((await state()).settings.delivery, "batch");
        const a = await post("/api/threads", { kind: "file", path: "a.cs", body: "Rename this" });
        assert.equal(a.status, 200);
        assert.equal(a.json.draft, true);
        const a2 = await post(`/api/threads/${a.json.threadId}/messages`, { body: "And add a test" });
        assert.equal(a2.json.draft, true);
        const b = await post("/api/threads", { kind: "file", path: "b.cs", body: "Why is this needed?" });
        const c = await post("/api/threads", { kind: "file", path: "b.cs", body: "Typo here" });
        assert.deepEqual([b.json.draft, c.json.draft], [true, true]);

        const urgent = await post("/api/threads", { kind: "file", path: "b.cs", body: "This breaks the build", draft: false });
        assert.equal(urgent.json.draft, false, "an explicit draft flag overrides the mode");
        await waitFor(() => sent.length === 1, "the urgent comment to be delivered");
        assert.ok(sent[0].prompt.includes(urgent.json.messageId));
        const invalid = await post("/api/threads", { kind: "file", path: "a.cs", body: "Never stored", draft: "yes" });
        assert.equal(invalid.status, 400);
        assert.equal(invalid.json.error.code, "invalid_input");

        assert.deepEqual((await post(`/api/messages/${b.json.messageId}/discard`, {})).json, { threadId: b.json.threadId, threadRemoved: true });
        for (const action of ["send", "discard"]) {
            const rejected = await post(`/api/messages/${urgent.json.messageId}/${action}`, {});
            assert.equal(rejected.status, 409, action);
            assert.equal(rejected.json.error.code, "conflict");
        }

        const single = await post(`/api/messages/${c.json.messageId}/send`, {});
        assert.equal(single.status, 200);
        assert.deepEqual(single.json, { delivered: true, sessionMessageId: "sm-2" });
        assert.ok(sent[1].prompt.includes(c.json.messageId) && !sent[1].prompt.includes("Rename this"), "sending one draft leaves the others held");

        const submitted = await post("/api/submit", {});
        assert.equal(submitted.status, 200);
        assert.deepEqual(submitted.json, { submitted: 2, delivered: true, sessionMessageId: "sm-3" });
        assert.equal(sent.length, 3);
        assert.match(sent[2].prompt, /with 2 comments in 1 thread\./);
        assert.deepEqual((await post("/api/submit", {})).json, { submitted: 0, delivered: false });
        assert.ok(!JSON.stringify((await state()).review).includes("Never stored"), "a rejected comment is not saved");
    });
});

test("in ask mode comments wait as drafts until the reviewer chooses how this review is delivered", async () => {
    const { store, service } = fresh();
    const settings = new SettingsService({ store });
    await settings.update(repo, { delivery: "ask" });
    const { sent, delivery } = recorder(service);
    const reviewId = await openReview(service);

    await withServer({ instanceId: "inst-ask", getReviewId: () => reviewId, service, delivery, settings }, async ({ state, post }) => {
        const held = await post("/api/threads", { kind: "file", path: "a.cs", body: "Before choosing" });
        assert.equal(held.json.draft, true, "an undecided review holds comments");
        for (const mode of ["ask", "later", undefined]) {
            const rejected = await post("/api/delivery", { mode });
            assert.equal(rejected.status, 400, String(mode));
            assert.equal(rejected.json.error.code, "invalid_input");
        }

        assert.deepEqual((await post("/api/delivery", { mode: "batch" })).json, { mode: "batch", submitted: 0 });
        assert.equal((await state()).review.deliveryMode, "batch");
        assert.equal((await post(`/api/threads/${held.json.threadId}/messages`, { body: "Still batching" })).json.draft, true);
        assert.equal(sent.length, 0);

        assert.deepEqual((await post("/api/delivery", { mode: "immediate" })).json, { mode: "immediate", submitted: 2 }, "switching to immediate sends what was held");
        assert.equal(sent.length, 1);
        assert.match(sent[0].prompt, /with 2 comments in 1 thread\./);
        const live = await post("/api/threads", { kind: "file", path: "b.cs", body: "Sent right away" });
        assert.equal(live.json.draft, false);
        await waitFor(() => sent.length === 2, "the comment to be delivered immediately");

        assert.deepEqual((await post("/api/delivery", { mode: null })).json, { mode: null, submitted: 0 });
        assert.equal((await state()).review.deliveryMode, undefined);
        assert.equal((await post("/api/threads", { kind: "file", path: "b.cs", body: "Asked again" })).json.draft, true, "asking again holds new comments");
    });
});

test("without a delivery setting every comment is sent immediately unless the reviewer holds it", async () => {
    const { store, service } = fresh();
    const { sent, delivery } = recorder(service);
    const reviewId = await openReview(service);
    for (const settings of [new SettingsService({ store }), undefined]) {
        await withServer({ instanceId: "inst-now", getReviewId: () => reviewId, service, delivery, settings }, async ({ post }) => {
            const count = sent.length;
            const res = await post("/api/threads", { kind: "file", path: "a.cs", body: `Comment ${count}` });
            assert.equal(res.json.draft, false);
            await waitFor(() => sent.length === count + 1, "immediate delivery");
            const kept = await post("/api/threads", { kind: "file", path: "a.cs", body: "Held on request", draft: true });
            assert.equal(kept.json.draft, true, "the reviewer can still hold one comment");
        });
    }
    assert.equal(sent.length, 2);
});
