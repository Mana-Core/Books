// SPDX-License-Identifier: GPL-3.0-or-later
//
// Offline checks of the built repository against the rules the app enforces silently:
// icons, versions, intents, and globals the runtime does not have.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const problem = (where, message) => problems.push(`${where}: ${message}`);

const INTENTS = {
    preferences: 0,
    pageResolver: 3,
    authenticatable: 5,
    basicAuth: 6,
    basicAuthUsesEmail: 7,
    webviewAuth: 8,
    search: 10,
    searchForm: 11,
    sortOptions: 12,
    providesChapters: 21,
};

const BANNED = [
    [/\bfetch\s*\(/, "fetch() does not exist in the runtime — use HttpClient"],
    [/new\s+URL\s*\(/, "URL is not typed here — use src/lib/url.ts"],
    [/\bURLSearchParams\b/, "use encodeQuery from src/lib/url.ts"],
    [/\bText(De|En)coder\b/, "TextEncoder/TextDecoder do not exist in the runtime"],
    [/crypto\.subtle/, "crypto.subtle does not exist in the runtime"],
    [/\bDOMParser\b/, "DOMParser does not exist in the runtime — use cheerio"],
    [
        /onEnvironmentLoaded\s*\([^)]*\)\s*{[^}]*this\.\w+\s*=/s,
        "onEnvironmentLoaded is not awaited — create clients lazily",
    ],
];

const distArg = process.argv.find((a) => a.startsWith("--dist="))?.slice(7);
const indexPath = join(ROOT, distArg ?? "dist", "sources.json");
if (!existsSync(indexPath)) {
    console.error("dist/sources.json is missing. Run npm run build first.");
    process.exit(2);
}
const index = JSON.parse(readFileSync(indexPath, "utf8"));

const folders = readdirSync(join(ROOT, "src"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "lib" && !d.name.startsWith("."))
    .map((d) => d.name);

// A partial build (--dist) only answers for the folders it contains.
for (const folder of distArg ? [] : folders) {
    const built = index.sources.find((s) => s.path === folder || s.name === folder);
    if (!built) {
        problem(
            folder,
            "not in dist/sources.json — does main.ts export class Target and info.name match the folder?",
        );
    }
    if (!existsSync(join(ROOT, "probes", `${folder}.json`))) {
        problem(folder, "no probes/<Name>.json for npm run verify");
    }
}

const ids = new Set();
for (const source of index.sources) {
    const where = source.name;
    if (ids.has(source.id)) problem(where, `duplicate id ${source.id}`);
    ids.add(source.id);
    if (!/^\d+\.\d+\.\d+$/.test(String(source.version))) {
        problem(where, `version ${source.version} is not x.y.z`);
    }
    if (!source.website) problem(where, "info.website is required by the app");
    if (!source.thumbnail || !existsSync(join(ROOT, "assets", source.thumbnail))) {
        problem(
            where,
            `icon assets/${source.thumbnail ?? "<none>"} is missing — the app draws a placeholder`,
        );
    }
    for (const required of ["search", "providesChapters"]) {
        if (!(source.intents & (1 << INTENTS[required]))) {
            problem(where, `missing intent ${required}`);
        }
    }

    const probePath = join(ROOT, "probes", `${source.name}.json`);
    const probe = existsSync(probePath) ? JSON.parse(readFileSync(probePath, "utf8")) : {};
    for (const intent of probe.intents ?? []) {
        if (!(intent in INTENTS)) problem(where, `probe lists unknown intent ${intent}`);
        else if (!(source.intents & (1 << INTENTS[intent]))) {
            problem(where, `expected intent ${intent} is not set`);
        }
    }
}

function walk(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
    });
}

for (const file of walk(join(ROOT, "src"))) {
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const [pattern, message] of BANNED) {
        if (pattern.test(code)) problem(file.replace(`${ROOT}/`, ""), message);
    }
    if (/\bclass\s+Target\b/.test(code) && file.includes("/src/lib/")) {
        problem(file, "src/lib must not declare Target — it would be built as a source");
    }
}

if (problems.length) {
    console.log(problems.map((p) => `✗ ${p}`).join("\n"));
    console.log(`\n${problems.length} problem(s).`);
    process.exit(1);
}
console.log(`✓ ${index.sources.length} sources pass the offline checks.`);
