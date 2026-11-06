// Per-repository user settings, kept in the extension's user-local data and never written into the repository.
import path from "node:path";
import * as gitDefault from "./git.mjs";
import { ReviewError } from "./review-service.mjs";

// How the agent treats review feedback as reusable guidelines:
//   off     - address the comment only; never touch instruction files
//   suggest - propose guidelines in the thread and save one only after the reviewer approves it
//   auto    - save settled repository guidelines directly and report where they went
export const LEARNING_MODES = ["off", "suggest", "auto"];
export const DEFAULT_LEARNING = "off";

// Reduces equivalent remote spellings (https, ssh, scp-style, credentials, port, .git) to host/owner/repo.
export function normalizeRemoteUrl(url) {
    let value = String(url ?? "").trim().replace(/\\/g, "/");
    const scp = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/\/)(.+)$/.exec(value);
    if (scp && !value.includes("://")) {
        value = `${scp[1]}/${scp[2]}`;
    } else {
        value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]*@/, "");
    }
    value = value.replace(/^([^/:]+):\d+(?=\/|$)/, "$1");
    return value.replace(/\.git\/*$/i, "").replace(/\/+$/, "").toLowerCase();
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
    if (url) return { key: `remote:${normalizeRemoteUrl(url)}`, name: remoteName(url) };
    const common = await git.runGit(repoRoot, ["rev-parse", "--git-common-dir"], { allowFail: true });
    const dir = common.ok ? common.stdout.trim() : "";
    const root = dir ? path.resolve(repoRoot, dir) : path.resolve(repoRoot);
    return { key: `local:${root.toLowerCase()}`, name: path.basename(repoRoot) };
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
            configured,
            dismissed: entry?.promptDismissed === true,
        };
    }

    async update(repoRoot, patch = {}) {
        if (patch.learning === undefined && patch.dismissed === undefined) {
            throw new ReviewError("invalid_input", "Provide learning or dismissed.");
        }
        if (patch.learning !== undefined && !LEARNING_MODES.includes(patch.learning)) {
            throw new ReviewError("invalid_input", `learning must be one of ${LEARNING_MODES.join(", ")}.`);
        }
        if (patch.dismissed !== undefined && typeof patch.dismissed !== "boolean") {
            throw new ReviewError("invalid_input", "dismissed must be a boolean.");
        }
        const identity = await repoIdentity(repoRoot, this.git);
        await this.store.updateSettings((settings) => {
            const entry = { ...settings.repos[identity.key] };
            if (patch.learning !== undefined) entry.learning = patch.learning;
            if (patch.dismissed !== undefined) entry.promptDismissed = patch.dismissed;
            settings.repos[identity.key] = { ...entry, name: identity.name, updatedAt: new Date().toISOString() };
        });
        return this.get(repoRoot);
    }
}
