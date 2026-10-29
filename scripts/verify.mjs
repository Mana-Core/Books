// SPDX-License-Identifier: GPL-3.0-or-later
//
// Contract test against the live site: drives a built bundle through the calls the app
// makes and checks what comes back, down to the bytes of the chapter document.
//
//   node scripts/verify.mjs <Name> [--verbose]
//   node scripts/verify.mjs --all
//
// A Cloudflare challenge reports SKIP. SKIP means unverified, not passed.

import { spawnSync } from "node:child_process";
import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadSource } from "./harness/runtime.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const names = args.filter((a) => !a.startsWith("--"));
// --dist=<dir> verifies a build written elsewhere, e.g. `mana-dev build src/<Name> -o .mana-temp/<Name>`.
const DIST = join(ROOT, args.find((a) => a.startsWith("--dist="))?.slice(7) ?? "dist");

const index = JSON.parse(readFileSync(join(DIST, "sources.json"), "utf8"));

if (args.includes("--all")) {
    let failed = 0;
    for (const entry of index.sources) {
        const run = spawnSync(
            process.execPath,
            [
                fileURLToPath(import.meta.url),
                entry.name,
                ...args.filter((a) => a.startsWith("--dist=")),
            ],
            { stdio: "inherit" },
        );
        if (run.status !== 0) failed += 1;
    }
    process.exit(failed ? 1 : 0);
}

if (names.length !== 1) {
    console.error("Usage: node scripts/verify.mjs <Name> [--verbose] [--dist=<dir>] | --all");
    process.exit(2);
}

const name = names[0];
const entry = index.sources.find((s) => s.name === name || s.id === name);
if (!entry) {
    console.error(`No built source named ${name}. Run npm run build first.`);
    process.exit(2);
}

const probePath = join(ROOT, "probes", `${entry.name}.json`);
const probe = existsSync(probePath) ? JSON.parse(readFileSync(probePath, "utf8")) : {};

const env = (key) => process.env[key]?.trim() || undefined;
const secureStore = Object.fromEntries(
    Object.entries(probe.secureStore ?? {})
        .map(([key, variable]) => [key, env(variable)])
        .filter(([, value]) => value),
);

const { source, call } = loadSource(join(DIST, "sources", `${entry.name}.mana`), {
    secureStore,
    log: verbose ? (line) => console.log(`    · ${line}`) : undefined,
});

const results = [];
let cloudflare = false;

async function step(label, run) {
    const started = Date.now();
    try {
        const note = await run();
        results.push(["PASS", label, note]);
        console.log(`  PASS  ${label}${note ? ` — ${note}` : ""} (${Date.now() - started} ms)`);
        return true;
    } catch (error) {
        if (error?.name === "SkipError") {
            results.push(["SKIP", label, error.message]);
            console.log(`  SKIP  ${label} — ${error.message}`);
        } else if (
            error?.constructor?.name === "CloudflareError" ||
            /cloudflare/i.test(error?.message ?? "")
        ) {
            cloudflare = true;
            results.push(["SKIP", label, "Cloudflare challenge"]);
            console.log(`  SKIP  ${label} — Cloudflare challenge (unverified)`);
        } else {
            results.push(["FAIL", label, error?.message]);
            console.log(`  FAIL  ${label} — ${error?.message ?? error}`);
            if (verbose && error?.stack) console.log(error.stack);
        }
        return false;
    }
}

class SkipError extends Error {
    constructor(message) {
        super(message);
        this.name = "SkipError";
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function checkHighlight(item, where) {
    assert(item && typeof item.id === "string" && item.id, `${where}: highlight without id`);
    assert(
        typeof item.title === "string" && item.title.trim(),
        `${where}: "${item.id}" has no title`,
    );
    assert(typeof item.cover === "string", `${where}: "${item.id}" has no cover string`);
}

function sniff(bytes) {
    const head = bytes.subarray(0, 4).toString("latin1");
    if (head === "%PDF") return "pdf";
    if (head.startsWith("PK\u0003\u0004")) {
        const start = bytes.subarray(0, 200).toString("latin1");
        return start.includes("application/epub+zip") || bytes.includes("META-INF/container.xml")
            ? "epub"
            : "zip";
    }
    const text = bytes.toString("utf8");
    if (/<(p|div|br|h\d)\b/i.test(text)) return "html";
    return text.trim() ? "text" : "empty";
}

console.log(`\n${entry.name} ${entry.version} (${entry.website})`);

const has = (method) => typeof source[method] === "function";
let firstResult;

await step("info", async () => {
    assert(
        source.info.id && source.info.name && source.info.version,
        "info is missing id/name/version",
    );
    assert(
        typeof source.info.website === "string",
        "info.website must be a string — the app refuses the source otherwise",
    );
});

if (has("getPreferenceMenu")) {
    await step("preferences", async () => {
        const form = await call("getPreferenceMenu");
        const mirror = form.sections
            .flatMap((s) => s.children ?? [])
            .find((c) => c.id === "mirror.selected");
        return mirror
            ? mirror.options
                  .slice(1)
                  .map((o) => o.title)
                  .join(" | ")
            : `${form.sections.length} sections`;
    });
}

if (has("getSectionsForPage")) {
    await step("home", async () => {
        const sections = await call("getSectionsForPage", { id: "home" });
        assert(sections.length > 0, "no home sections");
        const counts = [];
        for (const section of sections) {
            const items =
                section.items ??
                (await call("resolvePageSection", { id: "home" }, section.id)).items;
            assert(items.length > 0, `section "${section.title}" is empty`);
            items.forEach((item) => checkHighlight(item, `section ${section.id}`));
            counts.push(`${section.title}: ${items.length}`);
        }
        return counts.join(", ");
    });
}

if (has("getSearchForm")) {
    await step("search form", async () => {
        const form = await call("getSearchForm");
        assert(Array.isArray(form.sections) && form.sections.length > 0, "empty search form");
        return `${form.sections.length} sections`;
    });
}

await step(`search "${probe.query ?? ""}"`, async () => {
    const result = await call("search", { query: probe.query, page: 1 });
    assert(Array.isArray(result.results) && result.results.length > 0, "no results");
    result.results.forEach((item) => checkHighlight(item, "search"));
    firstResult = result.results[0];
    if (!result.isLastPage) {
        const next = await call("search", { query: probe.query, page: 2 });
        assert(next.results.length > 0, "page 2 is empty although page 1 said more exist");
        assert(next.results[0].id !== firstResult.id, "page 2 repeats page 1");
    }
    return `${result.results.length} results, first "${firstResult.title}"`;
});

const contentId = probe.contentId ?? firstResult?.id;
let chapters = [];
let contentLoaded = false;

if (contentId) {
    await step(`content ${contentId}`, async () => {
        const content = await call("getContent", contentId, undefined);
        assert(content.title, "no title");
        assert(typeof content.cover === "string", "no cover");
        assert(content.contentType === 4, "contentType must be NOVEL (4) so the book reader opens");
        chapters = content.chapters ?? [];
        contentLoaded = true;
        return `"${content.title}"`;
    });

    await step("chapters", async () => {
        if (!chapters.length && has("getChapters")) chapters = await call("getChapters", contentId);
        // A source that lists chapters only with its content has none to show when that step
        // was blocked; the app would not ask it separately either.
        if (!chapters.length && !has("getChapters") && !contentLoaded) {
            throw new SkipError(
                "content did not load, and this source lists chapters only with it",
            );
        }
        assert(chapters.length > 0, "no chapters");
        const indices = chapters.map((c) => c.index).sort((a, b) => a - b);
        assert(
            indices.every((v, i) => v === i),
            "chapter indices must be 0..n-1, each used once",
        );
        for (const chapter of chapters) {
            assert(chapter.chapterId, "chapter without id");
            assert(
                chapter.date instanceof Date && !Number.isNaN(chapter.date.getTime()),
                `chapter ${chapter.chapterId} has an invalid date`,
            );
            assert(Number.isFinite(chapter.number), `chapter ${chapter.chapterId} has no number`);
            assert(
                typeof chapter.language === "string" && chapter.language,
                `chapter ${chapter.chapterId} has no language`,
            );
        }
        const first = chapters.find((c) => c.index === 0);
        return `${chapters.length} chapters, first "${first.title ?? first.number}"`;
    });
}

const chapter =
    chapters.find((c) => c.chapterId === probe.chapterId) ?? chapters.find((c) => c.index === 0);
if (chapter) {
    await step(`chapter data ${chapter.chapterId}`, async () => {
        const missing = (probe.requiresEnv ?? []).filter((key) => !env(key));
        if (missing.length) throw new SkipError(`needs ${missing.join(", ")}`);
        // Sign in only when the credentials are there; a source that also works signed out is
        // then checked down its guest path instead.
        if (probe.basicAuth?.every((key) => env(key))) {
            const [identifier, password] = probe.basicAuth.map(env);
            await call("handleBasicAuth", identifier, password);
        }
        const row = {
            sourceId: source.info.id,
            contentId,
            chapterId: chapter.chapterId,
            index: chapter.index,
            number: chapter.number,
            volume: chapter.volume,
            title: chapter.title,
            language: chapter.language,
            webURL: chapter.webUrl,
            isNew: false,
            date: chapter.date.toISOString().replace(/\.\d{3}Z$/, "Z"),
        };
        const data = await call("getChapterData", contentId, chapter.chapterId, row);
        assert(data.document, "no document — novel and ebook chapters must return one");
        assert(
            data.document.status >= 200 && data.document.status < 300,
            `document status ${data.document.status}`,
        );
        const bytes = data.document.bytes;
        assert(bytes?.length, "document body is empty");
        const kind = sniff(bytes);
        const expected = probe.expect ?? "html";
        const accepted = expected === "file" ? ["epub", "pdf", "text"] : [expected];
        assert(accepted.includes(kind), `expected ${expected}, got ${kind}`);
        if (kind === "html") {
            const words = bytes
                .toString("utf8")
                .replace(/<[^>]+>/g, " ")
                .split(/\s+/)
                .filter(Boolean).length;
            assert(words >= 100, `chapter text is only ${words} words`);
            return `${kind}, ${words} words`;
        }
        return `${kind}, ${(bytes.length / 1024 / 1024).toFixed(2)} MB`;
    });
}

const failed = results.filter(([s]) => s === "FAIL").length;
const skipped = results.filter(([s]) => s === "SKIP").length;
console.log(
    `  ${failed ? "FAILED" : skipped ? "PASSED WITH SKIPS (unverified parts)" : "PASSED"} — ${results.length - failed - skipped} pass, ${skipped} skip, ${failed} fail${cloudflare ? " — Cloudflare blocked part of the run" : ""}`,
);
process.exit(failed ? 1 : 0);
