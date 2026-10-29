/* SPDX-License-Identifier: GPL-3.0-or-later */

import type { SortOption } from "@mana-app/types";

export const BASE_URL = "https://lnori.com";
/** The direct-download index the reader's "Download EPUB" button points at. */
export const FILES_URL = "https://files.lnori.com";
export const PAGE_SIZE = 30;
/** The library page and the home page are static and change at most daily. */
export const CACHE_MS = 30 * 60_000;

/** The site's own library sorts; "relevance" is its popularity rank. */
export const SORTS: SortOption[] = [
    { id: "relevance", title: "Popular", isDefault: true },
    { id: "title", title: "Title" },
    { id: "date", title: "Newest" },
    { id: "volumes", title: "Most Volumes" },
];

export const FILTER = { genre: "genre", year: "year" } as const;

/** One series as the library page describes it in its card attributes. */
export type Series = {
    id: string;
    path: string;
    title: string;
    author: string;
    year: number;
    volumes: number;
    tags: string[];
    rank: number;
    cover: string;
};

export type HomeItem = { path: string; title: string; author?: string; cover: string };

export type HomePage = {
    featured: HomeItem[];
    shelves: { id: string; title: string; items: HomeItem[] }[];
};

export type Volume = {
    chapterId: string;
    title: string;
    /** The printed volume number, when the site gives one. */
    number?: number;
    webUrl: string;
};

/** The reader page's `app-data` block, flattened. */
export type BookData = {
    name: string;
    seriesTitle?: string;
    epubFilename?: string;
    language?: string;
};

export type DdlFolder = { href: string; title: string };
