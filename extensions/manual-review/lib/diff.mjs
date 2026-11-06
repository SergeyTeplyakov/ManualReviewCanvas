// Unified diff parsing into a compact, render-friendly structure.
// Row shape: { t: "ctx" | "add" | "del", o: oldLine | null, n: newLine | null, s: text }

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function stripCr(line) {
    return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function unquotePath(value) {
    let p = value.replace(/\t+$/, "");
    if (p.startsWith('"') && p.endsWith('"')) {
        p = p.slice(1, -1);
        const escapes = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", '"': '"', "\\": "\\" };
        const chunks = [];
        let start = 0;
        for (const match of p.matchAll(/\\([0-7]{1,3}|["\\abfnrtv])/g)) {
            chunks.push(Buffer.from(p.slice(start, match.index)));
            chunks.push(/^[0-7]/.test(match[1]) ? Buffer.from([parseInt(match[1], 8)]) : Buffer.from(escapes[match[1]]));
            start = match.index + match[0].length;
        }
        chunks.push(Buffer.from(p.slice(start)));
        p = Buffer.concat(chunks).toString("utf8");
    }
    return p;
}

function stripSidePrefix(p) {
    if (p === "/dev/null") return null;
    return p.replace(/^[ab]\//, "");
}

// For an unquoted header whose two sides name the same path ("a/P b/P"), returns P. A path can itself contain
// " b/", which makes the split ambiguous to a regex, but equal halves pin it down.
function sameSidePath(rest) {
    if (!rest.startsWith("a/") || (rest.length - 5) % 2 !== 0) return null;
    const n = (rest.length - 5) / 2;
    if (n <= 0) return null;
    const p = rest.slice(2, 2 + n);
    return rest.slice(2 + n) === ` b/${p}` ? p : null;
}

function newFile() {
    return { path: null, oldPath: null, status: "modified", binary: false, untracked: false, additions: 0, deletions: 0, hunks: [] };
}

export function parseUnifiedDiff(text) {
    const files = [];
    let file = null;
    let hunk = null;
    let oldRemaining = 0;
    let newRemaining = 0;
    let oldNo = 0;
    let newNo = 0;

    for (const raw of text.split("\n")) {
        const line = stripCr(raw);

        if (hunk && (oldRemaining > 0 || newRemaining > 0)) {
            const c = line[0];
            // Some tools strip the single space git emits for empty context lines.
            if (c === " " || (line === "" && oldRemaining > 0 && newRemaining > 0)) {
                hunk.rows.push({ t: "ctx", o: oldNo++, n: newNo++, s: line.slice(1) });
                oldRemaining--;
                newRemaining--;
                continue;
            }
            if (c === "-") {
                hunk.rows.push({ t: "del", o: oldNo++, n: null, s: line.slice(1) });
                file.deletions++;
                oldRemaining--;
                continue;
            }
            if (c === "+") {
                hunk.rows.push({ t: "add", o: null, n: newNo++, s: line.slice(1) });
                file.additions++;
                newRemaining--;
                continue;
            }
        }
        if (line.startsWith("\\")) {
            if (hunk) hunk.noNewlineAtEnd = true;
            continue;
        }

        if (line.startsWith("diff --git ")) {
            file = newFile();
            files.push(file);
            hunk = null;
            const same = sameSidePath(line.slice("diff --git ".length));
            const m = same === null && /^diff --git ("(?:[^"\\]|\\.)*"|a\/.*) ("(?:[^"\\]|\\.)*"|b\/.*)$/.exec(line);
            if (same !== null) {
                file.oldPath = same;
                file.path = same;
            } else if (m) {
                file.oldPath = stripSidePrefix(unquotePath(m[1]));
                file.path = stripSidePrefix(unquotePath(m[2]));
            }
            continue;
        }
        if (!file) continue;

        const header = HUNK_HEADER.exec(line);
        if (header) {
            const oldStart = Number(header[1]);
            const oldLines = header[2] === undefined ? 1 : Number(header[2]);
            const newStart = Number(header[3]);
            const newLines = header[4] === undefined ? 1 : Number(header[4]);
            hunk = { header: line, section: header[5].trim(), oldStart, oldLines, newStart, newLines, rows: [] };
            file.hunks.push(hunk);
            oldRemaining = oldLines;
            newRemaining = newLines;
            oldNo = oldStart;
            newNo = newStart;
            continue;
        }

        if (line.startsWith("new file mode")) file.status = "added";
        else if (line.startsWith("deleted file mode")) file.status = "deleted";
        else if (line.startsWith("rename from ")) {
            file.status = "renamed";
            file.oldPath = unquotePath(line.slice("rename from ".length));
        } else if (line.startsWith("rename to ")) {
            file.status = "renamed";
            file.path = unquotePath(line.slice("rename to ".length));
        } else if (line.startsWith("--- ")) {
            const p = stripSidePrefix(unquotePath(line.slice(4)));
            if (p !== null) file.oldPath = p;
        } else if (line.startsWith("+++ ")) {
            const p = stripSidePrefix(unquotePath(line.slice(4)));
            if (p !== null) file.path = p;
        } else if (line.startsWith("Binary files ")) {
            file.binary = true;
        }
    }

    for (const f of files) {
        if (!f.path) f.path = f.oldPath;
        if (f.status === "added") f.oldPath = null;
    }
    return files;
}

// Builds an "added file" entry for an untracked file's content.
export function synthesizeAddedFile(relPath, content) {
    const lines = content.split("\n").map(stripCr);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const rows = lines.map((s, i) => ({ t: "add", o: null, n: i + 1, s }));
    return {
        path: relPath,
        oldPath: null,
        status: "added",
        binary: false,
        untracked: true,
        additions: rows.length,
        deletions: 0,
        hunks: rows.length === 0 ? [] : [{
            header: `@@ -0,0 +1,${rows.length} @@`,
            section: "",
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: rows.length,
            rows,
        }],
    };
}

export function rowPrefix(row) {
    if (row.t === "add") return "+";
    if (row.t === "del") return "-";
    return " ";
}

function hunkLineRange(hunk, side) {
    const key = side === "old" ? "o" : "n";
    const nums = hunk.rows.map((r) => r[key]).filter((v) => v !== null);
    return nums.length ? { start: Math.min(...nums), end: Math.max(...nums) } : null;
}

// The anchor a "discuss this change" thread uses: new side unless the hunk only deletes.
export function hunkAnchorRange(hunk) {
    const side = hunk.rows.some((r) => r.t === "add") ? "new" : "old";
    const range = hunkLineRange(hunk, side);
    return range ? { side, startLine: range.start, endLine: range.end } : null;
}

// Text of the hunk that contains a line range, trimmed to a window around the selection.
export function hunkExcerpt(file, side, startLine, endLine, maxRows = 60) {
    const key = side === "old" ? "o" : "n";
    for (const hunk of file.hunks) {
        const idx = hunk.rows.findIndex((r) => r[key] !== null && r[key] >= startLine && r[key] <= endLine);
        if (idx < 0) continue;
        let lastIdx = idx;
        hunk.rows.forEach((r, i) => {
            if (r[key] !== null && r[key] <= endLine) lastIdx = Math.max(lastIdx, i);
        });
        const pad = Math.max(3, Math.floor((maxRows - (lastIdx - idx + 1)) / 2));
        const from = Math.max(0, idx - pad);
        const to = Math.min(hunk.rows.length, lastIdx + pad + 1);
        const body = hunk.rows.slice(from, to).map((r) => rowPrefix(r) + r.s);
        return { header: hunk.header, text: [hunk.header, ...body].join("\n") };
    }
    return null;
}

// Selected source lines on one side of the diff.
export function selectedLines(file, side, startLine, endLine) {
    const key = side === "old" ? "o" : "n";
    const out = [];
    for (const hunk of file.hunks) {
        for (const r of hunk.rows) {
            if (r[key] !== null && r[key] >= startLine && r[key] <= endLine) out.push(r.s);
        }
    }
    return out;
}
