/* SPDX-License-Identifier: GPL-3.0-or-later */

import type { SortOption } from "@mana-app/types";

/**
 * Official domains (open-slum.org and the eAPI's own `/eapi/info/domains`). The `.sk`
 * domains sit behind DiamWall, which can refuse an app client outright (HTTP 517); the
 * mirror set then moves on to the next domain that answers.
 */
export const MIRRORS = [
    "https://z-lib.sk",
    "https://z-library.sk",
    "https://1lib.sk",
    "https://z-lib.gl",
    "https://z-lib.gd",
    "https://library-access.sk",
    "https://go-to-library.sk",
];

/** A tiny eAPI answer; a parked domain or a block page never carries the marker. */
export const PROBE_PATH = "/eapi/info/extensions";
export const PROBE_MARKER = '"extensions"';

export const KEY_USER_ID = "zlib.remix_userid";
export const KEY_USER_KEY = "zlib.remix_userkey";

export const PAGE_SIZE = 30;

export const FILTER = {
    ext: "extensions",
    lang: "languages",
    yearFrom: "yearFrom",
    yearTo: "yearTo",
} as const;

/**
 * The website's search `order` values, which `/eapi/book/search` accepts as well. Unlike
 * file types and languages, the eAPI has no list of them (`/eapi/info` carries only
 * those two), and an unknown value silently falls back to "popular".
 */
export const SORTS: SortOption[] = [
    { id: "popular", title: "Most Popular", isDefault: true },
    { id: "bestmatch", title: "Best Match" },
    { id: "date", title: "Recently Added" },
    { id: "year", title: "Newest (Year)" },
    { id: "titleA", title: "Title A–Z" },
    { id: "title", title: "Title Z–A" },
    { id: "filesize", title: "Largest File" },
    { id: "filesizeA", title: "Smallest File" },
];
