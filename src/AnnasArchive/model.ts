/* SPDX-License-Identifier: GPL-3.0-or-later */

import type { SortOption } from "@mana-app/types";

/** The domains open-slum.org lists for Anna's Archive, best first. */
export const MIRRORS = [
    "https://annas-archive.gl",
    "https://annas-archive.pk",
    "https://annas-archive.gd",
];

/**
 * `/dyn/up/` is Anna's own health check: tiny, never behind the browser check, and it
 * answers `{"aa_logged_in":0}`, which a parked or seized domain does not.
 */
export const PROBE_PATH = "/dyn/up/";
export const PROBE_MARKER = "aa_logged_in";

/**
 * The Library Genesis mirrors Anna's links to for free downloads. Their `ads.php` page
 * hands out a keyed `get.php` link without a browser check.
 */
export const LIBGEN_MIRRORS = [
    "https://libgen.li",
    "https://libgen.bz",
    "https://libgen.vg",
    "https://libgen.gl",
    "https://libgen.la",
];

export const KEY_SECRET = "annas.key";
export const KEY_QUOTA = "annas.downloadsPerDay";

/**
 * Any record works for the account summary; this is the md5 Anna's own API docs use.
 * The summary only reads the account, so asking about it never spends a download.
 */
export const SUMMARY_MD5 = "d6e1dc51a50726f00ec438af21952a45";

/** Anna's serves 50 results a page and stops at page 100. */
export const LAST_PAGE = 100;

/** The search page's filter groups, by the query parameter each one sets. */
export const FILTER = {
    content: "content",
    ext: "ext",
    lang: "lang",
    acc: "acc",
    src: "src",
} as const;

/**
 * The search page's "Most relevant" order, which it sends as no `sort` at all. The other
 * orders are read from the page, and this one stands in while it cannot be reached.
 */
export const RELEVANCE: SortOption = { id: "relevance", title: "Most Relevant", isDefault: true };
