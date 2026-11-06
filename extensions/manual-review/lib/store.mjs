// Durable review storage under ~/.copilot/extension-data/manual-review.
// Writes are atomic (temp file + rename) and serialized per key so concurrent
// UI posts and agent replies cannot lose each other's updates.
import { mkdir, readFile, rename, writeFile, appendFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const REVIEW_ID = /^[a-z0-9][a-z0-9._-]{0,100}$/;
const REVISION_ID = /^r[0-9]{1,6}$/;
const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

export function defaultDataRoot() {
    return path.join(os.homedir(), ".copilot", "extension-data", "manual-review");
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

    // Serializes async work per key; the callback always sees the latest committed state.
    async lock(key, fn) {
        const prev = this.locks.get(key) ?? Promise.resolve();
        let release;
        const next = new Promise((r) => (release = r));
        const chained = prev.then(() => next);
        this.locks.set(key, chained);
        await prev;
        try {
            return await fn();
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

    async readLessons() {
        try {
            const text = await readFile(path.join(this.root, "lessons.jsonl"), "utf8");
            return text.split("\n").filter(Boolean).flatMap((l) => {
                try {
                    return [JSON.parse(l)];
                } catch {
                    return [];
                }
            });
        } catch (err) {
            if (err?.code === "ENOENT") return [];
            throw err;
        }
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
