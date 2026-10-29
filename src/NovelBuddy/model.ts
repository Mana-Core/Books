/* SPDX-License-Identifier: GPL-3.0-or-later */

import { options } from "../lib/search";

/**
 * novelbuddy.io, novelbuddy.com, lightnovelpub.io and novelfab.com (and their `api.`
 * hosts) all answer with a 301 to novelbuddy.me, so they fail exactly when it does and
 * add nothing as failover.
 */
export const MIRRORS = ["https://novelbuddy.me"];

/** Probes the API host, which is what the source talks to; a parked domain lacks the JSON. */
export const PROBE_MARKER = '"success":true';
export const probeUrl = (origin: string): string => `${apiOf(origin)}/trending/titles?limit=1`;

/**
 * The front end reads everything from `api.<site host>` (its `siteConfig.apiUrl`), which
 * the site itself does not proxy, so the API host follows whichever mirror is active.
 */
export function apiOf(origin: string): string {
    return origin.replace(/^(https?:\/\/)(?:www\.)?/i, "$1api.");
}

export const PAGE_SIZE = 24;

/**
 * The site's filter panel also sends `demographic`, `content_rating`, `format`, `raw`,
 * `mtl` and `uncensored`; for novels the first three match nothing and the toggles change
 * nothing, so they are left out.
 */
export const FILTER = {
    genres: "genres",
    status: "status",
    type: "type",
    chapters: "chapters",
    maxChapters: "max_chapters",
    author: "author",
    tag: "tag",
} as const;

/** "Best Match" is relevance; the API returns nothing when it is sent explicitly. */
export const BEST_MATCH = "best_match";

/**
 * The search page's own origin list is the comic one (manga, manhwa, manhua), which matches
 * no novel, and the API's `/types` answers "Failed to fetch types". These are the `type`
 * slugs novels carry in `/titles/by-slug/…`, kept here because nothing on the site lists them.
 */
export const TYPES = options([
    ["korean", "Korean"],
    ["chinese", "Chinese"],
    ["japanese", "Japanese"],
]);

export type ApiGenre = { name?: string; slug?: string };

/** The API's 400 for an invalid filter, which names the values it accepts. */
export type ApiRejection = { details?: { field?: string; message?: string }[] };

export type ApiEnvelope<T> = { success?: boolean; message?: string; data?: T };

export type ApiNamed = { name?: string; slug?: string };

export type ApiChapterRef = {
    id?: string;
    url?: string;
    name?: string;
    slug?: string;
    updated_at?: string;
    number?: number | string | null;
};

export type ApiTitle = {
    id?: string;
    url?: string;
    name?: string;
    slug?: string;
    cover?: string;
    status?: string;
    summary?: string;
    alt_names?: ApiNamed[] | null;
    genres?: ApiNamed[] | null;
    tags?: ApiNamed[] | null;
    authors?: ApiNamed[] | null;
    is_adult?: boolean;
    content_version?: number | string;
    cv?: number | string;
    stats?: { chapters_count?: number };
    latest_chapters?: ApiChapterRef[] | null;
};

export type ApiPage = {
    items?: ApiTitle[];
    pagination?: { page?: number; total_pages?: number; has_next?: boolean };
};

export type ApiChapter = ApiChapterRef & { content?: string };
