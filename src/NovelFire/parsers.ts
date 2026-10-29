/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    ContentType,
    PublicationStatus,
    type Content,
    type Highlight,
    type Option,
    type PagedSearchResult,
    type SortOption,
} from "@mana-app/types";

import type { ListedChapter } from "../lib/books";
import { parseDate } from "../lib/dates";
import {
    attr,
    imageOf,
    load,
    summaryOf,
    text,
    type Cheerio,
    type CheerioAPI,
    type Element,
} from "../lib/html";
import { SourceError } from "../lib/http";
import { BOOK_PATH, canonicalPath, CHAPTER_PATH, routeFor } from "./model";

/** The book link inside a list tile. Tiles may link the cover and the title separately. */
function bookLink($: CheerioAPI, item: Cheerio<Element>): Cheerio<Element> | undefined {
    return item
        .find("a[href]")
        .toArray()
        .map((a) => $(a))
        .find((a) => BOOK_PATH.test(canonicalPath(a.attr("href") ?? "")));
}

/**
 * Every list on the site — browse, search, filter results, rankings, home rows — renders
 * `li.novel-item` tiles; only the stats line differs, so one parser serves them all.
 */
function parseTiles($: CheerioAPI, items: Cheerio<Element>, origin: string): Highlight[] {
    const results: Highlight[] = [];
    const seen = new Set<string>();

    items.each((_, element) => {
        const item = $(element);
        const link = bookLink($, item);
        if (!link) return;

        const id = canonicalPath(link.attr("href") ?? "");
        if (seen.has(id)) return;
        seen.add(id);

        const heading = text(item.find(".novel-title, .title").first()) || text(link);
        const title = attr(link, "title") ?? heading;

        const chapter = text(item.find(".chapter-title").first());
        const stats = item
            .find(".novel-stats span, .novel-stats")
            .toArray()
            .map((s) => text($(s)))
            .find((s) => /chapters?|rank|views|monthly/i.test(s));

        results.push({
            id,
            title,
            subtitle: chapter || stats || undefined,
            cover: imageOf(item.find("img").first(), origin),
            webUrl: `${origin}${routeFor(origin, id)}`,
        });
    });

    return results;
}

export function parseList(html: string, origin: string): PagedSearchResult {
    const $ = load(html);

    // Search pages append a "popular novels" strip that has nothing to do with the query.
    const items = $("li.novel-item").filter(
        (_, item) => $(item).closest(".popular-novels, .related").length === 0,
    );
    const results = parseTiles($, items, origin);

    return { results, isLastPage: $('a[rel="next"]').length === 0 };
}

/** A home row that has no list page of its own, found by the heading the site prints. */
export function parseHomeRow(html: string, origin: string, heading: RegExp): PagedSearchResult {
    const $ = load(html);

    const section = $("section")
        .toArray()
        .map((s) => $(s))
        .find((s) => heading.test(text(s.find(".section-header h3").first())));
    const tab = $(".rank-container")
        .toArray()
        .map((c) => $(c))
        .find((c) => heading.test(text(c.children("h3").first())));
    const root = section ?? tab;

    const results = root ? parseTiles($, root.find("li.novel-item"), origin) : [];

    return { results, isLastPage: true };
}

function statusOf(label: string): PublicationStatus | undefined {
    if (label.includes("completed")) return PublicationStatus.COMPLETED;
    if (label.includes("ongoing")) return PublicationStatus.ONGOING;

    return undefined;
}

export function parseBook(
    html: string,
    origin: string,
    webUrl: string,
): { content: Content; postId?: string } {
    const $ = load(html);

    const title =
        text($("h1.novel-title").first()) || attr($('meta[property="og:title"]'), "content") || "";
    const cover =
        imageOf($(".novel-header figure.cover img").first(), origin) ||
        attr($('meta[property="og:image"]'), "content") ||
        "";

    const summary = $(".summary .content").first().clone();
    summary.find(".expand").remove();

    const authors = $(".novel-info .author [itemprop=author]")
        .toArray()
        .map((a) => text($(a)))
        .filter(Boolean);
    const statusText = text(
        $(".header-stats strong.ongoing, .header-stats strong.completed").first(),
    ).toLowerCase();

    const genres = $(".novel-info .categories a.property-item")
        .toArray()
        .map((a) => ({
            id: `genre:${text($(a)).toLowerCase()}`,
            title: text($(a)),
            isNonInteractive: true,
        }));
    const tags = $(".tags a.tag")
        .toArray()
        .map((a) => ({
            id: `tag:${attr($(a), "href") ?? text($(a))}`,
            title: text($(a)),
            isNonInteractive: true,
        }));

    const postId =
        attr($("#novel-report"), "report-post_id") ?? /post_id\s*=\s*['"]?(\d+)/.exec(html)?.[1];

    const content: Content = {
        title,
        cover,
        summary: summaryOf($, summary),
        status: statusOf(statusText),
        contentType: ContentType.NOVEL,
        additionalTitles: authors.length ? [`by ${authors.join(", ")}`] : undefined,
        tags: [...genres, ...tags],
        webUrl,
    };

    return { content, postId };
}

type ChapterRow = { n_sort?: number | string | null; title?: string };
export type ChapterRows = { data?: ChapterRow[] };

/** The chapter-list endpoint, already oldest first because the query asks for it. */
export function parseChapterRows(json: ChapterRows, bookPath: string): ListedChapter[] {
    return (json.data ?? [])
        .filter((row) => row.n_sort !== undefined && row.n_sort !== null)
        .map((row) => ({
            chapterId: `${bookPath}/chapter-${row.n_sort}`,
            title: decodeEntities(row.title ?? `Chapter ${row.n_sort}`).trim(),
        }));
}

/** One page of `/book/{slug}/chapters`: the fallback when the endpoint is unavailable. */
export function parseChapterPage(html: string): { chapters: ListedChapter[]; lastPage: number } {
    const $ = load(html);

    const chapters: ListedChapter[] = [];
    $("ul.chapter-list li a[href]").each((_, element) => {
        const link = $(element);
        const id = canonicalPath(link.attr("href") ?? "");
        if (!CHAPTER_PATH.test(id)) return;

        const time = link.find("time");
        chapters.push({
            chapterId: id,
            title: attr(link, "title") ?? text(link.find(".chapter-title")),
            date: parseDate(attr(time, "datetime") ?? text(time)),
        });
    });

    // novelfire.net prints a numbered pager and novelphoenix.com a range <select>; both
    // carry `chapters?page=N` for every page, which is all the count needs.
    const pages = [...html.matchAll(/chapters\?page=(\d+)/g)].map((m) => Number(m[1]));

    return { chapters, lastPage: Math.max(1, ...pages) };
}

/** Where a chapter page sends the browser instead of rendering the chapter. */
export function redirectTarget(html: string): string | undefined {
    const script = /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/.exec(html)?.[1];
    const meta = /http-equiv=["']refresh["'][^>]*url=['"]?([^'">\s]+)/i.exec(html)?.[1];
    const target = (script ?? meta)?.replace(/\\\//g, "/");

    return target && /^https?:\/\//i.test(target) ? target : undefined;
}

const ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
};

function decodeEntities(value: string): string {
    if (!value.includes("&")) return value;

    return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
        if (code.startsWith("#x") || code.startsWith("#X")) {
            return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
        }
        if (code.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));

        return ENTITIES[code.toLowerCase()] ?? whole;
    });
}

/** Every list the `/search-adv` form offers, with the ids it submits. */
export type SearchOptions = {
    searchIn: Option[];
    origins: Option[];
    genres: Option[];
    genreMatch: Option[];
    chapters: Option[];
    ratings: Option[];
    ratingMatch: Option[];
    statuses: Option[];
    tagMatch: Option[];
    sorts: SortOption[];
};

export const NO_SEARCH_OPTIONS: SearchOptions = {
    searchIn: [],
    origins: [],
    genres: [],
    genreMatch: [],
    chapters: [],
    ratings: [],
    ratingMatch: [],
    statuses: [],
    tagMatch: [],
    sorts: [],
};

function choices($: CheerioAPI, name: string): (Option & { selected: boolean })[] {
    return $(`select[name="${name}"] option`)
        .toArray()
        .map((option) => ({
            id: $(option).attr("value") ?? "",
            title: text($(option)),
            selected: $(option).is("[selected]"),
        }))
        .filter((option) => option.title);
}

/** A filter's choices without the one the form preselects: that one is its "any" state. */
function filterChoices($: CheerioAPI, name: string): Option[] {
    return choices($, name)
        .filter((option) => !option.selected)
        .map(({ id, title }) => ({ id, title }));
}

function modes($: CheerioAPI, name: string): Option[] {
    return choices($, name).map(({ id, title }) => ({ id, title }));
}

function checkboxes($: CheerioAPI, name: string): Option[] {
    return $(`input[type="checkbox"][name="${name}"]`)
        .toArray()
        .map((input) => ({ id: $(input).attr("value") ?? "", title: text($(input).parent()) }))
        .filter((option) => option.id && option.title);
}

export function parseSearchOptions(html: string): SearchOptions {
    const $ = load(html);

    // A challenge or error page still answers 200; caching its empty lists would hide the
    // filters for a day.
    const genres = checkboxes($, "categories[]");
    if (!genres.length) throw new SourceError("Novel Fire's search form did not load.");

    const origins = checkboxes($, "country_id[]");
    const searchIn = $("#filterDropdownMenu li[data-value]")
        .toArray()
        .map((item) => ({ id: $(item).attr("data-value") ?? "", title: text($(item)) }))
        .filter((option) => option.id && option.title);
    const sorts = choices($, "sort").map(({ id, title, selected }) => ({
        id,
        title,
        isDefault: selected || undefined,
    }));

    return {
        searchIn,
        // novelphoenix.com asks for one origin from a menu instead of checkboxes.
        origins: origins.length ? origins : filterChoices($, "country_id"),
        genres,
        // Excluding is the genre picker's own minus state, so only the include modes remain.
        genreMatch: modes($, "ctgcon").filter((mode) => mode.id !== "exclude"),
        chapters: filterChoices($, "totalchapter"),
        ratings: filterChoices($, "rating"),
        ratingMatch: modes($, "ratcon"),
        statuses: filterChoices($, "status"),
        tagMatch: modes($, "tagcon"),
        sorts,
    };
}
