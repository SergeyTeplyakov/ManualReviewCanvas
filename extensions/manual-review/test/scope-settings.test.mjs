import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGit } from "../lib/git.mjs";
import { Store } from "../lib/store.mjs";
import { ReviewService, computeReviewId, scopeOf } from "../lib/review-service.mjs";
import { Delivery } from "../lib/delivery.mjs";
import { startReviewServer } from "../lib/server.mjs";
import { SettingsService, normalizeRemoteUrl, repoIdentity } from "../lib/settings.mjs";

const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const lines = (n, f = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";
const git = (cwd, ...args) => runGit(cwd, ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=false", ...args]);

let tmp;
let repo;
let seq = 0;

// Fixture: feature is one commit ahead of main, with a staged file, an unstaged edit, and an untracked file on top.
before(async () => {
    tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "mr-scope-")));
    repo = path.join(tmp, "proj");
    await runGit(tmp, ["init", "-q", "-b", "main", repo]);
    await writeFile(path.join(repo, "a.cs"), lines(20));
    await writeFile(path.join(repo, "keep.txt"), "unchanged\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "base");
    await git(repo, "checkout", "-q", "-b", "feature");
    await writeFile(path.join(repo, "a.cs"), lines(20, (i) => (i === 5 ? "line 5 COMMITTED" : `line ${i}`)));
    await writeFile(path.join(repo, "committed.txt"), "committed\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "feature work");
    await writeFile(path.join(repo, "a.cs"), lines(20, (i) => (i === 5 ? "line 5 COMMITTED" : i === 15 ? "line 15 PENDING" : `line ${i}`)));
    await writeFile(path.join(repo, "staged.txt"), "staged\n");
    await git(repo, "add", "staged.txt");
    await writeFile(path.join(repo, "untracked.txt"), "untracked\n");
});

after(async () => {
    await rm(tmp, { recursive: true, force: true });
});

// Every test gets its own store so reviews, lessons, and settings never leak between tests.
function fresh() {
    const store = new Store(path.join(tmp, `data-${++seq}`));
    return { store, service: new ReviewService({ store }) };
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
            headers,
            state: async () => (await request(port, { pathName: `/api/state?t=${token}` })).json,
            post: (pathName, body, extraHeaders = headers) => request(port, { method: "POST", pathName, headers: extraHeaders, body }),
        });
    } finally {
        await server.close();
    }
}

async function commentThread(service, body = "Prefer early returns") {
    const reviewId = await service.ensureReview({ repoPath: repo, base: "main" });
    const { thread, message } = await service.createThread(reviewId, { kind: "file", path: "a.cs", body, author: "user" });
    return { reviewId, thread, message };
}

const agentReply = (service, reviewId, thread, extra) => service.addMessage(reviewId, thread.threadId, { author: "agent", body: "Reply", ...extra });

test("each scope diffs against its own base and gets its own review", async () => {
    const { service } = fresh();
    const head = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    const mainCommit = (await runGit(repo, ["rev-parse", "main"])).stdout.trim();
    const allId = await service.ensureReview({ repoPath: repo, base: "main" });
    const pendingId = await service.ensureReview({ repoPath: repo, base: "main", scope: "pending" });
    assert.match(allId, /^proj-feature-vs-main-[0-9a-f]{8}$/);
    assert.match(pendingId, /^proj-feature-pending-[0-9a-f]{8}$/);

    const all = await service.getReview(allId);
    const pending = await service.getReview(pendingId);
    assert.deepEqual([all.scope, pending.scope], ["all", "pending"]);
    assert.deepEqual([all.title, pending.title], ["feature vs main", "feature (pending changes)"]);
    assert.equal(all.git.baseCommit, mainCommit);
    assert.deepEqual([pending.git.baseCommit, pending.git.headCommit], [head, head], "pending compares the working tree with HEAD");
    assert.deepEqual([all.git.uncommittedFiles, pending.git.uncommittedFiles], [3, 3]);

    const summary = (snapshot) => snapshot.files.map((f) => [f.path, f.status, f.untracked, f.additions, f.deletions]);
    const allSnapshot = await service.getSnapshot(allId);
    const pendingSnapshot = await service.getSnapshot(pendingId);
    assert.deepEqual(summary(allSnapshot), [
        ["a.cs", "modified", false, 2, 2],
        ["committed.txt", "added", false, 1, 0],
        ["staged.txt", "added", false, 1, 0],
        ["untracked.txt", "added", true, 1, 0],
    ]);
    assert.deepEqual(summary(pendingSnapshot), [
        ["a.cs", "modified", false, 1, 1],
        ["staged.txt", "added", false, 1, 0],
        ["untracked.txt", "added", true, 1, 0],
    ]);
    const rowsOf = (snapshot) => snapshot.files.find((f) => f.path === "a.cs").hunks.flatMap((h) => h.rows.map((r) => r.s));
    assert.ok(rowsOf(allSnapshot).includes("line 5 COMMITTED") && rowsOf(allSnapshot).includes("line 15 PENDING"));
    assert.ok(rowsOf(pendingSnapshot).includes("line 15 PENDING"));
    assert.ok(!rowsOf(pendingSnapshot).includes("line 5 COMMITTED"), "committed edits are not pending");
});

test("review ids stay stable for the all scope and differ per scope, branch, base, and pathspec", () => {
    const input = { repoRoot: path.join(os.tmpdir(), "Proj"), branch: "feature", base: "main" };
    const preScopeHash = createHash("sha256")
        .update([path.resolve(input.repoRoot).toLowerCase(), "feature", "main", "", ""].join("|"))
        .digest("hex")
        .slice(0, 8);
    assert.equal(computeReviewId(input), `proj-feature-vs-main-${preScopeHash}`, "existing reviews keep their ids and threads");
    assert.equal(computeReviewId({ ...input, scope: "all" }), computeReviewId(input));
    const pending = computeReviewId({ ...input, scope: "pending" });
    assert.match(pending, /^proj-feature-pending-[0-9a-f]{8}$/);
    const ids = new Set([
        computeReviewId(input),
        pending,
        computeReviewId({ ...input, branch: "other" }),
        computeReviewId({ ...input, base: "develop" }),
        computeReviewId({ ...input, paths: ["src"] }),
        computeReviewId({ ...input, exclude: ["docs"] }),
        computeReviewId({ ...input, scope: "pending", branch: "other" }),
    ]);
    assert.equal(ids.size, 7);
    assert.equal(computeReviewId({ ...input, paths: ["b", "a"] }), computeReviewId({ ...input, paths: ["a", "b"] }), "pathspec order does not matter");
});

test("review ids stay distinct per scope when a long branch name truncates the readable prefix", () => {
    const branch = `dev/someone/${"a-long-description-".repeat(6)}`;
    const input = { repoRoot: path.join(os.tmpdir(), "Proj"), branch, base: "main" };
    assert.notEqual(computeReviewId(input), computeReviewId({ ...input, scope: "pending" }));
});

test("openSibling moves between the two scopes of a branch, and each scope keeps its own threads", async () => {
    const { service } = fresh();
    const allId = await service.ensureReview({ repoPath: repo, base: "main" });
    assert.equal(await service.openSibling(allId, "all"), allId, "the current scope is a no-op");
    const pendingId = await service.openSibling(allId, "pending");
    assert.match(pendingId, /^proj-feature-pending-/);
    assert.equal(await service.openSibling(pendingId, "pending"), pendingId);
    assert.equal(await service.openSibling(pendingId, "all"), allId, "toggling back returns to the original review");
    assert.equal(await service.ensureReview({ repoPath: repo, base: "main", scope: "pending" }), pendingId, "opening by scope finds the same sibling");

    const all = await service.getReview(allId);
    const sibling = await service.getReview(pendingId);
    assert.deepEqual(
        [sibling.scope, sibling.base, sibling.repoRoot, sibling.originBranch, sibling.currentRevisionId],
        ["pending", "main", all.repoRoot, "feature", "r1"],
        "the sibling is captured as soon as it is opened",
    );

    await service.createThread(allId, { kind: "file", path: "committed.txt", body: "Only in the full review", author: "user" });
    await service.createThread(pendingId, { kind: "line", path: "a.cs", side: "new", startLine: 15, body: "Only in the pending review", author: "user" });
    assert.deepEqual((await service.getReview(allId)).threads.map((t) => t.messages[0].body), ["Only in the full review"]);
    assert.deepEqual((await service.getReview(pendingId)).threads.map((t) => t.messages[0].body), ["Only in the pending review"]);
});

test("the sibling review inherits the pathspecs, and its title follows the scope", async () => {
    const { service } = fresh();
    const filtered = await service.ensureReview({ repoPath: repo, base: "main", exclude: ["keep.txt"], paths: ["a.cs", "committed.txt"] });
    const filteredPending = await service.getReview(await service.openSibling(filtered, "pending"));
    assert.equal(filteredPending.title, "feature (pending changes)", "a default title is regenerated for the new scope");
    assert.deepEqual([filteredPending.paths, filteredPending.exclude], [["a.cs", "committed.txt"], ["keep.txt"]]);
    assert.deepEqual((await service.getSnapshot(filteredPending.reviewId)).files.map((f) => f.path), ["a.cs"], "the pathspec still filters the pending diff");

    const custom = await service.ensureReview({ repoPath: repo, base: "main", exclude: ["staged.txt"], title: "Release prep" });
    const customPending = await service.openSibling(custom, "pending");
    assert.equal((await service.getReview(customPending)).title, "Release prep (pending changes)");

    const pendingFirst = await service.ensureReview({ repoPath: repo, base: "main", exclude: ["untracked.txt"], scope: "pending", title: "Release prep (pending changes)" });
    const customAll = await service.openSibling(pendingFirst, "all");
    assert.equal((await service.getReview(customAll)).title, "Release prep", "the pending suffix is dropped when going back to all");
});

test("ensureReview with a reviewId switches scope instead of refreshing when the scope differs", async () => {
    const { service } = fresh();
    const allId = await service.ensureReview({ repoPath: repo, base: "main" });
    assert.equal(await service.ensureReview({ reviewId: allId }), allId, "no scope keeps the review");
    assert.equal(await service.ensureReview({ reviewId: allId, scope: "all" }), allId, "the same scope keeps the review");
    const pendingId = await service.ensureReview({ reviewId: allId, scope: "pending" });
    assert.notEqual(pendingId, allId);
    assert.equal(scopeOf(await service.getReview(pendingId)), "pending");
    assert.equal(await service.ensureReview({ reviewId: pendingId, scope: "all" }), allId);
    assert.equal(await service.ensureReview({ reviewId: pendingId }), pendingId);
});

test("an invalid scope is rejected wherever it can be supplied", async () => {
    const { service } = fresh();
    const allId = await service.ensureReview({ repoPath: repo, base: "main" });
    const invalid = (fn) => assert.rejects(fn, (e) => e.code === "invalid_input");
    await invalid(() => service.ensureReview({ repoPath: repo, base: "main", scope: "everything" }));
    await invalid(() => service.ensureReview({ repoPath: repo, base: "main", scope: "" }));
    await invalid(() => service.ensureReview({ reviewId: allId, scope: "everything" }));
    await invalid(() => service.openSibling(allId, "everything"));
    await invalid(() => service.openSibling(allId, ""));
});

test("a review saved before scopes existed behaves as an all-scope review", async () => {
    const { store, service } = fresh();
    const allId = await service.ensureReview({ repoPath: repo, base: "main" });
    await store.updateReview(allId, (r) => {
        delete r.scope;
        delete r.originBranch;
        return { review: r };
    });
    const legacy = await service.getReview(allId);
    assert.equal("scope" in legacy, false);
    assert.equal(scopeOf(legacy), "all");
    assert.equal(service.summarize(legacy).scope, "all");
    assert.equal(await service.ensureReview({ reviewId: allId }), allId);
    assert.equal(await service.ensureReview({ reviewId: allId, scope: "all" }), allId, "an explicit all scope is not a switch");

    const pendingId = await service.openSibling(allId, "pending");
    assert.match(pendingId, /^proj-feature-pending-/);
    assert.equal(await service.openSibling(pendingId, "all"), allId, "the sibling of a pending review resolves back to the legacy id");
});

test("committing pending work empties the pending review while the all review keeps the change", async () => {
    const work = path.join(tmp, "flow");
    await runGit(tmp, ["init", "-q", "-b", "main", work]);
    await writeFile(path.join(work, "a.cs"), lines(10));
    await git(work, "add", ".");
    await git(work, "commit", "-q", "-m", "base");
    await git(work, "checkout", "-q", "-b", "feature");
    await writeFile(path.join(work, "a.cs"), lines(10, (i) => (i === 4 ? "line 4 EDITED" : `line ${i}`)));

    const { service } = fresh();
    const pendingId = await service.ensureReview({ repoPath: work, base: "main", scope: "pending" });
    const allId = await service.openSibling(pendingId, "all");
    const fileCount = async (id) => (await service.getSnapshot(id)).files.length;
    assert.deepEqual([await fileCount(pendingId), await fileCount(allId)], [1, 1]);

    await git(work, "commit", "-q", "-am", "work");
    assert.equal((await service.refresh(pendingId)).created, true);
    assert.equal((await service.refresh(allId)).created, false, "committing does not change the diff against the merge-base");
    assert.deepEqual([await fileCount(pendingId), await fileCount(allId)], [0, 1]);
    const pending = await service.getReview(pendingId);
    assert.equal(pending.git.uncommittedFiles, 0);
    assert.equal(pending.git.baseCommit, pending.git.headCommit);
});

test("a proposed guideline is settled in place when it is saved or declined", async () => {
    const { store, service } = fresh();
    const { reviewId, thread, message } = await commentThread(service);
    const rule = "Prefer early returns over nested conditionals.";

    const proposal = await agentReply(service, reviewId, thread, { inReplyTo: message.messageId, lessons: [{ rule, status: "proposed", savedTo: "ignored.md" }] });
    const [lesson] = (await service.getReview(reviewId)).lessons;
    assert.match(lesson.lessonId, /^l-[0-9a-f]{8}$/);
    assert.deepEqual([lesson.status, lesson.scope, lesson.savedTo, lesson.rule], ["proposed", "repo", null, rule], "a proposal is not saved anywhere yet");
    assert.deepEqual(proposal.message.lessonIds, [lesson.lessonId]);

    await agentReply(service, reviewId, thread, { lessons: [{ lessonId: lesson.lessonId, status: "saved", savedTo: ".github/copilot-instructions.md" }] });
    const settled = (await service.getReview(reviewId)).lessons;
    assert.equal(settled.length, 1, "the proposal is updated, not duplicated");
    assert.deepEqual([settled[0].status, settled[0].savedTo, settled[0].rule], ["saved", ".github/copilot-instructions.md", rule]);
    assert.ok(settled[0].updatedAt);

    await agentReply(service, reviewId, thread, { lessons: [{ rule: "Log the correlation id.", status: "proposed" }] });
    await agentReply(service, reviewId, thread, { lessons: [{ rule: "  log the CORRELATION   id ", status: "declined", savedTo: "ignored.md" }] });
    const lessons = (await service.getReview(reviewId)).lessons;
    assert.equal(lessons.length, 2, "repeating a proposed rule settles it instead of adding another");
    assert.deepEqual([lessons[1].status, lessons[1].savedTo], ["declined", null]);
    assert.deepEqual(service.summarize(await service.getReview(reviewId)).lessons.map((l) => l.status), ["saved", "declined"]);

    const log = (await readFile(path.join(store.root, "lessons.jsonl"), "utf8")).trim().split("\n");
    assert.equal(log.length, 4, "every change is appended");
    assert.deepEqual(
        (await store.readLessons()).map((l) => [l.lessonId, l.status]),
        lessons.map((l) => [l.lessonId, l.status]),
        "the latest record of each lesson wins",
    );
});

test("lessons recorded before statuses existed read as saved", async () => {
    const { store, service } = fresh();
    const { reviewId, thread, message } = await commentThread(service);
    await agentReply(service, reviewId, thread, {
        inReplyTo: message.messageId,
        lessons: [{ rule: "Explain renames", scope: "personal", savedTo: "~/.copilot/copilot-instructions.md" }],
    });
    const created = (await service.getReview(reviewId)).lessons[0];
    assert.deepEqual([created.status, created.scope, created.savedTo], ["saved", "personal", "~/.copilot/copilot-instructions.md"], "a lesson without a status is saved");

    await store.updateReview(reviewId, (r) => {
        delete r.lessons[0].status;
        return { review: r };
    });
    const legacy = await service.getReview(reviewId);
    assert.equal("status" in legacy.lessons[0], false);
    assert.equal(service.summarize(legacy).lessons[0].status, "saved");
});

test("lesson updates are validated before anything is written", async () => {
    const { store, service } = fresh();
    const { reviewId, thread } = await commentThread(service);
    const other = await service.createThread(reviewId, { kind: "file", path: "keep.txt", body: "Another thread", author: "user" });
    await agentReply(service, reviewId, thread, { lessons: [{ rule: "Keep methods short.", status: "proposed" }] });
    const [lesson] = (await service.getReview(reviewId)).lessons;
    const snapshot = JSON.stringify(await service.getReview(reviewId));

    const rejects = (target, lessons, code) => assert.rejects(() => agentReply(service, reviewId, target, { lessons }), (e) => e.code === code, JSON.stringify(lessons));
    await rejects(thread, [{ rule: "Valid rule", status: "maybe" }], "invalid_input");
    await rejects(thread, [{ rule: "Valid rule", scope: "team" }], "invalid_input");
    await rejects(thread, [{ rule: "   " }], "invalid_input");
    await rejects(thread, [{}], "invalid_input");
    await rejects(thread, [null], "invalid_input");
    await rejects(thread, [{ lessonId: "l-00000000", status: "saved" }], "not_found");
    await rejects(other.thread, [{ lessonId: lesson.lessonId, status: "saved" }], "not_found");
    assert.equal(JSON.stringify(await service.getReview(reviewId)), snapshot, "a rejected reply leaves the review untouched");
    assert.equal((await store.readLessons()).length, 1);
});

test("normalizeRemoteUrl reduces equivalent remote spellings to host/owner/repo", () => {
    for (const url of [
        "https://github.com/Owner/Repo.git",
        "https://user:pw@GitHub.com:443/Owner/Repo.git/",
        "git@github.com:Owner/Repo.git",
        "ssh://git@github.com:22/Owner/Repo.git",
        "github.com/owner/repo",
        "  https://github.com/owner/repo  ",
    ]) {
        assert.equal(normalizeRemoteUrl(url), "github.com/owner/repo", url);
    }
    assert.equal(normalizeRemoteUrl("https://contoso@dev.azure.com/contoso/Project/_git/Repo"), "dev.azure.com/contoso/project/_git/repo");
    assert.notEqual(normalizeRemoteUrl("https://gitlab.com/owner/repo"), "github.com/owner/repo");
    assert.notEqual(normalizeRemoteUrl("https://github.com/owner/other"), "github.com/owner/repo");
});

test("repoIdentity follows the origin remote across clones and worktrees, and falls back to the git directory", async () => {
    const main = path.join(tmp, "ident");
    await runGit(tmp, ["init", "-q", "-b", "main", main]);
    await writeFile(path.join(main, "f.txt"), "x\n");
    await git(main, "add", ".");
    await git(main, "commit", "-q", "-m", "init");
    const worktree = path.join(tmp, "ident-wt");
    await git(main, "worktree", "add", "-q", "-b", "other", worktree);

    const local = await repoIdentity(main);
    assert.match(local.key, /^local:/);
    assert.equal(local.name, "ident");
    assert.equal((await repoIdentity(worktree)).key, local.key, "worktrees share the key of their repository");

    await git(main, "remote", "add", "origin", "git@github.com:Owner/My-Repo.git");
    assert.deepEqual(await repoIdentity(main), { key: "remote:github.com/owner/my-repo", name: "My-Repo" });
    assert.equal((await repoIdentity(worktree)).key, "remote:github.com/owner/my-repo");

    const clone = path.join(tmp, "ident-clone");
    await runGit(tmp, ["init", "-q", "-b", "main", clone]);
    await git(clone, "remote", "add", "origin", "https://user@github.com/owner/my-repo.git");
    assert.equal((await repoIdentity(clone)).key, "remote:github.com/owner/my-repo", "a clone over another protocol is the same repository");
});

test("SettingsService keeps learning off until a mode is chosen and stores each choice per repository", async () => {
    const { store } = fresh();
    const settings = new SettingsService({ store });
    const other = path.join(tmp, "other-repo");
    await runGit(tmp, ["init", "-q", "-b", "main", other]);

    const initial = { repoName: "proj", learning: "off", configured: false, dismissed: false };
    assert.deepEqual(await settings.get(repo), initial);
    assert.deepEqual(await settings.update(repo, { dismissed: true }), { ...initial, dismissed: true }, "dismissing the prompt does not choose a mode");
    assert.deepEqual(await settings.update(repo, { learning: "suggest" }), { ...initial, learning: "suggest", configured: true, dismissed: true });
    assert.deepEqual(await new SettingsService({ store }).get(repo), { ...initial, learning: "suggest", configured: true, dismissed: true }, "the choice is stored, not cached");
    assert.deepEqual(await settings.update(repo, { dismissed: false }), { ...initial, learning: "suggest", configured: true }, "the prompt flag does not touch the mode");
    assert.deepEqual(await settings.update(repo, { learning: "off" }), { ...initial, configured: true }, "off is a deliberate choice, not the unset state");
    assert.deepEqual(await settings.get(other), { repoName: "other-repo", learning: "off", configured: false, dismissed: false }, "other repositories are unaffected");
    assert.deepEqual(await settings.update(other, { learning: "auto" }), { repoName: "other-repo", learning: "auto", configured: true, dismissed: false });
    assert.equal((await settings.get(repo)).learning, "off");

    const saved = JSON.parse(await readFile(store.settingsFile(), "utf8"));
    assert.equal(saved.version, 1);
    assert.equal(Object.keys(saved.repos).length, 2);
});

test("SettingsService shares a choice between clones of the same remote", async () => {
    const { store } = fresh();
    const settings = new SettingsService({ store });
    const first = path.join(tmp, "clone-a");
    const second = path.join(tmp, "clone-b");
    for (const [dir, url] of [[first, "https://github.com/Owner/Repo.git"], [second, "git@github.com:owner/repo.git"]]) {
        await runGit(tmp, ["init", "-q", "-b", "main", dir]);
        await git(dir, "remote", "add", "origin", url);
    }
    await settings.update(first, { learning: "auto" });
    assert.deepEqual(await settings.get(second), { repoName: "repo", learning: "auto", configured: true, dismissed: false });
});

test("SettingsService rejects invalid updates without writing anything", async () => {
    const { store } = fresh();
    const settings = new SettingsService({ store });
    for (const patch of [undefined, {}, { learning: "sometimes" }, { learning: null }, { learning: 1 }, { dismissed: "yes" }, { dismissed: 1 }, { dismissed: null }, { learning: "auto", dismissed: "no" }]) {
        await assert.rejects(() => settings.update(repo, patch), (e) => e.code === "invalid_input", JSON.stringify(patch));
    }
    assert.deepEqual(await settings.get(repo), { repoName: "proj", learning: "off", configured: false, dismissed: false });
    await assert.rejects(() => access(store.settingsFile()), { code: "ENOENT" });
});

test("an unreadable or hand-edited settings file never blocks reading the effective settings", async () => {
    const { store } = fresh();
    await mkdir(store.root, { recursive: true });
    await writeFile(store.settingsFile(), "{ not json");
    const logs = [];
    const settings = new SettingsService({ store, log: (m) => logs.push(m) });
    assert.deepEqual(await settings.get(repo), { repoName: "proj", learning: "off", configured: false, dismissed: false });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^settings unreadable: /);

    const { key } = await repoIdentity(repo);
    await writeFile(store.settingsFile(), JSON.stringify({ version: 1, repos: { [key]: { learning: "loud", promptDismissed: "yes" } } }));
    assert.deepEqual(await settings.get(repo), { repoName: "proj", learning: "off", configured: false, dismissed: false }, "unknown values are ignored");
});

test("Delivery hands the repository's learning mode to the prompt and falls back to off when it cannot be read", async () => {
    const { service } = fresh();
    const { reviewId, thread, message } = await commentThread(service);
    const { repoRoot } = await service.getReview(reviewId);

    const deliver = async (learning) => {
        const sent = [];
        const logs = [];
        const delivery = new Delivery({
            service,
            send: async (opts) => {
                sent.push(opts);
                return `sm-${sent.length}`;
            },
            log: (text, level) => logs.push({ text, level }),
            ...(learning ? { learning } : {}),
        });
        await delivery.deliver(reviewId, thread.threadId, message.messageId, "inst", { retry: true });
        return { prompt: sent[0].prompt, logs };
    };
    const off = /Guideline learning is off for this repository/;

    assert.match((await deliver()).prompt, off, "no provider means off");
    const asked = [];
    assert.match((await deliver(async (root) => (asked.push(root), "suggest"))).prompt, /Guideline learning is in suggest mode/);
    assert.deepEqual(asked, [repoRoot]);
    assert.match((await deliver(async () => "auto")).prompt, /Treat every review comment as coding-guideline input/);
    assert.match((await deliver(async () => "bogus")).prompt, off, "an unknown mode is treated as off");

    const failed = await deliver(async () => {
        throw new Error("settings offline");
    });
    assert.match(failed.prompt, off);
    assert.deepEqual(failed.logs.map((l) => l.level), ["warning"]);
    assert.match(failed.logs[0].text, /could not read the learning setting, using off: settings offline/);
});

test("the settings API stores the learning mode per repository and the next comment is delivered with it", async () => {
    const { store, service } = fresh();
    const settings = new SettingsService({ store });
    const sent = [];
    const delivery = new Delivery({
        service,
        send: async (opts) => {
            sent.push(opts);
            return `sm-${sent.length}`;
        },
        learning: async (repoRoot) => (await settings.get(repoRoot)).learning,
    });
    const reviewId = await service.ensureReview({ repoPath: repo, base: "main" });

    await withServer({ instanceId: "inst-settings", getReviewId: () => reviewId, service, delivery, settings }, async ({ headers, state, post }) => {
        const initial = await state();
        assert.deepEqual(initial.settings, { repoName: "proj", learning: "off", configured: false, dismissed: false });
        assert.equal(initial.review.scope, "all");

        const chosen = await post("/api/settings", { learning: "suggest" });
        assert.equal(chosen.status, 200);
        assert.deepEqual(chosen.json, { repoName: "proj", learning: "suggest", configured: true, dismissed: false });
        assert.deepEqual((await state()).settings, chosen.json);
        assert.deepEqual((await post("/api/settings", { dismissed: true })).json, { ...chosen.json, dismissed: true });

        for (const body of [{}, { learning: "loud" }, { learning: null }, { dismissed: "yes" }]) {
            const rejected = await post("/api/settings", body);
            assert.equal(rejected.status, 400, JSON.stringify(body));
            assert.equal(rejected.json.error.code, "invalid_input");
        }
        assert.equal((await post("/api/settings", { learning: "auto" }, { "Content-Type": "application/json" })).status, 403, "the token header is required");
        assert.equal((await post("/api/settings", { learning: "auto" }, { ...headers, "Content-Type": "text/plain" })).status, 415);
        assert.equal((await post("/api/settings", { learning: "auto" }, { ...headers, Origin: "http://evil.example" })).status, 403);
        assert.equal((await state()).settings.learning, "suggest", "rejected requests change nothing");

        assert.equal((await post("/api/settings", { learning: "auto" })).status, 200);
        assert.equal((await post("/api/threads", { kind: "file", path: "a.cs", body: "Prefer early returns" })).status, 200);
        await waitFor(() => sent.length === 1, "the comment to be delivered");
        assert.match(sent[0].prompt, /Treat every review comment as coding-guideline input/);
    });
});

test("the scope API switches the served review and keeps the repository setting", async () => {
    const { store, service } = fresh();
    const settings = new SettingsService({ store });
    const delivery = new Delivery({ service, send: async () => "sm-1" });
    const allId = await service.ensureReview({ repoPath: repo, base: "main" });
    let currentId = allId;
    const events = [];
    service.on("changed", (e) => events.push(e));

    await withServer(
        { instanceId: "inst-scope", getReviewId: () => currentId, service, delivery, settings, onReviewChange: (id) => { currentId = id; } },
        async ({ state, post }) => {
            await post("/api/settings", { learning: "suggest" });
            for (const body of [{}, { scope: "bogus" }, { scope: null }, { scope: ["all"] }]) {
                const rejected = await post("/api/scope", body);
                assert.equal(rejected.status, 400, JSON.stringify(body));
                assert.equal(rejected.json.error.code, "invalid_input");
            }
            assert.equal(currentId, allId);

            const same = await post("/api/scope", { scope: "all" });
            assert.deepEqual(same.json, { reviewId: allId, scope: "all" });
            assert.equal(events.some((e) => e.reason === "scope"), false, "staying on the same scope announces nothing");

            const switched = await post("/api/scope", { scope: "pending" });
            assert.equal(switched.status, 200);
            assert.equal(switched.json.scope, "pending");
            assert.match(switched.json.reviewId, /^proj-feature-pending-/);
            assert.equal(currentId, switched.json.reviewId);
            assert.deepEqual(events.filter((e) => e.reason === "scope"), [{ reviewId: switched.json.reviewId, reason: "scope" }]);

            const view = await state();
            assert.deepEqual([view.review.reviewId, view.review.scope], [switched.json.reviewId, "pending"]);
            assert.equal(view.settings.learning, "suggest", "the learning mode belongs to the repository, not the scope");

            assert.deepEqual((await post("/api/scope", { scope: "all" })).json, { reviewId: allId, scope: "all" });
            assert.equal((await state()).review.reviewId, allId);
        },
    );
});

test("the settings and scope endpoints say so when the host does not provide them", async () => {
    const { service } = fresh();
    const delivery = new Delivery({ service, send: async () => "sm-1" });
    const reviewId = await service.ensureReview({ repoPath: repo, base: "main" });

    await withServer({ instanceId: "inst-bare", getReviewId: () => reviewId, service, delivery }, async ({ state, post }) => {
        assert.equal((await state()).settings, null);
        const settings = await post("/api/settings", { learning: "auto" });
        assert.equal(settings.status, 501);
        assert.equal(settings.json.error.code, "unsupported");
        assert.equal((await post("/api/scope", { scope: "bogus" })).status, 400, "validation comes first");
        assert.equal((await post("/api/scope", { scope: "pending" })).status, 501);
    });
});

test("a failing settings read leaves the review usable", async () => {
    const { service } = fresh();
    const delivery = new Delivery({ service, send: async () => "sm-1" });
    const reviewId = await service.ensureReview({ repoPath: repo, base: "main" });
    const logs = [];
    const settings = {
        get: async () => {
            throw new Error("settings disk error");
        },
        update: async () => ({}),
    };

    await withServer({ instanceId: "inst-failing", getReviewId: () => reviewId, service, delivery, settings, log: (m, level) => logs.push({ m, level }) }, async ({ state }) => {
        const view = await state();
        assert.equal(view.settings, null);
        assert.equal(view.review.reviewId, reviewId);
    });
    assert.ok(logs.some(({ m, level }) => level === "warning" && /could not read settings: settings disk error/.test(m)));
});
