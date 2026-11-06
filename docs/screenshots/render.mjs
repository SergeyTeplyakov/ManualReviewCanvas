// Renders the README screenshots from a scripted demo review.
//
// Builds a throwaway git repo, seeds a review through the same ReviewService the canvas
// uses, serves the real web UI, and captures it with Playwright in light and dark themes.
//
//   cd docs/screenshots
//   npm install
//   node render.mjs           render every shot into docs/images
//   node render.mjs --keep    also keep the demo review running and print its URL
//
// Uses an installed Edge or Chrome when available (set MR_BROWSER_CHANNEL to pick one).
// Without either, run `npx playwright-core install chromium` first.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { runGit } from "../../extensions/manual-review/lib/git.mjs";
import { Store } from "../../extensions/manual-review/lib/store.mjs";
import { ReviewService } from "../../extensions/manual-review/lib/review-service.mjs";
import { Delivery } from "../../extensions/manual-review/lib/delivery.mjs";
import { startReviewServer } from "../../extensions/manual-review/lib/server.mjs";
import { SettingsService } from "../../extensions/manual-review/lib/settings.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(HERE, "..", "..", "extensions", "manual-review", "web");
const OUT = path.join(HERE, "..", "images");
const KEEP = process.argv.includes("--keep");
const WIDTH = 1320;
const THEMES = ["light", "dark"];

// ---------- Demo repository ----------

const file = (text) => text.replace(/^\n/, "");

const MAIN = {
    "package.json": file(`
{
  "name": "orders-api",
  "version": "1.4.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p .",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
`),
    "README.md": file(`
# orders-api

Typed client for the internal orders backend.

\`\`\`ts
const orders = new OrderService();
const order = await orders.getOrder("o-1042");
\`\`\`
`),
    "src/config.ts": file(`
export interface HttpConfig {
    baseUrl: string;
    timeoutMs: number;
}

export const defaultConfig: HttpConfig = {
    baseUrl: process.env.ORDERS_BASE_URL ?? "https://orders.internal",
    timeoutMs: 10_000,
};
`),
    "src/http/client.ts": file(`
import { defaultConfig, type HttpConfig } from "../config.js";
import { withTimeout } from "./timeout.js";

export class HttpClient {
    constructor(private readonly config: HttpConfig = defaultConfig) {}

    async get<T>(path: string): Promise<T> {
        const response = await withTimeout(fetch(new URL(path, this.config.baseUrl)), this.config.timeoutMs);
        if (!response.ok) {
            throw new HttpError(response.status, await response.text());
        }
        return (await response.json()) as T;
    }
}

export class HttpError extends Error {
    constructor(readonly status: number, body: string) {
        super(\`HTTP \${status}: \${body.slice(0, 200)}\`);
    }
}
`),
    "src/http/timeout.ts": file(`
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(\`Timed out after \${ms} ms\`)), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}
`),
    "src/orders/service.ts": file(`
import { HttpClient } from "../http/client.js";

export interface Order {
    id: string;
    status: "pending" | "shipped" | "cancelled";
    totalCents: number;
}

export class OrderService {
    constructor(private readonly http = new HttpClient()) {}

    getOrder(id: string): Promise<Order> {
        return this.http.get<Order>(\`/orders/\${encodeURIComponent(id)}\`);
    }
}
`),
    "test/client.test.ts": file(`
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient, HttpError } from "../src/http/client.js";

const config = { baseUrl: "https://orders.test", timeoutMs: 1_000 };

afterEach(() => vi.unstubAllGlobals());

describe("HttpClient", () => {
    it("returns the parsed body", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "o-1" })));
        await expect(new HttpClient(config).get("/orders/o-1")).resolves.toEqual({ id: "o-1" });
    });

    it("throws HttpError for non-2xx responses", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
        await expect(new HttpClient(config).get("/orders/o-1")).rejects.toBeInstanceOf(HttpError);
    });
});
`),
};

// Revision 1: the committed and pushed feature branch.
const FEATURE = {
    "README.md": MAIN["README.md"] + file(`

## Retries

\`HttpClient\` retries throttling, server errors and network failures with exponential backoff.
Tune it with \`retry\` in \`src/config.ts\`.
`),
    "src/config.ts": file(`
import type { RetryPolicy } from "./http/retry.js";

export interface HttpConfig {
    baseUrl: string;
    timeoutMs: number;
    retry: RetryPolicy;
}

export const defaultConfig: HttpConfig = {
    baseUrl: process.env.ORDERS_BASE_URL ?? "https://orders.internal",
    timeoutMs: 10_000,
    retry: {
        maxAttempts: 4,
        baseDelayMs: 200,
        maxDelayMs: 5_000,
    },
};
`),
    "src/http/client.ts": file(`
import { defaultConfig, type HttpConfig } from "../config.js";
import { withRetry } from "./retry.js";

export class HttpClient {
    constructor(private readonly config: HttpConfig = defaultConfig) {}

    async get<T>(path: string): Promise<T> {
        return withRetry(this.config.retry, async () => {
            const response = await fetch(new URL(path, this.config.baseUrl), {
                signal: AbortSignal.timeout(this.config.timeoutMs),
            });
            if (!response.ok) {
                const retryAfter = response.headers.get("retry-after");
                throw new HttpError(response.status, await response.text(), retryAfter);
            }
            return (await response.json()) as T;
        });
    }
}

export class HttpError extends Error {
    constructor(
        readonly status: number,
        body: string,
        readonly retryAfter: string | null = null,
    ) {
        super(\`HTTP \${status}: \${body.slice(0, 200)}\`);
    }
}
`),
    "src/http/retry.ts": file(`
import { HttpError } from "./client.js";

export interface RetryPolicy {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export function isRetryable(error: unknown): boolean {
    if (error instanceof HttpError) return RETRYABLE_STATUS.has(error.status);
    return error instanceof TypeError; // fetch reports network failures as TypeError
}

export function computeDelay(policy: RetryPolicy, attempt: number): number {
    const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
    return Math.min(exponential, policy.maxDelayMs);
}

export async function withRetry<T>(policy: RetryPolicy, operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (attempt >= policy.maxAttempts || !isRetryable(error)) throw error;
            await sleep(computeDelay(policy, attempt));
        }
    }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
`),
    "src/http/timeout.ts": null,
    "test/client.test.ts": file(`
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient, HttpError } from "../src/http/client.js";

const config = {
    baseUrl: "https://orders.test",
    timeoutMs: 1_000,
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
};

afterEach(() => vi.unstubAllGlobals());

describe("HttpClient", () => {
    it("returns the parsed body", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "o-1" })));
        await expect(new HttpClient(config).get("/orders/o-1")).resolves.toEqual({ id: "o-1" });
    });

    it("throws HttpError for non-2xx responses", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
        await expect(new HttpClient(config).get("/orders/o-1")).rejects.toBeInstanceOf(HttpError);
    });

    it("retries a 503 and returns the next response", async () => {
        const fetch = vi.fn()
            .mockResolvedValueOnce(new Response("busy", { status: 503 }))
            .mockResolvedValueOnce(Response.json({ id: "o-1" }));
        vi.stubGlobal("fetch", fetch);
        await expect(new HttpClient(config).get("/orders/o-1")).resolves.toEqual({ id: "o-1" });
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});
`),
    "test/retry.test.ts": file(`
import { describe, expect, it } from "vitest";
import { HttpError } from "../src/http/client.js";
import { computeDelay, isRetryable } from "../src/http/retry.js";

const policy = { maxAttempts: 4, baseDelayMs: 200, maxDelayMs: 5_000 };

describe("isRetryable", () => {
    it("retries throttling and server errors", () => {
        expect(isRetryable(new HttpError(429, ""))).toBe(true);
        expect(isRetryable(new HttpError(503, ""))).toBe(true);
    });

    it("does not retry other client errors", () => {
        expect(isRetryable(new HttpError(400, ""))).toBe(false);
        expect(isRetryable(new HttpError(409, ""))).toBe(false);
    });
});

describe("computeDelay", () => {
    it("grows exponentially up to maxDelayMs", () => {
        expect(computeDelay(policy, 1)).toBe(200);
        expect(computeDelay(policy, 6)).toBe(5_000);
    });
});
`),
};

const RETRY_TEST_HEAD = FEATURE["test/retry.test.ts"].slice(0, FEATURE["test/retry.test.ts"].indexOf('describe("computeDelay"'));

// Revision 2 (uncommitted): full jitter and Retry-After, after the first review round.
const R2 = {
    "src/http/retry.ts": FEATURE["src/http/retry.ts"]
        .replace(file(`
export function computeDelay(policy: RetryPolicy, attempt: number): number {
    const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
    return Math.min(exponential, policy.maxDelayMs);
}
`), file(`
export function computeDelay(policy: RetryPolicy, attempt: number, error: unknown): number {
    const retryAfter = error instanceof HttpError ? parseRetryAfter(error.retryAfter) : null;
    if (retryAfter != null) return retryAfter;
    // Full jitter: spread retries so clients don't hit a recovering backend in lockstep.
    const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
    return Math.random() * Math.min(exponential, policy.maxDelayMs);
}
`))
        .replace("await sleep(computeDelay(policy, attempt));", "await sleep(computeDelay(policy, attempt, error));")
        .replace("const sleep =", file(`
// Retry-After is either delay-seconds or an HTTP-date (RFC 9110, section 10.2.3).
function parseRetryAfter(value: string | null): number | null {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

const sleep =`)),
    "test/retry.test.ts": RETRY_TEST_HEAD + file(`
describe("computeDelay", () => {
    it("stays within the exponential bound", () => {
        for (let attempt = 1; attempt <= 6; attempt++) {
            const delay = computeDelay(policy, attempt, new HttpError(503, ""));
            expect(delay).toBeLessThanOrEqual(Math.min(200 * 2 ** (attempt - 1), 5_000));
        }
    });

    it("honors Retry-After in seconds", () => {
        expect(computeDelay(policy, 1, new HttpError(429, "", "2"))).toBe(2_000);
    });
});
`),
};

// Revision 3 (uncommitted): Retry-After is clamped, after the second review round.
const R3 = {
    "src/http/retry.ts": R2["src/http/retry.ts"].replace(
        "if (retryAfter != null) return retryAfter;",
        "if (retryAfter != null) return Math.min(retryAfter, policy.maxDelayMs);"),
    "test/retry.test.ts": R2["test/retry.test.ts"].replace(/\n\}\);\n$/, "\n" + file(`

    it("clamps Retry-After to maxDelayMs", () => {
        expect(computeDelay(policy, 1, new HttpError(429, "", "3600"))).toBe(5_000);
    });
});
`)),
};

const DESCRIPTION = (clamped) => [
    "Transient failures from the orders backend (throttling, deployments, dropped connections) currently fail the request on the first attempt. This adds a retry policy to `HttpClient`.",
    "",
    "### Behavior",
    "- Retries 408, 429, 500, 502, 503, 504 and network errors, up to `maxAttempts` (default 4).",
    "- Exponential backoff with full jitter, capped at `maxDelayMs`.",
    clamped
        ? "- Honors `Retry-After` (seconds or HTTP-date), clamped to `maxDelayMs`."
        : "- Honors `Retry-After` (seconds or HTTP-date).",
    "- Replaces the hand-rolled `withTimeout` helper with `AbortSignal.timeout`.",
    "",
    "### Verification",
    `- \`npm test\`: ${clamped ? 9 : 8} passed, including the new \`retry.test.ts\`.`,
    "",
    "### Risks",
    "- Non-idempotent requests are retried too; see the open thread on `withRetry`.",
].join("\n");

const git = (cwd, ...args) => runGit(cwd, [
    "-c", "user.name=Demo", "-c", "user.email=demo@example.com",
    "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args]);

async function writeFiles(repo, files) {
    for (const [rel, text] of Object.entries(files)) {
        const full = path.join(repo, ...rel.split("/"));
        if (text === null) {
            await rm(full, { force: true });
        } else {
            await mkdir(path.dirname(full), { recursive: true });
            await writeFile(full, text);
        }
    }
}

function lineOf(text, needle) {
    const index = text.split("\n").findIndex((l) => l.includes(needle));
    if (index < 0) throw new Error(`Demo anchor not found: ${needle}`);
    return index + 1;
}

// ---------- Seed the review ----------

async function seed(tmp) {
    const repo = path.join(tmp, "orders-api");
    const origin = path.join(tmp, "orders-api.git");
    await runGit(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
    await runGit(tmp, ["init", "-q", "-b", "main", repo]);
    await writeFiles(repo, MAIN);
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "Add orders client");
    await git(repo, "remote", "add", "origin", origin);
    await git(repo, "push", "-q", "-u", "origin", "main");
    await git(repo, "checkout", "-q", "-b", "feature/retry-policy");
    await writeFiles(repo, FEATURE);
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "Retry transient failures in HttpClient");
    await git(repo, "push", "-q", "-u", "origin", "feature/retry-policy");

    const store = new Store(path.join(tmp, "data"));
    const service = new ReviewService({ store });
    let reviewId;
    const delivery = new Delivery({ service, send: async () => "demo", reviewIds: () => [reviewId] });
    reviewId = await service.ensureReview({ repoPath: repo, base: "main", title: "Retry transient failures in HttpClient" });

    // Backdate everything afterwards so the UI shows a plausible timeline instead of "just now".
    const minutesAgo = new Map();
    const revision = async (minutes) => {
        const { currentRevisionId } = await service.getReview(reviewId);
        minutesAgo.set(currentRevisionId, minutes);
    };
    const comment = async (minutes, input) => {
        const { thread, message } = await service.createThread(reviewId, input);
        minutesAgo.set(message.messageId, minutes);
        return { threadId: thread.threadId, messageId: message.messageId };
    };
    const onLine = (minutes, files, filePath, needle, body) => {
        const line = lineOf(files[filePath], needle);
        return comment(minutes, { kind: "line", path: filePath, side: "new", startLine: line, endLine: line, body });
    };
    const reply = async (minutes, threadId, input) => {
        const { message } = await service.addMessage(reviewId, threadId, { author: "agent", ...input });
        minutesAgo.set(message.messageId, minutes);
    };
    const nextRevision = async (files, minutes) => {
        await writeFiles(repo, files);
        await service.refresh(reviewId);
        await revision(minutes);
    };

    await revision(44);
    const overall = await comment(42, { kind: "overview", body: "Draft the description. Keep it short; reviewers skim." });
    await service.updateDescription(reviewId, { body: DESCRIPTION(false), expectedVersion: 0 });
    await reply(40, overall.threadId, {
        outcome: "answered",
        body: "Drafted it above: purpose, behavior, verification and risks. I'll keep it in sync as the diff changes. Short descriptions look like a personal preference, so I proposed it as a guideline: say yes and I'll save it to your own instructions.",
        lessons: [{ scope: "personal", rule: "Keep PR descriptions short: purpose, behavior change, verification, risks.", status: "proposed" }],
    });

    const jitter = await onLine(36, FEATURE, "src/http/retry.ts", "return Math.min(exponential, policy.maxDelayMs);",
        "No jitter, so after an outage every client retries in lockstep and hits the backend at the same moment. Use full jitter, and honor `Retry-After` on 429 and 503.");
    const header = await onLine(33, FEATURE, "src/http/client.ts", 'const retryAfter = response.headers.get("retry-after");',
        "Parse `Retry-After` here and store milliseconds instead of carrying the raw header around.");
    await reply(31, header.threadId, {
        outcome: "disagreed",
        body: "I'd keep the raw header. `Retry-After` can be an HTTP-date, which is relative to the current time, so parsing it here makes the delay stale by the time `withRetry` sleeps. `computeDelay` parses it right before waiting.",
    });

    await nextRevision(R2, 27);
    await reply(26, jitter.threadId, {
        outcome: "changed",
        body: "Switched to full jitter: the delay is now uniform in `[0, min(base * 2^n, maxDelayMs)]`. `Retry-After` (seconds or HTTP-date) wins when the server sends it.",
        verification: "`npm test -- retry`: 5 passed",
        lessons: [{ scope: "repo", rule: "Retries use exponential backoff with full jitter and honor `Retry-After`.", savedTo: ".github/copilot-instructions.md" }],
    });
    await service.setThreadStatus(reviewId, jitter.threadId, "resolved");

    const clamp = await onLine(15, R2, "src/http/retry.ts", "const retryAfter = error instanceof HttpError",
        "Clamp this. A server that sends `Retry-After: 3600` would stall the request for an hour.");
    await nextRevision(R3, 9);
    await reply(8, clamp.threadId, {
        outcome: "changed",
        body: "`Retry-After` is now clamped to `maxDelayMs`, the same cap as the computed backoff. Added a test for a one-hour value.",
        verification: "`npm test -- retry`: 6 passed",
        lessons: [{ scope: "repo", rule: "Clamp server-supplied delays such as `Retry-After` to the configured maximum.", savedTo: ".github/copilot-instructions.md" }],
    });
    await service.updateDescription(reviewId, { body: DESCRIPTION(true), expectedVersion: 1 });

    const idempotent = await onLine(3, R3, "src/http/retry.ts", "export async function withRetry",
        "This retries POSTs too. Only retry idempotent requests unless the caller passes an idempotency key.");
    await service.setDelivery(reviewId, idempotent.messageId, { state: "processing", processingAt: new Date().toISOString() });
    const knob = await onLine(1, FEATURE, "src/config.ts", "maxAttempts: 4,",
        "Read this from `ORDERS_RETRY_MAX_ATTEMPTS` so we can tune it without a deploy.");
    await service.setDelivery(reviewId, knob.messageId, { state: "queued", queuedAt: new Date().toISOString() });
    delivery.setBusy(true);

    await store.updateReview(reviewId, (review) => {
        const iso = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
        const stamp = (item, id) => {
            if (minutesAgo.has(id)) item.createdAt = iso(minutesAgo.get(id));
        };
        for (const rev of review.revisions) stamp(rev, rev.revisionId);
        for (const thread of review.threads) {
            for (const message of thread.messages) stamp(message, message.messageId);
            thread.createdAt = thread.messages[0].createdAt;
        }
        for (const lesson of review.lessons) {
            const message = review.threads.flatMap((t) => t.messages).find((m) => m.messageId === lesson.messageId);
            if (message) lesson.createdAt = message.createdAt;
        }
        return { review };
    });

    const outdated = (await service.getReview(reviewId)).threads.find((t) => t.threadId === jitter.threadId);
    if (outdated.location?.state !== "outdated") throw new Error("Expected the jitter thread to be outdated after revision 2.");

    return { reviewId, service, delivery, store, threads: { clamp: clamp.threadId, idempotent: idempotent.threadId } };
}

// ---------- Capture ----------

async function launchBrowser() {
    const channels = [...new Set([process.env.MR_BROWSER_CHANNEL, "msedge", "chrome"].filter(Boolean)), undefined];
    let lastError;
    for (const channel of channels) {
        try {
            return await chromium.launch(channel ? { channel } : {});
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError;
}

async function nav(page, view, filePath) {
    const pathSelector = filePath ? `[data-path="${filePath}"]` : "";
    await page.locator(`#side [data-action="nav"][data-view="${view}"]${pathSelector}`).first().click();
    if (view === "file") {
        await page.locator(`.file-section[data-file="${filePath}"] .diff`).waitFor();
        await page.waitForFunction(() => ![...document.querySelectorAll(".full-note")].some((n) => n.textContent.startsWith("Loading")));
    }
    await page.evaluate(() => document.querySelector("#main").scrollTo(0, 0));
    await page.waitForTimeout(250);
}

// Sizes the viewport to the content of both panes (up to maxHeight) so the shot has no scrolling
// and no trailing whitespace. scrollHeight is unusable here: it never drops below the pane height.
async function fitHeight(page, maxHeight) {
    const needed = await page.evaluate(() => {
        const main = document.querySelector("#main");
        const bottoms = [...main.children].map((el) => el.getBoundingClientRect().bottom + main.scrollTop);
        bottoms.push(...[...document.querySelectorAll("#side .nav-item")].map((el) => el.getBoundingClientRect().bottom));
        return Math.ceil(Math.max(...bottoms) + 16);
    });
    await page.setViewportSize({ width: WIDTH, height: Math.min(needed, maxHeight) });
    await page.waitForTimeout(250);
}

async function capture(browser, url, theme, resetLearning) {
    await resetLearning();
    const context = await browser.newContext({ viewport: { width: WIDTH, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
    const page = await context.newPage();
    await page.goto(url);
    await page.locator("#side .nav-item").first().waitFor();
    const shot = async (name, clip) => {
        const target = path.join(OUT, `${name}-${theme}.png`);
        await page.screenshot({ path: target, clip });
        console.log(`  ${path.relative(process.cwd(), target)}`);
    };

    // A repository with no learning setting opens with a notice. Choosing Suggest from it dismisses the notice for good.
    await page.locator("#banner:not([hidden])").waitFor();
    const banner = await page.locator("#banner").boundingBox();
    await shot("banner", { x: 0, y: 0, width: WIDTH, height: Math.ceil(banner.y + banner.height) });
    await page.locator('#banner [data-action="learning-set"][data-mode="suggest"]').click();
    await page.locator("#banner").waitFor({ state: "hidden" });
    await page.locator("#toast").waitFor({ state: "hidden" });

    // A file with an answered thread (change, verification, lesson) and one Copilot is working on.
    await nav(page, "file", "src/http/retry.ts");
    await fitHeight(page, 1290);
    await shot("conversation");

    // Selecting lines in a modified file opens an inline composer.
    await nav(page, "file", "src/http/client.ts");
    await fitHeight(page, 1050);
    const first = page.locator("tr.row.add", { hasText: "const response = await fetch(" }).first();
    const last = page.locator("tr.row.add", { hasText: "signal: AbortSignal.timeout(" }).first();
    await first.locator("td.ln").nth(1).hover();
    await page.mouse.down();
    await last.locator("td.ln").nth(1).hover();
    await page.mouse.up();
    const composer = page.locator("textarea[data-composer^='line:']");
    await composer.waitFor();
    await composer.focus();
    await page.keyboard.type("Log each attempt with its status code, so retry storms show up on the dashboard.");
    await shot("comment");

    await page.keyboard.press("Escape");
    await nav(page, "overview");
    await fitHeight(page, 1700);
    await shot("overview");

    await nav(page, "lessons");
    await fitHeight(page, 700);
    await shot("lessons");

    // The per-repository learning setting.
    await page.locator('#top [data-action="configure"]').click();
    await page.locator("#dialog .modal").waitFor();
    await shot("configure");
    await page.keyboard.press("Escape");

    // The pending scope is its own review of what is not committed yet. Switch back so the next theme starts on the full review.
    await page.locator('#top [data-action="scope"][data-scope="pending"]').click();
    await page.locator('#top [data-scope="pending"][aria-pressed="true"]:not([disabled])').waitFor();
    await nav(page, "file", "src/http/retry.ts");
    await fitHeight(page, 600);
    await shot("pending");
    await page.locator('#top [data-action="scope"][data-scope="all"]').click();
    await page.locator('#top [data-scope="all"][aria-pressed="true"]:not([disabled])').waitFor();

    await context.close();
}

const tmp = await mkdtemp(path.join(os.tmpdir(), "mr-shots-"));
let server;
let browser;
try {
    const seeded = await seed(tmp);
    const { service, delivery } = seeded;
    let reviewId = seeded.reviewId;
    const settings = new SettingsService({ store: seeded.store });
    // Every theme starts like a first run: the repository has no learning setting yet.
    const resetLearning = () => rm(seeded.store.settingsFile(), { force: true });
    server = await startReviewServer({
        instanceId: "screenshots",
        getReviewId: () => reviewId,
        onReviewChange: (id) => {
            reviewId = id;
        },
        service,
        delivery,
        settings,
        webRoot: WEB_ROOT,
    });
    await mkdir(OUT, { recursive: true });
    browser = await launchBrowser();
    for (const theme of THEMES) {
        console.log(`${theme}:`);
        await capture(browser, server.url, theme, resetLearning);
    }
    if (KEEP) {
        console.log(`\nDemo review: ${server.url}\nRepo: ${path.join(tmp, "orders-api")}\nPress Ctrl+C to stop.`);
        await new Promise(() => {});
    }
} finally {
    await browser?.close();
    await server?.close();
    await rm(tmp, { recursive: true, force: true });
}
