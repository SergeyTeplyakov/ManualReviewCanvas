// Durable review storage under ~/.copilot/extension-data/self-review.
// Writes are atomic (temp file + rename) and serialized per key so concurrent
// UI posts and agent replies cannot lose each other's updates.
import { cp, mkdir, open, readFile, rename, rm, stat, writeFile, appendFile, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const REVIEW_ID = /^[a-z0-9][a-z0-9._-]{0,100}$/;
const REVISION_ID = /^r[0-9]{1,6}$/;
const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

export function defaultDataRoot() {
    return path.join(os.homedir(), ".copilot", "extension-data", "self-review");
}

// Where releases named Manual Review Canvas kept their data.
export function legacyDataRoot() {
    return path.join(os.homedir(), ".copilot", "extension-data", "manual-review");
}

async function exists(p) {
    try {
        await stat(p);
        return true;
    } catch (err) {
        if (err?.code === "ENOENT") return false;
        throw err;
    }
}

/**
 * Copies data from the pre-rename location once, before the store is first used. The legacy
 * directory is left intact so a still-running older provider keeps working; its later writes are
 * not merged. Lock and temporary files are skipped.
 * @returns {Promise<boolean>} whether data was copied
 */
export async function migrateLegacyDataRoot(root = defaultDataRoot(), legacyRoot = legacyDataRoot()) {
    if ((await exists(root)) || !(await exists(legacyRoot))) return false;
    const tmp = `${root}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await mkdir(path.dirname(root), { recursive: true });
        await cp(legacyRoot, tmp, {
            recursive: true,
            filter: (src) => {
                const rel = path.relative(legacyRoot, src);
                return rel.split(path.sep)[0] !== "locks" && !rel.endsWith(".tmp");
            },
        });
        await withRetry(() => rename(tmp, root));
        return true;
    } catch (err) {
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
        // Another provider finished the copy first.
        if (await exists(root)) return false;
        throw err;
    }
}

export function assertReviewId(reviewId) {
    if (typeof reviewId !== "string" || !REVIEW_ID.test(reviewId)) throw new Error(`Invalid reviewId: ${reviewId}`);
    return reviewId;
}

export function assertRevisionId(revisionId) {
    if (typeof revisionId !== "string" || !REVISION_ID.test(revisionId)) throw new Error(`Invalid revisionId: ${revisionId}`);
    return revisionId;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (!RETRYABLE.has(err?.code) || attempt >= 6) throw err;
            await sleep(25 * 2 ** attempt);
        }
    }
}

async function writeJsonAtomic(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    try {
        await withRetry(() => rename(tmp, file));
    } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
    }
}

async function readJson(file) {
    try {
        return JSON.parse(await withRetry(() => readFile(file, "utf8")));
    } catch (err) {
        if (err?.code === "ENOENT") return null;
        throw err;
    }
}

export class Store {
    constructor(root = defaultDataRoot()) {
        this.root = root;
        this.locks = new Map();
    }

    reviewDir(reviewId) {
        return path.join(this.root, "reviews", assertReviewId(reviewId));
    }

    reviewFile(reviewId) {
        return path.join(this.reviewDir(reviewId), "review.json");
    }

    snapshotFile(reviewId, revisionId) {
        return path.join(this.reviewDir(reviewId), "snapshots", `${assertRevisionId(revisionId)}.json`);
    }

    settingsFile() {
        return path.join(this.root, "settings.json");
    }

    // The exclusive file covers the entire transaction across provider processes.
    // Never steal an old lock: a slow or suspended owner may still be writing.
    async fileLock(key, fn) {
        const directory = path.join(this.root, "locks");
        await mkdir(directory, { recursive: true });
        const file = path.join(directory, `${createHash("sha256").update(key).digest("hex")}.lock`);
        const deadline = Date.now() + 10000;
        let handle;
        while (!handle) {
            try {
                handle = await open(file, "wx", 0o600);
            } catch (err) {
                if (err?.code !== "EEXIST") throw err;
                if (Date.now() >= deadline) {
                    throw new Error(`Timed out waiting for store lock ${file}. If a provider crashed, stop all self-review providers before removing this lock.`);
                }
                await sleep(25);
            }
        }
        try {
            await handle.writeFile(JSON.stringify({ pid: process.pid, key, createdAt: new Date().toISOString() }));
            return await fn();
        } finally {
            await handle.close();
            await withRetry(() => unlink(file));
        }
    }

    // Serializes async work per key; the callback always sees the latest committed state.
    async lock(key, fn) {
        const prev = this.locks.get(key) ?? Promise.resolve();
        let release;
        const next = new Promise((r) => (release = r));
        const chained = prev.then(() => next);
        this.locks.set(key, chained);
        await prev;
        try {
            return await this.fileLock(key, fn);
        } finally {
            release();
            if (this.locks.get(key) === chained) this.locks.delete(key);
        }
    }

    async readReview(reviewId) {
        return readJson(this.reviewFile(reviewId));
    }

    // Read-modify-write under the review lock.
    // mutate(current | null) => { review?, value?, write? = true }
    async updateReview(reviewId, mutate) {
        return this.lock(`review:${reviewId}`, async () => {
            const current = await this.readReview(reviewId);
            const { review, value, write = true } = (await mutate(current)) ?? {};
            if (write && review) {
                review.updatedAt = new Date().toISOString();
                await writeJsonAtomic(this.reviewFile(reviewId), review);
            }
            return value;
        });
    }

    async writeSnapshot(reviewId, revisionId, snapshot) {
        await writeJsonAtomic(this.snapshotFile(reviewId, revisionId), snapshot);
    }

    async readSnapshot(reviewId, revisionId) {
        return readJson(this.snapshotFile(reviewId, revisionId));
    }

    async appendLesson(lesson) {
        await mkdir(this.root, { recursive: true });
        await this.lock("lessons", () => withRetry(() => appendFile(path.join(this.root, "lessons.jsonl"), JSON.stringify(lesson) + "\n", "utf8")));
    }

    // lessons.jsonl is append-only; a lesson updated in place (proposed -> saved) is appended again and the last record wins.
    async readLessons() {
        try {
            const text = await readFile(path.join(this.root, "lessons.jsonl"), "utf8");
            const byId = new Map();
            for (const line of text.split("\n").filter(Boolean)) {
                try {
                    const lesson = JSON.parse(line);
                    byId.set(lesson.lessonId ?? line, lesson);
                } catch {
                    // A torn or hand-edited line is skipped rather than failing the whole read.
                }
            }
            return [...byId.values()];
        } catch (err) {
            if (err?.code === "ENOENT") return [];
            throw err;
        }
    }

    async readSettings() {
        return (await readJson(this.settingsFile())) ?? { version: 1, repos: {} };
    }

    // Read-modify-write of the per-user settings file. mutate(settings) edits it in place and may return a value.
    async updateSettings(mutate) {
        return this.lock("settings", async () => {
            const settings = await this.readSettings();
            if (!settings.repos || typeof settings.repos !== "object") settings.repos = {};
            const value = await mutate(settings);
            await writeJsonAtomic(this.settingsFile(), settings);
            return value;
        });
    }

    async getInstanceReview(instanceId) {
        const map = (await readJson(path.join(this.root, "instances.json"))) ?? {};
        return map[instanceId] ?? null;
    }

    async setInstanceReview(instanceId, reviewId) {
        await this.lock("instances", async () => {
            const file = path.join(this.root, "instances.json");
            const map = (await readJson(file)) ?? {};
            if (map[instanceId] === reviewId) return;
            map[instanceId] = reviewId;
            await writeJsonAtomic(file, map);
        });
    }
}
