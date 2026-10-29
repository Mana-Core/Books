/* SPDX-License-Identifier: GPL-3.0-or-later */

import { hostOf, pathOf } from "../lib/url";

/**
 * Domains that serve the NovelFire catalogue, best first. novelphoenix.com shares the
 * database (same post and chapter ids, same covers) and is where novelfire.net now sends
 * every chapter page, but it files books under `/novel/` instead of `/book/`.
 */
export const MIRRORS = ["https://novelfire.net", "https://novelphoenix.com"];

/** Hosts whose book pages live under `/novel/` and whose home page is `/`. */
const NOVEL_PREFIX_HOSTS = new Set(["novelphoenix.com"]);

/**
 * The live search answers with JSON naming the book, so a parked domain or the sister
 * site findnovel.net (same engine, different catalogue) never passes as a mirror.
 */
export const PROBE_PATH = "/ajax/searchLive?keyword=shadow%20slave&type=title";
export const PROBE_MARKER = '"slug":"shadow-slave"';

/**
 * DataTables parameters the chapter-list endpoint insists on: without the column, order
 * and the empty global search it answers HTTP 500. `length=-1` returns every chapter.
 */
export const CHAPTER_LIST_QUERY = [
    "draw=1",
    "columns%5B0%5D%5Bdata%5D=n_sort",
    "columns%5B0%5D%5Bname%5D=cmm_posts_detail.n_sort",
    "order%5B0%5D%5Bcolumn%5D=0",
    "order%5B0%5D%5Bdir%5D=asc",
    "search%5Bvalue%5D=",
    "start=0",
    "length=-1",
].join("&");

/** The path `origin` serves a stored path at. IDs always use `/book/`. */
export function routeFor(origin: string, path: string): string {
    return NOVEL_PREFIX_HOSTS.has(hostOf(origin)) ? path.replace(/^\/book\//, "/novel/") : path;
}

export function homePathFor(origin: string): string {
    return NOVEL_PREFIX_HOSTS.has(hostOf(origin)) ? "/" : "/home";
}

/** A link from any mirror as the stored ID: host-free and under `/book/`. */
export function canonicalPath(link: string): string {
    return pathOf(link)
        .replace(/[?#].*$/, "")
        .replace(/\/+$/, "")
        .replace(/^\/novel\//, "/book/");
}

export const BOOK_PATH = /^\/book\/[^/]+$/;
export const CHAPTER_PATH = /^\/book\/[^/]+\/chapter-[^/]+$/;

export const FILTER = {
    searchIn: "searchIn",
    genres: "genres",
    genreMatch: "genreMatch",
    status: "status",
    origin: "origin",
    chapters: "chapters",
    rating: "rating",
    ratingMatch: "ratingMatch",
    tags: "tags",
    excludedTags: "excludedTags",
    tagMatch: "tagMatch",
} as const;

/** The site's own tag lookup, which needs at least four characters of a name. */
export type TagLookup = { data?: { id: number; name: string }[] };
