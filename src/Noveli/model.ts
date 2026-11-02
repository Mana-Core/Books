/* SPDX-License-Identifier: GPL-3.0-or-later */

import { SectionStyle, type Option, type SortOption } from "@mana-app/types";

export const BASE_URL = "https://noveli.to";
export const API_URL = `${BASE_URL}/api`;
export const PAGE_SIZE = 36;
export const NOVEL_PATH = /^\/novel\/[^/?#]+$/;

export const SORTS: SortOption[] = [
    { id: "popular", title: "Popular (All-Time)", isDefault: true },
    { id: "trending", title: "Trending (This Month)" },
    { id: "rating", title: "Top Rated" },
    { id: "newest", title: "Newest Added" },
    { id: "chapters", title: "Most Chapters" },
    { id: "az", title: "A-Z" },
];

export const STATUSES: Option[] = [
    { id: "All", title: "All" },
    { id: "Ongoing", title: "Ongoing" },
    { id: "Completed", title: "Completed" },
];

export const FILTER = {
    genres: "genres",
    status: "status",
    minChapters: "minChapters",
    maxChapters: "maxChapters",
} as const;

export type HomeRowSpec = {
    id: string;
    title: string;
    style: SectionStyle;
    sort: string;
    status?: string;
};

export const HOME_ROWS: HomeRowSpec[] = [
    { id: "popular", title: "Popular", style: SectionStyle.SimpleHeroPaged, sort: "popular" },
    {
        id: "trending",
        title: "Trending",
        style: SectionStyle.DetailedSingleRowPaged,
        sort: "trending",
    },
    { id: "rating", title: "Top Rated", style: SectionStyle.SimpleDoubleRow, sort: "rating" },
    {
        id: "newest",
        title: "Newest Added",
        style: SectionStyle.SimpleSingleRow,
        sort: "newest",
    },
    {
        id: "chapters",
        title: "Most Chapters",
        style: SectionStyle.DetailedDoubleRowPaged,
        sort: "chapters",
    },
    {
        id: "completed",
        title: "Completed",
        style: SectionStyle.SimpleSingleRow,
        sort: "popular",
        status: "Completed",
    },
];

/** A novel in the site's list responses. */
export type NovelCard = {
    id: number;
    title: string;
    slug: string;
    cover_image?: string | null;
    author?: string | null;
    status?: string | null;
    chapter_count?: number;
};

export type NovelListResponse = {
    success: boolean;
    data?: NovelCard[];
    pagination?: { page: number; limit: number; total: number };
};

export type NovelDetail = NovelCard & {
    description?: string | null;
    genres?: string[] | null;
    tags?: string[] | null;
};

export type NovelDetailResponse = {
    success: boolean;
    data?: NovelDetail;
    message?: string;
};

export type ChapterRow = {
    id: number;
    novel_id: number;
    chapter_number: number;
    title: string;
    created_at?: string | null;
};

export type ChapterListResponse = {
    success: boolean;
    chapters?: ChapterRow[];
};

export type ChapterParagraph = {
    id?: string;
    text?: string | null;
    html?: string | null;
    isHoneypot?: boolean;
    isMidWatermark?: boolean;
};

export type ChapterDetail = {
    title?: string | null;
    content?: string | null;
    raw_content?: string | null;
    paragraphs?: ChapterParagraph[] | null;
};

export type ChapterDetailResponse = {
    success: boolean;
    chapter?: ChapterDetail;
};

export type TagListResponse = {
    success: boolean;
    tags?: string[];
};
