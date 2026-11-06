// Per-repository user settings, kept in the extension's user-local data and never written into the repository.
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as gitDefault from "./git.mjs";
import { ReviewError } from "./review-service.mjs";

// How the agent treats review feedback as reusable guidelines:
//   off     - address the comment only; never touch instruction files
//   suggest - propose guidelines in the thread and save one only after the reviewer approves it
//   auto    - save settled repository guidelines directly and report where they went
export const LEARNING_MODES = ["off", "suggest", "auto"];
export const DEFAULT_LEARNING = "off";

// When the agent receives the reviewer's comments:
//   immediate - each comment is sent as soon as it is posted
//   batch     - comments wait as drafts until the reviewer submits them together
//   ask       - each review asks the reviewer to choose immediate or batch
export const DELIVERY_MODES = ["immediate", "batch", "ask"];
export const DEFAULT_DELIVERY = "immediate";

// The delivery mode in effect for one review, or null while an ask-mode review is undecided.
export function resolveDelivery(repoMode, review) {
    const mode = DELIVERY_MODES.includes(repoMode) ? repoMode : DEFAULT_DELIVERY;
    if (mode !== "ask") return mode;
    return review?.deliveryMode === "immediate" || review?.deliveryMode === "batch" ? review.deliveryMode : null;
}

const DEFAULT_PORTS = { http: "80", https: "443", ssh: "22", "git+ssh": "22", "ssh+git": "22", git: "9418" };

// Reduces equivalent remote spellings (https, ssh, scp-style, credentials, default port, .git) to host/owner/repo.
// A non-default port is kept, since it can name a different server.
export function normalizeRemoteUrl(url) {
    let value = String(url ?? "").trim().replace(/\\/g, "/");
    const scp = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/\/)(.+)$/.exec(value);
    if (scp && !value.includes("://")) {
        value = `${scp[1]}/${scp[2]}`;
    } else {
        const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1].toLowerCase();
        value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]*@/, "");
        value = value.replace(/^([^/:]+):(\d+)(?=\/|$)/, (all, host, port) => (DEFAULT_PORTS[scheme] === port ? host : all));
    }
    return value.replace(/\.git\/*$/i, "").replace(/\/+$/, "").toLowerCase();
}

// Case-insensitive file systems (the Windows and macOS defaults) fold a path's case; others keep it.
export function pathKey(p, platform = process.platform) {
    return platform === "win32" || platform === "darwin" ? p.toLowerCase() : p;
}

// Git treats a URL without a scheme or an scp-style host as a local path, relative to the repository.
function localRemotePath(url, repoRoot) {
    const value = url.trim();
    if (/^file:\/\//i.test(value)) {
        try {
            return fileURLToPath(value);
        } catch {
            return path.resolve(repoRoot, decodeURIComponent(value.replace(/^file:\/\//i, "")));
        }
    }
    if (value.includes("://")) return null;
    if (/^(?:[^@/\\\s]+@)?[^:/\\\s]{2,}:/.test(value)) return null;
    return path.resolve(repoRoot, value);
}

function remoteName(url) {
    const cleaned = String(url).trim().replace(/\\/g, "/").replace(/\/+$/, "").replace(/\.git$/i, "");
    return cleaned.split(/[/:]/).pop() || cleaned;
}

// The origin remote identifies a repository so a setting follows it across branches and worktrees;
// without a remote the shared git directory stands in.
export async function repoIdentity(repoRoot, git = gitDefault) {
    const remote = await git.runGit(repoRoot, ["config", "--get", "remote.origin.url"], { allowFail: true });
    const url = remote.ok ? remote.stdout.trim() : "";
    if (url) {
        const local = localRemotePath(url, repoRoot);
        if (local) return { key: `remote:file:${pathKey(local)}`, name: remoteName(url) };
        return { key: `remote:${normalizeRemoteUrl(url)}`, name: remoteName(url) };
    }
    const common = await git.runGit(repoRoot, ["rev-parse", "--git-common-dir"], { allowFail: true });
    const dir = common.ok ? common.stdout.trim() : "";
    const root = dir ? path.resolve(repoRoot, dir) : path.resolve(repoRoot);
    return { key: `local:${pathKey(root)}`, name: path.basename(repoRoot) };
}

export class SettingsService {
    constructor({ store, git = gitDefault, log = () => {} }) {
        this.store = store;
        this.git = git;
        this.log = log;
    }

    // Effective settings for a repository. Learning stays off until the reviewer chooses a mode,
    // and an unreadable settings file never blocks the review.
    async get(repoRoot) {
        const identity = await repoIdentity(repoRoot, this.git);
        let entry = null;
        try {
            entry = (await this.store.readSettings()).repos?.[identity.key] ?? null;
        } catch (err) {
            this.log(`settings unreadable: ${err.message}`);
        }
        const configured = LEARNING_MODES.includes(entry?.learning);
        return {
            repoName: identity.name,
            learning: configured ? entry.learning : DEFAULT_LEARNING,
            delivery: DELIVERY_MODES.includes(entry?.delivery) ? entry.delivery : DEFAULT_DELIVERY,
            configured,
            dismissed: entry?.promptDismissed === true,
        };
    }

    async update(repoRoot, patch = {}) {
        if (patch.learning === undefined && patch.delivery === undefined && patch.dismissed === undefined) {
            throw new ReviewError("invalid_input", "Provide learning, delivery, or dismissed.");
        }
        if (patch.learning !== undefined && !LEARNING_MODES.includes(patch.learning)) {
            throw new ReviewError("invalid_input", `learning must be one of ${LEARNING_MODES.join(", ")}.`);
        }
        if (patch.delivery !== undefined && !DELIVERY_MODES.includes(patch.delivery)) {
            throw new ReviewError("invalid_input", `delivery must be one of ${DELIVERY_MODES.join(", ")}.`);
        }
        if (patch.dismissed !== undefined && typeof patch.dismissed !== "boolean") {
            throw new ReviewError("invalid_input", "dismissed must be a boolean.");
        }
        const identity = await repoIdentity(repoRoot, this.git);
        await this.store.updateSettings((settings) => {
            const entry = { ...settings.repos[identity.key] };
            if (patch.learning !== undefined) entry.learning = patch.learning;
            if (patch.delivery !== undefined) entry.delivery = patch.delivery;
            if (patch.dismissed !== undefined) entry.promptDismissed = patch.dismissed;
            settings.repos[identity.key] = { ...entry, name: identity.name, updatedAt: new Date().toISOString() };
        });
        return this.get(repoRoot);
    }
}
