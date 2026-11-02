/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    ContentRating,
    ContentType,
    PublicationStatus,
    type Content,
    type Highlight,
    type Option,
    type PagedSearchResult,
    type Tag,
} from "@mana-app/types";

import { load } from "../lib/html";
import { SourceError } from "../lib/http";
import { resolveUrl } from "../lib/url";
import {
    BASE_URL,
    NOVEL_PATH,
    type Facets,
    type SeriesCard,
    type SeriesDetail,
    type SeriesPage,
} from "./model";

/** Every payload the page streams to its client, decoded and joined into one string. */
const PUSH = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;

/**
 * The page's framework stream. The detail page carries the novel's record in it, not in
 * the markup, so the record is read from here.
 */
export function flightData(html: string): string {
    return [...html.matchAll(PUSH)].map((m) => JSON.parse(`"${m[1] ?? ""}"`) as string).join("");
}

/** The JSON object that opens at `start`, found by bracket depth so nested data is kept whole. */
function balancedObject(text: string, start: number): string | undefined {
    let depth = 0;
    let inString = false;

    for (let i = start; i < text.length; i += 1) {
        const ch = text[i];

        if (inString) {
            if (ch === "\\") i += 1;
            else if (ch === '"') inString = false;
            continue;
        }

        if (ch === '"') inString = true;
        else if (ch === "{") depth += 1;
        else if (ch === "}") {
            depth -= 1;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }

    return undefined;
}

/**
 * A text row of the stream, by its reference. Its length is counted in UTF-8 bytes, so the
 * characters are walked rather than sliced by length.
 */
function textRow(flight: string, ref: string): string | undefined {
    const head = new RegExp(`(?:^|\\n)${ref}:T([0-9a-f]+),`).exec(flight);
    if (!head) return undefined;

    const budget = Number.parseInt(head[1] ?? "0", 16);
    const from = head.index + head[0].length;

    let taken = 0;
    let i = from;
    while (i < flight.length && taken < budget) {
        const code = flight.codePointAt(i) ?? 0;
        taken += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
        i += code > 0xffff ? 2 : 1;
    }

    return flight.slice(from, i);
}

/** The novel record for `slug`. The page may name other series too, so each is checked. */
function seriesFor(flight: string, slug: string): SeriesDetail | undefined {
    const marker = '"series":{"id":"';

    for (let at = flight.indexOf(marker); at >= 0; at = flight.indexOf(marker, at + 1)) {
        const json = balancedObject(flight, at + '"series":'.length);
        if (!json) continue;

        const series = JSON.parse(json) as SeriesDetail;
        if (series.slug === slug) return series;
    }

    return undefined;
}

/** The synopsis as the site wrote it: paragraphs kept, the stream's line breaks normalised. */
function synopsisOf(flight: string, description: string | undefined): string | undefined {
    const ref = /^\$([0-9a-f]+)$/.exec(description ?? "")?.[1];
    const raw = ref ? textRow(flight, ref) : description;

    const paragraphs = (raw ?? "")
        .split(/\r?\n+/)
        .map((line) => line.trim())
        .filter(Boolean);

    return paragraphs.length ? paragraphs.join("\n\n") : undefined;
}

/**
 * The author the page's structured data names. The page lists it only there, so this is
 * the one place it can be read.
 */
function authorOf($: ReturnType<typeof load>): string | undefined {
    for (const script of $('script[type="application/ld+json"]').toArray()) {
        // One malformed block must not hide the author that another block names.
        let json: unknown;
        try {
            json = JSON.parse($(script).text() || "null");
        } catch {
            continue;
        }

        const nodes = Array.isArray(json) ? json : [json];

        for (const node of nodes) {
            const graph = (node as { "@graph"?: unknown[] } | null)?.["@graph"] ?? [node];
            for (const item of graph) {
                const author = (item as { author?: unknown } | null)?.author;
                const first = Array.isArray(author) ? author[0] : author;
                const name = (first as { name?: unknown } | null)?.name;

                if (typeof name === "string" && name.trim()) return name.trim();
            }
        }
    }

    return undefined;
}

export function statusOf(value: string | undefined): PublicationStatus | undefined {
    switch (value) {
        case "ONGOING":
            return PublicationStatus.ONGOING;
        case "COMPLETED":
            return PublicationStatus.COMPLETED;
        case "HIATUS":
            return PublicationStatus.HIATUS;
        // The site separates a translator's dropped work from a discontinued one; the app has
        // only the cancelled state for both.
        case "DROPPED":
        case "DISCONTINUED":
            return PublicationStatus.CANCELLED;
        default:
            return undefined;
    }
}

export function coverOf(value: string | null | undefined): string {
    return resolveUrl(BASE_URL, value ?? undefined) ?? "";
}

/** Mature series are flagged by the site; the rest carry no rating so the app shows none. */
function ratingOf(flagged: { isMature?: boolean; nsfw?: boolean }): ContentRating | undefined {
    return flagged.isMature || flagged.nsfw ? ContentRating.MATURE : undefined;
}

export function novelPath(slug: string): string {
    return `/series/novel/${slug}`;
}

function highlightOf(card: SeriesCard): Highlight {
    const path = novelPath(card.slug);
    const latest = Math.max(0, ...(card.chapters ?? []).map((c) => c.number));

    return {
        id: path,
        title: card.title,
        cover: coverOf(card.coverImage),
        subtitle: latest ? `Chapter ${latest}` : undefined,
        contentRating: ratingOf(card),
        webUrl: `${BASE_URL}${path}`,
    };
}

export function parseSeriesPage(json: SeriesPage): PagedSearchResult {
    return {
        results: (json.data ?? []).map(highlightOf),
        isLastPage: !json.meta?.hasMore,
        totalResultCount: json.meta?.total,
    };
}

/** A name the site's own filter lists carry, as the id the feed filters by. */
export function facetOptions(entries: { name: string; slug: string }[]): Option[] {
    return entries.map((entry) => ({ id: entry.slug, title: entry.name }));
}

export function parseFacets(json: Facets): { genres: Option[]; tags: Facets["tags"] } {
    return { genres: facetOptions(json.genres ?? []), tags: json.tags ?? [] };
}

/** The novel's details, from its page: the record in the stream, the author from its data. */
export function parseDetail(html: string, path: string): Content {
    if (!NOVEL_PATH.test(path)) throw new SourceError("This link is not a NovelDex novel.");
    const slug = path.slice("/series/novel/".length);

    const flight = flightData(html);
    const series = seriesFor(flight, slug);
    if (!series) throw new SourceError("NovelDex's page for this novel had no details.");

    const $ = load(html);
    const tags: Tag[] = [
        ...(series.genres ?? []).map((g) => ({
            id: `genre:${g.slug}`,
            title: g.name,
            isNonInteractive: true,
        })),
        ...(series.tags ?? []).map((t) => ({
            id: `tag:${t.slug}`,
            title: t.name,
            isNonInteractive: true,
        })),
    ];

    const author = authorOf($);

    return {
        title: series.title,
        cover: coverOf(series.coverImage),
        summary: synopsisOf(flight, series.description),
        status: statusOf(series.status),
        contentType: ContentType.NOVEL,
        contentRating: ratingOf(series),
        additionalTitles: author ? [`by ${author}`] : undefined,
        tags,
        webUrl: `${BASE_URL}${path}`,
    };
}
