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
import { hunkExcerpt, parseUnifiedDiff } from "../lib/diff.mjs";
import { normalizeRemoteUrl, SettingsService } from "../lib/settings.mjs";
import { relocate } from "../lib/anchors.mjs";
import { captureSnapshot, readWorkingFile, runGit, safeJoin } from "../lib/git.mjs";

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
    await assert.rejects(new Store(dir).updateSettings(() => assert.fail("must not mutate")), /stop all self-review providers before removing this lock/);
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

test("safeJoin accepts names that start with two dots and rejects parent traversal", async (t) => {
    const dir = await temporary(t);
    assert.equal(safeJoin(dir, "..notes"), path.join(dir, "..notes"));
    assert.equal(safeJoin(dir, "docs/..draft.md"), path.join(dir, "docs", "..draft.md"));
    for (const bad of ["..", "../x", "a/../../x"]) assert.throws(() => safeJoin(dir, bad), /escapes repository/, bad);
});

test("diff paths parse the same whatever the diff prefix settings, and a file named ..notes is reviewable", async (t) => {
    const { repo } = await fixture(t);
    await writeFile(path.join(repo, "..notes"), "kept inside the repository\n");
    for (const key of ["diff.mnemonicPrefix", "diff.noprefix"]) {
        await git(repo, "config", key, "true");
        const snapshot = await captureSnapshot({ repoRoot: repo, base: "main" });
        assert.deepEqual(snapshot.files.map((f) => f.path).sort(), ["..notes", "a.txt"], key);
        assert.ok(snapshot.files.find((f) => f.path === "a.txt").hunks.length > 0, key);
    }
});

test("going idle settles only the comments this conversation was processing", async (t) => {
    const { repo, store, service } = await fixture(t);
    const id = await service.ensureReview({ repoPath: repo, base: "main" });
    const mine = await service.createThread(id, { kind: "overview", body: "Mine" });
    const theirs = await service.createThread(id, { kind: "overview", body: "Theirs" });
    let n = 0;
    const send = async () => `sm-${++n}`;
    const a = new Delivery({ service, send, sessionId: () => "session-a" });
    const b = new Delivery({ service: new ReviewService({ store: new Store(store.root) }), send, sessionId: () => "session-b" });
    const sentA = await a.deliver(id, mine.thread.threadId, mine.message.messageId, "inst");
    const sentB = await b.deliver(id, theirs.thread.threadId, theirs.message.messageId, "inst");
    await a.onUserMessage({ data: { messageId: sentA.sessionMessageId } });
    await b.onUserMessage({ data: { messageId: sentB.sessionMessageId } });
    const delivery = async (m) => (await service.findMessage(id, m.message.messageId)).message.delivery;
    assert.equal((await delivery(mine)).processedBy, "session-a");
    assert.equal((await delivery(theirs)).processedBy, "session-b");

    await a.onIdle();
    assert.equal((await delivery(mine)).state, "no-reply");
    assert.equal((await delivery(theirs)).state, "processing", "another conversation's turn may still be running");
    await b.onIdle();
    assert.equal((await delivery(theirs)).state, "no-reply");
});

test("a comment claimed by a provider that stopped can be resent, and live claims are left alone", async (t) => {
    const { repo, store, service } = await fixture(t);
    const stopped = new ReviewService({ store: new Store(store.root), pid: 999999 });
    const id = await stopped.ensureReview({ repoPath: repo, base: "main" });
    const orphan = await stopped.createThread(id, { kind: "overview", body: "Claimed by a provider that crashed" });
    const live = await service.createThread(id, { kind: "overview", body: "Still being sent" });
    assert.equal(orphan.message.delivery.claimPid, 999999);
    assert.equal(live.message.delivery.claimPid, process.pid);

    const checker = new ReviewService({ store: new Store(store.root), pid: 4242, isProcessAlive: (pid) => pid !== 999999 });
    assert.deepEqual(await checker.recoverAbandonedClaims(id), [orphan.message.messageId]);
    const delivery = async (m) => (await service.findMessage(id, m.message.messageId)).message.delivery;
    assert.equal((await delivery(orphan)).state, "failed");
    assert.match((await delivery(orphan)).error, /Resend it/);
    assert.equal((await delivery(live)).state, "saving", "a running provider keeps its claim");
    assert.deepEqual(await service.recoverAbandonedClaims(id), [], "this provider never recovers its own claims");

    const sent = [];
    const resend = new Delivery({ service, send: async (options) => { sent.push(options); return "sm-resend"; } });
    assert.equal((await resend.deliver(id, orphan.thread.threadId, orphan.message.messageId, "inst", { retry: true })).delivered, true);
    assert.equal(sent.length, 1);
    assert.equal((await delivery(orphan)).state, "queued");
});

test("a comment whose turn ends before send() returns settles instead of staying processing", async (t) => {
    const { repo, service } = await fixture(t);
    const id = await service.ensureReview({ repoPath: repo, base: "main" });
    const early = await service.createThread(id, { kind: "overview", body: "Answered before send returned" });
    const running = await service.createThread(id, { kind: "overview", body: "Still running when send returned" });
    const state = async (m) => (await service.findMessage(id, m.message.messageId)).message.delivery.state;
    let finishTurn = false;
    const delivery = new Delivery({ service, send: async () => {
        const sessionMessageId = finishTurn ? "sm-early" : "sm-running";
        // The turn starts, with no marker the provider can match, before send() resolves.
        await delivery.onUserMessage({ data: { messageId: sessionMessageId } });
        if (finishTurn) await delivery.onIdle();
        return sessionMessageId;
    } });

    finishTurn = true;
    assert.equal((await delivery.deliver(id, early.thread.threadId, early.message.messageId, "inst")).delivered, true);
    assert.equal(await state(early), "no-reply", "a finished turn is not reported as still running");

    finishTurn = false;
    await delivery.deliver(id, running.thread.threadId, running.message.messageId, "inst");
    assert.equal(await state(running), "processing");
    await delivery.onIdle();
    assert.equal(await state(running), "no-reply");
    assert.equal(delivery.seenSessionMessageIds.size, 0);
});

test("unquoted diff headers split at the matching side when a path contains ' b/'", async (t) => {
    const [binary] = parseUnifiedDiff("diff --git a/x b/y.bin b/x b/y.bin\nindex 1111111..2222222 100644\nBinary files a/x b/y.bin and b/x b/y.bin differ\n");
    assert.deepEqual([binary.oldPath, binary.path, binary.binary], ["x b/y.bin", "x b/y.bin", true]);
    const [mode] = parseUnifiedDiff("diff --git a/dir b/file b/dir b/file\nold mode 100644\nnew mode 100755\n");
    assert.deepEqual([mode.oldPath, mode.path], ["dir b/file", "dir b/file"]);

    const { repo } = await fixture(t);
    await mkdir(path.join(repo, "x b"));
    await writeFile(path.join(repo, "x b", "y.bin"), Buffer.from([0, 1, 2]));
    await git(repo, "add", "x b/y.bin");
    await git(repo, "commit", "-q", "-m", "binary");
    await writeFile(path.join(repo, "x b", "y.bin"), Buffer.from([0, 1, 3]));
    const snapshot = await captureSnapshot({ repoRoot: repo, base: "HEAD", scope: "pending" });
    const file = snapshot.files.find((f) => f.binary);
    assert.deepEqual([file?.oldPath, file?.path], ["x b/y.bin", "x b/y.bin"]);
});

test("snapshots show a file's real content even when a textconv driver is configured", async (t) => {
    const { dir, repo } = await fixture(t);
    const script = path.join(dir, "upper.mjs");
    await writeFile(script, 'import { readFileSync } from "node:fs";\nprocess.stdout.write(readFileSync(process.argv[2], "utf8").toUpperCase());\n');
    const slash = (p) => p.replaceAll("\\", "/");
    await git(repo, "config", "diff.upper.textconv", `"${slash(process.execPath)}" "${slash(script)}"`);
    await writeFile(path.join(repo, ".git", "info", "attributes"), "*.txt diff=upper\n");
    assert.match((await git(repo, "diff", "main")).stdout, /LINE 5 EDITED/, "the driver is active for a plain git diff");

    const snapshot = await captureSnapshot({ repoRoot: repo, base: "main" });
    const rows = snapshot.files.find((f) => f.path === "a.txt").hunks.flatMap((h) => h.rows);
    assert.ok(rows.some((r) => r.t === "add" && r.s === "line 5 edited"));
    assert.ok(!rows.some((r) => /LINE/.test(r.s)));
});

test("the snapshot fingerprint changes when an untracked file becomes binary or too large", async (t) => {
    const { repo } = await fixture(t);
    const file = path.join(repo, "new.dat");
    const fingerprint = async () => (await captureSnapshot({ repoRoot: repo, base: "main" })).fingerprint;
    await writeFile(file, "");
    const empty = await fingerprint();
    await writeFile(file, Buffer.from([0, 1, 2]));
    const binary = await fingerprint();
    await writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    const tooLarge = await fingerprint();
    assert.equal(new Set([empty, binary, tooLarge]).size, 3);
});

test("quoted and forged delivery markers cannot release drafts or transfer another session's attempt", async (t) => {
    const { repo, store, service } = await fixture(t);
    const id = await service.ensureReview({ repoPath: repo, base: "main" });
    const draft = await service.createThread(id, { kind: "overview", body: "Private draft", hold: true });
    const sent = await service.createThread(id, { kind: "overview", body: "Submitted comment" });
    const marker = (m) => `[self-review sr:${id}:${m.message.messageId}]`;
    const a = new Delivery({ service, sessionId: () => "a", send: async () => "transport-a" });
    await a.deliver(id, sent.thread.threadId, sent.message.messageId, "inst");
    const b = new Delivery({ service, sessionId: () => "b", send: async () => "transport-b" });
    await a.onUserMessage({ data: { messageId: "quote", content: `Quoted log:\n${marker(draft)}\n${marker(sent)}` } });
    await a.onUserMessage({ data: { messageId: "forged", content: marker(draft) } });
    await b.onUserMessage({ data: { messageId: "transport-a", content: marker(sent) } });
    const state = async (m) => (await service.findMessage(id, m.message.messageId)).message.delivery;
    assert.equal((await state(draft)).state, "draft");
    assert.equal((await state(sent)).state, "queued");
    assert.doesNotMatch(JSON.stringify(service.summarize(await service.getReview(id))), /Private draft/);

    // A restarted provider can recognize only its own persisted transport and current attempt.
    const resumed = new Delivery({ service: new ReviewService({ store: new Store(store.root) }), sessionId: () => "a", send: async () => "unused" });
    await resumed.onUserMessage({ data: { messageId: "wrong-transport", content: marker(sent) } });
    assert.equal((await state(sent)).state, "queued");
    await resumed.onUserMessage({ data: { messageId: "transport-a", content: marker(sent) } });
    assert.equal((await state(sent)).processedBy, "a");
    await b.onUserMessage({ data: { messageId: "transport-a", content: marker(sent) } });
    assert.equal((await state(sent)).processedBy, "a");
    await resumed.onIdle();
    const oldAttempt = (await state(sent)).attemptId;
    await service.claimDelivery(id, sent.thread.threadId, sent.message.messageId, { retry: true, senderSessionId: "a" });
    assert.equal(await service.processDelivery(id, sent.message.messageId, { attemptId: oldAttempt, sessionMessageId: "transport-a", sessionId: "a" }), false);
    await resumed.onUserMessage({ data: { messageId: "transport-a", content: marker(sent) } });
    assert.equal((await state(sent)).state, "saving", "an old marker cannot process a new attempt");
});

test("legacy queued attempts require their exact transport event to establish the processing owner", async (t) => {
    const { repo, store, service } = await fixture(t);
    const id = await service.ensureReview({ repoPath: repo, base: "main" });
    const { thread, message } = await service.createThread(id, { kind: "overview", body: "Sent before upgrading" });
    const claim = await service.claimDelivery(id, thread.threadId, message.messageId);
    await service.setDelivery(id, message.messageId, { state: "queued", sessionMessageId: "legacy" }, claim);
    const delivery = new Delivery({ service: new ReviewService({ store }), sessionId: () => "owner", send: async () => "unused" });
    const content = `[self-review sr:${id}:${message.messageId}]`;
    await delivery.onUserMessage({ data: { messageId: "quoted", content } });
    assert.equal((await service.findMessage(id, message.messageId)).message.delivery.state, "queued");
    await delivery.onUserMessage({ data: { messageId: "legacy", content } });
    await delivery.onIdle();
    assert.equal((await service.findMessage(id, message.messageId)).message.delivery.state, "no-reply");
});

test("a provider restarted after the rename recognizes markers sent as manual-review", async (t) => {
    const { store, service, repo } = await fixture(t);
    const id = await service.ensureReview({ repoPath: repo, base: "main" });
    const { thread, message } = await service.createThread(id, { kind: "overview", body: "Sent before the rename" });
    await new Delivery({ service, sessionId: () => "a", send: async () => "transport-a" }).deliver(id, thread.threadId, message.messageId, "inst");
    const resumed = new Delivery({ service: new ReviewService({ store: new Store(store.root) }), sessionId: () => "a", send: async () => "unused" });
    await resumed.onUserMessage({ data: { messageId: "transport-a", content: `[manual-review mr:${id}:${message.messageId}]` } });
    const delivery = (await service.findMessage(id, message.messageId)).message.delivery;
    assert.equal(delivery.state, "processing");
    assert.equal(delivery.processedBy, "a");
});

test("idle waits for every preceding batch processing update, including delayed persistence", async (t) => {
    const { repo, service } = await fixture(t);
    const id = await service.ensureReview({ repoPath: repo, base: "main" });
    const comments = [];
    for (let i = 0; i < 3; i++) comments.push(await service.createThread(id, { kind: "overview", body: `Comment ${i}`, hold: true }));
    const delivery = new Delivery({ service, send: async () => "batch", sessionId: () => "owner" });
    await delivery.submit(id, "inst");
    let release, reached;
    const paused = new Promise((resolve) => { reached = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const processDelivery = service.processDelivery.bind(service);
    let calls = 0;
    service.processDelivery = async (...args) => {
        const result = await processDelivery(...args);
        if (++calls === 1) { reached(); await gate; }
        return result;
    };
    const processing = delivery.onUserMessage({ data: { messageId: "batch" } });
    await paused;
    const idle = delivery.onIdle();
    release();
    await Promise.all([processing, idle]);
    for (const c of comments) {
        assert.equal((await service.findMessage(id, c.message.messageId)).message.delivery.state, "no-reply");
    }
});

test("newline-only changes retain the affected row in snapshots, excerpts and full-file validation", async (t) => {
    const { repo, service } = await fixture(t);
    await writeFile(path.join(repo, "eof.txt"), "same");
    await git(repo, "add", "eof.txt");
    await git(repo, "commit", "-q", "-m", "without newline");
    await writeFile(path.join(repo, "eof.txt"), "same\n");
    const id = await service.ensureReview({ repoPath: repo, base: "main" });
    const snapshot = await service.store.readSnapshot(id, "r1");
    const file = snapshot.files.find((f) => f.path === "eof.txt");
    assert.deepEqual(file.hunks[0].rows.map((r) => [r.t, r.s, !!r.noNewlineAtEnd]), [["del", "same", true], ["add", "same", false]]);
    assert.match(hunkExcerpt(file, "new", 1, 1).text, /-same\n\\ No newline at end of file\n\+same/);
    assert.equal((await service.getFileContent(id, "r1", "eof.txt")).available, true);
    await writeFile(path.join(repo, "eof.txt"), "same");
    assert.equal((await service.getFileContent(id, "r1", "eof.txt")).reason, "stale");
    await writeFile(path.join(repo, "eof.txt"), "same\n");
    await git(repo, "add", "eof.txt");
    await git(repo, "commit", "-q", "-m", "with newline");
    await writeFile(path.join(repo, "eof.txt"), "same");
    const removed = (await captureSnapshot({ repoRoot: repo, scope: "pending" })).files.find((f) => f.path === "eof.txt");
    assert.deepEqual(removed.hunks[0].rows.map((r) => [r.t, !!r.noNewlineAtEnd]), [["del", false], ["add", true]]);
});

test("file-to-symlink replacement is one navigable file with both sides available for anchors", async (t) => {
    const { repo, service } = await fixture(t);
    await git(repo, "config", "core.symlinks", "true");
    await rm(path.join(repo, "a.txt"));
    await symlink("target.txt", path.join(repo, "a.txt"), "file");
    const id = await service.ensureReview({ repoPath: repo, base: "main" });
    const snapshot = await service.store.readSnapshot(id, "r1");
    const files = snapshot.files.filter((f) => f.path === "a.txt");
    assert.equal(files.length, 1);
    assert.deepEqual([files[0].oldMode, files[0].newMode, files[0].typeChanged], ["100644", "120000", true]);
    assert.deepEqual((await service.getFileContent(id, "r1", "a.txt")).lines, ["target.txt"]);
    for (const side of ["old", "new"]) {
        const { thread } = await service.createThread(id, { kind: "line", path: "a.txt", side, startLine: 1, body: side });
        assert.deepEqual(thread.anchor.selectedLines, [side === "old" ? "line 1" : "target.txt"]);
    }
    await git(repo, "add", "a.txt");
    await git(repo, "commit", "-q", "-m", "symlink");
    await rm(path.join(repo, "a.txt"));
    await writeFile(path.join(repo, "a.txt"), "regular again\n");
    const reversed = (await captureSnapshot({ repoRoot: repo, scope: "pending" })).files;
    assert.equal(reversed.length, 1);
    assert.deepEqual([reversed[0].oldMode, reversed[0].newMode, reversed[0].hunks[0].rows.at(-1).s], ["120000", "100644", "regular again"]);
});

test("mode-only changes preserve old and new permissions and reach file-comment prompts", async (t) => {
    const { repo, service } = await fixture(t);
    await git(repo, "config", "core.filemode", "false");
    await writeFile(path.join(repo, "run.sh"), "echo ok\n");
    await git(repo, "add", "run.sh");
    await git(repo, "commit", "-q", "-m", "script");
    await git(repo, "update-index", "--chmod=+x", "run.sh");
    const id = await service.ensureReview({ repoPath: repo, base: "main" });
    const file = (await service.store.readSnapshot(id, "r1")).files.find((f) => f.path === "run.sh");
    assert.deepEqual([file.oldMode, file.newMode, file.hunks.length], ["100644", "100755", 0]);
    const { thread } = await service.createThread(id, { kind: "file", path: "run.sh", body: "Why executable?" });
    assert.equal((await service.promptContext(id, thread.threadId)).excerpt.text, "File mode: 100644 to 100755");
});

test("raw content fingerprints change within binary and oversized classifications and for final newlines", async (t) => {
    const { repo, service } = await fixture(t);
    const target = path.join(repo, "untracked.dat");
    const fingerprints = [];
    let id;
    for (const data of [Buffer.from([0, 1]), Buffer.from([0, 2]), Buffer.alloc(2 * 1024 * 1024 + 1, 65), Buffer.alloc(2 * 1024 * 1024 + 1, 66), "text", "text\n"]) {
        await writeFile(target, data);
        if (!id) id = await service.ensureReview({ repoPath: repo, base: "main" });
        else await service.refresh(id);
        const review = await service.getReview(id);
        const snapshot = await service.store.readSnapshot(id, review.currentRevisionId);
        fingerprints.push(snapshot.fingerprint);
        const file = snapshot.files.find((f) => f.path === "untracked.dat");
        assert.equal(file.contentHash, createHash("sha256").update(data).digest("hex"));
    }
    assert.equal(new Set(fingerprints).size, 6);
    assert.equal((await service.getReview(id)).revisions.length, 6);
});

test("generic SSH home paths keep their user and never share automatic learning with absolute paths", async (t) => {
    const home = "git@host.example:team/repo.git";
    const absolute = "ssh://git@host.example/team/repo.git";
    assert.notEqual(normalizeRemoteUrl(home), normalizeRemoteUrl(absolute));
    assert.notEqual(normalizeRemoteUrl(home), normalizeRemoteUrl("other@host.example:team/repo.git"));
    assert.equal(normalizeRemoteUrl("git@host.example:/team/repo.git"), normalizeRemoteUrl(absolute));
    assert.equal(normalizeRemoteUrl("git@github.com:Owner/Repo.git"), normalizeRemoteUrl("ssh://git@github.com/Owner/Repo.git"));
    const { repo, store } = await fixture(t);
    let url = home;
    const settings = new SettingsService({ store, git: { runGit: async () => ({ ok: true, stdout: url }) } });
    await settings.update(repo, { learning: "auto", delivery: "batch" });
    url = absolute;
    assert.deepEqual([(await settings.get(repo)).learning, (await settings.get(repo)).delivery], ["off", "immediate"]);
});
