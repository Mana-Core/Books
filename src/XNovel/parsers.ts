/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    ContentType,
    PublicationStatus,
    type Content,
    type Highlight,
    type Option,
    type PagedSearchResult,
    type SortOption,
    type Tag,
} from "@mana-app/types";

import { chapterNumber, type ListedChapter } from "../lib/books";
import {
    attr,
    cleanChapterHtml,
    imageOf,
    load,
    summaryOf,
    text,
    textToHtml,
    type Cheerio,
    type CheerioAPI,
    type Element,
} from "../lib/html";
import { pathOf, resolveUrl } from "../lib/url";
import { BASE_URL, CHAPTER_PATH, HIDDEN_BOXES, NOVEL_PATH } from "./model";

const WATERMARKS = [/\bxnovel\b/i];
const MIN_CHAPTER_CHARS = 200;
const READING_TEXT = [".prose", "[class*='whitespace-pre-wrap']"];

export function pathFromLink(link: string | undefined): string {
    return pathOf(link ?? "")
        .replace(/[?#].*$/, "")
        .replace(/\/+$/, "");
}

function cardOf($: CheerioAPI, link: Cheerio<Element>): Cheerio<Element> | undefined {
    let node = link;

    for (let depth = 0; depth < 12 && node.length; depth += 1) {
        node = node.parent();

        const novels = new Set(
            node
                .find("a[href]")
                .toArray()
                .map((a) => pathFromLink($(a).attr("href")))
                .filter((path) => NOVEL_PATH.test(path)),
        );

        if (novels.size > 1) return undefined;
        if (novels.size === 1 && node.find("h3").length) return node;
    }

    return undefined;
}

export function parseCards($: CheerioAPI): Highlight[] {
    const results: Highlight[] = [];
    const seen = new Set<string>();

    $("a[href]").each((_, element) => {
        const link = $(element);
        const id = pathFromLink(link.attr("href"));
        if (!NOVEL_PATH.test(id) || seen.has(id)) return;

        const card = cardOf($, link);
        if (!card) return;
        seen.add(id);

        const latest = card
            .find("a[href]")
            .toArray()
            .map((a) => $(a))
            .find((a) => CHAPTER_PATH.test(pathFromLink(a.attr("href"))));

        results.push({
            id,
            title: text(card.find("h3").first()) || attr(link, "title") || text(link),
            subtitle: latest ? text(latest) || undefined : undefined,
            cover: imageOf(card.find("img").first(), BASE_URL),
            webUrl: `${BASE_URL}${id}`,
        });
    });

    return results;
}

export function parseList(html: string): PagedSearchResult {
    const $ = load(html);
    const hasNext = $("a")
        .toArray()
        .some((a) => text($(a)) === "»");

    return { results: parseCards($), isLastPage: !hasNext };
}

export function parseFilterOptions(
    homeHtml: string,
    searchHtml: string,
): { genres: Option[]; sorts: SortOption[] } {
    const home = load(homeHtml);
    const genreSelect = home("select")
        .toArray()
        .map((select) => home(select))
        .find((select) => select.find('option[value="action"]').length > 0);

    const genres = (genreSelect?.find("option").toArray() ?? [])
        .map((option) => ({
            id: home(option).attr("value") ?? "",
            title: text(home(option)),
        }))
        .filter((option) => option.id && option.id !== "all");

    const search = load(searchHtml);
    const sortSelect = search("select")
        .toArray()
        .map((select) => search(select))
        .find((select) => select.find('option[value="field_update"]').length > 0);

    const sorts = (sortSelect?.find("option").toArray() ?? [])
        .map((option) => ({
            id: search(option).attr("value") ?? "",
            title: text(search(option)),
            isDefault: search(option).is("[selected]") || undefined,
        }))
        .filter((sort) => sort.id && sort.title);

    return { genres, sorts };
}

function rowOf($: CheerioAPI, label: string): Cheerio<Element> | undefined {
    const bold = $("b")
        .toArray()
        .map((b) => $(b))
        .find((b) => text(b).replace(/:$/, "").trim().toLowerCase() === label);

    return bold?.parent();
}

function statusOf(label: string): PublicationStatus | undefined {
    if (label.includes("completed")) return PublicationStatus.COMPLETED;
    if (label.includes("ongoing")) return PublicationStatus.ONGOING;
    if (label.includes("hiatus")) return PublicationStatus.HIATUS;
    if (label.includes("cancel") || label.includes("dropped")) {
        return PublicationStatus.CANCELLED;
    }

    return undefined;
}

export function parseNovel(html: string, path: string): Content {
    const $ = load(html);

    const heading = $("h3")
        .toArray()
        .map((h) => $(h))
        .find((h) =>
            h
                .find("a[href]")
                .toArray()
                .some((a) => pathFromLink($(a).attr("href")) === path),
        );
    const title =
        text(heading ?? $("h3").first()) ||
        (attr($('meta[property="og:title"]'), "content") ?? "").replace(
            /\s+-\s+Your novels.*$/,
            "",
        );

    const cover =
        resolveUrl(BASE_URL, attr($('meta[property="og:image"]'), "content")) ??
        imageOf($("img[src*='/media/']").first(), BASE_URL);

    const prose = $(".prose").first();
    const summary =
        (prose.length ? summaryOf($, prose) : "") ||
        attr($('meta[name="description"]'), "content") ||
        undefined;

    const authors = (rowOf($, "author")?.find('a[href^="/author/"]').toArray() ?? [])
        .map((a) => text($(a)))
        .filter(Boolean);

    const genres = (rowOf($, "genres")?.find("a[href]").toArray() ?? []).map((a): Tag => {
        const slug = pathFromLink($(a).attr("href")).split("/").pop() ?? "";
        return { id: `genre:${slug}`, title: text($(a)), isNonInteractive: true };
    });

    const statusRow = rowOf($, "status");
    const statusLabel = (statusRow ? text(statusRow) : "").replace(/^Status:\s*/i, "");

    return {
        title,
        cover,
        summary,
        status: statusOf(statusLabel.toLowerCase()),
        contentType: ContentType.NOVEL,
        additionalTitles: authors.length ? [`by ${authors.join(", ")}`] : undefined,
        tags: genres,
        webUrl: `${BASE_URL}${path}`,
    };
}

function chapterTitle(link: Cheerio<Element>, id: string): string {
    const title = attr(link, "title") ?? text(link);
    if (chapterNumber(title) !== undefined) return title;

    const match = /-chapter-(\d+)(?:-(.+))?$/.exec(id.split("/").pop() ?? "");
    if (!match) return title || id;

    const words = (match[2] ?? "")
        .split("-")
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1));

    return words.length ? `Chapter ${match[1]}: ${words.join(" ")}` : `Chapter ${match[1]}`;
}

export function parseChapters(html: string, path: string): ListedChapter[] {
    const $ = load(html);
    const seen = new Set<string>();
    const chapters: ListedChapter[] = [];

    $("a[href]").each((_, element) => {
        const link = $(element);
        const id = pathFromLink(link.attr("href"));
        if (!CHAPTER_PATH.test(id) || !id.startsWith(`${path}/`) || seen.has(id)) return;

        seen.add(id);
        chapters.push({ chapterId: id, title: chapterTitle(link, id) });
    });

    const numbers = chapters.map((c) => chapterNumber(c.title));
    if (numbers.every((n) => n !== undefined)) {
        return chapters.sort(
            (a, b) => (chapterNumber(a.title) ?? 0) - (chapterNumber(b.title) ?? 0),
        );
    }

    return chapters.reverse();
}

function readingTextOf($: CheerioAPI): Cheerio<Element> | undefined {
    const candidates: Cheerio<Element>[] = READING_TEXT.flatMap((selector) =>
        $(selector)
            .toArray()
            .filter((element): element is Element => element.type === "tag")
            .map((element) => $(element)),
    );

    let best: Cheerio<Element> | undefined;
    for (const node of candidates) {
        if (!best || text(node).length > text(best).length) best = node;
    }

    return best;
}

export function parseChapterBody(html: string, url: string): string | undefined {
    const $ = load(html);
    const root = readingTextOf($);

    if (!root || text(root).length < MIN_CHAPTER_CHARS) return undefined;

    if (root.find("p").length === 0) {
        root.find("br").replaceWith("\n");
        return textToHtml(root.text());
    }

    return cleanChapterHtml($, root, {
        baseUrl: url,
        remove: HIDDEN_BOXES,
        dropText: WATERMARKS,
    });
}
