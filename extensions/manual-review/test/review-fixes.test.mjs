import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../lib/store.mjs";
import { ReviewService } from "../lib/review-service.mjs";
import { Delivery } from "../lib/delivery.mjs";
import { parseUnifiedDiff } from "../lib/diff.mjs";
import { relocate } from "../lib/anchors.mjs";
import { captureSnapshot, readWorkingFile, runGit } from "../lib/git.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (cwd, ...args) => runGit(cwd, ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args]);

async function temporary(t) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mr-review-fixes-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return dir;
}

async function fixture(t, branch = "main") {
    const dir = await temporary(t);
    const repo = path.join(dir, "repo");
    await git(dir, "init", "-q", "-b", branch, repo);
    const original = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await writeFile(path.join(repo, "a.txt"), original);
    await git(repo, "add", "a.txt");
    await git(repo, "commit", "-q", "-m", "base");
    const text = original.replace("line 5\n", "line 5 edited\n");
    await writeFile(path.join(repo, "a.txt"), text);
    const store = new Store(path.join(dir, "data"));
    return { dir, repo, text, store, service: new ReviewService({ store }) };
}

test("quoted diff headers identify binary, empty, mode-only and mixed quoted paths without text headers", () => {
    const fixtures = [
        ['"a/tab\\tfile.png" "b/tab\\tfile.png"', "Binary files differ", "tab\tfile.png", "tab\tfile.png"],
        ['"a/new\\nfile" "b/new\\nfile"', "new file mode 100644", null, "new\nfile"],
        ['"a/q\\"uote" "b/q\\"uote"', "old mode 100644\nnew mode 100755", 'q"uote', 'q"uote'],
        ['"a/literal\\\\t" "b/literal\\\\t"', "old mode 100644\nnew mode 100755", "literal\\t", "literal\\t"],
        ['"a/caf\\303\\251" "b/caf\\303\\251"', "new file mode 100644", null, "caf\u00e9"],
        ['"a/old\\tname" b/new name', "similarity index 100%", "old\tname", "new name"],
        ['a/old name "b/new\\tname"', "similarity index 100%", "old name", "new\tname"],
        ['"a/cr\\rname" "b/cr\\rname"', "deleted file mode 100644", "cr\rname", "cr\rname"],
    ];
    for (const [header, body, oldPath, filePath] of fixtures) {
        const [file] = parseUnifiedDiff(`diff --git ${header}\n${body}\n`);
        assert.deepEqual([file.oldPath, file.path], [oldPath, filePath]);
    }
});

test("anchor fallback preserves spaces inside literals and between tokens", () => {
    const anchor = { startLine: 1, endLine: 1, selectedLines: ['const key = "a b";'] };
    assert.equal(relocate(anchor, 1, ['const key = "ab";']).state, "outdated");
    assert.equal(relocate(anchor, 1, ['  const key = "a b"; \t']).state, "current");
    assert.equal(relocate({ ...anchor, selectedLines: ["return value;"] }, 1, ["returnvalue;"]).state, "outdated");
});

test("separate provider processes preserve review, settings, lesson and instance updates", { timeout: 30000 }, async (t) => {
    const dir = await temporary(t);
    const store = new Store(dir);
    await store.updateReview("shared", () => ({ review: { values: [] } }));
    const source = `
        import { Store } from ${JSON.stringify(new URL("../lib/store.mjs", import.meta.url).href)};
        const store = new Store(process.argv[1]);
        const worker = process.argv[2];
        const delay = () => new Promise(r => setTimeout(r, 10));
        process.once("message", async () => {
            try {
                for (let i = 0; i < 8; i++) {
                    const id = worker + "-" + i;
                    await store.updateReview("shared", async r => { await delay(); r.values.push(id); return { review: r }; });
                    await store.updateSettings(async s => { await delay(); s.repos[id] = { learning: "suggest" }; });
                    await store.setInstanceReview(id, "shared");
                    await store.appendLesson({ lessonId: id });
                }
                process.disconnect();
            } catch (e) { console.error(e); process.exit(1); }
        });
        process.send("ready");
    `;
    const workers = Array.from({ length: 4 }, (_, n) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", source, dir, String(n)], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        const ready = new Promise((resolve, reject) => {
            child.once("message", resolve);
            child.once("error", reject);
            child.once("exit", () => reject(new Error(`Worker exited before ready: ${stderr}`)));
        });
        const done = new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Worker failed (${code}): ${stderr}`)));
        });
        t.after(() => { if (child.exitCode === null) child.kill(); });
        return { child, ready, done };
    });
    const finished = Promise.all(workers.map((worker) => worker.done));
    await Promise.all(workers.map((worker) => worker.ready));
    workers.forEach((worker) => worker.child.send("go"));
    await finished;
    assert.equal(new Set((await store.readReview("shared")).values).size, 32);
    assert.equal(Object.keys((await store.readSettings()).repos).length, 32);
    assert.equal(Object.keys(JSON.parse(await readFile(path.join(dir, "instances.json"), "utf8"))).length, 32);
    assert.equal((await store.readLessons()).length, 32);
    assert.deepEqual(await readdir(path.join(dir, "locks")), []);
});

test("failed store mutations release their cross-process lock without committing partial state", async (t) => {
    const dir = await temporary(t);
    const first = new Store(dir);
    const second = new Store(dir);
    await assert.rejects(first.updateSettings((settings) => {
        settings.repos.lost = {};
        throw new Error("cancel update");
    }), /cancel update/);
    await second.updateSettings((settings) => { settings.repos.kept = {}; });
    assert.deepEqual(Object.keys((await first.readSettings()).repos), ["kept"]);
    assert.deepEqual(await readdir(path.join(dir, "locks")), []);
});

test("an abandoned store lock fails explicitly instead of stealing ownership", { timeout: 15000 }, async (t) => {
    const dir = await temporary(t);
    await mkdir(path.join(dir, "locks"));
    const lockFile = path.join(dir, "locks", `${createHash("sha256").update("settings").digest("hex")}.lock`);
    const owner = JSON.stringify({ pid: 123, key: "settings", createdAt: "2000-01-01T00:00:00Z" });
    await writeFile(lockFile, owner);
    await assert.rejects(new Store(dir).updateSettings(() => assert.fail("must not mutate")), /stop all manual-review providers before removing this lock/);
    assert.equal(await readFile(lockFile, "utf8"), owner);
});

test("pending reviews need no inferred comparison base, and explicit All changes switching keeps sibling identity", async (t) => {
    const { repo, service } = await fixture(t, "trunk");
    const pending = await service.ensureReview({ repoPath: repo, scope: "pending" });
    assert.equal((await service.getReview(pending)).base, null);
    const snapshot = await service.getSnapshot(pending);
    assert.equal(snapshot.baseCommit, snapshot.headCommit);
    await assert.rejects(service.openSibling(pending, "all"), /pass input.base explicitly/);
    const all = await service.ensureReview({ reviewId: pending, scope: "all", base: "trunk" });
    assert.equal((await service.getReview(all)).title, "trunk vs trunk");
    assert.equal(await service.openSibling(all, "pending"), pending);
    assert.equal(await service.openSibling(pending, "all"), all);
});

test("pending reviews resolve a default comparison base only when switching to All changes", async (t) => {
    const { repo, service } = await fixture(t);
    const pending = await service.ensureReview({ repoPath: repo, scope: "pending" });
    assert.equal((await service.getReview(pending)).base, null);
    const all = await service.openSibling(pending, "all");
    assert.equal((await service.getReview(all)).base, "main");
    assert.equal(await service.openSibling(all, "pending"), pending);
});

test("reopening applies explicit capture options and retains unspecified ones", async (t) => {
    const { repo, service } = await fixture(t);
    await writeFile(path.join(repo, "untracked.txt"), "untracked\n");
    const input = { repoPath: repo, base: "main" };
    const id = await service.ensureReview(input);
    assert.equal((await service.getSnapshot(id)).files.length, 2);
    await service.createThread(id, { kind: "overview", body: "Keep my thread" });
    assert.equal(await service.ensureReview({ ...input, includeUntracked: false, context: 0 }), id);
    let snapshot = await service.getSnapshot(id);
    assert.equal(snapshot.files.length, 1);
    assert.equal(snapshot.files[0].hunks[0].rows.length, 2);
    await service.ensureReview(input);
    assert.deepEqual([(await service.getReview(id)).includeUntracked, (await service.getReview(id)).contextLines], [false, 0]);
    await service.ensureReview({ reviewId: id, includeUntracked: true, context: 2 });
    snapshot = await service.getSnapshot(id);
    assert.equal(snapshot.files.length, 2);
    assert.equal(snapshot.files[0].hunks[0].rows.length, 6);
    assert.equal((await service.getReview(id)).threads.length, 1);
});

test("out-of-hunk selections and prompt context reject changed working files instead of labeling live text as saved", async (t) => {
    const { repo, text, service } = await fixture(t);
    const id = await service.ensureReview({ repoPath: repo, base: "main", context: 0 });
    const input = { kind: "line", path: "a.txt", side: "new", startLine: 50, endLine: 51, revisionId: "r1", body: "Explain these lines" };
    const { thread, message } = await service.createThread(id, input);
    assert.deepEqual(thread.anchor.selectedLines, ["line 50", "line 51"]);
    assert.deepEqual((await service.promptContext(id, thread.threadId)).selected, ["line 50", "line 51"]);
    await writeFile(path.join(repo, "a.txt"), "inserted\n" + text);
    await assert.rejects(service.createThread(id, input), (e) => e.code === "conflict");
    await assert.rejects(service.promptContext(id, thread.threadId), (e) => e.code === "conflict");
    const sent = [];
    const delivery = new Delivery({ service, send: async (options) => { sent.push(options); return "sm"; } });
    assert.equal((await delivery.deliver(id, thread.threadId, message.messageId, "inst")).delivered, false);
    assert.equal(sent.length, 0);
    assert.equal((await service.findMessage(id, message.messageId)).message.delivery.state, "failed");
    const captured = await service.createThread(id, { ...input, startLine: 5, endLine: 5 });
    assert.deepEqual(captured.thread.anchor.selectedLines, ["line 5 edited"], "saved hunk text remains usable");
    const old = await service.createThread(id, { ...input, side: "old" });
    assert.deepEqual(old.thread.anchor.selectedLines, ["line 50", "line 51"], "the committed old side is immutable");
    await service.refresh(id);
    assert.deepEqual((await service.promptContext(id, thread.threadId)).selected, ["line 50", "line 51"]);
    assert.equal((await delivery.deliver(id, thread.threadId, message.messageId, "inst", { retry: true })).delivered, true);
    await assert.rejects(service.createThread(id, input), (e) => e.code === "conflict");
});

test("concurrent deliveries and retries claim one send, and stale retries do not reset active or replied messages", async (t) => {
    const { repo, store, service } = await fixture(t);
    const id = await service.ensureReview({ repoPath: repo, base: "main" });
    const { thread, message } = await service.createThread(id, { kind: "overview", body: "Review this" });
    let sends = 0;
    const send = async () => { const n = ++sends; await delay(50); return `sm-${n}`; };
    const first = new Delivery({ service, send });
    const second = new Delivery({ service: new ReviewService({ store: new Store(store.root) }), send });
    const args = [id, thread.threadId, message.messageId, "inst"];
    const calls = Array.from({ length: 10 }, (_, i) => (i % 2 ? first : second).deliver(...args));
    await Promise.all(calls);
    assert.equal(sends, 1);
    await service.setDelivery(id, message.messageId, { state: "processing" });
    assert.equal(await service.setDelivery(id, message.messageId, { state: "failed" }), false, "late transport failures cannot reset an already processing message");
    await first.deliver(...args, { retry: true });
    assert.equal((await service.findMessage(id, message.messageId)).message.delivery.state, "processing");
    await service.settleProcessing(id);
    const oldAttempt = (await service.findMessage(id, message.messageId)).message.delivery.attemptId;
    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? first : second).deliver(...args, { retry: true })));
    assert.equal(sends, 2);
    assert.equal((await service.findMessage(id, message.messageId)).message.delivery.attempts, 2);
    assert.equal(await service.setDelivery(id, message.messageId, { state: "failed" }, { attemptId: oldAttempt }), false);
    await service.addMessage(id, thread.threadId, { author: "agent", body: "Answered", inReplyTo: message.messageId });
    await Promise.all([first.deliver(...args, { retry: true }), second.deliver(...args, { retry: true })]);
    assert.equal(sends, 2);
    assert.equal((await service.findMessage(id, message.messageId)).message.delivery.state, "replied");
});

test("failed sends can be retried once without coalescing away a later attempt", async (t) => {
    const { repo, service } = await fixture(t);
    const id = await service.ensureReview({ repoPath: repo, base: "main" });
    const { thread, message } = await service.createThread(id, { kind: "overview", body: "Retry me" });
    let attempts = 0;
    const delivery = new Delivery({ service, send: async () => {
        if (++attempts === 1) throw new Error("transport unavailable");
        return "sm-retry";
    } });
    const args = [id, thread.threadId, message.messageId, "inst"];
    const first = delivery.deliver(...args);
    assert.equal(delivery.deliver(...args, { retry: true }), first, "same-provider callers share the in-flight promise");
    assert.deepEqual(await first, { delivered: false, error: "transport unavailable" });
    assert.equal((await service.findMessage(id, message.messageId)).message.delivery.state, "failed");
    assert.equal((await delivery.deliver(...args, { retry: true })).delivered, true);
    assert.equal(attempts, 2);
    assert.equal((await service.findMessage(id, message.messageId)).message.delivery.attempts, 2);
});

test("symlink contents are target text, including broken and external links", async (t) => {
    const { dir, repo } = await fixture(t);
    const secret = path.join(dir, "external.txt");
    await writeFile(secret, "must never enter the review");
    try {
        await symlink(secret, path.join(repo, "external-link"), "file");
    } catch (err) {
        if (err.code === "EPERM") { t.skip("File symlink creation requires Windows Developer Mode or administrator rights."); return; }
        throw err;
    }
    await symlink(path.join(dir, "missing.txt"), path.join(repo, "broken-link"), "file");
    const snapshot = await captureSnapshot({ repoRoot: repo, base: "main" });
    assert.equal(snapshot.files.find((f) => f.path === "external-link").hunks[0].rows[0].s, secret);
    assert.doesNotMatch(JSON.stringify(snapshot), /must never enter the review/);
    assert.deepEqual(await readWorkingFile(repo, "external-link"), [secret]);
    assert.deepEqual(await readWorkingFile(repo, "broken-link"), [path.join(dir, "missing.txt")]);
});

test("working-file reads reject paths through escaping directory links and allow contained links", async (t) => {
    const { dir, repo } = await fixture(t);
    const outside = path.join(dir, "outside");
    const inside = path.join(repo, "inside");
    await mkdir(outside);
    await mkdir(inside);
    await writeFile(path.join(outside, "secret.txt"), "external secret");
    await writeFile(path.join(inside, "safe.txt"), "safe");
    await symlink(outside, path.join(repo, "escape"), process.platform === "win32" ? "junction" : "dir");
    await symlink(inside, path.join(repo, "contained"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(readWorkingFile(repo, "escape/secret.txt"), /escapes repository/);
    assert.deepEqual(await readWorkingFile(repo, "contained/safe.txt"), ["safe"]);
    await assert.rejects(readWorkingFile(repo, "../outside/secret.txt"), /escapes repository/);
});
