import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, cp, appendFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGit } from "../lib/git.mjs";
import { Store } from "../lib/store.mjs";
import { ReviewService } from "../lib/review-service.mjs";
import { Delivery } from "../lib/delivery.mjs";
import { startReviewServer } from "../lib/server.mjs";

const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const lines = (n, f = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";
const git = (cwd, ...args) => runGit(cwd, ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=false", ...args]);

let tmp;
let repo;
let store;
let service;
let delivery;
let sent;
let reviewId;

async function waitFor(predicate, label, timeoutMs = 5000) {
    const start = Date.now();
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

const deliveryState = async (messageId) => (await service.findMessage(reviewId, messageId)).message.delivery?.state;

before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "mr-int-"));
    repo = path.join(tmp, "repo");
    await runGit(tmp, ["init", "-q", "-b", "main", repo]);
    await writeFile(path.join(repo, "a.cs"), lines(20));
    await writeFile(path.join(repo, "keep.txt"), "unchanged\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "base");
    await git(repo, "checkout", "-q", "-b", "feature");
    await writeFile(path.join(repo, "a.cs"), lines(20, (i) => (i === 10 ? "line 10 CHANGED" : `line ${i}`)));
    await writeFile(path.join(repo, "notes.md"), "# notes\nhello\n");
    await writeFile(path.join(repo, "agency.toml"), "excluded = true\n");

    store = new Store(path.join(tmp, "data"));
    service = new ReviewService({ store });
    sent = [];
    delivery = new Delivery({
        service,
        send: async (opts) => {
            sent.push(opts);
            return `sm-${sent.length}`;
        },
        reviewIds: () => [reviewId],
    });
});

after(async () => {
    await rm(tmp, { recursive: true, force: true });
});

test("ensureReview captures the working-tree diff vs merge-base with excludes and untracked files", async () => {
    reviewId = await service.ensureReview({ repoPath: repo, base: "main", exclude: ["agency.toml"], title: "Test review" });
    assert.equal(await service.ensureReview({ repoPath: repo, base: "main", exclude: ["agency.toml"] }), reviewId, "same inputs reuse the review");
    const review = await service.getReview(reviewId);
    assert.equal(review.title, "Test review");
    assert.equal(review.currentRevisionId, "r1");
    assert.equal(review.revisions.length, 1, "unchanged tree does not create a revision");
    const snap = await service.getSnapshot(reviewId);
    assert.deepEqual(snap.files.map((f) => [f.path, f.status, f.untracked]), [["a.cs", "modified", false], ["notes.md", "added", true]]);
    assert.equal(snap.branch, "feature");
});

let lineThread;
let lineMessage;

test("a line comment is delivered once with location, and the marker/messageId map tracks processing", async () => {
    const created = await service.createThread(reviewId, { kind: "line", path: "a.cs", side: "new", startLine: 10, endLine: 10, body: "Why CHANGED?", author: "user", clientRequestId: "c-1" });
    lineThread = created.thread;
    lineMessage = created.message;
    assert.equal(lineMessage.delivery.state, "saving");
    assert.deepEqual(lineThread.anchor.selectedLines, ["line 10 CHANGED"]);

    const dup = await service.createThread(reviewId, { kind: "line", path: "a.cs", side: "new", startLine: 10, body: "Why CHANGED?", author: "user", clientRequestId: "c-1" });
    assert.equal(dup.duplicate, true);
    assert.equal((await service.getReview(reviewId)).threads.length, 1);

    const result = await delivery.deliver(reviewId, lineThread.threadId, lineMessage.messageId, "inst-1");
    assert.deepEqual(result, { delivered: true, sessionMessageId: "sm-1" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].mode, "enqueue");
    assert.match(sent[0].prompt, new RegExp(`\\[self-review sr:${reviewId}:${lineMessage.messageId}\\]`));
    assert.match(sent[0].prompt, /a\.cs L10/);
    assert.match(sent[0].prompt, /line 10 CHANGED/);
    assert.equal(await deliveryState(lineMessage.messageId), "queued");

    await delivery.onUserMessage({ data: { messageId: "sm-1", content: sent[0].prompt } });
    assert.equal(await deliveryState(lineMessage.messageId), "processing");
});

test("refresh after edits relocates the thread by content", async () => {
    await writeFile(path.join(repo, "a.cs"), "inserted 1\ninserted 2\ninserted 3\n" + lines(20, (i) => (i === 10 ? "line 10 CHANGED" : `line ${i}`)));
    const r = await service.refresh(reviewId);
    assert.equal(r.revisionId, "r2");
    assert.equal(r.created, true);
    const thread = (await service.getReview(reviewId)).threads.find((t) => t.threadId === lineThread.threadId);
    assert.deepEqual([thread.location.revisionId, thread.location.startLine, thread.location.endLine, thread.location.state], ["r2", 13, 13, "current"]);
    assert.equal(thread.anchor.startLine, 10, "the original anchor is preserved");
});

test("full-file content matches the revision and reports stale working trees", async () => {
    const content = await service.getFileContent(reviewId, "r2", "a.cs");
    assert.equal(content.available, true);
    assert.equal(content.lines.length, 23);
    assert.equal(content.lines[12], "line 10 CHANGED");
    const added = await service.getFileContent(reviewId, "r2", "notes.md");
    assert.deepEqual(added.lines, ["# notes", "hello"]);
    await assert.rejects(service.getFileContent(reviewId, "r2", "keep.txt"), /not part of revision/);
    await assert.rejects(service.getFileContent(reviewId, "r2", "../outside.txt"), /escapes/);
    const original = await readFile(path.join(repo, "a.cs"), "utf8");
    await writeFile(path.join(repo, "a.cs"), original.replace("line 10 CHANGED", "line 10 EDITED"));
    try {
        assert.deepEqual(await service.getFileContent(reviewId, "r2", "a.cs"), { revisionId: "r2", path: "a.cs", available: false, reason: "stale", stale: true });
    } finally {
        await writeFile(path.join(repo, "a.cs"), original);
    }
});

test("full-file content rejects edits outside the captured diff hunks", async () => {
    const snapshot = await service.getSnapshot(reviewId, "r2");
    const file = snapshot.files.find((entry) => entry.path === "a.cs");
    assert.equal(file.hunks.some((hunk) => hunk.rows.some((row) => row.n === 23)), false);
    const original = await readFile(path.join(repo, "a.cs"), "utf8");
    try {
        await writeFile(path.join(repo, "a.cs"), original.replace("line 20\n", "line 20 EDITED\n"));
        assert.deepEqual(await service.getFileContent(reviewId, "r2", "a.cs"), {
            revisionId: "r2", path: "a.cs", available: false, reason: "stale", stale: true,
        });
    } finally {
        await writeFile(path.join(repo, "a.cs"), original);
    }
});

test("full-file content handles renamed files and empty modified files", async () => {
    const otherRepo = await mkdtemp(path.join(tmp, "content-"));
    await git(otherRepo, "init", "-q", "-b", "main");
    await writeFile(path.join(otherRepo, "old.cs"), lines(30));
    await writeFile(path.join(otherRepo, "empty.cs"), "old line\n");
    await git(otherRepo, "add", ".");
    await git(otherRepo, "commit", "-q", "-m", "base");
    await git(otherRepo, "checkout", "-q", "-b", "feature");
    await git(otherRepo, "mv", "old.cs", "renamed.cs");
    await writeFile(path.join(otherRepo, "renamed.cs"), lines(30, (i) => i === 15 ? "line 15 CHANGED" : `line ${i}`));
    await writeFile(path.join(otherRepo, "empty.cs"), "");
    const otherReviewId = await service.ensureReview({ repoPath: otherRepo, base: "main" });
    const snapshot = await service.getSnapshot(otherReviewId);
    const renamed = snapshot.files.find((entry) => entry.path === "renamed.cs");
    assert.equal(renamed.status, "renamed");
    assert.equal(renamed.oldPath, "old.cs");
    const content = await service.getFileContent(otherReviewId, "r1", "renamed.cs");
    assert.equal(content.available, true);
    assert.equal(content.lines[14], "line 15 CHANGED");
    const empty = await service.getFileContent(otherReviewId, "r1", "empty.cs");
    assert.equal(empty.available, true);
    assert.deepEqual(empty.lines, []);
});

test("full-file content handles separated zero-context insertions and deletions", async () => {
    const otherRepo = await mkdtemp(path.join(tmp, "hunks-"));
    await git(otherRepo, "init", "-q", "-b", "main");
    await writeFile(path.join(otherRepo, "a.cs"), lines(100));
    await git(otherRepo, "add", ".");
    await git(otherRepo, "commit", "-q", "-m", "base");
    await git(otherRepo, "checkout", "-q", "-b", "feature");
    const updated = [];
    for (let i = 1; i <= 100; i++) {
        if (i !== 95) updated.push(i === 5 ? "line 5 CHANGED" : `line ${i}`);
        if (i === 50) updated.push("inserted");
    }
    await writeFile(path.join(otherRepo, "a.cs"), updated.join("\n") + "\n");
    const otherReviewId = await service.ensureReview({ repoPath: otherRepo, base: "main", context: 0 });
    const snapshot = await service.getSnapshot(otherReviewId);
    assert.equal(snapshot.files[0].hunks.length, 3);
    const content = await service.getFileContent(otherReviewId, "r1", "a.cs");
    assert.equal(content.available, true);
    assert.deepEqual(content.lines, updated);
    await writeFile(path.join(otherRepo, "a.cs"), updated.join("\n").replace("line 20\n", "line 20 EDITED\n") + "\n");
    assert.equal((await service.getFileContent(otherReviewId, "r1", "a.cs")).reason, "stale");
});

test("agent reply marks the comment replied and records lessons", async () => {
    const { message } = await service.addMessage(reviewId, lineThread.threadId, {
        author: "agent",
        body: "Renamed.",
        outcome: "changed",
        inReplyTo: lineMessage.messageId,
        verification: "unit tests",
        lessons: [{ scope: "personal", rule: "Explain renames", savedTo: "~/.copilot/copilot-instructions.md" }],
    });
    assert.equal(message.outcome, "changed");
    assert.equal(await deliveryState(lineMessage.messageId), "replied");
    await delivery.onIdle();
    assert.equal(await deliveryState(lineMessage.messageId), "replied", "idle does not downgrade a replied comment");
    const review = await service.getReview(reviewId);
    assert.equal(review.lessons.length, 1);
    assert.equal((await store.readLessons()).length, 1);
    await assert.rejects(
        () => service.addMessage(reviewId, lineThread.threadId, { author: "agent", body: "x", outcome: "bogus" }),
        (e) => e.code === "invalid_input",
    );
});

test("user.message arriving before send() resolves still marks processing; idle settles to no-reply", async () => {
    const { thread, message } = await service.createThread(reviewId, { kind: "overview", body: "Overall: looks fine?", author: "user" });
    let sends = 0;
    const racing = new Delivery({
        service,
        send: async (opts) => {
            sends++;
            if (sends === 1) await racing.onUserMessage({ data: { messageId: "sm-race", content: "no marker" } });
            sent.push(opts);
            return `sm-race-${sends}`.replace("-1", "");
        },
        reviewIds: () => [reviewId],
    });
    await racing.deliver(reviewId, thread.threadId, message.messageId, "inst-1");
    assert.equal(await deliveryState(message.messageId), "processing");
    await racing.onIdle();
    assert.equal(await deliveryState(message.messageId), "no-reply");

    const retried = await racing.deliver(reviewId, thread.threadId, message.messageId, "inst-1", { retry: true });
    assert.equal(retried.delivered, true);
    assert.equal(await deliveryState(message.messageId), "queued");
    assert.equal((await service.findMessage(reviewId, message.messageId)).message.delivery.attempts, 2);
});

test("a change thread whose code is removed becomes outdated but stays visible", async () => {
    const snap = await service.getSnapshot(reviewId);
    const hunk = snap.files.find((f) => f.path === "a.cs").hunks.find((h) => h.rows.some((r) => r.s === "line 10 CHANGED"));
    const changeRow = hunk.rows.find((r) => r.s === "line 10 CHANGED");
    const { thread } = await service.createThread(reviewId, { kind: "change", path: "a.cs", side: "new", startLine: changeRow.n, endLine: changeRow.n, body: "Drop this", author: "agent" });
    await writeFile(path.join(repo, "a.cs"), lines(20, (i) => (i === 10 ? "line 10 REWRITTEN" : `line ${i}`)));
    await service.refresh(reviewId);
    const after = (await service.getReview(reviewId)).threads.find((t) => t.threadId === thread.threadId);
    assert.equal(after.location.state, "outdated");
    const summary = service.summarize(await service.getReview(reviewId));
    assert.ok(summary.threads.some((t) => t.threadId === thread.threadId));
});

test("anchors are validated", async () => {
    const bad = (input) => assert.rejects(() => service.createThread(reviewId, { author: "user", body: "x", ...input }), (e) => e.code === "invalid_input");
    await bad({ kind: "line", path: "a.cs", startLine: 0 });
    await bad({ kind: "line", path: "a.cs", startLine: 5, endLine: 4 });
    await bad({ kind: "line", path: "a.cs", startLine: 900 });
    await bad({ kind: "file" });
    await bad({ kind: "nope", path: "a.cs" });
    await assert.rejects(() => service.createThread(reviewId, { kind: "file", path: "../outside.txt", body: "x" }));
});

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
                resolve({ status: res.statusCode, text, json, headers: res.headers });
            });
        });
        req.on("error", reject);
        if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
        req.end();
    });
}

test("HTTP server enforces token/host/origin and delivers posted comments", async () => {
    const server = await startReviewServer({ instanceId: "inst-1", getReviewId: () => reviewId, service, delivery, webRoot: WEB_ROOT });
    try {
        const url = new URL(server.url);
        const port = Number(url.port);
        const token = url.searchParams.get("t");
        const json = { "Content-Type": "application/json", "X-MR-Token": token };

        const page = await request(port, { pathName: "/" });
        assert.equal(page.status, 200);
        assert.match(page.text, /app\.js/);
        assert.equal((await request(port, { pathName: "/app.js" })).status, 200);
        assert.equal((await request(port, { pathName: "/../extension.mjs" })).status, 404);

        assert.equal((await request(port, { pathName: "/api/state" })).status, 403);
        assert.equal((await request(port, { pathName: "/api/state?t=wrong" })).status, 403);
        assert.equal((await request(port, { pathName: `/api/state?t=${token}`, headers: { Host: "evil.example:80" } })).status, 421);
        const state = await request(port, { pathName: `/api/state?t=${token}` });
        assert.equal(state.status, 200);
        assert.equal(state.json.review.reviewId, reviewId);

        const snap = await request(port, { pathName: `/api/snapshot/${state.json.review.currentRevisionId}?t=${token}` });
        assert.equal(snap.status, 200);
        assert.ok(Array.isArray(snap.json.files));
        assert.equal((await request(port, { pathName: `/api/snapshot/..%2f..%2fx?t=${token}` })).status >= 400, true);

        const contentPath = `/api/content/${state.json.review.currentRevisionId}?path=a.cs`;
        assert.equal((await request(port, { pathName: contentPath })).status, 403);
        const content = await request(port, { pathName: `${contentPath}&t=${token}` });
        assert.equal(content.status, 200);
        assert.equal(content.json.available, true);
        assert.equal(content.json.lines[9], "line 10 REWRITTEN");
        assert.equal((await request(port, { pathName: `/api/content/${state.json.review.currentRevisionId}?path=..%2Foutside.txt&t=${token}` })).status >= 400, true);

        assert.equal((await request(port, { method: "POST", pathName: `/api/threads?t=${token}`, headers: { "Content-Type": "application/json" }, body: { kind: "overview", body: "x" } })).status, 403, "POST needs the header token");
        assert.equal((await request(port, { method: "POST", pathName: "/api/threads", headers: { ...json, Origin: "http://evil.example" }, body: { kind: "overview", body: "x" } })).status, 403);
        assert.equal((await request(port, { method: "POST", pathName: "/api/threads", headers: { ...json, "Content-Type": "text/plain" }, body: "{}" })).status, 415);
        assert.equal((await request(port, { method: "POST", pathName: "/api/threads", headers: json, body: { kind: "line", path: "a.cs", startLine: -1, body: "x" } })).status, 400);

        const before = sent.length;
        const posted = await request(port, { method: "POST", pathName: "/api/threads", headers: { ...json, Origin: `http://127.0.0.1:${port}` }, body: { kind: "file", path: "notes.md", body: "Is this file needed?", clientRequestId: "http-1" } });
        assert.equal(posted.status, 200);
        await waitFor(async () => (await deliveryState(posted.json.messageId)) === "queued", "HTTP comment delivery");
        assert.equal(sent.length, before + 1);
        assert.match(sent.at(-1).prompt, /file notes\.md/);

        const again = await request(port, { method: "POST", pathName: "/api/threads", headers: json, body: { kind: "file", path: "notes.md", body: "Is this file needed?", clientRequestId: "http-1" } });
        assert.equal(again.json.duplicate, true);
        assert.equal(sent.length, before + 1, "duplicate submit is not re-delivered");

        const reply = await request(port, { method: "POST", pathName: `/api/threads/${posted.json.threadId}/messages`, headers: json, body: { body: "Follow-up" } });
        assert.equal(reply.status, 200);
        await waitFor(() => sent.length === before + 2, "reply delivery");
        assert.match(sent.at(-1).prompt, /Earlier messages in this thread/);

        const status = await request(port, { method: "POST", pathName: `/api/threads/${posted.json.threadId}/status`, headers: json, body: { status: "resolved" } });
        assert.deepEqual(status.json, { threadId: posted.json.threadId, status: "resolved" });

        const events = await new Promise((resolve, reject) => {
            const req = http.get({ host: "127.0.0.1", port, path: `/api/events?t=${token}` }, (res) => {
                let buf = "";
                res.on("data", (c) => {
                    buf += c;
                    if (buf.includes("event: changed")) {
                        req.destroy();
                        resolve(buf);
                    }
                });
            });
            req.on("error", (e) => (e.code === "ECONNRESET" ? null : reject(e)));
            setTimeout(() => service.changed(reviewId, "test"), 100);
        });
        assert.match(events, /event: hello/);
        assert.match(events, /"reason":"test"/);
    } finally {
        await server.close();
    }
});

test("editing a web asset broadcasts 'assets' to open pages; serving the files does not", async () => {
    const webCopy = path.join(tmp, "web-copy");
    await cp(WEB_ROOT, webCopy, { recursive: true });
    const server = await startReviewServer({ instanceId: "inst-assets", getReviewId: () => reviewId, service, delivery, webRoot: webCopy });
    let req;
    try {
        const url = new URL(server.url);
        const port = Number(url.port);
        let seen = "";
        req = http.get({ host: "127.0.0.1", port, path: `/api/events?t=${url.searchParams.get("t")}` }, (res) => res.on("data", (c) => (seen += c)));
        req.on("error", () => {});
        await waitFor(() => seen.includes("event: hello"), "SSE hello");

        for (const asset of ["/", "/app.js", "/styles.css"]) await request(port, { pathName: asset });
        await new Promise((r) => setTimeout(r, 700));
        assert.doesNotMatch(seen, /event: assets/, "reads of the assets are not changes");

        await appendFile(path.join(webCopy, "app.js"), "\n// edited\n");
        await waitFor(() => /event: assets/.test(seen), "assets event after an edit");
    } finally {
        req?.destroy();
        await server.close();
    }
});

test("review data never leaves the data root and the repo is untouched", async () => {
    const status = await runGit(repo, ["status", "--porcelain"]);
    assert.doesNotMatch(status.stdout, /\.copilot|review\.json/);
    const review = JSON.parse(await readFile(store.reviewFile(reviewId), "utf8"));
    assert.equal(review.reviewId, reviewId);
});

test("descriptions persist across reopen, reject stale updates, and are captured with overview comments", async () => {
    assert.equal(service.summarize(await service.getReview(reviewId)).description, null, "old reviews need no migration");
    const events = [];
    const listener = (e) => events.push(e);
    service.on("changed", listener);
    try {
        const first = await service.updateDescription(reviewId, { expectedVersion: 0, body: "## Purpose\n\nExplain the change." });
        assert.equal(first.version, 1);
        assert.equal(first.revisionId, (await service.getReview(reviewId)).currentRevisionId);
        assert.equal(events.at(-1).reason, "description");
        const reopened = new ReviewService({ store: new Store(path.join(tmp, "data")) });
        await reopened.ensureReview({ reviewId });
        assert.deepEqual((await reopened.getReview(reviewId)).description, first);
        const { thread, message } = await service.createThread(reviewId, { kind: "overview", body: "Revise this description", descriptionVersion: 1 });
        assert.deepEqual(message.descriptionContext, first);
        const updates = await Promise.allSettled([
            service.updateDescription(reviewId, { expectedVersion: 1, body: "## Purpose\n\nSecond version." }),
            service.updateDescription(reviewId, { expectedVersion: 1, body: "Concurrent edit." }),
        ]);
        assert.equal(updates.filter((r) => r.status === "fulfilled").length, 1);
        assert.equal(updates.find((r) => r.status === "rejected").reason.code, "conflict");
        assert.equal((await service.findMessage(reviewId, message.messageId)).message.descriptionContext.body, first.body);
        await assert.rejects(() => service.createThread(reviewId, { kind: "overview", body: "Stale comment", descriptionVersion: 1 }), (e) => e.code === "conflict");
        await assert.rejects(() => service.addMessage(reviewId, thread.threadId, { body: "Stale reply", descriptionVersion: 1 }), (e) => e.code === "conflict");
        for (const body of ["", "x".repeat(20001)]) {
            await assert.rejects(() => service.updateDescription(reviewId, { expectedVersion: 2, body }), (e) => e.code === "invalid_input");
        }
        await service.addMessage(reviewId, thread.threadId, { author: "agent", inReplyTo: message.messageId, body: "Updated.", outcome: "changed" });
        await service.setThreadStatus(reviewId, thread.threadId, "resolved");
        const reply = await service.addMessage(reviewId, thread.threadId, { body: "One more point", descriptionVersion: 2 });
        assert.equal(reply.thread.status, "active", "user follow-up reopens a resolved thread");
        assert.equal(reply.message.descriptionContext.version, 2);
    } finally {
        service.off("changed", listener);
    }
});
