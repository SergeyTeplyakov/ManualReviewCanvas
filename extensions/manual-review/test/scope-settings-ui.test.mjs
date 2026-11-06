import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Loads the page script into a bare vm context. Elements are created on demand and remembered per selector,
// so a test can render one piece of the page and read its markup back.
async function loadApp(globals = {}) {
    const nodes = new Map();
    const focused = [];
    const node = (selector) => {
        if (!nodes.has(selector)) nodes.set(selector, { innerHTML: "", textContent: "", className: "", hidden: false, scrollTop: 0, focus: () => focused.push(selector) });
        return nodes.get(selector);
    };
    const storage = () => {
        const items = new Map();
        return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)), removeItem: (key) => items.delete(key) };
    };
    const document = { addEventListener() {}, querySelector: node, querySelectorAll: () => [], activeElement: null };
    const sessionStorage = storage();
    const context = vm.createContext({
        URLSearchParams, location: { search: "" }, document, localStorage: storage(), sessionStorage,
        setInterval() {}, setTimeout: () => 0, clearTimeout() {}, ...globals,
    });
    vm.runInContext(await readFile(new URL("../web/app.js", import.meta.url), "utf8"), context);
    return {
        document, sessionStorage, focused, node,
        state: vm.runInContext("state", context),
        run: (code) => vm.runInContext(code, context),
        read: (expression) => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)),
    };
}

const reviewFixture = (overrides = {}) => ({
    reviewId: "r", title: "Feature work", base: "main", branch: "feature", scope: "all", currentRevisionId: "r1",
    revisions: [{ revisionId: "r1", files: 2, additions: 3, deletions: 1, createdAt: "2026-01-01T00:00:00Z" }],
    git: { branch: "feature", headCommit: "abc", baseCommit: "def", upstream: { name: "origin/feature", ahead: 1, behind: 2 }, uncommittedFiles: 3 },
    threads: [], lessons: [],
    ...overrides,
});
const settingsFixture = (overrides = {}) => ({ repoName: "repo", learning: "off", configured: false, dismissed: false, ...overrides });
const jsonResponse = (data, status = 200) => ({ ok: status < 400, status, statusText: status < 400 ? "OK" : "Error", json: async () => data });
const clicker = (app) => (action, dataset = {}) => {
    const target = { tagName: "BUTTON", dataset: { action, ...dataset } };
    target.closest = () => target;
    return app.run("onClick")({ target });
};

test("the page provides every container the scope and learning controls render into", async () => {
    const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
    for (const id of ["top", "banner", "layout", "side", "main", "ruler", "dialog", "toast"]) assert.match(html, new RegExp(`id="${id}"`), id);
});

test("the top bar shows the review scope, and the learning controls only when the settings are known", async () => {
    const app = await loadApp();
    const top = () => {
        app.run("renderTop()");
        return app.node("#top").innerHTML;
    };
    const toggle = (html) => html.match(/<span class="seg"[^>]*>.*?<\/span>/)[0];
    app.state.settings = settingsFixture({ configured: true });

    app.state.review = reviewFixture();
    let html = top();
    assert.match(html, /data-scope="all" aria-pressed="true"/);
    assert.match(html, /data-scope="pending" aria-pressed="false"/);
    assert.match(html, /<span class="muted">vs<\/span><span class="pill mono" title="merge-base def">main<\/span>/);
    assert.match(html, /↑1 ↓2/);
    assert.match(html, />3 uncommitted</);
    assert.doesNotMatch(toggle(html), /disabled/);

    app.state.review = reviewFixture({ git: { branch: "feature", uncommittedFiles: 0 } });
    html = top();
    assert.match(html, /no upstream/);
    assert.doesNotMatch(html, /\d+ uncommitted/);

    app.state.review = reviewFixture({ scope: "pending", title: "feature (pending changes)", branch: 'x"><img src=1>' });
    html = top();
    assert.match(html, /data-scope="all" aria-pressed="false"/);
    assert.match(html, /data-scope="pending" aria-pressed="true"/);
    assert.match(html, /<span class="muted">uncommitted changes only<\/span>/);
    assert.doesNotMatch(html, />vs<|merge-base|↑|no upstream|\d+ uncommitted|<img/, "pending changes have no base, upstream or uncommitted count to show");

    app.state.switching = true;
    assert.equal(toggle(top()).match(/ disabled/g).length, 2, "both scope buttons are disabled while a switch is in flight");
    app.state.switching = false;

    for (const [learning, pill] of [["off", "Off"], ["suggest", "Suggest"], ["auto", "Auto-save"], ["unexpected", "Off"]]) {
        app.state.settings = settingsFixture({ learning, configured: true });
        assert.match(top(), new RegExp(`Learning: ${pill}</span><button data-action="configure"`), learning);
    }
    app.state.settings = null;
    html = top();
    assert.doesNotMatch(html, /Learning:|data-action="configure"/);
    assert.match(html, /data-action="refresh"/);
});

test("the first-use banner offers Suggest or Save automatically, never Off, and only while the repository is undecided", async () => {
    const app = await loadApp();
    const banner = (settings) => {
        app.state.settings = settings;
        app.run("renderBanner()");
        return app.node("#banner");
    };
    assert.equal(banner(null).hidden, true);
    assert.equal(banner(settingsFixture({ configured: true })).hidden, true);
    assert.equal(banner(settingsFixture({ dismissed: true })).hidden, true);
    assert.equal(app.node("#banner").innerHTML, "");

    const shown = banner(settingsFixture({ repoName: "<img src=x>" }));
    assert.equal(shown.hidden, false);
    assert.match(shown.innerHTML, /Learn from your review feedback in &lt;img src=x&gt;\?/);
    assert.doesNotMatch(shown.innerHTML, /<img/);
    assert.match(shown.innerHTML, /data-action="learning-set" data-mode="suggest" class="primary"[^>]*>Suggest</);
    assert.match(shown.innerHTML, /data-action="learning-set" data-mode="auto"(?! class="primary")[^>]*>Save automatically</);
    assert.doesNotMatch(shown.innerHTML, /data-mode="off"/);
    assert.match(shown.innerHTML, /data-action="learning-dismiss"[^>]*>Not now</);
});

test("the Configure dialog is an accessible modal that preselects the draft mode and locks while saving", async () => {
    const app = await loadApp();
    assert.equal(app.run("dialogHtml()"), "", "closed by default");
    app.state.settings = settingsFixture({ repoName: "Org/Repo <x>", learning: "suggest", configured: true });
    app.state.dialog = { learning: "suggest", saving: false, error: "" };
    const html = app.run("dialogHtml()");
    assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-desc"/);
    assert.match(html, /<h2 id="dialog-title">Learn from review feedback<\/h2>/);
    assert.match(html, /<p id="dialog-desc" class="muted">Setting for Org\/Repo &lt;x&gt;\. /);
    assert.deepEqual(
        [...html.matchAll(/<input type="radio" name="learning" value="(\w+)"( checked)?>/g)].map((m) => [m[1], Boolean(m[2])]),
        [["off", false], ["suggest", true], ["auto", false]],
    );
    assert.match(html, /<span class="choice-title">Save automatically<\/span>/);
    assert.doesNotMatch(html, /role="alert"|\sdisabled[\s>]/);
    assert.match(html, /data-action="dialog-save">Save<\/button>/);

    app.state.dialog = { learning: "auto", saving: true, error: "Could not save <b>" };
    const busy = app.run("dialogHtml()");
    assert.match(busy, /<div class="modal-error" role="alert">Could not save &lt;b&gt;<\/div>/);
    assert.match(busy, /data-action="dialog-cancel" disabled>/);
    assert.match(busy, /data-action="dialog-save" disabled>Saving…<\/button>/);
    assert.match(busy, /value="auto" checked/);

    app.state.settings = settingsFixture({ repoName: undefined });
    assert.match(app.run("dialogHtml()"), /Setting for this repository\./);
});

test("the Configure dialog opens on the saved mode, keeps the page inert behind it, traps Tab, and closes on Escape", async () => {
    const app = await loadApp();
    let prevented = 0;
    const press = (event) => app.run("onKeyDown")({ preventDefault: () => prevented++, ...event });
    app.state.review = reviewFixture();

    app.state.settings = null;
    app.run("openConfigure()");
    assert.equal(app.state.dialog, null, "there is nothing to configure until the server reports the settings");
    app.state.settings = settingsFixture({ learning: "auto", configured: true });

    app.run("openConfigure()");
    assert.equal(app.state.dialog.learning, "auto");
    assert.match(app.node("#dialog").innerHTML, /value="auto" checked/);
    for (const id of ["#top", "#banner", "#layout"]) assert.equal(app.node(id).inert, true, id);
    assert.equal(app.focused.at(-1), '#dialog input[name="learning"]:checked');
    const opened = app.state.dialog;
    app.run("openConfigure()");
    assert.equal(app.state.dialog, opened, "opening twice keeps the first dialog");

    await app.run("onChange")({ target: { name: "learning", value: "off" } });
    assert.equal(app.state.dialog.learning, "off");
    assert.equal(app.state.settings.learning, "auto", "the choice is only a draft until Save");

    const focus = [];
    const radios = [{ checked: false }, { checked: true, focus: () => focus.push("radio") }, { checked: false }];
    const buttons = [{ focus: () => focus.push("cancel") }, { focus: () => focus.push("save") }];
    app.document.querySelectorAll = (selector) => (selector.startsWith("#dialog input") ? radios : buttons);
    app.document.activeElement = buttons[1];
    press({ key: "Tab", shiftKey: false });
    app.document.activeElement = radios[1];
    press({ key: "Tab", shiftKey: true });
    app.document.activeElement = buttons[0];
    press({ key: "Tab", shiftKey: false });
    assert.deepEqual(focus, ["radio", "save"], "Tab wraps from the last stop to the first, and Shift+Tab from the first to the last");
    assert.equal(prevented, 2, "Tab between the stops is left to the browser");

    press({ key: "Escape" });
    assert.equal(app.state.dialog, null);
    assert.equal(prevented, 3);
    assert.equal(app.node("#dialog").innerHTML, "");
    for (const id of ["#top", "#banner", "#layout"]) assert.equal(app.node(id).inert, false, id);
    assert.equal(app.focused.at(-1), '[data-action="configure"]', "focus returns to the button that opened the dialog");

    app.run("openConfigure()");
    app.state.dialog.saving = true;
    press({ key: "Escape" });
    assert.notEqual(app.state.dialog, null, "a save in flight cannot be dismissed");
});

test("choosing a mode from the banner or the Configure dialog saves it, updates the controls, and reports a failed save", async () => {
    const posts = [];
    let settings = settingsFixture();
    let failure = null;
    const fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        posts.push([init.method, url, body]);
        if (failure) return jsonResponse({ error: { message: failure } }, 500);
        settings = { ...settings, ...(body.learning ? { learning: body.learning, configured: true } : {}), ...(body.dismissed ? { dismissed: true } : {}) };
        return jsonResponse(settings);
    };
    const app = await loadApp({ fetch });
    const click = clicker(app);
    app.state.review = reviewFixture();
    app.state.settings = settings;
    app.run("renderBanner()");
    assert.equal(app.node("#banner").hidden, false);

    await click("learning-set", { mode: "suggest" });
    assert.deepEqual(posts.at(-1), ["POST", "/api/settings", { learning: "suggest" }]);
    assert.equal(app.state.settings.learning, "suggest");
    assert.equal(app.node("#banner").hidden, true, "choosing a mode settles the question");
    assert.match(app.node("#top").innerHTML, /Learning: Suggest/);
    assert.equal(app.node("#toast").textContent, "Learning mode: Suggest");

    settings = settingsFixture();
    app.state.settings = settings;
    await click("learning-dismiss");
    assert.deepEqual(posts.at(-1), ["POST", "/api/settings", { dismissed: true }]);
    assert.equal(app.node("#banner").hidden, true);
    assert.equal(app.state.settings.configured, false, "Not now leaves the repository unconfigured");
    assert.match(app.node("#top").innerHTML, /Learning: Off/);

    await click("configure");
    assert.equal(app.state.dialog.learning, "off");
    await app.run("onChange")({ target: { name: "learning", value: "auto" } });
    await click("dialog-save");
    assert.deepEqual(posts.at(-1), ["POST", "/api/settings", { learning: "auto" }]);
    assert.equal(app.state.dialog, null);
    assert.equal(app.state.settings.learning, "auto");
    assert.equal(app.node("#dialog").innerHTML, "");
    assert.match(app.node("#top").innerHTML, /Learning: Auto-save/);
    assert.equal(app.node("#toast").textContent, "Learning mode: Save automatically");
    assert.equal(app.focused.at(-1), '[data-action="configure"]');

    await click("configure");
    failure = "disk full";
    await app.run("onChange")({ target: { name: "learning", value: "off" } });
    await click("dialog-save");
    assert.equal(app.state.dialog.saving, false);
    assert.equal(app.state.dialog.error, "disk full");
    assert.equal(app.state.settings.learning, "auto", "a failed save changes nothing");
    assert.match(app.node("#dialog").innerHTML, /role="alert">disk full</);
    assert.equal(app.focused.at(-1), '#dialog [data-action="dialog-save"]');
    failure = null;
    await click("dialog-save");
    assert.equal(app.state.dialog, null, "retrying after the failure succeeds");
    assert.equal(app.state.settings.learning, "off");

    failure = "offline";
    await click("learning-set", { mode: "auto" });
    assert.equal(app.state.settings.learning, "off");
    assert.equal(app.node("#toast").textContent, "offline");
    assert.equal(app.node("#toast").className, "error");
});

test("the Configure dialog closes from Cancel or a click on the backdrop, but not from a click inside it or while saving", async () => {
    const app = await loadApp();
    const click = clicker(app);
    app.state.review = reviewFixture();
    app.state.settings = settingsFixture({ configured: true });

    await click("configure");
    const backdrop = { tagName: "DIV", dataset: { action: "dialog-backdrop" } };
    backdrop.closest = () => backdrop;
    await app.run("onClick")({ target: { closest: () => backdrop } });
    assert.notEqual(app.state.dialog, null, "a click that landed inside the dialog does not close it");
    await app.run("onClick")({ target: backdrop });
    assert.equal(app.state.dialog, null);

    await click("configure");
    app.state.dialog.saving = true;
    await click("dialog-cancel");
    assert.notEqual(app.state.dialog, null);
    app.state.dialog.saving = false;
    await click("dialog-cancel");
    assert.equal(app.state.dialog, null);
});

test("lessons show their status next to each rule in the thread and in the Lessons learned table", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture({
        lessons: [
            { lessonId: "l-1", threadId: "t1", scope: "repo", rule: "Prefer `ILogger`", savedTo: "AGENTS.md", createdAt: "2026-01-01T00:00:00Z" },
            { lessonId: "l-2", threadId: "t1", scope: "personal", rule: "Keep <b>short</b>", status: "proposed", savedTo: null, createdAt: "2026-01-02T00:00:00Z" },
            { lessonId: "l-3", threadId: "t2", scope: "repo", rule: "Avoid globals", status: "declined", savedTo: null, createdAt: "2026-01-03T00:00:00Z" },
            { lessonId: "l-4", threadId: "t2", scope: "repo", rule: "Unknown status", status: "bogus", savedTo: null, createdAt: "2026-01-04T00:00:00Z" },
        ],
    });
    const message = (lessonIds) => app.run(`messageHtml(${JSON.stringify({ messageId: "m", author: "agent", body: "Done", outcome: "fixed", createdAt: "2026-01-02T00:00:00Z", lessonIds })})`);

    const html = message(["l-1", "l-2", "missing"]);
    assert.match(html, /<li><span class="badge">repo<\/span> <span class="badge lesson-saved"[^>]*>saved<\/span> Prefer <code>ILogger<\/code> <span class="muted mono">→ AGENTS\.md<\/span><\/li>/, "a lesson recorded before statuses existed was saved");
    assert.match(html, /<li><span class="badge">personal<\/span> <span class="badge lesson-proposed"[^>]*>proposed<\/span> Keep &lt;b&gt;short&lt;\/b&gt;<\/li>/, "a proposed lesson is not saved anywhere yet");
    assert.equal(html.match(/<li>/g).length, 2, "an unknown lesson id is skipped");
    assert.doesNotMatch(message([]), /Guidelines:/);

    const table = app.run("lessonsView()");
    assert.match(table, /<h2>Lessons learned \(4\)<\/h2>/);
    assert.match(table, /<th>Scope<\/th><th>Status<\/th><th>Rule<\/th><th>Saved to<\/th>/);
    assert.deepEqual([...table.matchAll(/badge lesson-(\w+)"/g)].map((m) => m[1]), ["saved", "declined", "proposed", "saved"], "newest first, and an unknown status reads as saved");
    assert.match(table, /<td class="mono muted">AGENTS\.md<\/td>/);
    assert.match(table, /Keep &lt;b&gt;short&lt;\/b&gt;/);
});

test("the empty Lessons learned view explains what the current learning mode does", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    const empty = (settings) => {
        app.state.settings = settings;
        return app.run("lessonsView()");
    };
    assert.match(empty(null), /^<h2>Lessons learned<\/h2><div class="empty">Copilot records reusable rules here/);
    assert.match(empty(settingsFixture({ learning: "suggest" })), /Copilot proposes reusable guidelines here.*saves one after you approve it/);
    assert.match(empty(settingsFixture({ learning: "auto" })), /Copilot saves reusable guidelines here/);
    for (const learning of ["off", "unexpected"]) assert.match(empty(settingsFixture({ learning })), /Learning is off for this repository.*Use Configure to turn it on/, learning);
});

test("an empty diff explains itself per scope, and only the pending scope offers the way back", async () => {
    const app = await loadApp();
    const empty = () => app.run("emptyDiffHtml()");
    app.state.review = reviewFixture({ scope: "pending", base: "origin/<main>" });
    assert.equal(empty(), "", "nothing is claimed before the snapshot loads");
    app.state.snapshot = { files: [{ path: "a.cs", hunks: [], additions: 1, deletions: 0 }] };
    assert.equal(empty(), "");

    app.state.snapshot = { files: [] };
    assert.match(empty(), /<strong>No uncommitted changes\.<\/strong>/);
    assert.match(empty(), /<button data-action="scope" data-scope="all">Switch to All changes<\/button>/);
    assert.match(app.run("overviewView()"), /^<div class="card empty-diff">/);
    app.run("renderSide()");
    assert.match(app.node("#side").innerHTML, /No uncommitted changes\./);

    for (const scope of ["all", undefined]) {
        app.state.review = reviewFixture({ scope, base: "origin/<main>" });
        const html = empty();
        assert.match(html, /<strong>No changes to review\.<\/strong> Nothing differs from origin\/&lt;main&gt;\./);
        assert.doesNotMatch(html, /<button/);
        app.run("renderSide()");
        assert.match(app.node("#side").innerHTML, /No changes against the base\./);
    }
});

test("switching scope loads the other review, remembers each review's own view, and never sticks in the switching state", async () => {
    const calls = [];
    const reviews = {
        a: reviewFixture({ reviewId: "a", currentRevisionId: "ra" }),
        b: reviewFixture({ reviewId: "b", currentRevisionId: "rb", scope: "pending" }),
    };
    let current = "a";
    let failure = null;
    let settings = settingsFixture({ configured: true });
    const fetch = async (url, init) => {
        calls.push(`${init.method} ${url}`);
        if (url === "/api/state") return jsonResponse({ review: reviews[current], session: { busy: false }, settings });
        if (url.startsWith("/api/snapshot/")) return jsonResponse({ revisionId: url.split("/").pop(), files: [] });
        if (url === "/api/scope") {
            if (failure) return jsonResponse({ error: { message: failure } }, 500);
            current = JSON.parse(init.body).scope === "pending" ? "b" : "a";
            return jsonResponse({ reviewId: current });
        }
        throw new Error(`unexpected request ${init.method} ${url}`);
    };
    const app = await loadApp({ fetch });
    const click = clicker(app);
    app.run("render = () => {}; var switchingSeen = []; renderTop = () => { switchingSeen.push(state.switching); };");

    await app.run("loadState()");
    assert.equal(app.state.review.reviewId, "a");
    assert.equal(app.state.snapshot.revisionId, "ra");

    app.run('navigate({ type: "file", path: "src/a.cs" })');
    app.run('state.open.add("line:src/a.cs:new:5-5"); state.expanded.add("t1"); state.fileFold.set("src/a.cs", true); state.content.set("ra:src/a.cs", {}); state.pendingJump = "t1"; collapsedDirs();');
    app.sessionStorage.items.set("mr:b:view", JSON.stringify({ type: "lessons" }));

    await click("scope", { scope: "pending" });
    assert.deepEqual(calls.slice(-3), ["POST /api/scope", "GET /api/state", "GET /api/snapshot/rb"]);
    assert.equal(app.state.review.reviewId, "b");
    assert.equal(app.state.snapshot.revisionId, "rb");
    assert.deepEqual(app.read("state.view"), { type: "lessons" }, "the other review restores its own view instead of inheriting this one");
    assert.deepEqual(app.read("[state.open.size, state.pending.size, state.expanded.size, state.fileFold.size, state.content.size]"), [0, 0, 0, 0, 0]);
    assert.equal(app.read("state.collapsedDirs"), null);
    assert.equal(app.read("state.pendingJump"), null);
    assert.equal(app.state.switching, false);

    const before = calls.length;
    await click("scope", { scope: "pending" });
    assert.equal(calls.length, before, "choosing the active scope does nothing");

    await app.run("loadState()");
    assert.deepEqual(calls.slice(before), ["GET /api/state"], "a refresh of the same review does not reload the snapshot");
    assert.deepEqual(app.read("state.view"), { type: "lessons" }, "and keeps the view");

    await click("scope", { scope: "all" });
    assert.equal(app.state.review.reviewId, "a");
    assert.deepEqual(app.read("state.view"), { type: "file", path: "src/a.cs" }, "switching back returns to where this review was left");

    failure = "boom";
    await click("scope", { scope: "pending" });
    assert.equal(app.state.review.reviewId, "a", "a failed switch stays on the current review");
    assert.equal(app.state.switching, false);
    assert.equal(app.node("#toast").textContent, "boom");
    assert.equal(app.node("#toast").className, "error");
    assert.deepEqual(app.read("switchingSeen"), [true, false, true, false, true, false]);

    settings = undefined;
    await app.run("loadState()");
    assert.equal(app.state.settings, null, "a server without settings hides the learning controls");
});
