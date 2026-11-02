/* SPDX-License-Identifier: GPL-3.0-or-later */

import { SectionStyle, type Option, type SortOption } from "@mana-app/types";

export const BASE_URL = "https://noveldex.io";
export const PAGE_SIZE = 24;

/** Novel pages are stored as paths under this prefix; comics live under /series/comic/. */
export const NOVEL_PATH = /^\/series\/novel\/[^/?#]+$/;

/**
 * The browse feed's sorts, as its own filter menu lists them. Trending and Longest are
 * the site's names, kept as-is.
 */
export const SORTS: SortOption[] = [
    { id: "updated", title: "Recently Updated", isDefault: true },
    { id: "popular", title: "Most Bookmarked" },
    { id: "views", title: "Most Viewed" },
    { id: "trending", title: "Trending" },
    { id: "rating", title: "Top Rated" },
    { id: "newest", title: "Newest" },
    { id: "longest", title: "Longest" },
];

export const STATUSES: Option[] = [
    { id: "ONGOING", title: "Ongoing" },
    { id: "COMPLETED", title: "Completed" },
    { id: "HIATUS", title: "Hiatus" },
    { id: "DROPPED", title: "Dropped" },
    { id: "DISCONTINUED", title: "Discontinued" },
    { id: "UPCOMING", title: "Upcoming" },
];

export const ORIGINS: Option[] = [
    { id: "KOREAN", title: "Korean" },
    { id: "JAPANESE", title: "Japanese" },
    { id: "CHINESE", title: "Chinese" },
    { id: "OTHER", title: "Other" },
];

/** The novel kinds the site files under its Novel mode; comic kinds are excluded. */
export const NOVEL_TYPES: Option[] = [
    { id: "WEB_NOVEL", title: "Web Novel" },
    { id: "LIGHT_NOVEL", title: "Light Novel" },
    { id: "PUBLISHED_NOVEL", title: "Published Novel" },
    { id: "FANFICTION", title: "Fanfiction" },
    { id: "ORIGINAL_FICTION", title: "Original Fiction" },
    { id: "ONE_SHOT", title: "One Shot" },
    { id: "NOVEL", title: "Novel" },
];

export const FILTER = {
    status: "status",
    origins: "origins",
    types: "types",
    genres: "genres",
    tags: "tags",
    excludedTags: "excludedTags",
} as const;

export type HomeRowSpec = {
    id: string;
    title: string;
    style: SectionStyle;
    sort: string;
    status?: string;
};

/** Home rows are the site's own browse orders; each row's "View more" is the same feed. */
export const HOME_ROWS: HomeRowSpec[] = [
    { id: "trending", title: "Trending", style: SectionStyle.SimpleHeroPaged, sort: "trending" },
    {
        id: "updated",
        title: "Recently Updated",
        style: SectionStyle.DetailedDoubleRowPaged,
        sort: "updated",
    },
    {
        id: "popular",
        title: "Most Bookmarked",
        style: SectionStyle.SimpleDoubleRow,
        sort: "popular",
    },
    {
        id: "rating",
        title: "Top Rated",
        style: SectionStyle.DetailedSingleRowPaged,
        sort: "rating",
    },
    { id: "newest", title: "Newest", style: SectionStyle.SimpleSingleRow, sort: "newest" },
    {
        id: "completed",
        title: "Completed",
        style: SectionStyle.SimpleSingleRow,
        sort: "popular",
        status: "COMPLETED",
    },
];

/** The browse feed as the site's own UI requests it. */
export type SeriesCard = {
    slug: string;
    title: string;
    coverImage?: string | null;
    status?: string;
    isMature?: boolean;
    nsfw?: boolean;
    chapters?: { number: number }[];
};

export type SeriesPage = {
    data: SeriesCard[];
    meta: { total: number; hasMore: boolean };
};

export type FacetEntry = { id: string; name: string; slug: string };

/** The site's own filter lists, which its browse page reads. */
export type Facets = {
    genres: FacetEntry[];
    tags: FacetEntry[];
};

/** A series as the detail page's payload carries it; `description` is a reference into the stream. */
export type SeriesDetail = {
    title: string;
    slug: string;
    coverImage?: string | null;
    status?: string;
    isMature?: boolean;
    nsfw?: boolean;
    description?: string;
    genres?: { name: string; slug: string }[];
    tags?: { name: string; slug: string }[];
};
