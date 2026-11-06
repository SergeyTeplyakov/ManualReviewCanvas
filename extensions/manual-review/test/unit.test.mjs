import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import vm from "node:vm";
import os from "node:os";
import path from "node:path";
import { parseUnifiedDiff, synthesizeAddedFile, hunkAnchorRange, selectedLines, hunkExcerpt } from "../lib/diff.mjs";
import { relocate } from "../lib/anchors.mjs";
import { buildCommentPrompt, marker } from "../lib/prompt.mjs";
import { Store } from "../lib/store.mjs";

const DIFF = [
    "diff --git a/src/a.cs b/src/a.cs",
    "index 111..222 100644",
    "--- a/src/a.cs",
    "+++ b/src/a.cs",
    "@@ -1,4 +1,4 @@ class A",
    " line1",
    "--- not a header, a deleted line starting with dashes",
    "+++ not a header, an added line starting with pluses",
    " line3",
    "",
    "diff --git a/old name.txt b/new name.txt",
    "similarity index 90%",
    "rename from old name.txt",
    "rename to new name.txt",
    "--- a/old name.txt",
    "+++ b/new name.txt",
    "@@ -1 +1 @@",
    "-x",
    "\\ No newline at end of file",
    "+y",
    "\\ No newline at end of file",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-a",
    "-b",
    "diff --git \"a/q\\\"uote.txt\" \"b/q\\\"uote.txt\"",
    "new file mode 100644",
    "--- /dev/null",
    "+++ \"b/q\\\"uote.txt\"",
    "@@ -0,0 +1 @@",
    "+hi",
    "",
].join("\n");

test("parseUnifiedDiff handles dash/plus content, renames, no-newline, deletes, quoted paths", () => {
    const files = parseUnifiedDiff(DIFF);
    assert.equal(files.length, 4);

    const [a, renamed, gone, quoted] = files;
    assert.equal(a.path, "src/a.cs");
    assert.equal(a.additions, 1);
    assert.equal(a.deletions, 1);
    assert.deepEqual(a.hunks[0].rows.map((r) => r.t), ["ctx", "del", "add", "ctx", "ctx"]);
    assert.equal(a.hunks[0].rows[1].s, "-- not a header, a deleted line starting with dashes");
    assert.deepEqual(a.hunks[0].rows[4], { t: "ctx", o: 4, n: 4, s: "" });
    assert.equal(a.hunks[0].section, "class A");

    assert.equal(renamed.status, "renamed");
    assert.equal(renamed.oldPath, "old name.txt");
    assert.equal(renamed.path, "new name.txt");
    assert.equal(renamed.hunks[0].noNewlineAtEnd, true);
    assert.deepEqual(renamed.hunks[0].rows.map((r) => [r.t, r.o, r.n, r.s]), [["del", 1, null, "x"], ["add", null, 1, "y"]]);

    assert.equal(gone.status, "deleted");
    assert.equal(gone.path, "gone.txt");
    assert.deepEqual(hunkAnchorRange(gone.hunks[0]), { side: "old", startLine: 1, endLine: 2 });

    assert.equal(quoted.status, "added");
    assert.equal(quoted.path, 'q"uote.txt');
    assert.equal(quoted.oldPath, null);
});

test("hunk helpers select lines per side", () => {
    const [a] = parseUnifiedDiff(DIFF);
    assert.deepEqual(hunkAnchorRange(a.hunks[0]), { side: "new", startLine: 1, endLine: 4 });
    assert.deepEqual(selectedLines(a, "new", 2, 3), ["++ not a header, an added line starting with pluses", "line3"]);
    assert.deepEqual(selectedLines(a, "old", 2, 2), ["-- not a header, a deleted line starting with dashes"]);
    const ex = hunkExcerpt(a, "new", 2, 2);
    assert.match(ex.text, /^@@ -1,4 \+1,4 @@ class A\n/);
    assert.equal(hunkExcerpt(a, "new", 50, 60), null);
});

test("synthesizeAddedFile strips CR and trailing newline", () => {
    const f = synthesizeAddedFile("n.txt", "a\r\nb\r\n");
    assert.deepEqual(f.hunks[0].rows, [{ t: "add", o: null, n: 1, s: "a" }, { t: "add", o: null, n: 2, s: "b" }]);
    assert.equal(synthesizeAddedFile("e.txt", "").hunks.length, 0);
});

test("relocate follows moved code, prefers nearest match, and marks removed code outdated", () => {
    const anchor = { startLine: 2, endLine: 3, selectedLines: ["foo();", "bar();"] };
    assert.deepEqual(relocate(anchor, 2, ["x", "y", "z", "foo();", "bar();"]), { startLine: 4, endLine: 5, state: "current" });
    assert.deepEqual(relocate(anchor, 9, ["foo();", "bar();", "", "", "", "", "", "", "foo();", "bar();"]), { startLine: 9, endLine: 10, state: "current" });
    assert.deepEqual(relocate(anchor, 2, ["  foo();  ", "bar();"]).state, "current");
    assert.deepEqual(relocate(anchor, 2, ["a", "b", "c"]), { startLine: 2, endLine: 3, state: "outdated" });
    assert.deepEqual(relocate(anchor, 2, null), { startLine: 2, endLine: 3, state: "outdated" });
    assert.deepEqual(relocate({ startLine: 5, endLine: 5, selectedLines: [""] }, 5, ["a", "b"]), { startLine: 2, endLine: 2, state: "current" });
    const long = Array.from({ length: 600 }, (_, i) => `line ${i}`);
    const truncated = { startLine: 1, endLine: 500, selectedLines: long.slice(0, 400) };
    assert.deepEqual(relocate(truncated, 1, ["new", ...long]), { startLine: 2, endLine: 501, state: "current" });
});

test("prompt carries marker, location, fenced code and reply instructions", () => {
    const review = { reviewId: "rev-1", repoRoot: "C:\\repo", branch: "b", base: "master", headCommit: "abcdef1234567", baseCommit: "1234567abcdef", currentRevisionId: "r2" };
    const message = { messageId: "m-11111111-2222-3333-4444-555555555555", author: "user", body: "Use a named argument here" };
    const thread = {
        threadId: "t-1",
        kind: "line",
        status: "active",
        anchor: { revisionId: "r1", path: "src/a.cs", side: "new", startLine: 3, endLine: 3 },
        location: { revisionId: "r2", path: "src/a.cs", side: "new", startLine: 5, endLine: 5, state: "current" },
        messages: [message],
    };
    const { prompt, displayPrompt } = buildCommentPrompt({ review, thread, message, instanceId: "inst-1", excerpt: { text: "@@ -1 +1 @@\n+x" }, selected: ["Foo(```, null);"] });
    assert.ok(prompt.startsWith(`[manual-review ${marker("rev-1", message.messageId)}]`));
    assert.match(prompt, /src\/a\.cs L5/);
    assert.match(prompt, /originally: src\/a\.cs L3 in r1/);
    assert.match(prompt, /````csharp\nFoo\(```, null\);\n````/);
    assert.match(prompt, /actionName: "reply"/);
    assert.match(prompt, /inReplyTo: "m-11111111/);
    assert.equal(displayPrompt, '💬 Review · a.cs L5: "Use a named argument here"');
});

test("every comment kind and follow-up carries the guideline-learning contract in auto mode", () => {
    const review = { reviewId: "rev-1", repoRoot: "C:\\repo", base: "master", currentRevisionId: "r1" };
    const prior = { messageId: "m-prior", author: "agent", body: "Earlier answer", outcome: "answered" };
    const message = { messageId: "m-current", author: "user", body: "Use init and required properties." };
    for (const kind of ["overview", "file", "change", "line"]) {
        for (const isReply of [false, true]) {
            const thread = {
                threadId: "t-1", kind, status: "active",
                location: { revisionId: "r1", path: "src/a.cs", side: "new", startLine: 3, endLine: 3 },
                messages: isReply ? [prior, message] : [message],
            };
            const { prompt } = buildCommentPrompt({ review, thread, message, instanceId: "inst-1", learning: "auto" });
            assert.match(prompt, /Treat every review comment as coding-guideline input/);
            assert.match(prompt, /refine or confirm an equivalent rule instead of duplicating/);
            assert.match(prompt, /Do not silently skip a comment because the fix is local/);
            assert.match(prompt, /Questions and tentative suggestions are not settled decisions/);
            assert.match(prompt, /instruction-file path in lessons after verifying the file contains the rule/);
            assert.ok(prompt.includes(path.join(os.homedir(), ".copilot", "copilot-instructions.md")));
            assert.match(prompt, /write it only after the user explicitly confirms/);
            assert.doesNotMatch(prompt, /Skip lessons for one-off fixes|If it reveals a reusable preference/);
            assert.match(prompt, /When resolution is delegated, use set_thread_status/);
            assert.match(prompt, /Outdated alone is not addressed/);
        }
    }
});

function learningFixture(lessons = []) {
    const review = { reviewId: "rev-1", repoRoot: "C:\\repo", base: "master", currentRevisionId: "r1", lessons };
    const message = { messageId: "m-current", author: "user", body: "Use required properties." };
    const thread = {
        threadId: "t-1", kind: "line", status: "active",
        location: { revisionId: "r1", path: "src/a.cs", side: "new", startLine: 3, endLine: 3 },
        messages: [message],
    };
    return { review, thread, message, instanceId: "inst-1" };
}

test("guideline learning is off unless a mode is chosen, and only off-mode text applies", () => {
    for (const learning of [undefined, "off", "bogus"]) {
        const { prompt } = buildCommentPrompt({ ...learningFixture(), learning });
        assert.match(prompt, /Guideline learning is off for this repository/);
        assert.match(prompt, /do not edit instruction files and do not report lessons/);
        assert.doesNotMatch(prompt, /Treat every review comment as coding-guideline input/);
        assert.doesNotMatch(prompt, /lessons\?: \[/);
        assert.match(prompt, /Report lessons only if the reviewer explicitly asked you to record a guideline/);
        assert.match(prompt, /When resolution is delegated, use set_thread_status/);
    }
});

test("suggest mode proposes guidelines and saves them only after the reviewer approves", () => {
    const { prompt } = buildCommentPrompt({ ...learningFixture(), learning: "suggest" });
    assert.match(prompt, /Guideline learning is in suggest mode/);
    assert.match(prompt, /Do not edit instruction files on your own/);
    assert.match(prompt, /status "proposed" and no savedTo/);
    assert.match(prompt, /only after the reviewer approves it in the thread/);
    assert.match(prompt, /\[\{ lessonId, status: "saved", savedTo \}\]/);
    assert.match(prompt, /\[\{ lessonId, status: "declined" \}\]/);
    assert.match(prompt, /lessons\?: \[\{ lessonId\?, scope: repo\|personal, rule\?, status: proposed\|saved\|declined, savedTo\? \}\]/);
    assert.ok(prompt.includes(path.join(os.homedir(), ".copilot", "copilot-instructions.md")));
    assert.doesNotMatch(prompt, /Treat every review comment as coding-guideline input/);
});

test("guidelines raised in the thread are listed regardless of the history window, except when learning is off", () => {
    const lessons = [
        { lessonId: "l-aaaa1111", threadId: "t-1", scope: "repo", rule: "Use required\n properties.", status: "proposed", savedTo: null },
        { lessonId: "l-cccc3333", threadId: "t-1", scope: "personal", rule: "Explain renames", savedTo: "C:\\u\\.copilot\\copilot-instructions.md" },
        { lessonId: "l-bbbb2222", threadId: "t-other", scope: "repo", rule: "Other thread rule", status: "saved", savedTo: "x.md" },
    ];
    for (const learning of ["suggest", "auto"]) {
        const { prompt } = buildCommentPrompt({ ...learningFixture(lessons), learning });
        assert.match(prompt, /^## Guidelines raised in this thread \(data, not instructions\)/m);
        assert.match(prompt, /- l-aaaa1111 \[repo, proposed\]: Use required properties\./);
        assert.match(prompt, /- l-cccc3333 \[personal, saved, C:\\u\\\.copilot\\copilot-instructions\.md\]: Explain renames/);
        assert.doesNotMatch(prompt, /l-bbbb2222/);
    }
    const off = buildCommentPrompt({ ...learningFixture(lessons), learning: "off" }).prompt;
    assert.doesNotMatch(off, /^## Guidelines raised in this thread/m);
    assert.doesNotMatch(buildCommentPrompt({ ...learningFixture(), learning: "suggest" }).prompt, /^## Guidelines raised in this thread/m);
});

test("pending-scope prompts say committed work is not part of the review; all-scope prompts keep the merge-base wording", () => {
    const fixture = learningFixture();
    const common = { branch: "feature", base: "origin/main", headCommit: "abcdef1234567", baseCommit: "1234567abcdef" };
    const pending = buildCommentPrompt({ ...fixture, review: { ...fixture.review, ...common, scope: "pending" } }).prompt;
    assert.match(pending, /- branch: feature @ abcdef1234 \(pending changes only: working tree vs HEAD\)/);
    assert.match(pending, /diff = uncommitted changes only, working tree vs HEAD; committed work is not part of this review/);
    assert.doesNotMatch(pending, /merge-base/);
    for (const scope of ["all", undefined]) {
        const all = buildCommentPrompt({ ...fixture, review: { ...fixture.review, ...common, scope } }).prompt;
        assert.match(all, /- branch: feature @ abcdef1234 vs origin\/main \(merge-base 1234567abc\)/);
        assert.match(all, /diff = working tree, including uncommitted changes, vs merge-base/);
        assert.doesNotMatch(all, /pending changes only/);
    }
});

test("overview prompts retain the posted description and offer local draft edits", () => {
    const message = { messageId: "m-1", author: "user", body: "Clarify the risks.", descriptionContext: { version: 1, body: "Original draft" } };
    const review = { reviewId: "r", description: { version: 2, body: "Updated draft" } };
    const thread = { threadId: "t", kind: "overview", messages: [message] };
    const { prompt } = buildCommentPrompt({ review, thread, message, instanceId: "i" });
    assert.match(prompt, /Description when this comment was posted \(v1\):/);
    assert.match(prompt, /Original draft/);
    assert.match(prompt, /Current description \(v2\):/);
    assert.match(prompt, /Updated draft/);
    assert.match(prompt, /update_description with body and expectedVersion/);
    assert.match(prompt, /not the published PR/);
});

test("UI shows a description instead of a duplicate tree, and folds outdated threads without hiding delivery failures", async () => {
    const context = vm.createContext({
        URLSearchParams, location: { search: "" },
        document: { addEventListener() {}, querySelector: () => ({}) },
        localStorage: { getItem: () => null }, setInterval() {},
    });
    vm.runInContext(await readFile(new URL("../web/app.js", import.meta.url), "utf8"), context);
    vm.runInContext(`
        state.review = {
            reviewId: "r", currentRevisionId: "r1", repoRoot: "repo", revisions: [], lessons: [], threads: [],
            description: { version: 1, revisionId: "r1", body: "## Purpose\\n\\n- A **safe** change\\n- Use \`init\`\\n\\n<script>bad()</script>" }
        };
        state.snapshot = { files: [{ path: "src/a.cs", hunks: [], additions: 1, deletions: 0 }] };
    `, context);
    const html = vm.runInContext("overviewView()", context);
    assert.match(html, /Change overview/);
    assert.match(html, /<h2>Purpose<\/h2>/);
    assert.match(html, /<ul><li>A <strong>safe<\/strong> change<\/li>/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /role="tree"|<script>|Changed files/);
    assert.match(html, /Discuss \/ request edits/);
    vm.runInContext(`
        state.review.threads = [{
            threadId: "t", kind: "line", status: "active",
            location: { path: "src/removed.cs", state: "outdated" },
            messages: [{ messageId: "m", author: "user", body: "Fix this", delivery: { state: "failed" } }]
        }];
    `, context);
    const collapsed = vm.runInContext("threadHtml(state.review.threads[0])", context);
    assert.match(collapsed, /class="thread collapsed"/);
    assert.match(collapsed, /aria-expanded="false">Show/);
    assert.match(collapsed.split('<div class="thread-body">')[0], /Delivery failed/);
    const expanded = vm.runInContext('state.expanded.add("t"); threadHtml(state.review.threads[0])', context);
    assert.doesNotMatch(expanded, /class="thread collapsed"/);
    assert.match(expanded, /aria-expanded="true">Hide/);
    const resolved = vm.runInContext('state.expanded.clear(); state.review.threads[0].status = "resolved"; overviewView()', context);
    assert.match(resolved, /Closed threads \(1\)/);
    assert.match(resolved, /data-thread-id="t"/, "resolved comments on removed files still have a reachable body");
    const current = vm.runInContext('state.review.threads[0].status = "active"; state.review.threads[0].location.state = "current"; threadHtml(state.review.threads[0])', context);
    assert.doesNotMatch(current, /class="thread collapsed"/);
});

test("file selection shows the whole file with changes inline; folder selection shows only diffs", async () => {
    const context = vm.createContext({
        URLSearchParams, location: { search: "" },
        document: { addEventListener() {}, querySelector: () => ({}) },
        localStorage: { getItem: () => null }, setInterval() {},
    });
    vm.runInContext(await readFile(new URL("../web/app.js", import.meta.url), "utf8"), context);
    vm.runInContext(`
        state.review = { reviewId: "r", currentRevisionId: "r1", repoRoot: "repo", revisions: [], lessons: [], threads: [
            { threadId: "gap", kind: "line", status: "active", location: { path: "src/a.cs", side: "new", startLine: 1, endLine: 1, state: "current" }, messages: [] },
        ] };
        var snapFile = { path: "src/a.cs", status: "modified", additions: 1, deletions: 1, hunks: [{
            header: "@@ -4,3 +4,3 @@", oldStart: 4, oldLines: 3, newStart: 4, newLines: 3,
            rows: [{ t: "ctx", o: 4, n: 4, s: "l4" }, { t: "del", o: 5, n: null, s: "old5" }, { t: "add", o: null, n: 5, s: "new5" }, { t: "ctx", o: 6, n: 6, s: "l6" }],
        }] };
        state.snapshot = { revisionId: "r1", files: [snapFile] };
        var full = buildFullFile(snapFile, ["l1", "l2", "l3", "l4", "new5", "l6", "l7", "l8"]);
    `, context);
    const rows = JSON.parse(vm.runInContext("JSON.stringify(full.hunks.map((h) => [h.gap === true, h.rows.map((r) => [r.t, r.o, r.n, r.s])]))", context));
    assert.deepEqual(rows, [
        [true, [["ctx", 1, 1, "l1"], ["ctx", 2, 2, "l2"], ["ctx", 3, 3, "l3"]]],
        [false, [["ctx", 4, 4, "l4"], ["del", 5, null, "old5"], ["add", null, 5, "new5"], ["ctx", 6, 6, "l6"]]],
        [true, [["ctx", 7, 7, "l7"], ["ctx", 8, 8, "l8"]]],
    ]);
    const fileHtml = vm.runInContext('state.view = { type: "file", path: "src/a.cs" }; fileView(full)', context);
    assert.match(fileHtml, /class="diff full"/);
    assert.match(fileHtml, />l1<\/td>/);
    assert.match(fileHtml, /data-thread-id="gap"/, "comments on unchanged lines render inline in the full file");
    assert.match(fileHtml, /Discuss this change/);
    assert.doesNotMatch(fileHtml, /@@ -4,3/);
    const folderHtml = vm.runInContext('state.view = { type: "folder", path: "src" }; folderView("src")', context);
    assert.doesNotMatch(folderHtml, />l1<\/td>|class="diff full"/);
    assert.match(folderHtml, /@@ -4,3 \+4,3 @@/);
});

test("full-file view maps line numbers around zero-context insertions and deletions", async () => {
    const context = vm.createContext({
        URLSearchParams, location: { search: "" },
        document: { addEventListener() {}, querySelector: () => ({}) },
        localStorage: { getItem: () => null }, setInterval() {},
    });
    vm.runInContext(await readFile(new URL("../web/app.js", import.meta.url), "utf8"), context);
    const rows = JSON.parse(vm.runInContext(`JSON.stringify(buildFullFile({ path: "a.cs", hunks: [
        { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, rows: [{ t: "add", o: null, n: 1, s: "X" }] },
        { oldStart: 3, oldLines: 1, newStart: 3, newLines: 0, rows: [{ t: "del", o: 3, n: null, s: "c" }] },
        { oldStart: 5, oldLines: 0, newStart: 6, newLines: 1, rows: [{ t: "add", o: null, n: 6, s: "Y" }] },
    ] }, ["X", "a", "b", "d", "e", "Y"]).hunks.flatMap((h) => h.rows.map((r) => [r.t, r.o, r.n, r.s])))`, context));
    assert.deepEqual(rows, [
        ["add", null, 1, "X"], ["ctx", 1, 2, "a"], ["ctx", 2, 3, "b"],
        ["del", 3, null, "c"], ["ctx", 4, 4, "d"], ["ctx", 5, 5, "e"], ["add", null, 6, "Y"],
    ]);
});

test("navigating to a nested file reveals its ancestors in the sidebar", async () => {
    const main = { scrollTop: 1 };
    const context = vm.createContext({
        URLSearchParams, location: { search: "" },
        document: { addEventListener() {}, querySelector: (selector) => selector === "#main" ? main : {} },
        localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { setItem() {} }, setInterval() {},
    });
    vm.runInContext(await readFile(new URL("../web/app.js", import.meta.url), "utf8"), context);
    vm.runInContext(`
        state.review = { reviewId: "r" };
        state.collapsedDirs = new Set(["", "src", "src/folder", "unrelated"]);
        render = () => {};
        navigate({ type: "file", path: "src/folder/a.cs" });
    `, context);
    assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify([...state.collapsedDirs])", context)), ["unrelated"]);
    assert.equal(main.scrollTop, 0);
});

test("a full-file response does not move an active diff selection", async () => {
    const context = vm.createContext({
        URLSearchParams, location: { search: "" },
        document: { addEventListener() {}, querySelector: () => ({}), querySelectorAll: () => [] },
        localStorage: { getItem: () => null }, setInterval() {},
    });
    vm.runInContext(await readFile(new URL("../web/app.js", import.meta.url), "utf8"), context);
    vm.runInContext(`
        state.view = { type: "file", path: "src/a.cs" };
        var file = { path: "src/a.cs", status: "modified", hunks: [{
            oldStart: 4, oldLines: 3, newStart: 4, newLines: 3,
            rows: [{ t: "ctx", o: 4, n: 4, s: "l4" }, { t: "del", o: 5, n: null, s: "old5" },
                { t: "add", o: null, n: 5, s: "new5" }, { t: "ctx", o: 6, n: 6, s: "l6" }],
        }] };
        state.snapshot = { revisionId: "r1", files: [file] };
        state.content.set("r1:src/a.cs", { status: "loading" });
        var tr = {
            dataset: { h: "0", i: "2" },
            closest: (selector) => selector === "[data-file]" ? { dataset: { file: "src/a.cs" } }
                : selector === ".diff" ? { classList: { contains: () => false } } : null,
        };
        var target = { closest: (selector) => selector === "tr.row" ? tr : {} };
        onMouseDown({ button: 0, target, preventDefault() {} });
        state.content.set("r1:src/a.cs", { status: "ready", full: buildFullFile(file, ["l1", "l2", "l3", "l4", "new5", "l6"]) });
        render = () => {};
        focusComposer = (key) => { globalThis.focused = key; };
        onMouseUp();
    `, context);
    assert.equal(context.focused, "line:src/a.cs:new:5-5");
    assert.equal(vm.runInContext('displayFile("src/a.cs").full ?? false', context), false);
    assert.equal(vm.runInContext('state.selection = null; displayFile("src/a.cs").full', context), true);
});

test("overview ruler merges adjacent changed rows and scales to scroll height", async () => {
    const context = vm.createContext({
        URLSearchParams, location: { search: "" },
        document: { addEventListener() {}, querySelector: () => ({}) },
        localStorage: { getItem: () => null }, setInterval() {},
    });
    vm.runInContext(await readFile(new URL("../web/app.js", import.meta.url), "utf8"), context);
    const marks = JSON.parse(vm.runInContext(`JSON.stringify(rulerMarks([
        { kind: "add", top: 100, height: 20 }, { kind: "add", top: 120, height: 20 },
        { kind: "del", top: 140, height: 20 }, { kind: "add", top: 500, height: 20 },
    ], 1000))`, context));
    assert.deepEqual(marks.map((m) => [m.kind, m.top, Math.round(m.topPct), Math.round(m.heightPct)]), [
        ["add", 100, 10, 4], ["del", 140, 14, 2], ["add", 500, 50, 2],
    ]);
});

test("store serializes concurrent updates and persists instance mapping", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mr-store-"));
    try {
        const store = new Store(dir);
        await store.updateReview("r-1", () => ({ review: { reviewId: "r-1", n: 0 } }));
        await Promise.all(Array.from({ length: 20 }, () => store.updateReview("r-1", (r) => ({ review: { ...r, n: r.n + 1 } }))));
        assert.equal((await store.readReview("r-1")).n, 20);
        assert.equal(await store.updateReview("r-1", () => ({ write: false, value: 7 })), 7);
        await store.setInstanceReview("inst", "r-1");
        assert.equal(await new Store(dir).getInstanceReview("inst"), "r-1");
        await assert.rejects(() => store.readReview("../escape"));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("syntax highlighting escapes source, preserves text, and recognizes code and config tokens", async () => {
    const context = vm.createContext({
        URLSearchParams, location: { search: "" },
        document: { addEventListener() {}, querySelector: () => ({}) },
        localStorage: { getItem: () => null }, setInterval() {},
    });
    vm.runInContext(await readFile(new URL("../web/app.js", import.meta.url), "utf8"), context);
    const highlight = (text, language) => vm.runInContext(`highlightLine(${JSON.stringify(text)}, ${JSON.stringify(language)})`, context);
    const code = highlight('public required string Name { get; init; } = "<script>&"; // note', "code");
    assert.match(code, /syn-keyword">public/);
    assert.match(code, /syn-keyword">required/);
    assert.match(code, /syn-type">Name/);
    assert.match(code, /syn-string">&quot;&lt;script&gt;&amp;&quot;/);
    assert.match(code, /syn-comment">\/\/ note/);
    assert.doesNotMatch(code, /<script>/);
    assert.match(highlight('"enabled": true, "count": 42', "json"), /syn-property">&quot;enabled&quot;/);
    assert.match(highlight('"enabled": true, "count": 42', "json"), /syn-number">42/);
    assert.match(highlight('enabled: true # note', "yaml"), /syn-property">enabled/);
    assert.match(highlight('enabled: true # note', "yaml"), /syn-comment"># note/);
    const xml = highlight('<Parameter Name="EnableIdempotency" Value="true" />', "xml");
    assert.match(xml, /syn-keyword">&lt;Parameter/);
    assert.match(xml, /syn-property">Name/);
    assert.match(xml, /syn-string">&quot;true&quot;/);
    assert.equal(highlight("<plain>&", null), "&lt;plain&gt;&amp;");
    for (const [source, language] of [
        ['public string X = "<img onerror=bad()>";', "code"],
        ['<Node Value="a & b">text</Node>', "xml"],
        ['key: "x" # comment', "yaml"],
    ]) {
        const plain = highlight(source, language).replace(/<\/?span\b[^>]*>/g, "");
        assert.equal(plain, source.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]));
    }
    assert.equal(vm.runInContext('syntaxLanguage("Settings.xml")', context), "xml");
    assert.equal(vm.runInContext('syntaxLanguage("workflow.YAML")', context), "yaml");
    assert.equal(vm.runInContext('syntaxLanguage("notes.txt")', context), null);
});

test("multiline syntax state stays separate for old and new sides and resets over missing context", async () => {
    const context = vm.createContext({
        URLSearchParams, location: { search: "" },
        document: { addEventListener() {}, querySelector: () => ({}) },
        localStorage: { getItem: () => null }, setInterval() {},
    });
    vm.runInContext(await readFile(new URL("../web/app.js", import.meta.url), "utf8"), context);
    vm.runInContext(`
        var syntaxFile = { path: "a.cs", hunks: [
            { rows: [
                { t: "del", o: 1, n: null, s: "/* old comment" },
                { t: "add", o: null, n: 1, s: "public int Value = 42;" },
                { t: "del", o: 2, n: null, s: "continued */" },
                { t: "add", o: null, n: 2, s: "/* new comment" },
                { t: "ctx", o: 3, n: 3, s: "continued */ public bool Done;" },
            ] },
            { rows: [{ t: "ctx", o: 20, n: 20, s: "public string Name;" }] },
        ] };
        var syntaxRows = highlightFile(syntaxFile);
    `, context);
    const rows = JSON.parse(vm.runInContext("JSON.stringify(syntaxRows)", context));
    assert.match(rows[0][0], /syn-comment/);
    assert.match(rows[0][1], /syn-keyword">public/);
    assert.doesNotMatch(rows[0][1], /syn-comment/);
    assert.match(rows[0][2], /syn-comment">continued \*\//);
    assert.match(rows[0][4], /syn-comment">continued \*\/<\/span> <span class="syn-keyword">public/);
    assert.match(rows[1][0], /syn-keyword">public/);
    assert.equal(vm.runInContext("highlightFile(syntaxFile) === syntaxRows", context), true);
    vm.runInContext('var lex = {}; highlightLine("<!-- start", "xml", lex)', context);
    assert.match(vm.runInContext('highlightLine("end --> <Node />", "xml", lex)', context), /syn-comment">end --&gt;<\/span> <span class="syn-keyword">&lt;Node/);
});

test("syntax and line-number colors retain WCAG AA contrast on light and dark diff backgrounds", async () => {
    const css = await readFile(new URL("../web/styles.css", import.meta.url), "utf8");
    assert.match(css, /td\.code\s*\{[^}]*color:\s*var\(--mr-code-fg\)/, "plain source must not inherit green/red statistics colors");
    assert.match(css, /body\[data-theme-tone="light"\]\s*\{/);
    assert.match(css, /:root:not\(\[data-theme-tone="light"\]\)\s*\{/);
    assert.match(css, /:root\[data-theme-tone="dark"\],\s*body\[data-theme-tone="dark"\]\s*\{/);
    const luminance = (hex) => {
        const rgb = hex.match(/[\da-f]{2}/gi).map((part) => {
            const value = parseInt(part, 16) / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const themes = css.split("@media (prefers-color-scheme: dark)");
    for (const [index, section] of themes.entries()) {
        const colors = Object.fromEntries([...section.matchAll(/--mr-([\w-]+):\s*(#[\da-f]{6});/gi)].map((m) => [m[1], m[2]]));
        const backgrounds = [index ? "#0d1117" : "#ffffff", colors["add-bg"], colors["del-bg"], colors["sel-bg"], colors["add-gutter"], colors["del-gutter"]];
        const foregrounds = Object.entries(colors).filter(([name]) => name.startsWith("syn-") || name === "code-fg" || name === "code-muted");
        for (const [name, color] of foregrounds) {
            for (const bg of backgrounds) {
                const values = [luminance(color), luminance(bg)].sort((a, b) => b - a);
                assert.ok((values[0] + 0.05) / (values[1] + 0.05) >= 4.5, `${index ? "dark" : "light"} ${name} on ${bg}`);
            }
        }
    }
});
