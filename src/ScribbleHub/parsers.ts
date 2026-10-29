/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    ContentRating,
    ContentType,
    PublicationStatus,
    type Content,
    type Highlight,
    type Option,
    type PagedSearchResult,
    type SortOption,
    type Tag,
} from "@mana-app/types";

import type { ListedChapter } from "../lib/books";
import { parseDate } from "../lib/dates";
import { cleanChapterHtml, load, summaryOf, text, type CheerioAPI } from "../lib/html";
import { SourceError } from "../lib/http";
import { pathOf, resolveUrl } from "../lib/url";
import { BASE_URL } from "./model";

/** `/series/{id}/{slug}/` from any series link. */
export function seriesPath(href: string | undefined): string | undefined {
    const path = href ? pathOf(href) : undefined;
    if (!path || !/^\/series\/\d+\//.test(path)) return undefined;

    return path.replace(/[?#].*$/, "");
}

/**
 * The jQuery pagination widget is fed `items: N` (the page count) and `currentPage`; the
 * page has no other marker of how many pages exist.
 */
function paginationOf(
    html: string,
    widget: string,
): { current: number; total: number } | undefined {
    const at = html.indexOf(`#${widget}').pagination(`);
    if (at < 0) return undefined;

    const script = html.slice(at, at + 600);
    const total = Number(/items:\s*(\d+)/.exec(script)?.[1]);
    const current = Number(/currentPage:\s*'?(\d+)/.exec(script)?.[1] ?? 1);

    return Number.isFinite(total) ? { current, total } : undefined;
}

/** The lists of the series finder's own filter controls. */
export type FinderLists = {
    genres: Option[];
    tags: Option[];
    warnings: Option[];
    statuses: Option[];
    matchModes: Option[];
    sorts: SortOption[];
};

/**
 * The finder's form. Genres and warnings are click-to-cycle spans carrying their id
 * (`gmeid`, `ctid`) beside a label; tags are a plain `<select>`.
 */
export function parseFinderForm(html: string): FinderLists {
    const $ = load(html);

    const toggles = (selector: string, idAttribute: string) => {
        const options = $(selector)
            .toArray()
            .map((span) => {
                const label = $(span).siblings(".lbl_cl").first();

                return { id: $(span).attr(idAttribute) ?? "", title: text(label) };
            });

        return options.filter((option) => option.id && option.title);
    };

    const genres = toggles(".sfc_genre[gmeid]", "gmeid");
    // A challenge or error page can still answer 200; caching its empty lists would hide
    // the filters for a day.
    if (!genres.length) throw new SourceError("Scribble Hub's series finder could not be read.");

    const ascending = $("#sf_sortby_ascdesc option[selected]").attr("value") === "asc";
    const preselected = $("#sf_sortby_type option[selected]").attr("value");
    const sorts = selectOptions($, "#sf_sortby_type").map((sort) => ({
        ...sort,
        isDefault: sort.id === preselected || undefined,
        isOrderable: true,
        defaultAscending: ascending,
    }));

    // "All" is the absence of `cp`: the site's own submit only sends the three statuses.
    const statuses = selectOptions($, "#fic_storystatus").filter((option) => option.id !== "all");

    return {
        genres,
        tags: selectOptions($, "select.tagsalledit_include"),
        warnings: toggles(".sfc_mature[ctid]", "ctid"),
        statuses,
        matchModes: selectOptions($, "#gi_mm"),
        sorts,
    };
}

function selectOptions($: CheerioAPI, selector: string): Option[] {
    const options = $(selector)
        .first()
        .find("option")
        .toArray()
        .map((option) => ({ id: $(option).attr("value") ?? "", title: text($(option)) }));

    return options.filter((option) => option.id && option.title);
}

/** A series-finder result page. */
export function parseFinder(html: string): PagedSearchResult {
    const $ = load(html);
    const results: Highlight[] = [];

    $(".search_main_box").each((_, element) => {
        const box = $(element);
        const link = box.find(".search_title a").first();
        const id = seriesPath(link.attr("href"));
        if (!id) return;

        const stat = (icon: string, unit: string) => {
            const value = text(box.find(`.search_stats i.${icon}`).first().parent());

            return value.replace(new RegExp(`\\s*${unit}$`), "");
        };

        const rating = /([\d.]+)/.exec(text(box.find(".search_ratings")))?.[1];
        const genreLinks = box.find(".search_genre a.fic_genre").toArray();
        const genres = genreLinks.map((a) => text($(a)));

        const info = [
            { key: "Chapters", value: stat("fa-list-alt", "Chapters") },
            { key: "Views", value: stat("fa-eye", "Views") },
            { key: "Words", value: stat("fa-book", "Words") },
        ].filter((pair) => pair.value);

        const author = text(box.find(".search_stats .a_un_st a").first());
        const cover = resolveUrl(BASE_URL, box.find(".search_img img").attr("src"));

        results.push({
            id,
            title: text(link),
            subtitle: author || undefined,
            cover: cover ?? "",
            badge: rating ? { text: `★ ${rating}` } : undefined,
            contentRating: ratingFromGenres(genres, []),
            info,
            webUrl: `${BASE_URL}${id}`,
        });
    });

    const page = paginationOf(html, "pagination-profile-recent");
    const lastPage = !page || page.current >= page.total || results.length === 0;

    return { results, isLastPage: lastPage };
}

/** The home page's "Trending" carousel; the site gives it no paged list of its own. */
export function parseCarousel(html: string, heading: string): PagedSearchResult {
    const $ = load(html);
    const results: Highlight[] = [];

    $(".wi_fic_wrap.slider").each((_, element) => {
        const wrap = $(element);
        const title = text(wrap.find(".main_title").first()).toLowerCase();
        if (!title.startsWith(heading.toLowerCase())) return;

        wrap.find(".novel_carousel_img").each((__, item) => {
            const card = $(item);
            const href = card.find('a[href*="/series/"]').first().attr("href");
            const id = seriesPath(href);
            if (!id || results.some((r) => r.id === id)) return;

            const label = card.find(".centered_novel").first();
            const cover = resolveUrl(BASE_URL, card.find("img").first().attr("src"));

            results.push({
                id,
                title: label.attr("title")?.trim() || text(label),
                cover: cover ?? "",
                webUrl: `${BASE_URL}${id}`,
            });
        });
    });

    return { results, isLastPage: true };
}

/**
 * ScribbleHub has no rating field; its Adult/Smut genres and content warnings are what
 * readers filter on, so they decide the rating.
 */
function ratingFromGenres(genres: string[], warnings: string[]): ContentRating {
    const has = (name: string) => genres.some((g) => g.toLowerCase() === name);

    if (has("smut") || has("adult")) return ContentRating.EXPLICIT;
    if (has("mature") || warnings.length > 0) return ContentRating.MATURE;
    if (has("ecchi")) return ContentRating.SUGGESTIVE;

    return ContentRating.SAFE;
}

export function parseSeries(
    html: string,
    path: string,
): { content: Content; chapters: OrderedChapter[]; tocPages: number } {
    const $ = load(html);

    const title = text($(".fic_title").first());
    if (!title) {
        throw new SourceError("This series page could not be read. It may have been removed.");
    }

    const tagsOf = (selector: string, prefix: string, idAttribute: string): Tag[] => {
        const links = $(selector).toArray();

        return links.map((a) => ({
            id: `${prefix}:${$(a).attr(idAttribute) ?? text($(a))}`,
            title: text($(a)),
            isNonInteractive: true,
        }));
    };

    const genres = tagsOf(".wi_fic_genre a.fic_genre", "genre", "gid");
    const tags = tagsOf(".wi_fic_showtags a.stag", "tag", "href");

    const warnings = $("li.mature_contains a")
        .toArray()
        .map((a) => text($(a)));
    const warningTags = warnings.map((w) => ({
        id: `warning:${w}`,
        title: w,
        isNonInteractive: true,
    }));

    const author = text($(".auth_name_fic").first());
    const statusText = text($('span[title^="Last updated"]').first().parent());
    const image = resolveUrl(BASE_URL, $(".fic_image img").first().attr("src"));
    const cover = image ?? $('meta[property="og:image"]').attr("content") ?? "";
    const genreNames = genres.map((g) => g.title);

    const content: Content = {
        title,
        cover,
        summary: summaryOf($, $(".wi_fic_desc").first()) || undefined,
        status: statusOf(statusText),
        contentType: ContentType.NOVEL,
        contentRating: ratingFromGenres(genreNames, warnings),
        additionalTitles: author ? [`by ${author}`] : undefined,
        tags: [...genres, ...warningTags, ...tags],
        webUrl: `${BASE_URL}${path}`,
    };

    return {
        content,
        chapters: parseToc($),
        tocPages: paginationOf(html, "pagination-mesh-toc")?.total ?? 1,
    };
}

function statusOf(value: string): PublicationStatus | undefined {
    if (/^completed/i.test(value)) return PublicationStatus.COMPLETED;
    if (/^hiatus/i.test(value)) return PublicationStatus.HIATUS;
    if (/^ongoing/i.test(value)) return PublicationStatus.ONGOING;

    return undefined;
}

export type OrderedChapter = ListedChapter & { order: number };

/**
 * TOC rows, from a series page or the TOC endpoint. `order` is the chapter's absolute
 * position, oldest = 1.
 */
export function parseToc($: CheerioAPI): OrderedChapter[] {
    const rows = $("li.toc_w")
        .toArray()
        .map((li) => {
            const link = $(li).find("a.toc_a").first();
            const href = link.attr("href");

            const published = $(li).find(".fic_date_pub").first();
            // The visible text turns relative ("3 hours ago") for new chapters; the title
            // attribute always holds the full timestamp.
            const date = siteDate(published.attr("title")) ?? parseDate(text(published));

            return {
                order: Number($(li).attr("order")),
                chapterId: href ? pathOf(href) : "",
                title: text(link),
                date,
                webUrl: href,
            };
        });

    return rows.filter((chapter) => chapter.chapterId && Number.isFinite(chapter.order));
}

/**
 * "Oct 23, 2026 12:06 PM". Nothing in the markup names a zone and every visitor gets the
 * same text, so it is the server's clock, whose zone the pages do not reveal. Read as UTC,
 * as this source always has, so dates already in libraries do not shift.
 */
function siteDate(value: string | undefined): Date | undefined {
    const date = moment.utc(value ?? "", "MMM D, YYYY h:mm A", "en", true);

    return date.isValid() ? date.toDate() : undefined;
}

export function parseChapter(
    html: string,
    options: { url: string; keepNotes: boolean },
): { title: string; body: string } {
    const $ = load(html);

    const raw = $("#chp_raw").first();
    if (!raw.length) throw new SourceError("The chapter text could not be found on the page.");

    if (options.keepNotes) {
        // The note box is avatar + username + body; only the body reads as text, and without
        // a heading it would run straight on from the story.
        raw.find(".wi_authornotes").each((_, element) => {
            const note = $(element).find(".wi_authornotes_body").first().html() ?? "";
            const aside = `<aside><hr><p><strong>Author's Note</strong></p><div>${note}</div></aside>`;
            $(element).replaceWith(aside);
        });
    }

    const body = cleanChapterHtml($, raw, {
        baseUrl: options.url,
        remove: [".wi_authornotes"],
    });

    const title = text($(".chapter-title").first()) || "Chapter";

    return { title, body };
}
