/* SPDX-License-Identifier: GPL-3.0-or-later */

import type { SortOption } from "@mana-app/types";

import { options } from "../lib/search";

export const BASE_URL = "https://cyrisia.com";
export const PAGE_SIZE = 30;
export const CATALOGUE_TTL_MS = 30 * 60_000;

/**
 * The site's sorts (`var SORTS` in its page script) run in the browser over the whole
 * catalogue, so they only exist as code there; the source implements the same ones.
 * "Rated" is left out: neither the shelf nor the metadata carries a rating.
 */
export const SORTS: SortOption[] = [
    { id: "popular", title: "Popular", isDefault: true },
    { id: "updated", title: "Recently Updated" },
    { id: "most", title: "Most Volumes / Chapters" },
    { id: "fewest", title: "Fewest Volumes / Chapters" },
    { id: "az", title: "Title A–Z" },
    { id: "za", title: "Title Z–A" },
];

export const FILTER = {
    type: "type",
    translation: "translation",
    genres: "genres",
    tags: "tags",
    hideMature: "hideMature",
};

/** The site's type tabs, minus comics, which open in an image reader this source does not serve. */
export const TYPES = options({ ln: "Light Novels", webnovel: "Web Novels" });

/** `MTL` tags most of the web novel catalogue, so it gets its own switch rather than a chip. */
export const MTL_TAG = "mtl";
export const TRANSLATIONS = options({
    human: "Human translations only",
    mtl: "Machine translations only",
});

/** Labels on fewer books stay out of the sheets; genres collect more stray spellings than tags. */
export const MIN_GENRE_BOOKS = 20;
export const MIN_TAG_BOOKS = 8;

/** `/api/bookshelf`: the whole catalogue in popularity order. */
export type ShelfEntry = {
    name: string;
    /** For light novels every volume file; for web novels only the first chapter. */
    epubs: string[];
    count: number;
    kind: string;
    updated?: number;
    mature?: boolean;
};

/** One series in `/api/metadata-all`. */
export type Metadata = {
    genres?: string[];
    tags?: string[];
    aliases?: string[] | string;
    mature?: boolean;
};

export type Series = {
    name: string;
    metadata?: {
        genres?: string[];
        tags?: string[];
        synopsis?: string | null;
        title_en?: string | null;
        title_ja?: string | null;
        romaji?: string | null;
        aliases?: string[] | null;
        cover_url?: string | null;
        publication_status?: string | null;
    };
    volumes: { filename: string; size_bytes?: number }[];
};

export type SiteUser = {
    authenticated?: boolean;
    username?: string;
    display_name?: string;
    avatar_url?: string;
};

export type SeriesResponse = { series?: Series };
export type TrendingResponse = { trending?: { series_name: string }[] };
export type PicksResponse = { series?: string[] };
export type RecentResponse = { series?: { name: string; added_volumes: number }[] };
export type SessionResponse = { user?: SiteUser | null };
export type CsrfResponse = { csrf?: string };
