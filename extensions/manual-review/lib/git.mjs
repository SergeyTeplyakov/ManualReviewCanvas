// Read-only git access for capturing review snapshots. Never mutates the repository:
// GIT_OPTIONAL_LOCKS=0 keeps diff/status from rewriting the index.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseUnifiedDiff, synthesizeAddedFile } from "./diff.mjs";

const MAX_BUFFER = 256 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

export function runGit(cwd, args, { allowFail = false } = {}) {
    return new Promise((resolve, reject) => {
        execFile(
            "git",
            ["--no-pager", "-c", "core.quotepath=false", ...args],
            {
                cwd,
                maxBuffer: MAX_BUFFER,
                windowsHide: true,
                encoding: "utf8",
                env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
            },
            (err, stdout, stderr) => {
                if (err && !allowFail) {
                    reject(new Error(`git ${args[0]} failed: ${(stderr || err.message).trim().split("\n").slice(0, 3).join(" ")}`));
                    return;
                }
                resolve({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? "" });
            },
        );
    });
}

export async function resolveRepoRoot(repoPath) {
    const { stdout } = await runGit(repoPath, ["rev-parse", "--show-toplevel"]);
    return path.resolve(stdout.trim());
}

export async function defaultBase(repoRoot) {
    const head = await runGit(repoRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { allowFail: true });
    if (head.ok && head.stdout.trim()) return head.stdout.trim();
    for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
        const r = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", candidate], { allowFail: true });
        if (r.ok) return candidate;
    }
    throw new Error("Could not determine a base ref; pass input.base explicitly.");
}

export function buildPathspec(paths, exclude) {
    const spec = [];
    if (paths && paths.length) spec.push(...paths);
    else spec.push(".");
    for (const e of exclude ?? []) spec.push(`:(exclude)${e}`);
    return spec;
}

// Resolves a repo-relative path and refuses anything that escapes the repository.
export function safeJoin(repoRoot, relPath) {
    const full = path.resolve(repoRoot, relPath);
    const rel = path.relative(repoRoot, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Path escapes repository: ${relPath}`);
    return full;
}

function isBinary(buffer) {
    const len = Math.min(buffer.length, 8000);
    for (let i = 0; i < len; i++) if (buffer[i] === 0) return true;
    return false;
}

async function readUntracked(repoRoot, relPath) {
    const full = safeJoin(repoRoot, relPath);
    const info = await stat(full);
    if (!info.isFile()) return null;
    if (info.size > MAX_UNTRACKED_BYTES) {
        return { path: relPath, oldPath: null, status: "added", binary: true, untracked: true, additions: 0, deletions: 0, hunks: [], note: "File too large to display" };
    }
    const buffer = await readFile(full);
    if (isBinary(buffer)) {
        return { path: relPath, oldPath: null, status: "added", binary: true, untracked: true, additions: 0, deletions: 0, hunks: [] };
    }
    return synthesizeAddedFile(relPath, buffer.toString("utf8"));
}

// scope "all" diffs the working tree against the merge-base with `base` (the whole branch or PR);
// scope "pending" diffs it against HEAD, so committed work is left out.
export async function captureSnapshot({ repoRoot, base, paths, exclude, includeUntracked = true, contextLines = 5, scope = "all" }) {
    const head = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
    const branch = (await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    let baseCommit = head;
    if (scope !== "pending") {
        const mergeBase = await runGit(repoRoot, ["merge-base", base, "HEAD"], { allowFail: true });
        baseCommit = mergeBase.ok && mergeBase.stdout.trim()
            ? mergeBase.stdout.trim()
            : (await runGit(repoRoot, ["rev-parse", "--verify", base])).stdout.trim();
    }
    const pathspec = buildPathspec(paths, exclude);

    const diff = await runGit(repoRoot, [
        "diff", "--no-color", "--no-ext-diff", "--find-renames", `-U${contextLines}`, baseCommit, "--", ...pathspec,
    ]);
    const files = parseUnifiedDiff(diff.stdout);
    const hash = createHash("sha256").update(baseCommit).update("\0").update(diff.stdout);

    if (includeUntracked) {
        const list = await runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspec]);
        const untracked = list.stdout.split("\0").filter(Boolean).sort();
        for (const rel of untracked) {
            const entry = await readUntracked(repoRoot, rel).catch(() => null);
            if (!entry) continue;
            files.push(entry);
            hash.update("\0untracked\0").update(rel).update("\0").update(JSON.stringify(entry.hunks));
        }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));

    const uncommitted = await runGit(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...pathspec], { allowFail: true });
    const uncommittedFiles = uncommitted.ok
        ? uncommitted.stdout.split("\0").filter((e) => /^.. /.test(e)).map((e) => e.slice(3))
        : [];

    let upstream = null;
    const up = await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { allowFail: true });
    if (up.ok && up.stdout.trim()) {
        const counts = await runGit(repoRoot, ["rev-list", "--left-right", "--count", "@{u}...HEAD"], { allowFail: true });
        const [behind, ahead] = counts.ok ? counts.stdout.trim().split(/\s+/).map(Number) : [null, null];
        upstream = { name: up.stdout.trim(), ahead, behind };
    }

    return {
        base,
        baseCommit,
        headCommit: head,
        branch,
        upstream,
        uncommittedFiles,
        fingerprint: hash.digest("hex"),
        files,
    };
}

export async function readWorkingFile(repoRoot, relPath) {
    try {
        return (await readFile(safeJoin(repoRoot, relPath), "utf8")).split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
    } catch {
        return null;
    }
}

export async function readCommitFile(repoRoot, commit, relPath) {
    const r = await runGit(repoRoot, ["show", `${commit}:${relPath}`], { allowFail: true });
    if (!r.ok) return null;
    return r.stdout.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}
