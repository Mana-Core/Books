/* SPDX-License-Identifier: GPL-3.0-or-later */

import { ContentRating } from "@mana-app/types";

import { options } from "../lib/search";

// ao3.org, www.ao3.org and archiveofourown.com only 301/302 to this host, so there is no
// independent mirror to fail over to.
export const BASE_URL = "https://archiveofourown.org";

export const FILTER = {
    rating: "rating",
    warnings: "warnings",
    categories: "categories",
    complete: "complete",
    crossover: "crossover",
    language: "language",
    wordsFrom: "wordsFrom",
    wordsTo: "wordsTo",
    fandoms: "fandoms",
    includeTags: "includeTags",
    excludeTags: "excludeTags",
    title: "title",
    creators: "creators",
    characters: "characters",
    relationships: "relationships",
    freeforms: "freeforms",
    updated: "updated",
    singleChapter: "singleChapter",
    kudos: "kudos",
    hits: "hits",
    bookmarks: "bookmarks",
    comments: "comments",
} as const;

/**
 * The search page's Date field is free text in otwarchive's range syntax ("< 1 week" means
 * updated within the last week); the site lists no choices for it, so these stay here.
 */
export const UPDATED = options([
    ["", "Any time"],
    ["< 1 day", "Past day"],
    ["< 1 week", "Past week"],
    ["< 1 month", "Past month"],
    ["< 6 months", "Past 6 months"],
    ["< 1 year", "Past year"],
]);

/**
 * AO3 asks for confirmation before showing anything that is not General or Teen, and treats
 * "Not Rated" the same way, so an unrated work is filed as mature rather than safe. The
 * letter is the short form for the result badge.
 */
const RATING_BY_NAME = new Map<string, { rating: ContentRating; letter: string }>([
    ["general audiences", { rating: ContentRating.SAFE, letter: "G" }],
    ["teen and up audiences", { rating: ContentRating.SUGGESTIVE, letter: "T" }],
    ["mature", { rating: ContentRating.MATURE, letter: "M" }],
    ["explicit", { rating: ContentRating.EXPLICIT, letter: "E" }],
    ["not rated", { rating: ContentRating.MATURE, letter: "NR" }],
]);

export function ratingOf(
    name: string | undefined,
): { rating: ContentRating; letter: string } | undefined {
    return RATING_BY_NAME.get(name?.trim().toLowerCase() ?? "");
}
