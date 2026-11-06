// Re-locates line anchors in a newer revision by content, ADO-style. A thread keeps
// following its code when lines shift; if the code is gone, it is marked outdated
// at the nearest valid line instead of being hidden.

function normalize(line) {
    return line.replace(/\s+$/, "");
}

function squash(line) {
    return line.replace(/\s+/g, "");
}

function findMatches(fileLines, needle, map) {
    const hay = fileLines.map(map);
    const target = needle.map(map);
    const matches = [];
    if (target.length === 0 || target.length > hay.length) return matches;
    outer: for (let i = 0; i + target.length <= hay.length; i++) {
        for (let j = 0; j < target.length; j++) {
            if (hay[i + j] !== target[j]) continue outer;
        }
        matches.push(i + 1);
    }
    return matches;
}

function nearest(candidates, hint) {
    let best = candidates[0];
    for (const c of candidates) {
        if (Math.abs(c - hint) < Math.abs(best - hint)) best = c;
    }
    return best;
}

/**
 * @param {{ selectedLines?: string[], startLine: number, endLine: number }} anchor
 * @param {number} hintLine last known start line (in the previous revision)
 * @param {string[] | null} fileLines current content of the anchored side, or null if unavailable
 * @returns {{ startLine: number, endLine: number, state: "current" | "outdated" }}
 */
export function relocate(anchor, hintLine, fileLines) {
    const span = Math.max(0, anchor.endLine - anchor.startLine);
    const hint = hintLine ?? anchor.startLine;
    if (!fileLines) return { startLine: hint, endLine: hint + span, state: "outdated" };

    const needle = anchor.selectedLines ?? [];
    const meaningful = needle.some((l) => l.trim() !== "");
    if (meaningful) {
        for (const map of [normalize, squash]) {
            const found = findMatches(fileLines, needle, map);
            if (found.length > 0) {
                const start = nearest(found, hint);
                // selectedLines may be truncated for long ranges; keep the original span.
                const end = Math.min(start + Math.max(span, needle.length - 1), fileLines.length);
                return { startLine: start, endLine: end, state: "current" };
            }
        }
    }

    const max = Math.max(1, fileLines.length);
    const start = Math.min(Math.max(1, hint), max);
    // Blank-only selections cannot be tracked by content; keep them where they were.
    return { startLine: start, endLine: Math.min(start + span, max), state: meaningful ? "outdated" : "current" };
}
