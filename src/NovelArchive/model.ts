/* SPDX-License-Identifier: GPL-3.0-or-later */

// No alternate domain serves the site: novelarchive.net/.xyz are parked landers and the
// other obvious TLDs do not resolve, so this is a single-domain source.
export const BASE_URL = "https://novelarchive.cc";
export const API = `${BASE_URL}/api/novels`;

export const PAGE_SIZE = 30;
/** The fixed home lists (trending, recently updated) stop at 50 and ignore `page`. */
export const ROW_LIMIT = 50;

export const FILTER = {
    status: "status",
    genre: "genre",
    anyGenre: "anyGenre",
    hideAdult: "hideAdult",
} as const;

/** The site's own filter panel: its sort and status chips, and the script that runs them. */
export const LIBRARY_URL = `${BASE_URL}/library`;

export type ApiGenre = { value: string; label: string };

export type Novel = {
    id: string;
    title: string;
    author: string;
    /** Comma-separated, with or without spaces. */
    genres: string;
    cover_url: string;
    description: string;
    associated_names: string[];
    /** Only filled on the detail endpoint; position + 1 is the chapter number. */
    chapter_names: string[];
    total_chapters: string;
    rating: number;
    release_status: string;
    /** The archive keeps chapter text only; these novels still have artwork on an upstream copy. */
    has_image_chapters: boolean;
    preferred_source: string;
};

export type NovelPage = {
    novels: Novel[];
    pagination?: { page: number; has_next: boolean };
};

export type ArchiveChapter = {
    chapter: { number: number; name: string; content: string };
};

export type UpstreamChapterList = {
    chapters: { number: number; title: string }[];
};

export type UpstreamChapter = {
    number: string;
    title: string;
    content_html: string;
};

export type Upstreams = {
    sources: { id: string; label: string }[];
};
