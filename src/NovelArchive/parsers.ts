/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    ContentType,
    PublicationStatus,
    type Chapter,
    type Content,
    type Highlight,
    type HttpClient,
    type Option,
    type PagedSearchResult,
    type SortOption,
} from "@mana-app/types";

import { cleanTitle, load, text } from "../lib/html";
import { getJson, getText, SourceError } from "../lib/http";
import { resolveUrl } from "../lib/url";
import {
    API,
    BASE_URL,
    LIBRARY_URL,
    type ApiGenre,
    type Novel,
    type NovelPage,
    type UpstreamChapterList,
} from "./model";

export function novelUrl(id: string): string {
    return `${BASE_URL}/novel?id=${encodeURIComponent(id)}`;
}

function readerUrl(id: string, number: number, upstream?: string): string {
    const source = upstream ? `&source=${encodeURIComponent(upstream)}` : "";
    return `${BASE_URL}/reader?novel=${encodeURIComponent(id)}&chapter=${number}${source}`;
}

/** Chapter IDs are paths under `/api/novels/<id>`, so one string says which copy to read. */
function archiveChapterId(number: number): string {
    return `/chapters/${number}`;
}

function upstreamChapterId(upstream: string, number: number): string {
    return `/sources/${encodeURIComponent(upstream)}/chapters/${number}`;
}

export function parseChapterId(
    chapterId: string,
): { number: number; upstream?: string } | undefined {
    const match = /^\/(?:sources\/([^/]+)\/)?chapters\/(\d+(?:\.\d+)?)$/.exec(chapterId);
    if (!match) return undefined;

    return {
        number: Number(match[2]),
        upstream: match[1] ? decodeURIComponent(match[1]) : undefined,
    };
}

function coverOf(novel: Novel): string {
    return resolveUrl(BASE_URL, novel.cover_url) ?? "";
}

function chapterCount(novel: Novel): number {
    return Number.parseInt(novel.total_chapters, 10) || 0;
}

function toHighlight(novel: Novel): Highlight {
    const count = chapterCount(novel);

    return {
        id: novel.id,
        // The archive copies titles verbatim from upstream cards, badges and layout included.
        title: cleanTitle(novel.title),
        cover: coverOf(novel),
        subtitle: count ? `${count} chapters` : undefined,
        info: novel.rating ? [{ key: "Rating", value: novel.rating.toFixed(1) }] : undefined,
        webUrl: novelUrl(novel.id),
    };
}

export function toResult(page: NovelPage, paged: boolean): PagedSearchResult {
    return {
        results: page.novels.map(toHighlight),
        isLastPage: !paged || !page.pagination?.has_next || page.novels.length === 0,
    };
}

const STATUS: Record<string, PublicationStatus> = {
    ongoing: PublicationStatus.ONGOING,
    completed: PublicationStatus.COMPLETED,
    hiatus: PublicationStatus.HIATUS,
    cancelled: PublicationStatus.CANCELLED,
    dropped: PublicationStatus.CANCELLED,
};

export function toContent(novel: Novel): Content {
    const name = cleanTitle(novel.author ?? "");
    const author = name && name !== "Unknown" ? `by ${name}` : undefined;
    const aliases = novel.associated_names.map(cleanTitle).filter(Boolean);

    const genreNames = novel.genres
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean);
    const genres = [...new Set(genreNames)];
    const tags = genres.map((g) => ({ id: g.toLowerCase(), title: g, isNonInteractive: true }));

    return {
        title: cleanTitle(novel.title),
        cover: coverOf(novel),
        summary: novel.description.trim(),
        status: STATUS[novel.release_status.toLowerCase()],
        contentType: ContentType.NOVEL,
        additionalTitles: [...aliases, ...(author ? [author] : [])],
        tags,
        webUrl: novelUrl(novel.id),
    };
}

/**
 * The archive's own list. Names are positional (chapter N is entry N - 1), and a novel
 * whose names were never scraped still has `total_chapters`, as the site falls back to.
 */
export function archiveChapters(novel: Novel): Chapter[] {
    const names = novel.chapter_names.length
        ? novel.chapter_names
        : Array.from({ length: chapterCount(novel) }, (_, i) => `Chapter ${i + 1}`);

    return names.map((name, index) => ({
        chapterId: archiveChapterId(index + 1),
        index,
        number: index + 1,
        title: cleanTitle(name) || `Chapter ${index + 1}`,
        language: "en_US",
        // The API dates the novel, never its chapters.
        date: new Date(0),
        webUrl: readerUrl(novel.id, index + 1),
    }));
}

export function upstreamChapters(
    novelId: string,
    upstream: string,
    list: UpstreamChapterList,
): Chapter[] {
    const ordered = [...list.chapters].sort((a, b) => a.number - b.number);

    return ordered.map((chapter, index) => ({
        chapterId: upstreamChapterId(upstream, chapter.number),
        index,
        number: chapter.number,
        title: cleanTitle(chapter.title ?? "") || `Chapter ${chapter.number}`,
        language: "en_US",
        date: new Date(0),
        webUrl: readerUrl(novelId, chapter.number, upstream),
    }));
}

/** The site's own test for a copy that has no real text: empty, or a short "not found". */
export function looksMissing(html: string | undefined): boolean {
    const text = (html ?? "").replace(/<[^>]+>/g, " ").trim();
    if (!text) return true;

    return text.length < 60 && /not\s+found|does\s+not\s+exist/i.test(text);
}

export type LibraryFilters = {
    sorts: SortOption[];
    statuses: Option[];
    /** The genre tokens the library excludes in its SFW mode. */
    adultGenres: string[];
    /** Values `/genres` lists that the library does not show, being site categories. */
    nonGenres: string[];
};

export const NO_LIBRARY_FILTERS: LibraryFilters = {
    sorts: [],
    statuses: [],
    adultGenres: [],
    nonGenres: [],
};

/** A string array the library script assigns to `name`, as `[…]` or `new Set([…])`. */
function scriptList(script: string, name: string): string[] {
    const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:new Set\\()?\\[([^\\]]*)\\]`);
    const list = pattern.exec(script)?.[1];
    if (list === undefined) {
        throw new SourceError(`NovelArchive's library script no longer defines ${name}.`);
    }

    return [...list.matchAll(/"([^"]*)"/g)].map(([, value = ""]) => value.toLowerCase());
}

/** The filters of the site's library page, which keeps them in its markup and script. */
export async function libraryFilters(http: HttpClient): Promise<LibraryFilters> {
    const $ = load(await getText(http, LIBRARY_URL));

    const src = $('script[src*="libary-page"], script[src*="library-page"]').attr("src");
    if (!src) throw new SourceError("NovelArchive's library page did not name its script.");

    const script = await getText(http, resolveUrl(LIBRARY_URL, src) ?? "");

    // Chips carry a short desktop label and a fuller phone one; the phone one reads better alone.
    $(".hidden").remove();
    const chips = (group: string, key: string) =>
        $(`#library-${group}-filters [data-${key}]`)
            .toArray()
            .map((chip) => ({
                id: $(chip).attr(`data-${key}`) ?? "",
                title: text($(chip)),
                active: $(chip).hasClass("active"),
            }));

    const sorts = chips("sort", "sort").map(({ id, title, active }) => ({
        id,
        title,
        isDefault: active || undefined,
    }));
    if (!sorts.length) throw new SourceError("NovelArchive's library page had no sort options.");

    // "All" is what the app's picker already offers as no choice.
    const statuses = chips("status", "status")
        .filter((c) => c.id !== "all")
        .map(({ id, title }) => ({ id, title }));

    return {
        sorts,
        statuses,
        adultGenres: scriptList(script, "NSFW_GENRE_TOKENS"),
        nonGenres: scriptList(script, "NON_GENRE_TAGS"),
    };
}

/** Every genre value the archive has merged from upstream, as the library lists them. */
export async function siteGenres(http: HttpClient): Promise<Option[]> {
    const { genres } = await getJson<{ genres: ApiGenre[] }>(http, `${API}/genres`);

    return genres
        .map((g) => ({ id: g.value.trim().toLowerCase(), title: g.label.trim() || g.value.trim() }))
        .filter((g) => g.id);
}
