// Manual review canvas client: renders the diff, inline threads, and composers; talks to the
// per-instance loopback server with the token from the URL.
const TOKEN = new URLSearchParams(location.search).get("t") ?? "";
const STATUSES = ["active", "resolved", "wontfix", "closed"];
const STALE_QUEUE_MS = 120000;

const state = {
    review: null,
    snapshot: null,
    busy: null,
    connection: "connecting",
    view: { type: "overview" },
    selection: null, // { path, hunk, anchor, from, to }
    dragging: false,
    open: new Set(), // explicitly opened composer keys (file/change/reply)
    pending: new Map(), // composer key -> { clientRequestId, sending, error }
    expanded: new Set(), // outdated or non-active threads explicitly expanded
    showResolved: false,
    collapsedDirs: null, // folder paths folded in the tree (persisted per review)
    fileFold: new Map(), // path -> folded, for files stacked in a folder view
    content: new Map(), // `${revisionId}:${path}` -> full-file load state for the file view
    settings: null, // per-repository settings from the server; null hides the learning controls
    dialog: null, // open Configure dialog: { learning, delivery, saving, error }
    switching: false, // a scope switch is in flight
    submitting: false, // a review submission is in flight
};

const FOLDER_VIEW_ROW_BUDGET = 3000;

const LEARNING_MODES = ["off", "suggest", "auto"];
const LEARNING = {
    off: { label: "Off", pill: "Off", hint: "Copilot only addresses each comment. It does not edit instruction files or record guidelines unless you ask." },
    suggest: { label: "Suggest", pill: "Suggest", hint: "Copilot proposes a guideline in the thread when your feedback reveals a reusable rule, and saves it only after you approve." },
    auto: { label: "Save automatically", pill: "Auto-save", hint: "Copilot saves settled guidelines to the repository's instruction files and tells you where. Personal rules still wait for your confirmation." },
};
const DELIVERY_MODES = ["immediate", "batch", "ask"];
const DELIVERY = {
    immediate: { label: "Send each comment now", pill: "Immediate", hint: "Each comment goes to Copilot as soon as you post it." },
    batch: { label: "Batch into a review", pill: "Batch", hint: "Comments wait as drafts until you submit the review, then Copilot addresses them together in one pass." },
    ask: { label: "Ask for each review", pill: "Ask", hint: "The first time you comment on a review, choose whether to send each comment now or batch them." },
};
const LESSON_STATUSES = {
    proposed: "Proposed by Copilot and not saved yet. Approve it in the thread to save it.",
    saved: "Saved as a guideline for future work.",
    declined: "Declined; not saved.",
};
const scopeOf = (review) => (review?.scope === "pending" ? "pending" : "all");
const scopeLabel = (scope) => (scope === "pending" ? "pending changes" : "all changes");
const learningMode = () => (LEARNING_MODES.includes(state.settings?.learning) ? state.settings.learning : "off");
const deliveryRepoMode = () => (DELIVERY_MODES.includes(state.settings?.delivery) ? state.settings.delivery : "immediate");
// Mirrors the server's resolveDelivery: null while an ask-mode review is undecided. Without settings nothing is held.
function deliveryMode() {
    if (!state.settings) return "immediate";
    const mode = deliveryRepoMode();
    if (mode !== "ask") return mode;
    const chosen = state.review?.deliveryMode;
    return chosen === "immediate" || chosen === "batch" ? chosen : null;
}
const draftMessages = () => (state.review?.threads ?? []).flatMap((t) => t.messages).filter((m) => m.author === "user" && m.delivery?.state === "draft");
// Lessons recorded before statuses existed were saved by definition.
const lessonStatus = (lesson) => (Object.hasOwn(LESSON_STATUSES, lesson.status) ? lesson.status : "saved");
const lessonBadge = (lesson) => {
    const status = lessonStatus(lesson);
    return `<span class="badge lesson-${status}" title="${esc(LESSON_STATUSES[status])}">${status}</span>`;
};

const $ = (sel, root = document) => root.querySelector(sel);

function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const CODE_KEYWORDS = new Set(("abstract as async await base bool boolean break byte case catch char checked class const continue decimal default delegate delete do double else enum event export extends extern false finally fixed float for foreach from function get if implements import in init int interface internal is let lock long namespace new null object operator out override params partial private protected public readonly record ref required return sbyte sealed set short sizeof stackalloc static string struct super switch this throw true try typeof uint ulong unchecked undefined unsafe ushort using var virtual void volatile while with yield").split(" "));
const highlightedFiles = new WeakMap();

function syntaxLanguage(filePath) {
    const ext = filePath.split(".").pop().toLowerCase();
    if (["cs", "js", "mjs", "cjs", "jsx", "ts", "tsx", "java", "c", "h", "cpp", "hpp"].includes(ext)) return "code";
    if (["xml", "html", "htm", "csproj", "props", "targets", "config", "svg", "xaml"].includes(ext)) return "xml";
    if (["json", "jsonc"].includes(ext)) return "json";
    if (["yaml", "yml"].includes(ext)) return "yaml";
    if (["md", "markdown", "mdx"].includes(ext)) return "markdown";
    return null;
}

// Lexical highlighting only: escape every source fragment and preserve its exact text.
function highlightLine(text, language, lexical = {}) {
    if (!language) return esc(text);
    if (language === "markdown") return highlightMarkdown(text, lexical);
    const out = [];
    const emit = (value, kind) => out.push(kind ? `<span class="syn-${kind}">${esc(value)}</span>` : esc(value));
    const tokens = language === "xml"
        ? /<!--|<\/?[\w:.-]+|\/?>|[\w:.-]+(?=\s*=)|"(?:[^"]*)"|'(?:[^']*)'/g
        : /\/\*|\/\/.*$|#[^\n]*$|@"(?:""|[^"])*"|\$?"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|[A-Za-z_$][\w$]*/g;
    let offset = 0;
    while (offset < text.length) {
        if (lexical.comment) {
            const end = text.indexOf(lexical.comment, offset);
            const next = end < 0 ? text.length : end + lexical.comment.length;
            emit(text.slice(offset, next), "comment");
            offset = next;
            if (end < 0) break;
            lexical.comment = null;
            continue;
        }
        tokens.lastIndex = offset;
        const match = tokens.exec(text);
        if (!match) {
            emit(text.slice(offset));
            break;
        }
        emit(text.slice(offset, match.index));
        const token = match[0];
        offset = tokens.lastIndex;
        if ((language === "xml" && token === "<!--") || (language === "code" && token === "/*")) {
            lexical.comment = language === "xml" ? "-->" : "*/";
            emit(token, "comment");
        } else if (language === "xml") {
            if (token.startsWith("<")) lexical.tag = true;
            const kind = token.startsWith("<") || /^\/?>$/.test(token) ? "keyword"
                : /^["']/.test(token) ? "string" : lexical.tag ? "property" : null;
            emit(token, kind);
            if (/\/?>$/.test(token)) lexical.tag = false;
        } else if ((language === "code" || language === "json") && token.startsWith("//")
            || language === "yaml" && token.startsWith("#")) {
            emit(token, "comment");
        } else if (/^(?:@|\$)?["'`]/.test(token)) {
            emit(token, language === "json" && /^\s*:/.test(text.slice(offset)) ? "property" : "string");
        } else if (/^\d/.test(token)) {
            emit(token, "number");
        } else {
            const kind = language === "code" && CODE_KEYWORDS.has(token)
                || language !== "code" && /^(true|false|null)$/.test(token) ? "keyword"
                : language === "yaml" && /^\s*:/.test(text.slice(offset)) ? "property"
                : language === "code" && /^[A-Z]/.test(token) ? "type" : null;
            emit(token, kind);
        }
    }
    return out.join("");
}

const MD_FENCE_ALIASES = { javascript: "js", typescript: "ts", csharp: "cs", "c#": "cs", "c++": "cpp", markdown: "md" };
const MD_INLINE = /\\[!-\/:-@[-`{-~]|`+|<!--|!?\[|<(?:https?:\/\/|mailto:)[^<>\s]+>|(?<![\w/])https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]]|<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>|\*\*|__|~~|[*_|]/g;
const MD_LINK = /!?\[((?:\\.|[^\\\]\n])*)\](?:\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)((?:\s+(?:"[^"]*"|'[^']*'))?\s*)\)|\[([^\]\n]*)\])/y;
const MD_STYLES = { "**": "strong", __: "strong", "*": "em", _: "em", "~~": "del" };
const mdToken = (value, cls) => (value ? `<span class="${cls}">${esc(value)}</span>` : "");
const mdBlock = (html) => `<span class="md-block">${html}</span>`;

function fenceLanguage(info) {
    const name = info.trim().split(/[\s{,]/)[0].toLowerCase();
    return name ? syntaxLanguage(`fence.${MD_FENCE_ALIASES[name] ?? name}`) : null;
}

// Markdown stays source text: markers are dimmed, never removed, so selections and anchors match the file.
function highlightMarkdown(text, lexical) {
    const fence = lexical.fence;
    if (fence) {
        const close = text.match(/^(\s*)(`{3,}|~{3,})(\s*)$/);
        if (close && close[2][0] === fence.marker[0] && close[2].length >= fence.marker.length) {
            lexical.fence = null;
            return mdBlock(esc(close[1]) + mdToken(close[2], "md-mark") + esc(close[3]));
        }
        return mdBlock(fence.language ? highlightLine(text, fence.language, fence.lexical) : esc(text));
    }
    if (lexical.comment) {
        const end = text.indexOf("-->");
        if (end < 0) return mdToken(text, "syn-comment");
        lexical.comment = null;
        return mdToken(text.slice(0, end + 3), "syn-comment") + mdInline(text.slice(end + 3), lexical);
    }
    const open = text.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (open && !(open[2][0] === "`" && open[3].includes("`"))) {
        lexical.fence = { marker: open[2], language: fenceLanguage(open[3]), lexical: {} };
        return mdBlock(esc(open[1]) + mdToken(open[2], "md-mark") + mdToken(open[3], "md-lang"));
    }
    if (/^ {0,3}(?:([-*_])(?:[ \t]*\1){2,}|=+)[ \t]*$/.test(text)) return mdToken(text, "md-mark");
    const heading = text.match(/^( {0,3})(#{1,6})((?:\s.*?)?)((?:\s#+)?\s*)$/);
    if (heading) {
        return esc(heading[1]) + mdToken(heading[2], "md-mark")
            + `<span class="md-heading">${mdInline(heading[3], lexical)}</span>` + mdToken(heading[4], "md-mark");
    }
    const definition = text.match(/^( {0,3})(\[(?!\^)[^\]\n]+\]:)(\s*)(\S*)(.*)$/);
    if (definition) {
        return esc(definition[1]) + mdToken(definition[2], "md-link") + esc(definition[3])
            + mdToken(definition[4], "md-url") + mdToken(definition[5], "md-mark");
    }
    let prefix = "";
    let rest = text;
    const quote = rest.match(/^ {0,3}>(?:[ \t]?>)*[ \t]?/);
    if (quote) {
        prefix += mdToken(quote[0], "md-mark");
        rest = rest.slice(quote[0].length);
    }
    const item = rest.match(/^(\s*)([-*+]|\d{1,9}[.)])(?=\s|$)(\s*)(\[[ xX]\](?=\s|$))?/);
    if (item) {
        prefix += esc(item[1]) + mdToken(item[2], "md-list") + esc(item[3]) + mdToken(item[4], "md-mark");
        rest = rest.slice(item[0].length);
    }
    if (/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(rest)) return prefix + mdToken(rest, "md-mark");
    const body = mdInline(rest, lexical, /^\s*\|/.test(rest));
    return prefix + (quote ? `<span class="md-quote">${body}</span>` : body);
}

function mdInline(text, lexical, table = false, depth = 0) {
    // Delimiter matching rescans the line, so pathological lines stay plain.
    if (depth > 6 || text.length > 4000) return esc(text);
    const tokens = new RegExp(MD_INLINE);
    const out = [];
    let plain = 0;
    let match;
    while ((match = tokens.exec(text))) {
        const token = match[0];
        if (token[0] === "\\") continue;
        const at = match.index;
        let end = tokens.lastIndex;
        let html = null;
        if (token[0] === "`") {
            const closing = /`+/g;
            closing.lastIndex = end;
            let close;
            while ((close = closing.exec(text)) && close[0].length !== token.length);
            if (close) {
                html = `<span class="md-code">${mdToken(token, "md-mark")}${esc(text.slice(end, close.index))}${mdToken(close[0], "md-mark")}</span>`;
                end = closing.lastIndex;
            }
        } else if (token === "<!--") {
            const close = text.indexOf("-->", end);
            if (close < 0) lexical.comment = "-->";
            end = close < 0 ? text.length : close + 3;
            html = mdToken(text.slice(at, end), "syn-comment");
        } else if (token.endsWith("[")) {
            MD_LINK.lastIndex = at;
            const link = MD_LINK.exec(text);
            if (link) {
                const [, label, url, title, ref] = link;
                end = MD_LINK.lastIndex;
                const head = `${mdToken(token, "md-mark")}<span class="md-link">${mdInline(label, {}, false, depth + 1)}</span>`;
                html = url != null
                    ? `${head}${mdToken("](", "md-mark")}${mdToken(url, "md-url")}${mdToken(title, "md-mark")}${mdToken(")", "md-mark")}`
                    : `${head}${mdToken("][", "md-mark")}${mdToken(ref, "md-url")}${mdToken("]", "md-mark")}`;
            }
        } else if (/^<(?:https?:|mailto:)/.test(token)) {
            html = `${mdToken("<", "md-mark")}${mdToken(token.slice(1, -1), "md-url")}${mdToken(">", "md-mark")}`;
        } else if (token.startsWith("<")) {
            html = mdToken(token, "md-html");
        } else if (token.startsWith("http")) {
            html = mdToken(token, "md-url");
        } else if (token === "|") {
            if (table) html = mdToken(token, "md-mark");
        } else {
            const mark = token[0];
            if (mark === "_" && /[\p{L}\p{N}]/u.test(text[at - 1] ?? "")) continue;
            const c = mark === "*" ? "\\*" : mark;
            const closing = new RegExp(`(?=[^\\s${c}])(.*?[^\\s\\\\${c}])${c.repeat(token.length)}(?!${c})${mark === "_" ? "(?![\\p{L}\\p{N}])" : ""}`, "uy");
            closing.lastIndex = end;
            const close = closing.exec(text);
            if (close) {
                end = closing.lastIndex;
                html = `<span class="md-${MD_STYLES[token]}">${mdToken(token, "md-mark")}${mdInline(close[1], {}, table, depth + 1)}${mdToken(token, "md-mark")}</span>`;
            }
        }
        if (html == null) continue;
        if (at > plain) out.push(esc(text.slice(plain, at)));
        out.push(html);
        plain = tokens.lastIndex = end;
    }
    if (plain < text.length) out.push(esc(text.slice(plain)));
    return out.join("");
}

function highlightFile(file) {
    if (highlightedFiles.has(file)) return highlightedFiles.get(file);
    const language = syntaxLanguage(file.path);
    const sides = { old: { next: null, lexical: {} }, new: { next: null, lexical: {} } };
    const rows = file.hunks.map((hunk) => hunk.rows.map((row) => {
        let html;
        for (const [side, line] of [["old", row.o], ["new", row.n]]) {
            if (line == null) continue;
            const cursor = sides[side];
            // Omitted diff context cannot establish a multiline token's state.
            if (cursor.next !== line) cursor.lexical = {};
            html = highlightLine(row.s, language, cursor.lexical);
            cursor.next = line + 1;
        }
        return html ?? esc(row.s);
    }));
    highlightedFiles.set(file, rows);
    return rows;
}

function inline(text) {
    return text
        .split(/(`[^`\n]+`)/)
        .map((part) => (part.length > 1 && part.startsWith("`") && part.endsWith("`")
            ? `<code>${esc(part.slice(1, -1))}</code>`
            : esc(part).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")))
        .join("");
}

function md(text) {
    const out = [];
    let para = [];
    let code = null;
    let list = null;
    const flush = () => {
        if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
        para = [];
        if (list) out.push(`</${list}>`);
        list = null;
    };
    for (const line of String(text ?? "").replace(/\r/g, "").split("\n")) {
        if (code) {
            if (/^\s*```/.test(line)) {
                out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
                code = null;
            } else code.push(line);
            continue;
        }
        if (/^\s*```/.test(line)) {
            flush();
            code = [];
        } else if (!line.trim()) flush();
        else if (/^#{1,6}\s/.test(line)) {
            flush();
            const [, hashes, title] = line.match(/^(#{1,6})\s+(.*)$/);
            out.push(`<h${hashes.length}>${inline(title)}</h${hashes.length}>`);
        } else if (/^(?:[-*]|\d+\.)\s+/.test(line)) {
            const [, bullet, item] = line.match(/^([-*]|\d+\.)\s+(.*)$/);
            const tag = /^\d/.test(bullet) ? "ol" : "ul";
            if (list !== tag) {
                flush();
                out.push(`<${tag}>`);
                list = tag;
            }
            out.push(`<li>${inline(item)}</li>`);
        } else {
            if (list) flush();
            para.push(line);
        }
    }
    if (code) out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    flush();
    return `<div class="md">${out.join("")}</div>`;
}

function ago(iso) {
    if (!iso) return "";
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return new Date(iso).toLocaleString();
}

function uuid() {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

// ---------- API ----------

async function api(method, path, body) {
    const headers = { "X-MR-Token": TOKEN };
    if (state.review) headers["X-MR-Review"] = state.review.reviewId;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`/api/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    // The server switched reviews under this page; catch up so the next attempt targets the review on screen.
    if (res.status === 409) scheduleReload();
    if (!res.ok) throw new Error(json?.error?.message ?? `${res.status} ${res.statusText}`);
    return json;
}

// A scope switch points this page at a different review; nothing derived from the previous one may carry over.
function resetForReview() {
    state.snapshot = null;
    state.view = { type: "overview" };
    state.selection = null;
    state.pendingJump = null;
    state.open.clear();
    state.pending.clear();
    state.expanded.clear();
    state.fileFold.clear();
    state.content.clear();
    state.collapsedDirs = null;
    viewRestored = false;
}

let loading = null;
let reloadAgain = false;
async function loadState() {
    if (loading) {
        reloadAgain = true;
        return loading;
    }
    loading = (async () => {
        do {
            reloadAgain = false;
            const data = await api("GET", "state");
            if (state.review && state.review.reviewId !== data.review.reviewId) resetForReview();
            state.review = data.review;
            state.settings = data.settings ?? null;
            if (data.session) state.busy = data.session.busy;
            const rev = state.review.currentRevisionId;
            if (rev && state.snapshot?.revisionId !== rev) state.snapshot = await api("GET", `snapshot/${rev}`);
            restoreView();
        } while (reloadAgain);
        render();
    })().finally(() => {
        loading = null;
    });
    return loading;
}

let reloadTimer;
function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => loadState().catch((err) => toast(err.message, true)), 120);
}

function connect() {
    const es = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`);
    es.addEventListener("hello", (e) => {
        state.connection = "open";
        state.busy = JSON.parse(e.data).busy;
        scheduleReload();
    });
    es.addEventListener("changed", scheduleReload);
    // The extension's web assets changed on disk (dev hot reload).
    es.addEventListener("assets", () => location.reload());
    es.addEventListener("session", (e) => {
        state.busy = JSON.parse(e.data).busy;
        renderTop();
    });
    es.onerror = () => {
        state.connection = "lost";
        renderTop();
    };
}

// ---------- Drafts & view persistence ----------

const draftKey = (key) => `mr:${state.review?.reviewId}:draft:${key}`;
const getDraft = (key) => localStorage.getItem(draftKey(key)) ?? "";
function setDraft(key, value) {
    if (value) localStorage.setItem(draftKey(key), value);
    else localStorage.removeItem(draftKey(key));
}

function saveView() {
    if (state.review) sessionStorage.setItem(`mr:${state.review.reviewId}:view`, JSON.stringify(state.view));
}
let viewRestored = false;
function restoreView() {
    if (viewRestored || !state.review) return;
    viewRestored = true;
    try {
        const v = JSON.parse(sessionStorage.getItem(`mr:${state.review.reviewId}:view`) ?? "null");
        if (v?.type) state.view = v;
    } catch { /* ignore */ }
}

function collapsedDirs() {
    if (!state.collapsedDirs) {
        try {
            state.collapsedDirs = new Set(JSON.parse(localStorage.getItem(`mr:${state.review?.reviewId}:collapsed`) ?? "[]"));
        } catch {
            state.collapsedDirs = new Set();
        }
    }
    return state.collapsedDirs;
}
function setDirCollapsed(dir, collapsed) {
    const set = collapsedDirs();
    if (collapsed) set.add(dir);
    else set.delete(dir);
    localStorage.setItem(`mr:${state.review.reviewId}:collapsed`, JSON.stringify([...set]));
}
function expandAncestors(path) {
    for (const dir of collapsedDirs()) {
        if (dir === "" || path.startsWith(`${dir}/`)) setDirCollapsed(dir, false);
    }
}

// ---------- File tree ----------

const inDir = (path, dir) => dir === "" || path.startsWith(`${dir}/`);
const filesUnder = (dir) => (state.snapshot?.files ?? []).filter((f) => inDir(f.path, dir)).sort((a, b) => a.path.localeCompare(b.path));
const repoName = () => (state.review?.repoRoot ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "All files";

// Folders first, then files; chains of single-child folders are compacted like ADO ("src/Common/Foo").
function buildTree(files) {
    const root = { name: repoName(), path: "", dirs: new Map(), files: [] };
    for (const f of files) {
        const parts = f.path.split("/");
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
            if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] });
            node = node.dirs.get(parts[i]);
        }
        node.files.push(f);
    }
    const finish = (node) => {
        node.children = [...node.dirs.values()].map((dir) => {
            let d = dir;
            while (!d.files.length && d.dirs.size === 1) {
                const only = d.dirs.values().next().value;
                d = { ...only, name: `${d.name}/${only.name}` };
            }
            return finish(d);
        }).sort((a, b) => a.name.localeCompare(b.name));
        node.files.sort((a, b) => a.path.localeCompare(b.path));
        return node;
    };
    return finish(root);
}

// ---------- Diff helpers ----------

function hunkAnchorRange(hunk) {
    const side = hunk.rows.some((r) => r.t === "add") ? "new" : "old";
    const key = side === "old" ? "o" : "n";
    const nums = hunk.rows.map((r) => r[key]).filter((v) => v != null);
    return nums.length ? { side, startLine: Math.min(...nums), endLine: Math.max(...nums) } : null;
}

function selectionRange(file, sel) {
    const rows = file.hunks[sel.hunk].rows.slice(sel.from, sel.to + 1);
    const side = rows.every((r) => r.t === "del") ? "old" : "new";
    const key = side === "old" ? "o" : "n";
    const nums = rows.map((r) => r[key]).filter((v) => v != null);
    return { side, startLine: Math.min(...nums), endLine: Math.max(...nums) };
}

const fileOf = (p) => state.snapshot?.files.find((f) => f.path === p) ?? null;

// ADO parity: selecting a file shows the whole file (changes inline); folders show diffs only.
// The full view interleaves unchanged "gap" hunks with the snapshot hunks, so selection,
// placement, and anchoring keep working on the same { hunks: [{ rows }] } shape.
function needsContent(file) {
    return !file.binary && file.status !== "added" && file.status !== "deleted" && file.hunks.length > 0;
}

function contentEntry(file) {
    const rev = state.snapshot?.revisionId;
    const key = `${rev}:${file.path}`;
    let entry = state.content.get(key);
    if (!entry) {
        entry = { status: "loading" };
        state.content.set(key, entry);
        api("GET", `content/${encodeURIComponent(rev)}?path=${encodeURIComponent(file.path)}`)
            .then((data) => {
                Object.assign(entry, data.available ? { status: "ready", full: buildFullFile(file, data.lines) } : { status: "unavailable", reason: data.reason });
            })
            .catch((err) => Object.assign(entry, { status: "unavailable", reason: err.message }))
            .finally(() => {
                if (state.view.type === "file" && state.view.path === file.path && !state.dragging) {
                    render();
                    revealPendingJump();
                }
            });
    }
    return entry;
}

function buildFullFile(file, lines) {
    const hunks = [];
    let nextNew = 1;
    let nextOld = 1;
    const gap = (untilNew) => {
        const rows = [];
        for (let n = nextNew; n < untilNew; n++) rows.push({ t: "ctx", o: nextOld + (n - nextNew), n, s: lines[n - 1] ?? "" });
        if (rows.length) hunks.push({ gap: true, rows });
        nextOld += Math.max(0, untilNew - nextNew);
        nextNew = Math.max(nextNew, untilNew);
    };
    for (const hunk of file.hunks) {
        gap(hunk.newLines > 0 ? hunk.newStart : hunk.newStart + 1);
        hunks.push(hunk);
        nextNew = (hunk.newLines > 0 ? hunk.newStart : hunk.newStart + 1) + hunk.newLines;
        nextOld = (hunk.oldLines > 0 ? hunk.oldStart : hunk.oldStart + 1) + hunk.oldLines;
    }
    gap(lines.length + 1);
    return { ...file, hunks, full: true };
}

// The file object rendered for a path in the current view: full file in file view when loaded.
function displayFile(path) {
    const file = fileOf(path);
    if (!file || state.view.type !== "file" || state.view.path !== path || !needsContent(file)) return file;
    const entry = contentEntry(file);
    if (state.selection?.path === path && state.selection.full === false) return file;
    return entry.status === "ready" ? entry.full : file;
}

// Where a thread renders inside a file view, or null when it cannot be placed in the diff.
function placeThread(thread, file) {
    const loc = thread.location;
    if (!file || !loc || loc.path !== file.path) return null;
    if (thread.kind === "file") return { where: "file" };
    if (loc.state === "outdated") return null;
    const key = loc.side === "old" ? "o" : "n";
    for (let h = 0; h < file.hunks.length; h++) {
        const hunk = file.hunks[h];
        if (thread.kind === "change") {
            if (hunk.gap) continue;
            const r = hunkAnchorRange(hunk);
            if (r && r.side === loc.side && r.startLine <= loc.endLine && r.endLine >= loc.startLine) return { where: "hunk", hunk: h };
            continue;
        }
        for (let i = hunk.rows.length - 1; i >= 0; i--) {
            if (hunk.rows[i][key] === loc.endLine) return { where: "row", hunk: h, row: i };
        }
    }
    return null;
}

function isPlaced(thread) {
    if (thread.kind === "overview") return true;
    return placeThread(thread, fileOf(thread.location?.path)) !== null;
}

function lineLabel(loc) {
    if (!loc || loc.startLine == null) return "";
    return loc.startLine === loc.endLine ? `L${loc.startLine}` : `L${loc.startLine}–${loc.endLine}`;
}

function locLabel(thread) {
    const loc = thread.location ?? thread.anchor ?? {};
    if (thread.kind === "overview") return "Overall";
    if (thread.kind === "file") return loc.path;
    return `${loc.path} ${lineLabel(loc)}${loc.side === "old" ? " (old)" : ""}`;
}

const STATUS_LETTER = { modified: "M", added: "A", deleted: "D", renamed: "R" };

// ---------- Rendering ----------

function render() {
    const active = document.activeElement;
    const focusKey = active?.dataset?.composer;
    const selStart = active?.selectionStart;
    const selEnd = active?.selectionEnd;
    const main = $("#main");
    const scroll = main.scrollTop;
    renderTop();
    renderBanner();
    renderSide();
    renderMain();
    main.scrollTop = scroll;
    renderRuler();
    if (focusKey) {
        const el = document.querySelector(`textarea[data-composer="${CSS.escape(focusKey)}"]`);
        if (el) {
            el.focus();
            if (selStart != null) el.setSelectionRange(selStart, selEnd);
        }
    }
}

function scopeToggleHtml(scope) {
    const button = (value, label, title) => `<button type="button" data-action="scope" data-scope="${value}" aria-pressed="${scope === value}" title="${esc(title)}"${state.switching ? " disabled" : ""}>${label}</button>`;
    return `<span class="seg" role="group" aria-label="Review scope">`
        + button("all", "All changes", "Everything on this branch since it diverged from the base, plus uncommitted work")
        + button("pending", "Pending changes", "Only uncommitted work: staged, unstaged and untracked files compared with HEAD")
        + `</span>`;
}

function renderTop() {
    const r = state.review;
    if (!r) return;
    const rev = r.revisions.find((x) => x.revisionId === r.currentRevisionId);
    const git = r.git ?? {};
    const scope = scopeOf(r);
    const awaiting = r.threads.flatMap((t) => t.messages).filter((m) => ["queued", "processing"].includes(m.delivery?.state)).length;
    const branch = `<span class="pill mono" title="HEAD ${esc(git.headCommit ?? "")}">${esc(r.branch ?? "?")}</span>`;
    const parts = [
        `<span class="title">${esc(r.title)}</span>`,
        scope === "pending"
            ? `${branch}<span class="muted">uncommitted changes only</span>`
            : `${branch}<span class="muted">vs</span><span class="pill mono" title="merge-base ${esc(git.baseCommit ?? "")}">${esc(r.base)}</span>`,
        scopeToggleHtml(scope),
    ];
    if (rev) parts.push(`<span class="pill" title="Revision captured ${esc(rev.createdAt)}">${esc(rev.revisionId)} · ${rev.files} files · <span class="add">+${rev.additions}</span> <span class="del">−${rev.deletions}</span></span>`);
    if (scope === "all") {
        if (git.upstream) {
            const { ahead, behind, name } = git.upstream;
            parts.push(`<span class="pill${ahead || behind ? " warn" : ""}" title="${esc(name)}">↑${ahead} ↓${behind}</span>`);
        } else if (git.branch) parts.push(`<span class="pill warn">no upstream</span>`);
        if (git.uncommittedFiles) parts.push(`<span class="pill warn" title="Diff includes working-tree changes">${git.uncommittedFiles} uncommitted</span>`);
    }
    if (state.connection === "lost") parts.push(`<span class="pill warn" title="If this persists, reopen the canvas">disconnected</span>`);
    else if (state.busy === true) parts.push(`<span class="pill busy"><span class="dot"></span>Copilot working${awaiting ? ` · ${awaiting} pending` : ""}</span>`);
    else if (state.busy === false) parts.push(`<span class="pill"><span class="dot muted"></span>Copilot idle${awaiting ? ` · ${awaiting} pending` : ""}</span>`);
    parts.push(`<span class="spacer"></span>`);
    const drafts = draftMessages().length;
    if (drafts) {
        parts.push(`<button class="primary" data-action="submit-review" title="Send every draft comment to Copilot together, as one review"${state.submitting ? " disabled>Submitting…" : `>Submit review (${drafts})`}</button>`);
    }
    if (state.settings) {
        const repoMode = deliveryRepoMode();
        const chosen = repoMode === "ask" ? deliveryMode() : null;
        parts.push(chosen
            ? `<span class="pill" title="${esc(DELIVERY[chosen].hint)} Chosen for this review.">Delivery: ${esc(DELIVERY[chosen].pill)}</span><button class="link" data-action="delivery-reask" title="Choose again how this review sends comments">Change</button>`
            : `<span class="pill" title="${esc(DELIVERY[repoMode].hint)}">Delivery: ${esc(DELIVERY[repoMode].pill)}</span>`);
        const mode = LEARNING[learningMode()];
        parts.push(`<span class="pill" title="${esc(mode.hint)}">Learning: ${esc(mode.pill)}</span><button data-action="configure" title="Choose how Copilot receives and learns from your review feedback in this repository">Configure</button>`);
    }
    parts.push(`<button data-action="refresh" title="Re-read the working tree">Refresh</button>`);
    $("#top").innerHTML = parts.join("");
}

// ---------- Repository settings: first-use banner, per-review delivery question, and Configure dialog ----------

function learningBannerHtml() {
    const s = state.settings;
    if (!s || s.configured || s.dismissed) return "";
    const choice = (mode, primary) => `<button data-action="learning-set" data-mode="${mode}"${primary ? ` class="primary"` : ""} title="${esc(LEARNING[mode].hint)}">${esc(LEARNING[mode].label)}</button>`;
    return `<div class="banner-row"><span class="banner-text"><strong>Learn from your review feedback in ${esc(s.repoName)}?</strong> Copilot can turn your comments into reusable coding guidelines. The choice is stored on this machine only, and Configure changes it any time.</span>`
        + `<span class="banner-actions">${choice("suggest", true)}${choice("auto", false)}`
        + `<button class="link" data-action="learning-dismiss" title="Hide this notice. Learning stays off until you choose a mode with Configure.">Not now</button></span></div>`;
}

// Shown while an ask-mode review is undecided; until then the server holds new comments as drafts.
function deliveryBannerHtml() {
    if (!state.settings || !state.review || deliveryRepoMode() !== "ask" || deliveryMode()) return "";
    const drafts = draftMessages().length;
    const waiting = drafts ? `${drafts} draft ${drafts === 1 ? "comment is" : "comments are"} waiting.` : "Until you choose, new comments wait as drafts.";
    const choice = (mode, label) => `<button data-action="delivery-choose" data-mode="${mode}" title="${esc(DELIVERY[mode].hint)}">${label}</button>`;
    return `<div class="banner-row"><span class="banner-text"><strong>How should Copilot receive your comments on this review?</strong> Send each one as you post it, or batch them and submit the review when you are done. ${waiting}</span>`
        + `<span class="banner-actions">${choice("immediate", "Send each now")}${choice("batch", "Batch into a review")}</span></div>`;
}

function bannerHtml() {
    return learningBannerHtml() + deliveryBannerHtml();
}

function renderBanner() {
    const el = $("#banner");
    const html = bannerHtml();
    el.hidden = !html;
    el.innerHTML = html;
}

function choicesHtml(name, modes, table, selected) {
    return modes.map((mode) => `<label class="choice"><input type="radio" name="${name}" value="${mode}"${selected === mode ? " checked" : ""}>`
        + `<span><span class="choice-title">${esc(table[mode].label)}</span><span class="choice-hint">${esc(table[mode].hint)}</span></span></label>`).join("");
}

function dialogHtml() {
    const d = state.dialog;
    if (!d) return "";
    return `<div class="modal-backdrop" data-action="dialog-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-desc">`
        + `<h2 id="dialog-title">Review settings</h2>`
        + `<p id="dialog-desc" class="muted">Settings for ${esc(state.settings?.repoName ?? "this repository")}. They are stored on this machine only and never committed.</p>`
        + `<fieldset class="choices"><legend>Learn from review feedback</legend>${choicesHtml("learning", LEARNING_MODES, LEARNING, d.learning)}</fieldset>`
        + `<fieldset class="choices"><legend>Send comments to Copilot</legend>${choicesHtml("delivery", DELIVERY_MODES, DELIVERY, d.delivery)}</fieldset>`
        + (d.error ? `<div class="modal-error" role="alert">${esc(d.error)}</div>` : "")
        + `<div class="modal-actions"><button data-action="dialog-cancel"${d.saving ? " disabled" : ""}>Cancel</button>`
        + `<button class="primary" data-action="dialog-save"${d.saving ? " disabled" : ""}>${d.saving ? "Saving…" : "Save"}</button></div>`
        + `</div></div>`;
}

function focusIn(selector) {
    $(selector)?.focus?.();
}

// The dialog is rendered on its own so re-renders of the page never disturb its focus or radio state.
function renderDialog() {
    $("#dialog").innerHTML = dialogHtml();
    for (const id of ["#top", "#banner", "#layout"]) {
        const el = $(id);
        if (el) el.inert = Boolean(state.dialog);
    }
}

function openConfigure() {
    if (!state.settings || state.dialog) return;
    state.dialog = { learning: learningMode(), delivery: deliveryRepoMode(), saving: false, error: "" };
    renderDialog();
    focusIn('#dialog input[name="learning"]:checked');
}

function closeConfigure() {
    if (!state.dialog || state.dialog.saving) return;
    state.dialog = null;
    renderDialog();
    focusIn('[data-action="configure"]');
}

// A delivery change alters every composer's buttons, so it needs a full render once a diff is shown.
async function updateSettings(patch) {
    const before = deliveryMode();
    state.settings = await api("POST", "settings", patch);
    if (deliveryMode() !== before && state.snapshot) {
        render();
    } else {
        renderTop();
        renderBanner();
    }
}

async function saveConfigure() {
    const d = state.dialog;
    if (!d || d.saving) return;
    d.saving = true;
    d.error = "";
    renderDialog();
    try {
        await updateSettings({ learning: d.learning, delivery: d.delivery });
        state.dialog = null;
        renderDialog();
        focusIn('[data-action="configure"]');
        toast(`Saved. Learning: ${LEARNING[learningMode()].pill} · Delivery: ${DELIVERY[deliveryRepoMode()].pill}`);
    } catch (err) {
        d.saving = false;
        d.error = err.message;
        renderDialog();
        focusIn('#dialog [data-action="dialog-save"]');
    }
}

// Keeps Tab inside the open dialog; each radio group is a single tab stop (its checked radio).
function trapTab(e) {
    const groupStop = (name) => {
        const radios = [...document.querySelectorAll(`#dialog input[name="${name}"]`)];
        return radios.find((x) => x.checked) ?? radios[0];
    };
    const stops = [...new Set([groupStop("learning"), groupStop("delivery"), ...document.querySelectorAll("#dialog button:not([disabled])")].filter(Boolean))];
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
}

async function switchScope(scope) {
    if (state.switching || scope === scopeOf(state.review)) return;
    state.switching = true;
    renderTop();
    try {
        await api("POST", "scope", { scope });
        await loadState();
    } finally {
        state.switching = false;
        renderTop();
    }
}

function activeCount(pathName) {
    return state.review.threads.filter((t) => t.status === "active" && t.kind !== "overview" && t.location?.path === pathName).length;
}

const CHEVRON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const FOLDER_ICON = `<svg class="ficon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 3h4.1l1.5 1.5h6.9c.41 0 .75.34.75.75v7c0 .41-.34.75-.75.75H1.75A.75.75 0 0 1 1 12.25v-8.5c0-.41.34-.75.75-.75Z" fill="currentColor"/></svg>`;

const statHtml = (adds, dels) => `<span class="stat"><span class="add">+${adds}</span> <span class="del">−${dels}</span></span>`;

function treeHtml(node, depth, out) {
    const v = state.view;
    const collapsed = collapsedDirs().has(node.path);
    const files = filesUnder(node.path);
    const n = files.reduce((sum, f) => sum + activeCount(f.path), 0);
    const title = node.path === "" ? `${state.review.repoRoot} — ${scopeLabel(scopeOf(state.review))}` : node.path;
    out.push(`<div class="nav-item tree dir${v.type === "folder" && v.path === node.path ? " active" : ""}" data-action="nav" data-view="folder" data-path="${esc(node.path)}" style="--depth:${depth}" title="${esc(title)}" role="treeitem" aria-expanded="${!collapsed}">`
        + `<span class="twisty${collapsed ? "" : " open"}" data-action="fold" data-path="${esc(node.path)}" title="${collapsed ? "Expand" : "Collapse"}">${CHEVRON}</span>`
        + FOLDER_ICON
        + `<span class="name">${esc(node.name)}</span>`
        + `<span class="count${n ? "" : " zero"}">${n}</span>`
        + `</div>`);
    if (collapsed) return;
    for (const child of node.children) treeHtml(child, depth + 1, out);
    for (const f of node.files) {
        const letter = STATUS_LETTER[f.status] ?? "M";
        const fn = activeCount(f.path);
        out.push(`<div class="nav-item tree${v.type === "file" && v.path === f.path ? " active" : ""}" data-action="nav" data-view="file" data-path="${esc(f.path)}" style="--depth:${depth + 1}" title="${esc(f.path)}${f.untracked ? " (untracked)" : ""}" role="treeitem">`
            + `<span class="twisty spacer-twisty"></span>`
            + `<span class="status-letter ${letter}">${letter}</span>`
            + `<span class="name">${esc(f.path.slice(f.path.lastIndexOf("/") + 1))}</span>`
            + `<span class="count${fn ? "" : " zero"}">${fn}</span>`
            + `${statHtml(f.additions, f.deletions)}</div>`);
    }
}

function setAllDirsCollapsed(collapse) {
    const dirs = [];
    const walk = (node) => {
        for (const child of node.children) {
            dirs.push(child.path);
            walk(child);
        }
    };
    if (collapse) walk(buildTree(state.snapshot?.files ?? []));
    state.collapsedDirs = new Set(dirs);
    localStorage.setItem(`mr:${state.review.reviewId}:collapsed`, JSON.stringify(dirs));
}

function descriptionHtml() {
    const d = state.review.description;
    const stale = d && d.revisionId !== state.review.currentRevisionId;
    return `<div class="section-head"><h2>Change overview</h2><span class="spacer"></span>`
        + `<button data-action="discuss-description">Discuss / request edits</button></div>`
        + `<div class="card description"><div class="muted">Local PR-style draft; not synced to the published PR.`
        + (d ? ` v${d.version} · based on ${esc(d.revisionId)}${stale ? " · Diff changed; description may need updating." : ""}` : "")
        + `</div>${d ? md(d.body) : `<div class="empty">No description yet. Ask Copilot below to describe the purpose, behavior, scope, verification, and risks.</div>`}</div>`;
}

function renderSide() {
    const r = state.review;
    const files = state.snapshot?.files ?? [];
    const v = state.view;
    const overviewCount = r.threads.filter((t) => t.status === "active" && (t.kind === "overview" || !isPlaced(t))).length;
    const html = [
        `<div class="nav-item${v.type === "overview" ? " active" : ""}" data-action="nav" data-view="overview"><span class="name">Overview</span><span class="count${overviewCount ? "" : " zero"}">${overviewCount}</span></div>`,
        `<div class="nav-item${v.type === "lessons" ? " active" : ""}" data-action="nav" data-view="lessons"><span class="name">Lessons learned</span><span class="muted">${r.lessons.length}</span></div>`,
        `<div class="section">Files (${files.length})</div>`,
    ];
    if (files.length) {
        html.push(
            `<div class="tree-controls"><button class="link" data-action="fold-tree" data-fold="1">Collapse all</button><button class="link" data-action="fold-tree" data-fold="0">Expand all</button></div>`,
            `<div role="tree">`,
        );
        treeHtml(buildTree(files), 0, html);
        html.push(`</div>`);
    } else if (state.snapshot) {
        html.push(`<div class="side-empty">${scopeOf(r) === "pending" ? "No uncommitted changes." : "No changes against the base."}</div>`);
    }
    $("#side").innerHTML = html.join("");
}

function renderMain() {
    const main = $("#main");
    if (state.view.type === "file") {
        const file = displayFile(state.view.path);
        if (file) {
            main.innerHTML = fileView(file);
            return;
        }
        state.view = { type: "overview" };
    }
    if (state.view.type === "folder") {
        if (filesUnder(state.view.path).length) {
            main.innerHTML = folderView(state.view.path);
            return;
        }
        state.view = { type: "overview" };
    }
    main.innerHTML = state.view.type === "lessons" ? lessonsView() : overviewView();
}

function composerHtml(key, { label, placeholder, kind, path, side, startLine, endLine, alwaysOpen }) {
    const draft = getDraft(key);
    const p = state.pending.get(key);
    const open = alwaysOpen || state.open.has(key) || Boolean(draft) || Boolean(p);
    const data = [
        `data-key="${esc(key)}"`,
        kind ? `data-kind="${kind}"` : "",
        path ? `data-path="${esc(path)}"` : "",
        side ? `data-side="${side}"` : "",
        startLine ? `data-start="${startLine}"` : "",
        endLine ? `data-end="${endLine}"` : "",
    ].join(" ");
    const k = esc(key);
    const batching = deliveryMode() !== "immediate";
    const buttons = batching
        ? `<button data-action="submit" data-key="${k}" data-draft="0" title="Send this comment to Copilot right away"${p?.sending ? " disabled" : ""}>Send now</button>`
            + `<button class="primary" data-action="submit" data-key="${k}" data-draft="1" title="Hold this comment as a draft until you submit the review"${p?.sending ? " disabled>Saving…" : ">Add to review"}</button>`
        : `<button class="primary" data-action="submit" data-key="${k}" ${p?.sending ? "disabled" : ""}>${p?.sending ? "Sending…" : "Comment"}</button>`;
    return `<div class="composer${open ? " open" : ""}" ${data}>`
        + (label ? `<div class="label">${esc(label)}</div>` : "")
        + `<textarea data-composer="${k}" placeholder="${esc(placeholder ?? "Write a comment…")}" ${p?.sending ? "disabled" : ""}>${esc(draft)}</textarea>`
        + (p?.error ? `<div class="err">${esc(p.error)}</div>` : "")
        + `<div class="bar"><span class="hint">Markdown · Ctrl+Enter to ${batching ? "add to review" : "send"} · Esc to close</span>`
        + `<button data-action="cancel" data-key="${k}">Cancel</button>`
        + `${buttons}</div>`
        + `</div>`;
}

function deliveryHtml(m) {
    const d = m.delivery;
    if (!d) return "";
    const resend = (label) => `<button class="link" data-action="retry" data-message="${esc(m.messageId)}">${label}</button>`;
    switch (d.state) {
        case "draft":
            return `<span class="delivery draft" title="Held until you submit the review">Draft · <button class="link" data-action="send-draft" data-message="${esc(m.messageId)}">Send now</button>`
                + ` · <button class="link" data-action="discard-draft" data-message="${esc(m.messageId)}">Discard</button></span>`;
        case "saving":
            return `<span class="delivery saving">Sending to Copilot…</span>`;
        case "queued": {
            const stale = state.busy === false && d.queuedAt && Date.now() - Date.parse(d.queuedAt) > STALE_QUEUE_MS;
            return `<span class="delivery queued">Queued for Copilot${stale ? ` · ${resend("Resend")}` : ""}</span>`;
        }
        case "processing":
            return `<span class="delivery processing">Copilot is working…</span>`;
        case "replied":
            return `<span class="delivery replied">✓ Replied</span>`;
        case "no-reply":
            return `<span class="delivery no-reply" title="Copilot finished without replying in this thread">No reply · ${resend("Resend")}</span>`;
        case "failed":
            return `<span class="delivery failed" title="${esc(d.error ?? "")}">Delivery failed · ${resend("Retry")}</span>`;
        default:
            return "";
    }
}

function messageHtml(m) {
    const agent = m.author === "agent";
    const lessons = (m.lessonIds ?? []).map((id) => state.review.lessons.find((l) => l.lessonId === id)).filter(Boolean);
    return `<div class="msg" data-message-id="${esc(m.messageId)}">`
        + `<div class="msg-head"><span class="avatar${agent ? " agent" : ""}">${agent ? "AI" : "Me"}</span>`
        + `<span class="who">${agent ? "Copilot" : "You"}</span><span class="when" title="${esc(m.createdAt)}">${esc(ago(m.createdAt))}</span>`
        + (agent && m.outcome ? `<span class="outcome ${esc(m.outcome)}">${esc(m.outcome)}</span>` : "")
        + deliveryHtml(m)
        + `</div>${md(m.body)}`
        + (m.verification ? `<div class="verification">Verification: ${inline(m.verification)}</div>` : "")
        + (lessons.length ? `<div class="lessons">Guidelines:<ul>${lessons.map((l) => `<li><span class="badge">${esc(l.scope)}</span> ${lessonBadge(l)} ${inline(l.rule)}${l.savedTo ? ` <span class="muted mono">→ ${esc(l.savedTo)}</span>` : ""}</li>`).join("")}</ul></div>` : "")
        + `</div>`;
}

function threadHtml(t, { showLocation = false } = {}) {
    const loc = t.location ?? {};
    const outdated = loc.state === "outdated";
    const collapsible = t.status !== "active" || outdated;
    const collapsed = collapsible && !state.expanded.has(t.threadId);
    const pending = t.messages.filter((m) => m.delivery && m.delivery.state !== "replied");
    const notInDiff = !outdated && !isPlaced(t);
    const moved = t.anchor?.startLine != null && loc.startLine != null && (t.anchor.startLine !== loc.startLine || t.anchor.endLine !== loc.endLine);
    const options = STATUSES.map((s) => `<option value="${s}"${s === t.status ? " selected" : ""}>${s === "wontfix" ? "won't fix" : s}</option>`).join("");
    const head = `<div class="thread-head">`
        + `<span class="badge kind">${t.kind === "change" ? "change" : t.kind}</span>`
        + `<span class="loc">${showLocation ? `<button class="link" data-action="jump" data-thread="${esc(t.threadId)}">${esc(locLabel(t))}</button>` : esc(locLabel(t))}`
        + (moved ? ` <span class="muted" title="Line numbers changed since ${esc(t.anchor.revisionId)}">(originally ${esc(lineLabel(t.anchor))} in ${esc(t.anchor.revisionId)})</span>` : "")
        + `</span>`
        + (outdated ? `<span class="badge outdated" title="The commented code changed or was removed">Outdated</span>` : "")
        + (notInDiff ? `<span class="badge outdated" title="This location is not part of the current diff">Not in diff</span>` : "")
        + (t.status !== "active" ? `<span class="badge st-${t.status}">${t.status === "wontfix" ? "won't fix" : t.status}</span>` : "")
        + `<select data-action="status" data-thread="${esc(t.threadId)}" title="Thread status">${options}</select>`
        + (collapsed ? pending.map(deliveryHtml).join("") : "")
        + (collapsible ? `<button class="link" data-action="toggle" data-thread="${esc(t.threadId)}" aria-expanded="${!collapsed}">${collapsed ? "Show" : "Hide"}</button>` : "")
        + `</div>`;
    const original = outdated && t.anchor?.selectedLines?.length
        ? `<div class="original muted">Originally commented code (${esc(t.anchor.revisionId)}, ${esc(lineLabel(t.anchor))}):<pre>${esc(t.anchor.selectedLines.join("\n"))}</pre></div>`
        : "";
    const reply = composerHtml(`reply:${t.threadId}`, { placeholder: "Reply…" });
    return `<div class="thread${collapsed ? " collapsed" : ""}" data-thread-id="${esc(t.threadId)}">${head}<div class="thread-body">${original}${t.messages.map(messageHtml).join("")}${reply}</div></div>`;
}

// Explains an empty diff and, for pending changes, offers the way back to the full branch diff.
function emptyDiffHtml() {
    const files = state.snapshot?.files;
    if (!files || files.length) return "";
    if (scopeOf(state.review) === "pending") {
        return `<div class="card empty-diff"><strong>No uncommitted changes.</strong> The working tree matches HEAD, so there is nothing to review in this scope.`
            + ` <button data-action="scope" data-scope="all">Switch to All changes</button></div>`;
    }
    return `<div class="card empty-diff"><strong>No changes to review.</strong> Nothing differs from ${esc(state.review.base)}.</div>`;
}

function overviewView() {
    const r = state.review;
    const overall = r.threads.filter((t) => t.kind === "overview" && t.status === "active");
    const unplaced = r.threads.filter((t) => t.kind !== "overview" && t.status === "active" && !isPlaced(t));
    const others = r.threads.filter((t) => t.kind !== "overview");
    const active = others.filter((t) => t.status === "active");
    const done = r.threads.filter((t) => t.status !== "active");
    const listRow = (t) => {
        const last = t.messages[t.messages.length - 1];
        const lastUser = [...t.messages].reverse().find((m) => m.author === "user");
        return `<div class="list-row"><span class="badge kind">${t.kind}</span>`
            + `<button class="link loc" data-action="jump" data-thread="${esc(t.threadId)}">${esc(locLabel(t))}</button>`
            + `<span class="snippet">${esc(last.author === "agent" ? "Copilot: " : "")}${esc(last.body.replace(/\s+/g, " ").slice(0, 160))}</span>`
            + (lastUser ? deliveryHtml(lastUser) : "")
            + `</div>`;
    };
    const revs = [...r.revisions].reverse().slice(0, 8).map((x) => `<div class="list-row"><span class="mono">${esc(x.revisionId)}</span><span class="snippet">${esc(ago(x.createdAt))} · ${x.files} files · +${x.additions} −${x.deletions} · HEAD ${esc((x.headCommit ?? "").slice(0, 10))}</span></div>`).join("");
    return emptyDiffHtml()
        + descriptionHtml()
        + `<h2>Overall discussion</h2>`
        + (overall.length ? overall.map((t) => threadHtml(t)).join("") : `<div class="empty">No overall comments yet.</div>`)
        + `<div class="thread">${composerHtml("overview:new", { kind: "overview", label: "Discuss the change or request description edits", placeholder: "Ask to revise the description, discuss the design, or request a change…", alwaysOpen: true })}</div>`
        + (unplaced.length ? `<h2>Comments outside the current diff (${unplaced.length})</h2>${unplaced.map((t) => threadHtml(t, { showLocation: true })).join("")}` : "")
        + `<h2>Active threads (${active.length})</h2><div class="card">${active.length ? active.map(listRow).join("") : `<div class="empty">No active threads. Select lines in a file to comment.</div>`}</div>`
        + (done.length ? `<h2>Closed threads (${done.length})</h2>${done.map((t) => threadHtml(t, { showLocation: true })).join("")}` : "")
        + `<h2>Revisions</h2><div class="card">${revs || `<div class="empty">No revisions.</div>`}</div>`;
}

function lessonsEmptyHint() {
    if (!state.settings) return "Copilot records reusable rules here when your comments reveal a preference.";
    switch (learningMode()) {
        case "suggest":
            return "Copilot proposes reusable guidelines here when your comments reveal a preference, and saves one after you approve it.";
        case "auto":
            return "Copilot saves reusable guidelines here when your comments reveal a preference.";
        default:
            return "Learning is off for this repository, so Copilot does not record guidelines from your comments. Use Configure to turn it on.";
    }
}

function lessonsView() {
    const lessons = state.review.lessons;
    if (!lessons.length) return `<h2>Lessons learned</h2><div class="empty">${lessonsEmptyHint()}</div>`;
    const rows = [...lessons].reverse().map((l) => `<tr><td><span class="badge">${esc(l.scope)}</span></td><td>${lessonBadge(l)}</td><td>${inline(l.rule)}</td><td class="mono muted">${esc(l.savedTo ?? "")}</td><td><button class="link" data-action="jump" data-thread="${esc(l.threadId)}">thread</button><div class="muted">${esc(ago(l.createdAt))}</div></td></tr>`).join("");
    return `<h2>Lessons learned (${lessons.length})</h2><table class="lessons-table"><thead><tr><th>Scope</th><th>Status</th><th>Rule</th><th>Saved to</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function fileView(file, { stacked = false, folded = false } = {}) {
    const threads = state.review.threads.filter((t) => t.kind !== "overview" && t.location?.path === file.path);
    const placed = new Map();
    const unplaced = [];
    for (const t of threads) {
        const p = placeThread(t, file);
        if (!p) {
            unplaced.push(t);
            continue;
        }
        const key = p.where === "file" ? "file" : p.where === "hunk" ? `h${p.hunk}` : `r${p.hunk}:${p.row}`;
        if (!placed.has(key)) placed.set(key, []);
        placed.get(key).push(t);
    }
    const highlighted = new Set();
    for (const t of threads) {
        if (t.kind !== "line" || t.status !== "active" || t.location?.state === "outdated") continue;
        for (let n = t.location.startLine; n <= t.location.endLine; n++) highlighted.add(`${t.location.side}:${n}`);
    }

    const letter = STATUS_LETTER[file.status] ?? "M";
    const fileKey = `file:${file.path}`;
    const activeHere = threads.filter((t) => t.status === "active").length;
    const pathHtml = stacked
        ? `<button class="link path-link" data-action="nav" data-view="file" data-path="${esc(file.path)}" title="Open only this file">${esc(file.path)}</button>`
        : esc(file.path);
    const html = [`<section class="file-section" data-file="${esc(file.path)}">`,
        `<div class="file-head${stacked ? " stacked" : ""}">`
        + (stacked ? `<span class="twisty${folded ? "" : " open"}" data-action="fold-file" data-path="${esc(file.path)}" title="${folded ? "Show diff" : "Hide diff"}">${CHEVRON}</span>` : "")
        + `<span class="status-letter ${letter}">${letter}</span><span class="path">${pathHtml}${file.oldPath && file.oldPath !== file.path ? ` <span class="muted">(from ${esc(file.oldPath)})</span>` : ""}${file.untracked ? ` <span class="badge">untracked</span>` : ""}</span>`
        + (stacked && folded && activeHere ? `<span class="count">${activeHere}</span>` : "")
        + `<span class="stat"><span class="add">+${file.additions}</span> <span class="del">−${file.deletions}</span></span>`
        + `<button data-action="open" data-key="${esc(fileKey)}" data-path="${esc(file.path)}">Comment on file</button></div>`];
    if (folded) {
        html.push(`</section>`);
        return html.join("");
    }
    html.push((placed.get("file") ?? []).map((t) => threadHtml(t)).join(""));
    if (state.open.has(fileKey) || getDraft(fileKey) || state.pending.has(fileKey)) {
        html.push(`<div class="thread">${composerHtml(fileKey, { kind: "file", path: file.path, label: `Comment on ${file.path}`, alwaysOpen: true })}</div>`);
    }
    if (file.binary) html.push(`<div class="card muted">${esc(file.note ?? "Binary file not shown.")}</div>`);
    if (!file.binary && !file.hunks.length) html.push(`<div class="card muted">No textual changes (mode or rename only).</div>`);
    if (!stacked && !file.full && needsContent(file)) {
        const entry = contentEntry(file);
        const why = { stale: "the working tree changed since this revision; Refresh to see the full file", "too-large": "the file is too large", missing: "the file is missing from the working tree", "base-unavailable": "the base revision cannot be read" }[entry.reason] ?? entry.reason;
        const note = entry.status === "loading" ? "Loading full file…"
            : entry.status === "ready" ? "Showing changes only until the current line selection is closed."
            : `Showing changes only: ${esc(why)}.`;
        html.push(`<div class="muted full-note">${note}</div>`);
    }

    const sel = state.selection?.path === file.path ? state.selection : null;
    const selRange = sel ? selectionRange(file, sel) : null;
    const syntax = highlightFile(file);
    html.push(`<div class="diff${file.full ? " full" : ""}">`);
    file.hunks.forEach((hunk, h) => {
        const range = hunk.gap ? null : hunkAnchorRange(hunk);
        const changeKey = range ? `change:${file.path}:${range.side}:${range.startLine}-${range.endLine}` : null;
        if (!hunk.gap) {
            html.push(file.full
                ? `<div class="hunk-head change-bar"><span class="h muted">Change ${esc(lineLabel(range ?? {}))}</span>${range ? `<button data-action="open" data-key="${esc(changeKey)}">Discuss this change</button>` : ""}</div>`
                : `<div class="hunk-head"><span class="h" title="${esc(hunk.header)}">${esc(hunk.header)}</span>${range ? `<button data-action="open" data-key="${esc(changeKey)}">Discuss this change</button>` : ""}</div>`);
        }
        const hunkThreads = placed.get(`h${h}`) ?? [];
        const showChangeComposer = changeKey && (state.open.has(changeKey) || getDraft(changeKey) || state.pending.has(changeKey));
        if (hunkThreads.length || showChangeComposer) {
            html.push(`<div class="hunk-threads">${hunkThreads.map((t) => threadHtml(t)).join("")}`
                + (showChangeComposer ? `<div class="thread">${composerHtml(changeKey, { kind: "change", path: file.path, side: range.side, startLine: range.startLine, endLine: range.endLine, label: `Discuss this change (${range.side === "old" ? "old " : ""}${lineLabel(range)})`, alwaysOpen: true })}</div>` : "")
                + `</div>`);
        }
        html.push(`<table class="rows"><colgroup><col style="width:52px"><col style="width:52px"><col style="width:22px"><col></colgroup><tbody>`);
        hunk.rows.forEach((row, i) => {
            const selected = sel && sel.hunk === h && i >= sel.from && i <= sel.to;
            const hl = (row.n != null && highlighted.has(`new:${row.n}`)) || (row.t === "del" && highlighted.has(`old:${row.o}`));
            const prefix = row.t === "add" ? "+" : row.t === "del" ? "-" : " ";
            html.push(`<tr class="row ${row.t}${selected ? " sel" : ""}${hl ? " hl" : ""}" data-h="${h}" data-i="${i}">`
                + `<td class="ln">${row.o ?? ""}</td><td class="ln">${row.n ?? ""}</td><td class="gut"><span>+</span></td>`
                + `<td class="code" data-p="${prefix}">${syntax[h][i]}</td></tr>`);
            const rowThreads = placed.get(`r${h}:${i}`) ?? [];
            const composerHere = sel && !state.dragging && sel.hunk === h && sel.to === i;
            if (rowThreads.length || composerHere) {
                const lineKey = composerHere ? `line:${file.path}:${selRange.side}:${selRange.startLine}-${selRange.endLine}` : null;
                html.push(`<tr class="inline"><td colspan="4">${rowThreads.map((t) => threadHtml(t)).join("")}`
                    + (composerHere ? `<div class="thread">${composerHtml(lineKey, { kind: "line", path: file.path, side: selRange.side, startLine: selRange.startLine, endLine: selRange.endLine, label: `Comment on ${selRange.side === "old" ? "old " : ""}${lineLabel(selRange)}`, alwaysOpen: true })}</div>` : "")
                    + `</td></tr>`);
            }
        });
        html.push(`</tbody></table>`);
    });
    html.push(`</div>`);
    if (unplaced.length) {
        html.push(`<h2>Comments outside the current diff (${unplaced.length})</h2>${unplaced.map((t) => threadHtml(t)).join("")}`);
    }
    html.push(`</section>`);
    return html.join("");
}

// Folder selection shows every changed file under it, stacked, like ADO's Files tab.
// Past a row budget, files start folded so huge folders stay responsive.
function folderView(dir) {
    const files = filesUnder(dir);
    const adds = files.reduce((s, f) => s + f.additions, 0);
    const dels = files.reduce((s, f) => s + f.deletions, 0);
    const html = [`<div class="folder-head">${FOLDER_ICON}<span class="path">${esc(dir === "" ? repoName() : dir)}</span>`
        + `<span class="muted">${files.length} file${files.length === 1 ? "" : "s"}</span>`
        + `<span class="stat"><span class="add">+${adds}</span> <span class="del">−${dels}</span></span>`
        + `<span class="spacer"></span><button class="link" data-action="fold-all" data-fold="1">Collapse all</button><button class="link" data-action="fold-all" data-fold="0">Expand all</button></div>`];
    let rows = 0;
    for (const f of files) {
        const size = f.hunks.reduce((s, h) => s + h.rows.length, 0);
        const folded = state.fileFold.has(f.path) ? state.fileFold.get(f.path) : rows + size > FOLDER_VIEW_ROW_BUDGET && rows > 0;
        if (!folded) rows += size;
        html.push(fileView(f, { stacked: true, folded }));
    }
    return html.join("");
}

// ---------- Actions ----------

let toastTimer;
function toast(text, error = false) {
    const el = $("#toast");
    el.textContent = text;
    el.className = error ? "error" : "";
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        el.hidden = true;
    }, error ? 6000 : 2500);
}

function navigate(view) {
    state.view = view;
    state.selection = null;
    state.pendingJump = null;
    if (view.type === "file" || view.type === "folder") expandAncestors(view.path);
    saveView();
    render();
    $("#main").scrollTop = 0;
}

function focusComposer(key) {
    const el = document.querySelector(`textarea[data-composer="${CSS.escape(key)}"]`);
    if (el) {
        el.focus();
        el.scrollIntoView({ block: "nearest" });
    }
}

function jumpToThread(threadId) {
    const t = state.review.threads.find((x) => x.threadId === threadId);
    if (!t) return;
    if (t.status !== "active" || t.location?.state === "outdated") state.expanded.add(threadId);
    const inFile = t.kind !== "overview" && isPlaced(t) && fileOf(t.location.path);
    const unplacedInFile = t.kind !== "overview" && !isPlaced(t) && fileOf(t.location?.path);
    if ((inFile || unplacedInFile) && state.view.type === "folder" && inDir(t.location.path, state.view.path)) {
        state.fileFold.set(t.location.path, false);
        render();
    } else {
        navigate(inFile || unplacedInFile ? { type: "file", path: t.location.path } : { type: "overview" });
    }
    state.pendingJump = threadId;
    revealPendingJump();
}

// Scrolls to a jumped-to thread; retried after the full file loads, since it may move or appear then.
function revealPendingJump() {
    const threadId = state.pendingJump;
    if (!threadId) return;
    const el = document.querySelector(`[data-thread-id="${CSS.escape(threadId)}"]`);
    if (el) {
        el.scrollIntoView({ block: "center" });
        el.classList.add("flash");
        setTimeout(() => el.classList.remove("flash"), 1600);
    }
    const loading = state.view.type === "file" && [...state.content.values()].some((e) => e.status === "loading");
    if (!loading) state.pendingJump = null;
}

function closeComposer(key, discard) {
    if (discard) setDraft(key, "");
    state.open.delete(key);
    state.pending.delete(key);
    if (key.startsWith("line:")) state.selection = null;
    if (document.activeElement?.dataset?.composer === key) document.activeElement.blur();
    render();
}

// The composer's default action: undefined lets the server apply the delivery mode; otherwise the comment is held as a draft.
function defaultDraft() {
    return deliveryMode() === "immediate" ? undefined : true;
}

async function submit(key, draft = defaultDraft()) {
    const box = document.querySelector(`.composer[data-key="${CSS.escape(key)}"]`);
    const textarea = box?.querySelector("textarea");
    if (!box || !textarea) return;
    const body = textarea.value.trim();
    if (!body) {
        textarea.focus();
        return;
    }
    setDraft(key, textarea.value);
    const pending = state.pending.get(key) ?? { clientRequestId: uuid() };
    pending.sending = true;
    pending.error = null;
    state.pending.set(key, pending);
    render();
    try {
        let res;
        const hold = draft === undefined ? {} : { draft };
        if (key.startsWith("reply:")) {
            res = await api("POST", `threads/${encodeURIComponent(key.slice(6))}/messages`, { body, clientRequestId: pending.clientRequestId, descriptionVersion: state.review.description?.version ?? 0, ...hold });
        } else {
            const d = box.dataset;
            res = await api("POST", "threads", {
                kind: d.kind,
                path: d.path,
                side: d.side,
                startLine: d.start ? Number(d.start) : undefined,
                endLine: d.end ? Number(d.end) : undefined,
                revisionId: state.review.currentRevisionId,
                descriptionVersion: state.review.description?.version ?? 0,
                body,
                clientRequestId: pending.clientRequestId,
                ...hold,
            });
        }
        setDraft(key, "");
        state.pending.delete(key);
        state.open.delete(key);
        if (key.startsWith("line:")) state.selection = null;
        document.activeElement?.blur?.();
        await loadState();
        if (res?.threadId && !key.startsWith("reply:")) {
            const el = document.querySelector(`[data-thread-id="${CSS.escape(res.threadId)}"]`);
            el?.classList.add("flash");
            setTimeout(() => el?.classList.remove("flash"), 1600);
        }
    } catch (err) {
        pending.sending = false;
        pending.error = err.message;
        render();
    }
}

async function onClick(e) {
    const target = e.target.closest("[data-action]");
    if (!target || target.tagName === "SELECT") return;
    const { action } = target.dataset;
    try {
        switch (action) {
            case "discuss-description":
                focusComposer("overview:new");
                break;
            case "nav": {
                const { view, path } = target.dataset;
                if (view === "folder" && state.view.type === "folder" && state.view.path === path) {
                    setDirCollapsed(path, !collapsedDirs().has(path));
                    render();
                } else {
                    navigate(view === "file" || view === "folder" ? { type: view, path } : { type: view });
                }
                break;
            }
            case "fold":
                setDirCollapsed(target.dataset.path, !collapsedDirs().has(target.dataset.path));
                render();
                break;
            case "fold-tree":
                setAllDirsCollapsed(target.dataset.fold === "1");
                render();
                break;
            case "fold-file": {
                const path = target.dataset.path;
                state.fileFold.set(path, target.classList.contains("open"));
                render();
                document.querySelector(`.file-section[data-file="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "nearest" });
                break;
            }
            case "fold-all":
                for (const f of filesUnder(state.view.path ?? "")) state.fileFold.set(f.path, target.dataset.fold === "1");
                render();
                break;
            case "refresh":
                target.disabled = true;
                await api("POST", "refresh", {});
                await loadState();
                toast("Refreshed from the working tree");
                break;
            case "open":
                if (target.dataset.path) state.fileFold.set(target.dataset.path, false);
                state.open.add(target.dataset.key);
                render();
                focusComposer(target.dataset.key);
                break;
            case "cancel":
                closeComposer(target.dataset.key, true);
                break;
            case "submit": {
                const flag = target.dataset.draft;
                await submit(target.dataset.key, flag === "1" ? true : flag === "0" ? false : defaultDraft());
                break;
            }
            case "retry":
                await api("POST", `messages/${encodeURIComponent(target.dataset.message)}/retry`, {});
                await loadState();
                toast("Sent to Copilot again");
                break;
            case "send-draft": {
                const res = await api("POST", `messages/${encodeURIComponent(target.dataset.message)}/send`, {});
                await loadState();
                toast(res?.error ? res.error : "Sent to Copilot", Boolean(res?.error));
                break;
            }
            case "discard-draft":
                await api("POST", `messages/${encodeURIComponent(target.dataset.message)}/discard`, {});
                await loadState();
                toast("Draft discarded");
                break;
            case "submit-review": {
                if (state.submitting) break;
                state.submitting = true;
                renderTop();
                try {
                    const res = await api("POST", "submit", {});
                    if (res?.error) toast(res.error, true);
                    else toast(`Sent ${res.submitted} ${res.submitted === 1 ? "comment" : "comments"} to Copilot`);
                } finally {
                    state.submitting = false;
                    await loadState();
                }
                break;
            }
            case "delivery-choose": {
                const mode = target.dataset.mode;
                const res = await api("POST", "delivery", { mode });
                await loadState();
                toast(mode === "immediate"
                    ? (res?.submitted ? `Sending each comment now. Sent ${res.submitted} waiting ${res.submitted === 1 ? "draft" : "drafts"}.` : "Sending each comment now")
                    : "Batching comments. Submit the review when you are done.");
                break;
            }
            case "delivery-reask":
                await api("POST", "delivery", { mode: null });
                await loadState();
                break;
            case "toggle": {
                const id = target.dataset.thread;
                if (state.expanded.has(id)) state.expanded.delete(id);
                else state.expanded.add(id);
                render();
                break;
            }
            case "jump":
                jumpToThread(target.dataset.thread);
                break;
            case "scope":
                await switchScope(target.dataset.scope);
                break;
            case "configure":
                openConfigure();
                break;
            case "dialog-cancel":
                closeConfigure();
                break;
            case "dialog-backdrop":
                if (e.target === target) closeConfigure();
                break;
            case "dialog-save":
                await saveConfigure();
                break;
            case "learning-set":
                await updateSettings({ learning: target.dataset.mode });
                toast(`Learning mode: ${LEARNING[learningMode()].label}`);
                break;
            case "learning-dismiss":
                await updateSettings({ dismissed: true });
                break;
            default:
                break;
        }
    } catch (err) {
        toast(err.message, true);
        if (action === "refresh") target.disabled = false;
    }
}

async function onChange(e) {
    const el = e.target;
    if ((el.name === "learning" || el.name === "delivery") && state.dialog) {
        state.dialog[el.name] = el.value;
        return;
    }
    if (el.dataset?.action !== "status") return;
    try {
        await api("POST", `threads/${encodeURIComponent(el.dataset.thread)}/status`, { status: el.value });
        if (el.value !== "active") state.expanded.delete(el.dataset.thread);
        await loadState();
    } catch (err) {
        toast(err.message, true);
        await loadState().catch(() => {});
    }
}

function onInput(e) {
    const el = e.target;
    if (el.dataset?.composer) {
        setDraft(el.dataset.composer, el.value);
        el.closest(".composer")?.classList.add("open");
    }
}

function onKeyDown(e) {
    if (state.dialog) {
        if (e.key === "Escape") {
            e.preventDefault();
            closeConfigure();
        } else if (e.key === "Tab") trapTab(e);
        return;
    }
    const el = e.target;
    const key = el.dataset?.composer;
    if (!key) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit(key);
    } else if (e.key === "Escape") {
        e.preventDefault();
        if (key.startsWith("reply:") && !el.value.trim()) {
            el.closest(".composer")?.classList.remove("open");
            el.blur();
        } else if (!el.value.trim()) closeComposer(key, true);
        else el.blur();
    }
}

function onFocusIn(e) {
    const el = e.target;
    if (el.dataset?.composer) el.closest(".composer")?.classList.add("open");
}

function onFocusOut(e) {
    const el = e.target;
    const key = el.dataset?.composer;
    if (!key || !key.startsWith("reply:")) return;
    setTimeout(() => {
        const box = el.closest(".composer");
        if (box && !el.value.trim() && !box.contains(document.activeElement)) box.classList.remove("open");
    }, 150);
}

// ---------- Overview ruler (change markers beside the scrollbar) ----------

// Merges adjacent rows of the same kind so a long change becomes one marker, not one per line.
function rulerMarks(items, scrollHeight, minPx = 3) {
    const marks = [];
    for (const it of items) {
        const last = marks[marks.length - 1];
        if (last && last.kind === it.kind && it.top <= last.bottom + 1) {
            last.bottom = Math.max(last.bottom, it.top + it.height);
            continue;
        }
        marks.push({ kind: it.kind, top: it.top, bottom: it.top + it.height });
    }
    return marks.map((m) => ({
        kind: m.kind,
        top: m.top,
        topPct: (m.top / scrollHeight) * 100,
        heightPct: (Math.max(m.bottom - m.top, 0) / scrollHeight) * 100,
        minPx,
    }));
}

function renderRuler() {
    const main = $("#main");
    const ruler = $("#ruler");
    if (!main || !ruler) return;
    const mainRect = main.getBoundingClientRect();
    ruler.style.right = `${main.offsetWidth - main.clientWidth}px`;
    const offset = main.scrollTop - mainRect.top;
    const items = [];
    for (const el of main.querySelectorAll("tr.row.add, tr.row.del, tr.inline")) {
        const r = el.getBoundingClientRect();
        if (!r.height) continue;
        const kind = el.classList.contains("inline") ? "thread" : el.classList.contains("add") ? "add" : "del";
        items.push({ kind, top: r.top + offset, height: r.height });
    }
    const scrollable = main.scrollHeight > main.clientHeight;
    ruler.hidden = !scrollable || items.length === 0;
    if (ruler.hidden) {
        ruler.innerHTML = "";
        return;
    }
    ruler.innerHTML = rulerMarks(items, main.scrollHeight)
        .map((m) => `<div class="mark ${m.kind}" data-top="${m.top}" style="top:${m.topPct}%;height:max(${m.minPx}px, ${m.heightPct}%)"></div>`)
        .join("")
        + `<div class="viewport"></div>`;
    paintRulerViewport();
}

function paintRulerViewport() {
    const main = $("#main");
    const vp = $("#ruler .viewport");
    if (!main || !vp) return;
    vp.style.top = `${(main.scrollTop / main.scrollHeight) * 100}%`;
    vp.style.height = `${(main.clientHeight / main.scrollHeight) * 100}%`;
}

function onRulerClick(e) {
    const main = $("#main");
    const ruler = $("#ruler");
    const mark = e.target.closest(".mark");
    const target = mark
        ? Number(mark.dataset.top)
        : ((e.clientY - ruler.getBoundingClientRect().top) / ruler.clientHeight) * main.scrollHeight;
    main.scrollTo({ top: Math.max(0, target - main.clientHeight / 3), behavior: "smooth" });
}

// ---------- Line selection (click / shift-click / drag on line numbers or "+") ----------

function rowFromEvent(e) {
    const tr = e.target.closest("tr.row");
    const path = tr?.closest("[data-file]")?.dataset.file;
    if (!tr || !path) return null;
    return { path, h: Number(tr.dataset.h), i: Number(tr.dataset.i), full: Boolean(tr.closest(".diff")?.classList.contains("full")) };
}

function paintSelection() {
    const sel = state.selection;
    for (const tr of document.querySelectorAll("tr.row")) {
        const on = sel && tr.closest("[data-file]")?.dataset.file === sel.path && Number(tr.dataset.h) === sel.hunk && Number(tr.dataset.i) >= sel.from && Number(tr.dataset.i) <= sel.to;
        tr.classList.toggle("sel", Boolean(on));
    }
}

function onMouseDown(e) {
    if (e.button !== 0 || !e.target.closest("td.ln, td.gut")) return;
    const pos = rowFromEvent(e);
    if (!pos) return;
    e.preventDefault();
    const { path } = pos;
    const sel = state.selection;
    if (e.shiftKey && sel && sel.path === path && sel.hunk === pos.h && sel.full === pos.full) {
        sel.from = Math.min(sel.anchor, pos.i);
        sel.to = Math.max(sel.anchor, pos.i);
    } else {
        state.selection = { path, hunk: pos.h, anchor: pos.i, from: pos.i, to: pos.i, full: pos.full };
    }
    state.dragging = true;
    paintSelection();
}

function onMouseOver(e) {
    if (!state.dragging) return;
    const pos = rowFromEvent(e);
    const sel = state.selection;
    if (!pos || !sel || pos.path !== sel.path || pos.h !== sel.hunk) return;
    sel.from = Math.min(sel.anchor, pos.i);
    sel.to = Math.max(sel.anchor, pos.i);
    paintSelection();
}

function onMouseUp() {
    if (!state.dragging) return;
    state.dragging = false;
    const file = displayFile(state.selection?.path);
    if (!file) return;
    const r = selectionRange(file, state.selection);
    render();
    focusComposer(`line:${file.path}:${r.side}:${r.startLine}-${r.endLine}`);
}

// ---------- Boot ----------

document.addEventListener("click", onClick);
document.addEventListener("change", onChange);
document.addEventListener("input", onInput);
document.addEventListener("keydown", onKeyDown);
document.addEventListener("focusin", onFocusIn);
document.addEventListener("focusout", onFocusOut);
document.addEventListener("mousedown", onMouseDown);
document.addEventListener("mouseover", onMouseOver);
document.addEventListener("mouseup", onMouseUp);
document.addEventListener("click", (e) => {
    if (e.target.closest?.("#ruler")) onRulerClick(e);
    else requestAnimationFrame(renderRuler);
});
document.addEventListener("scroll", (e) => { if (e.target?.id === "main") paintRulerViewport(); }, true);
globalThis.addEventListener?.("resize", () => requestAnimationFrame(renderRuler));

setInterval(() => {
    if (!state.review || state.dragging) return;
    if (document.activeElement?.tagName === "TEXTAREA") renderTop();
    else render();
}, 30000);

if (!TOKEN) {
    $("#top").innerHTML = `<span class="del">Missing access token. Reopen the canvas.</span>`;
} else {
    loadState()
        .catch((err) => {
            $("#top").innerHTML = `<span class="del">${esc(err.message)}</span>`;
        })
        .finally(connect);
}
