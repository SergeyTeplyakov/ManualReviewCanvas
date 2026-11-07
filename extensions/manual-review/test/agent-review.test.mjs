import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../lib/store.mjs";
import { ReviewService } from "../lib/review-service.mjs";
import { AgentReview } from "../lib/agent-review.mjs";
import { Delivery } from "../lib/delivery.mjs";
import { parseUnifiedDiff } from "../lib/diff.mjs";
import * as git from "../lib/git.mjs";
import { startReviewServer } from "../lib/server.mjs";
import { buildCommentPrompt } from "../lib/prompt.mjs";

const models = ["gpt-review-test", "mai-review-test"];
const input = { models, focus: "both", revisionId: "r1" };
const summary = "Read the pinned diff and both versions of notes.md. Source inspection only; no tests run and no external skills used.";
const finding = {
    kind: "line", category: "issue", path: "notes.md", side: "new", startLine: 1,
    body: "The changed statement contradicts the preceding requirement. Keep the original constraint.",
    severity: "required", assessment: "confirmed",
    evidence: {
        source: "notes.md:1 changes the documented constraint.",
        baseline: "The old side of notes.md:1 preserves the constraint; the new side drops it.",
        validation: "Compared the statement with the requirement. No execution was needed; source inspection only.",
    },
};

async function fixture(t, options = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "mr-agent-review-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new Store(root);
    const snapshot = {
        files: parseUnifiedDiff("diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-old\n+new\n"),
        branch: "feature", baseCommit: "base", headCommit: "head", fingerprint: "one", uncommittedFiles: [],
    };
    const service = new ReviewService({
        store, isProcessAlive: options.isProcessAlive,
        git: { ...git, captureSnapshot: async () => snapshot, readWorkingFile: async () => ["new", ""], readCommitFile: async () => ["old", ""] },
    });
    await store.updateReview("review", () => ({
        review: { reviewId: "review", title: "Test", repoRoot: root, scope: "pending", branch: "feature", base: "main", revisions: [], threads: [], lessons: [] },
    }));
    await service.refresh("review");
    const sent = [];
    const log = [];
    const agent = new AgentReview({
        service, sessionId: () => options.owner ?? "session-a",
        send: async (o) => { sent.push(o); return options.send ? options.send(o) : "transport-1"; },
        log: (...args) => log.push(args),
    });
    return { root, store, service, snapshot, agent, sent, log };
}

test("multi-model review queues only after an explicit start and excludes manual drafts", async (t) => {
    const f = await fixture(t);
    await f.service.createThread("review", { kind: "overview", body: "PRIVATE DRAFT", hold: true });
    assert.equal(f.sent.length, 0);
    const intent = "Preserve the documented constraint. Use Addy's review skill if installed.";
    const run = await f.agent.start("review", { ...input, intent }, "canvas-one");
    assert.equal(run.state, "queued");
    assert.deepEqual(run.models, models);
    assert.equal(run.intent, intent);
    assert.equal(f.sent.length, 1);
    const prompt = f.sent[0];
    assert.equal(prompt.mode, "enqueue");
    assert.match(prompt.prompt, /one independent read-only subagent per selected model/);
    assert.match(prompt.prompt, /Do not substitute models/);
    assert.match(prompt.prompt, /Simplification applies to code and prose/);
    assert.match(prompt.prompt, /Do not fix any findings/);
    assert.match(prompt.prompt, /owning conversation must check each claim against the pinned change AND base/);
    assert.match(prompt.prompt, /relevant reachable callers, guards, tests, and requirements/);
    assert.match(prompt.prompt, /code-review-and-quality and code-simplification/);
    assert.match(prompt.prompt, /never auto-install/);
    assert.match(prompt.prompt, /no mutation tests in the user's checkout/);
    assert.match(prompt.prompt, /Project conventions|project conventions override/);
    assert.match(prompt.prompt, /requirements coverage as unavailable/);
    assert.match(prompt.prompt, /Zero confirmed findings/);
    assert.match(prompt.prompt, /Do not launch an extra validator model/);
    assert.match(prompt.prompt, /Preserve outputs, errors, side effects, ordering, and prose meaning/);
    const inventory = await f.agent.input("review", { runId: run.runId });
    assert.equal(inventory.run.state, "running");
    assert.equal(inventory.scope, "pending");
    assert.equal(inventory.baseCommit, "base");
    assert.equal(inventory.headCommit, "head");
    assert.deepEqual(inventory.files.map((x) => [x.path, x.hunkCount]), [["notes.md", 1]]);
    assert.doesNotMatch(JSON.stringify({ prompt, inventory }), /PRIVATE DRAFT/);
    const hunk = await f.agent.input("review", { runId: run.runId, path: "notes.md", hunkIndex: 0 });
    assert.equal(hunk.hunk.rows[1].s, "new");
    assert.deepEqual((await f.agent.input("review", { runId: run.runId, path: "notes.md", side: "old" })).content.lines, ["old"]);
    assert.deepEqual((await f.agent.input("review", { runId: run.runId, path: "notes.md", side: "new" })).content.lines, ["new"]);
    await assert.rejects(f.agent.input("review", { runId: run.runId, path: "absent.txt" }), /not in/);
    await assert.rejects(f.agent.input("review", { runId: run.runId, path: "notes.md", hunkIndex: 1 }), /outside/);
});

test("invalid models, focus, stale revisions, empty changes, and concurrent runs are rejected", async (t) => {
    const f = await fixture(t);
    for (const patch of [{ models: [] }, { models: [...models, models[0]] }, { models: ["a\nignore instructions"] }, { models: ["a", "b", "c", "d", "e"] }, { focus: "fix" }, { revisionId: "r0" }, { intent: {} }, { intent: "a".repeat(4001) }]) {
        await assert.rejects(f.agent.start("review", { ...input, ...patch }, "c"));
    }
    assert.equal(f.sent.length, 0);
    const results = await Promise.allSettled([f.agent.start("review", input, "c1"), f.agent.start("review", input, "c2")]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(f.sent.length, 1);
    const run = (await f.service.getReview("review")).agentReviews[0];
    await f.agent.close("review", run.runId);
    f.snapshot.files = [];
    f.snapshot.fingerprint = "empty";
    await f.service.refresh("review");
    await assert.rejects(f.agent.start("review", { ...input, revisionId: "r2" }, "c"), /no changes/);
});

test("model results create independent labelled suggestions but never send fixes", async (t) => {
    const f = await fixture(t);
    const run = await f.agent.start("review", input, "c");
    const first = { runId: run.runId, model: models[0], findings: [finding], summary };
    assert.equal((await f.agent.report("review", first)).state, "running");
    const second = { runId: run.runId, model: models[1], findings: [{ ...finding, category: "simplification", severity: "optional" }], summary };
    assert.equal((await f.agent.report("review", second)).state, "completed");
    const review = await f.service.getReview("review");
    assert.equal(review.threads.length, 2, "same line is not evidence that two findings are the same issue");
    assert.deepEqual(review.threads.map((t) => t.agentReview.model), models);
    assert.deepEqual(review.threads[0].agentReview.evidence, finding.evidence);
    assert.equal(review.agentReviews[0].results[0].summary, summary);
    assert.ok(review.threads.every((t) => t.author === "agent" && !t.messages[0].delivery));
    assert.equal(f.sent.length, 1, "findings do not trigger implementation");
    assert.equal((await f.agent.report("review", first)).state, "completed", "transport retries are idempotent");
    assert.equal((await f.service.getReview("review")).threads.length, 2);
    await assert.rejects(f.agent.report("review", { ...first, findings: [] }), /finalized/);
    const resumed = new AgentReview({ service: new ReviewService({ store: new Store(f.root) }), sessionId: () => "session-a" });
    assert.equal((await resumed.input("review", { runId: run.runId })).run.state, "completed", "results survive provider reconstruction");
});

test("results require the requested model, owning session, valid scope, and pinned diff locations", async (t) => {
    const f = await fixture(t);
    const run = await f.agent.start("review", input, "c");
    const report = { runId: run.runId, model: models[0], findings: [finding], summary };
    const other = new AgentReview({ service: f.service, sessionId: () => "session-b" });
    await assert.rejects(other.report("review", report), /not requested/);
    await assert.rejects(other.input("review", { runId: run.runId }), /another conversation/);
    await assert.rejects(f.agent.report("review", { ...report, model: "not-selected" }), /not requested/);
    for (const patch of [
        { path: "../outside.md" }, { startLine: 20 }, { side: "invalid" }, { body: "" }, { category: "auto-fix" },
        { kind: "file", path: "not-reviewed.txt" }, { assessment: "looks-good" }, { severity: "high-confidence" },
        { evidence: undefined }, { evidence: { ...finding.evidence, source: "" } },
        { evidence: { ...finding.evidence, baseline: null } }, { evidence: { ...finding.evidence, validation: "x".repeat(2001) } },
    ]) {
        await assert.rejects(f.agent.report("review", { ...report, findings: [finding, { ...finding, ...patch }] }));
        assert.equal((await f.service.getReview("review")).threads.length, 0, "validation is atomic across the model's findings");
    }
    await f.agent.close("review", run.runId);
    const simplify = await f.agent.start("review", { ...input, focus: "simplify" }, "c");
    await assert.rejects(f.agent.report("review", { ...report, runId: simplify.runId }), /focus/);
});

test("successful reports require coverage even when clean; missing evidence is never silently confirmed", async (t) => {
    const f = await fixture(t);
    const run = await f.agent.start("review", input, "c");
    for (const patch of [{}, { summary: " " }, { summary: {} }, { summary: "x".repeat(4001) }]) {
        await assert.rejects(f.agent.report("review", { runId: run.runId, model: models[0], findings: [], ...patch }), /summary/);
    }
    await assert.rejects(f.agent.report("review", { runId: run.runId, model: models[0], error: "failed", summary }), /not both/);
    assert.equal((await f.service.getReview("review")).agentReviews[0].results.length, 0);
    await f.agent.report("review", { runId: run.runId, model: models[0], findings: [], summary: "No confirmed defects. Specification unavailable; tests not run." });
    const result = (await f.service.getReview("review")).agentReviews[0].results[0];
    assert.deepEqual(result.threadIds, []);
    assert.match(result.summary, /Specification unavailable; tests not run/);
});

test("clean, partial, failed, and closed reviews are distinct", async (t) => {
    const f = await fixture(t);
    let run = await f.agent.start("review", input, "c");
    await f.agent.report("review", { runId: run.runId, model: models[0], findings: [], summary });
    run = await f.agent.report("review", { runId: run.runId, model: models[1], error: "Model unavailable" });
    assert.equal(run.state, "partial");
    assert.equal(run.results[0].state, "completed");
    assert.equal(run.results[1].error, "Model unavailable");
    run = await f.agent.start("review", { ...input, models: [models[0]] }, "c");
    run = await f.agent.report("review", { runId: run.runId, model: models[0], error: "No model-selectable subagent tool" });
    assert.equal(run.state, "failed");
    run = await f.agent.start("review", input, "c");
    assert.equal((await f.agent.close("review", run.runId)).state, "closed");
    await assert.rejects(f.agent.report("review", { runId: run.runId, model: models[0], findings: [finding], summary }), /finalized/);
});

test("delivery failures and dead sending claims are explicit, and early results win over the send acknowledgement", async (t) => {
    const f = await fixture(t, { send: () => { throw new Error("transport down"); } });
    await assert.rejects(f.agent.start("review", input, "c"), /transport down/);
    assert.equal((await f.service.getReview("review")).agentReviews[0].state, "failed");
    assert.equal(f.log.length, 1);
    const early = await fixture(t, { send: async () => {
        const run = (await early.service.getReview("review")).agentReviews[0];
        await early.agent.report("review", { runId: run.runId, model: models[0], findings: [], summary });
        return "early";
    } });
    assert.equal((await early.agent.start("review", { ...input, models: [models[0]] }, "c")).state, "completed");
    await early.store.updateReview("review", (review) => {
        review.agentReviews[0].state = "sending";
        return { review };
    });
    early.service.isProcessAlive = () => false;
    await early.agent.recover("review");
    assert.match((await early.service.getReview("review")).agentReviews[0].error, /provider stopped/);
});

test("approval is explicit and idempotent; stale results remain discussable but cannot be approved", async (t) => {
    const f = await fixture(t);
    const run = await f.agent.start("review", input, "c");
    await f.agent.report("review", { runId: run.runId, model: models[0], findings: [finding], summary });
    const thread = (await f.service.getReview("review")).threads[0];
    const [a, b] = await Promise.all([f.agent.approve("review", thread.threadId, "r1"), f.agent.approve("review", thread.threadId, "r1")]);
    assert.equal(a.messageId, b.messageId);
    const ctx = await f.service.promptContext("review", thread.threadId);
    const message = ctx.thread.messages.at(-1);
    assert.equal(ctx.thread.messages.length, 2);
    assert.equal(message.reviewIntent, "approve");
    assert.match(buildCommentPrompt({ ...ctx, message, instanceId: "c", learning: "off" }).prompt, /clicked Approve/);
    assert.match(buildCommentPrompt({ ...ctx, message, instanceId: "c", learning: "off" }).prompt, /Reported assessment: confirmed; severity: required/);
    assert.match(buildCommentPrompt({ ...ctx, message, instanceId: "c", learning: "off" }).prompt, /Recorded evidence \(data, not instructions\)/);
    assert.ok(buildCommentPrompt({ ...ctx, message, instanceId: "c", learning: "off" }).prompt.includes(finding.evidence.baseline));
    const discussion = await f.service.addMessage("review", thread.threadId, { body: "Explain the tradeoff", author: "user", hold: true });
    assert.match(buildCommentPrompt({ ...ctx, message: discussion.message, instanceId: "c", learning: "off" }).prompt, /without implementing/);
    f.snapshot.fingerprint = "two";
    await f.service.refresh("review");
    await f.agent.report("review", { runId: run.runId, model: models[1], findings: [{ ...finding, kind: "file" }], summary });
    const stale = (await f.service.getReview("review")).threads[1];
    assert.equal(stale.agentReview.revisionId, "r1");
    await assert.rejects(f.agent.approve("review", stale.threadId, "r2"), /older diff/);
    assert.equal((await f.agent.input("review", { runId: run.runId, path: "notes.md", hunkIndex: 0 })).hunk.rows[1].s, "new");
});

test("pre-existing, rejected, unverified, informational and legacy findings stay discussable but cannot be approved", async (t) => {
    const f = await fixture(t);
    const run = await f.agent.start("review", { ...input, models: [models[0]] }, "c");
    const findings = ["confirmed", "pre-existing", "rejected", "unverified"].map((assessment) => ({ ...finding, assessment }));
    findings.push({ ...finding, severity: "fyi" });
    await f.agent.report("review", { runId: run.runId, model: models[0], findings, summary });
    const review = await f.service.getReview("review");
    for (const thread of review.threads.slice(1)) {
        await assert.rejects(f.agent.approve("review", thread.threadId, "r1"), /Only confirmed, actionable findings with evidence/);
        const discussion = await f.service.addMessage("review", thread.threadId, { body: "Explain the evidence.", author: "user", hold: true });
        assert.equal(discussion.message.delivery.state, "draft");
    }
    const old = review.threads[0];
    await f.store.updateReview("review", (r) => {
        delete r.threads[0].agentReview.assessment;
        delete r.threads[0].agentReview.evidence;
        return { review: r };
    });
    await assert.rejects(f.agent.approve("review", old.threadId, "r1"), /Only confirmed/);
    assert.equal((await f.service.getReview("review")).threads[0].messages.length, 1);
    assert.equal(f.sent.length, 1, "assessments and discussion drafts do not request implementation");
});

test("full-file input distinguishes absent, renamed, binary and unavailable baseline content", async (t) => {
    for (const [label, patch, side, expected] of [
        ["added", { status: "added" }, "old", { available: true, absent: true }],
        ["deleted", { status: "deleted" }, "new", { available: true, absent: true }],
        ["renamed", { oldPath: "previous.md" }, "old", { available: true, path: "previous.md" }],
        ["binary", { binary: true }, "old", { available: false, reason: "binary" }],
        ["missing base", {}, "old", { available: false, reason: "base-unavailable" }],
    ]) {
        await t.test(label, async (t) => {
            const f = await fixture(t);
            Object.assign(f.snapshot.files[0], patch);
            f.snapshot.fingerprint = label;
            if (label === "missing base") f.service.git.readCommitFile = async () => null;
            if (label === "renamed") f.service.git.readCommitFile = async (_repo, commit, filePath) => {
                assert.equal(commit, "base");
                assert.equal(filePath, "previous.md");
                return ["old", ""];
            };
            const revision = await f.service.refresh("review");
            const run = await f.agent.start("review", { ...input, revisionId: revision.revisionId }, "c");
            const { content } = await f.agent.input("review", { runId: run.runId, path: "notes.md", side });
            for (const [key, value] of Object.entries(expected)) assert.equal(content[key], value);
            if (expected.absent) assert.deepEqual(content.lines, []);
        });
    }
});

test("review context exposes the baseline and caller guard; known outcomes persist without mutating reviewed files", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mr-review-evidence-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repo = path.join(root, "repo");
    const runGit = (...args) => git.runGit(repo, ["-c", "user.name=Review test", "-c", "user.email=review@example.test", "-c", "core.autocrlf=false", ...args]);
    await git.runGit(root, ["init", "-q", "-b", "main", repo]);
    const before = [
        "export function canAllocate(remaining, requested) {",
        "    return requested <= remaining;",
        "}",
        "",
        "export function allocate(actor, account, requested) {",
        '    if (actor !== account.owner) throw new Error("owner mismatch");',
        '    if (!canAllocate(account.remaining, requested)) throw new Error("quota exceeded");',
        "    const charge = 0;",
        "    return { remaining: account.remaining - requested, charge };",
        "}",
        ...Array.from({ length: 410 }, (_, i) => `// Context line ${i + 1}`),
        "",
    ].join("\n");
    const file = path.join(repo, "quota.mjs");
    await writeFile(file, before);
    await writeFile(path.join(repo, "CONTRACT.md"), "An owner may allocate the full remaining quota. Each allocation has a charge of one.\n");
    await runGit("add", ".");
    await runGit("commit", "-q", "-m", "baseline");
    const after = before.replace("requested <= remaining", "requested < remaining");
    await writeFile(file, after);
    const service = new ReviewService({ store: new Store(path.join(root, "data")) });
    const reviewId = await service.ensureReview({ repoPath: repo, scope: "pending", context: 0 });
    const agent = new AgentReview({ service, sessionId: () => "session", send: async () => "queued" });
    let run = await agent.start(reviewId, { ...input, models: [models[0]], intent: "Check CONTRACT.md, including the equality boundary." }, "c");
    const read = (extra) => agent.input(reviewId, { runId: run.runId, path: "quota.mjs", ...extra });
    const old = await read({ side: "old" });
    const current = await read({ side: "new" });
    assert.equal(old.baseCommit, old.headCommit, "pending review compares against the pinned HEAD");
    assert.match(old.content.lines[1], /<=/);
    assert.match(current.content.lines[1], /requested < remaining/);
    assert.match(current.content.lines[5], /actor !== account.owner/, "unchanged guards outside the hunk are available for counter-checking");
    assert.equal(current.content.lines.length, 400);
    assert.equal(current.content.nextStartLine, 401);
    const page = await read({ side: "new", startLine: current.content.nextStartLine });
    assert.equal(page.content.lines.length, 20);
    assert.equal(page.content.nextStartLine, null);
    for (const extra of [{ side: "new", startLine: 421 }, { side: "new", startLine: 0 }, { side: "new", hunkIndex: 0 }, { startLine: 1 }, { side: "invalid" }]) {
        await assert.rejects(read(extra));
    }
    await assert.rejects(agent.input(reviewId, { runId: run.runId, side: "old" }), /path is required/);
    // These are simulated coordinator assessments: the test verifies the contract, not model reasoning.
    const assessed = (assessment, body, baseline, validation) => ({
        ...finding, kind: "file", path: "quota.mjs", assessment, body,
        evidence: { source: "quota.mjs:2-9 and CONTRACT.md:1", baseline, validation },
    });
    await agent.report(reviewId, {
        runId: run.runId, model: models[0], summary: "Simulated coordinator result using both snapshots of quota.mjs and CONTRACT.md. No model or test execution.",
        findings: [
            assessed("confirmed", "Exact-quota allocation is now rejected. Restore the inclusive comparison.", "The base uses <=; the changed side uses <.", "With requested equal to remaining, the new condition is false. Source comparison only; tests not run."),
            assessed("pre-existing", "The allocation charge is zero.", "Both versions have charge = 0.", "This contradicts the contract but is unchanged by the diff."),
            assessed("rejected", "A different actor can allocate from this account.", "Both versions preserve the owner check.", "The reachable allocate caller checks actor against account.owner before invoking canAllocate; the claim is disproved."),
        ],
    });
    const threads = (await service.getReview(reviewId)).threads;
    assert.deepEqual(threads.map((x) => x.agentReview.assessment), ["confirmed", "pre-existing", "rejected"]);
    await agent.approve(reviewId, threads[0].threadId, "r1");
    await assert.rejects(agent.approve(reviewId, threads[1].threadId, "r1"), /Only confirmed/);
    await assert.rejects(agent.approve(reviewId, threads[2].threadId, "r1"), /Only confirmed/);
    assert.equal(await readFile(file, "utf8"), after, "reporting and approval enqueue work but do not edit source");
    await writeFile(file, before + "// Documented allocation contract.\n");
    const stale = await read({ side: "new" });
    assert.equal(stale.content.available, false);
    assert.equal(stale.content.reason, "stale");
    assert.match((await read({ side: "old" })).content.lines[1], /<=/, "base evidence remains pinned after local edits");
    await service.refresh(reviewId);
    run = await agent.start(reviewId, { ...input, models: [models[0]], revisionId: (await service.getReview(reviewId)).currentRevisionId }, "c");
    const clean = await agent.report(reviewId, { runId: run.runId, model: models[0], findings: [], summary: "Simulated clean-diff result: no new defects; the old charge issue remains. Source inspection only; tests not run." });
    assert.equal(clean.state, "completed");
    assert.deepEqual(clean.results[0].threadIds, [], "a clean diff must not fabricate a new finding");
});

test("HTTP start, model reporting, approval, and discussion use the real delivery pipeline", async (t) => {
    const f = await fixture(t);
    const fixes = [];
    const delivery = new Delivery({ service: f.service, sessionId: () => "session-a", send: async (p) => { fixes.push(p); return "fix-transport"; } });
    const server = await startReviewServer({
        instanceId: "c", getReviewId: () => "review", service: f.service, delivery, agentReview: f.agent,
        webRoot: fileURLToPath(new URL("../web", import.meta.url)),
    });
    t.after(() => server.close());
    const url = new URL(server.url);
    const headers = { "Content-Type": "application/json", "X-MR-Token": url.searchParams.get("t"), "X-MR-Review": "review" };
    const post = (route, body, changes = {}) => fetch(new URL(`api/${route}`, url), { method: "POST", headers: { ...headers, ...changes }, body: JSON.stringify(body) });
    assert.equal((await post("agent-reviews", input, { "X-MR-Review": "old-scope" })).status, 409);
    const res = await post("agent-reviews", input);
    assert.equal(res.status, 200);
    const run = await res.json();
    await f.agent.report("review", { runId: run.runId, model: models[0], findings: [finding, { ...finding, assessment: "unverified" }], summary });
    const thread = (await f.service.getReview("review")).threads[0];
    const unverified = (await f.service.getReview("review")).threads[1];
    assert.equal(fixes.length, 0);
    assert.equal((await post(`threads/${unverified.threadId}/approve`, { revisionId: "r1" })).status, 409);
    assert.equal(fixes.length, 0, "HTTP approval must not bypass assessment validation");
    const approved = await post(`threads/${thread.threadId}/approve`, { revisionId: "r1" });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).delivered, true);
    assert.equal(fixes.length, 1);
    assert.match(fixes[0].prompt, /Implement the following approved suggestion/);
    await post(`threads/${thread.threadId}/approve`, { revisionId: "r1" });
    assert.equal(fixes.length, 1, "double clicks do not deliver twice");
    assert.equal((await post(`agent-reviews/${run.runId}/close`, {})).status, 200);
});
