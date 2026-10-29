/* SPDX-License-Identifier: GPL-3.0-or-later */

import type { SortOption } from "@mana-app/types";

import { options } from "../lib/search";

// lightnovelworld.org, the site's former name, only serves a shutdown notice now and 301s
// every path to it, so chikari.moe is the one domain.
export const BASE_URL = "https://chikari.moe";
/** A novel, its chapters and their text. */
export const API = `${BASE_URL}/api/novels`;
/** Lists and search: novels and manga share one endpoint, told apart by `type`. */
export const LIST_API = `${BASE_URL}/api/series`;
export const GENRES_API = `${BASE_URL}/api/genres?novels=true`;
export const TAGS_API = `${BASE_URL}/api/tags?novels=true`;
/** The tag list runs to thousands; the form offers each catalogue's most used. */
export const TAG_LIMIT = 300;

/** The list API caps `limit` at 60. */
export const PAGE_SIZE = 60;
/** The chapter list API caps `limit` at 500. */
export const CHAPTER_PAGE_SIZE = 500;

/**
 * The novel sorts and trending windows of chikari.moe/search. No API publishes them: they
 * sit in a minified variable of a hashed `/_app/immutable/chunks/` file that the search
 * route reaches only through two import maps, too brittle to scrape, so they are kept here.
 */
export const SORTS: SortOption[] = [
    { id: "updated", title: "Recently Updated", isDefault: true },
    // The list API dropped the daily window: `trending-day` falls back to the default order.
    { id: "trending-week", title: "Trending This Week" },
    { id: "trending-month", title: "Trending This Month" },
    { id: "popular", title: "Popularity" },
    { id: "top_rated", title: "Top Rated" },
    { id: "added", title: "Recently Added" },
    { id: "most_bookmarked", title: "Most Bookmarked" },
    { id: "random", title: "Random" },
];

export const FILTER = {
    genre: "genre",
    tag: "tag",
    status: "status",
    content: "content",
    minChapters: "min_chapters",
} as const;

/**
 * The search page's status list, from the same hashed chunk as the sorts. The list API also
 * takes `language` and `year`, but novels carry neither (every value returns nothing), and
 * the site's minimum-chapter filter is a free number, so neither needs a list.
 */
export const STATUSES = options({
    releasing: "Releasing",
    completed: "Completed",
    hiatus: "Hiatus",
    cancelled: "Cancelled",
    upcoming: "Upcoming",
});

export type NovelGenre = { slug: string; name: string; count: number };

export type NovelTag = { id: number; name: string; count: number };

export type NovelSummary = {
    slug: string;
    title: string;
    status: string;
    is_nsfw: boolean;
    chapter_count: number;
    cover_url: string | null;
    rating: number | null;
};

export type NovelList = { items: NovelSummary[]; total: number; limit: number; offset: number };

export type NovelDetail = NovelSummary & {
    description: string | null;
    authors?: { name: string; role?: string }[];
    alt_titles?: string[];
    genres?: { slug: string; name: string }[];
    tags?: { id: number; name: string; is_spoiler: boolean }[];
};

export type ChapterRow = {
    number: number;
    volume: string;
    title: string;
    lang: string;
    created_at: string | null;
};

export type ChapterList = { items: ChapterRow[]; total: number };

export type ChapterRead = ChapterRow & {
    /** Plain text: paragraphs split by newlines, with a few inline tags written literally. */
    body: string;
    locked: boolean;
    lock_reason: string;
    club_block: unknown;
};
