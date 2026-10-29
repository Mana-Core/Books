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
} from "@mana-app/types";

import { parseDate } from "../lib/dates";
import { getJson } from "../lib/http";
import { chapterLanguage } from "../lib/language";
import { withQuery } from "../lib/url";
import {
    BASE_URL,
    GENRES_API,
    TAG_LIMIT,
    TAGS_API,
    type ChapterRow,
    type NovelDetail,
    type NovelGenre,
    type NovelList,
    type NovelSummary,
    type NovelTag,
} from "./model";

export function novelUrl(slug: string): string {
    return `${BASE_URL}/novels/${slug}`;
}

function toHighlight(novel: NovelSummary): Highlight {
    const subtitle = novel.chapter_count ? `${novel.chapter_count} chapters` : undefined;
    const info = novel.rating ? [{ key: "Rating", value: novel.rating.toFixed(1) }] : undefined;

    return {
        id: novel.slug,
        title: novel.title,
        cover: novel.cover_url ?? "",
        subtitle,
        info,
        webUrl: novelUrl(novel.slug),
    };
}

export function toResult(list: NovelList): PagedSearchResult {
    const shown = list.offset + list.items.length;
    const isLastPage = shown >= list.total || list.items.length === 0;

    return { results: list.items.map(toHighlight), isLastPage };
}

const STATUS: Record<string, PublicationStatus> = {
    releasing: PublicationStatus.ONGOING,
    upcoming: PublicationStatus.ONGOING,
    completed: PublicationStatus.COMPLETED,
    hiatus: PublicationStatus.HIATUS,
    cancelled: PublicationStatus.CANCELLED,
};

export function toContent(novel: NovelDetail): Content {
    const authors = (novel.authors ?? []).map((a) => a.name).filter(Boolean);
    const byline = authors.length ? [`by ${authors.join(", ")}`] : [];

    const summary = (novel.description ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    const genres = (novel.genres ?? []).map((g) => ({
        id: `genre:${g.slug}`,
        title: g.name,
        isNonInteractive: true,
    }));

    // Spoiler tags give away plot points on the details screen, which has no way to hide them.
    const tags = (novel.tags ?? [])
        .filter((t) => !t.is_spoiler)
        .map((t) => ({ id: `tag:${t.id}`, title: t.name, isNonInteractive: true }));

    return {
        title: novel.title,
        cover: novel.cover_url ?? "",
        summary,
        status: STATUS[novel.status],
        contentType: ContentType.NOVEL,
        additionalTitles: [...(novel.alt_titles ?? []), ...byline],
        tags: [...genres, ...tags],
        webUrl: novelUrl(novel.slug),
    };
}

export function toChapters(slug: string, rows: ChapterRow[]): Chapter[] {
    return rows.map((row, index) => {
        // `3224.0` arrives as the number 3224, which prints as "3224" — the token the site's URLs use.
        const token = String(row.number);
        const volume = Number.parseFloat(row.volume);

        return {
            chapterId: token,
            index,
            number: row.number,
            volume: Number.isFinite(volume) ? volume : undefined,
            title: row.title,
            language: chapterLanguage(row.lang),
            date: parseDate(row.created_at) ?? new Date(0),
            webUrl: `${novelUrl(slug)}/${token}`,
        };
    });
}

/**
 * A list from both catalogues, general entries first. The form is the same whether or not
 * Adult Catalogue Only is on, so it offers what either catalogue can filter by.
 */
async function bothCatalogues<T>(
    http: HttpClient,
    url: string,
    toOption: (item: T) => Option,
    limit?: number,
): Promise<Option[]> {
    const lists = await Promise.all([
        getJson<T[]>(http, url),
        getJson<T[]>(http, withQuery(url, { adult: "true" })),
    ]);

    const options = lists.flatMap((list) => list.slice(0, limit)).map(toOption);
    const seen = new Set<string>();

    return options.filter((o) => !seen.has(o.id) && Boolean(seen.add(o.id)));
}

/** In the site's alphabetical order, which the adult-only genres would otherwise break. */
export async function siteGenres(http: HttpClient): Promise<Option[]> {
    const toOption = (g: NovelGenre): Option => ({ id: g.slug, title: g.name });
    const genres = await bothCatalogues<NovelGenre>(http, GENRES_API, toOption);

    return genres.sort((a, b) => a.title.localeCompare(b.title));
}

/** Each catalogue's 300 most used tags, most used first as the site shows them. */
export function siteTags(http: HttpClient): Promise<Option[]> {
    return bothCatalogues<NovelTag>(
        http,
        TAGS_API,
        (t) => ({ id: String(t.id), title: t.name }),
        TAG_LIMIT,
    );
}
