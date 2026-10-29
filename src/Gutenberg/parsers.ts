/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    ContentType,
    PublicationStatus,
    type Content,
    type Highlight,
    type HttpClient,
    type Option,
    type PagedSearchResult,
    type SortOption,
} from "@mana-app/types";

import type { BookFile } from "../lib/books";
import { parseDate } from "../lib/dates";
import { load, text, type CheerioAPI } from "../lib/html";
import { getText, SourceError } from "../lib/http";
import { chapterLanguage } from "../lib/language";
import { resolveUrl, withQuery } from "../lib/url";
import { BASE_URL, SORT_MENU_QUERY } from "./model";

export function parseList(html: string): PagedSearchResult {
    const $ = load(html);
    const results: Highlight[] = [];

    $("li.booklink a.link").each((_, element) => {
        const link = $(element);
        const id = /^\/ebooks\/(\d+)$/.exec(link.attr("href") ?? "")?.[1];
        if (!id) return;

        // The list ships 66 px thumbnails; the medium size is the one the book page uses.
        const thumb = link.find("img.cover-thumb").attr("src");
        const medium = thumb?.replace(".small.", ".medium.");
        const cover = medium ? (resolveUrl(BASE_URL, medium) ?? "") : "";
        const downloads = text(link.find(".extra")).replace(/\s*downloads?$/i, "");

        results.push({
            id,
            title: text(link.find(".title")),
            subtitle: text(link.find(".subtitle")) || undefined,
            cover,
            info: [{ key: "Downloads", value: downloads }],
            webUrl: `${BASE_URL}/ebooks/${id}`,
        });
    });

    const isLastPage = $('link[rel="next"]').length === 0;

    return { results, isLastPage };
}

const GENERATED_NOTE = /\s*\(This is an automatically generated summary\.\)\s*$/;

function bibliography($: CheerioAPI, label: string): string[] {
    return $("table.bibrec tr")
        .toArray()
        .filter((row) => text($(row).find("th")) === label)
        .map((row) => text($(row).find("td")))
        .filter(Boolean);
}

export function parseBook(
    html: string,
    id: string,
): { content: Content; files: BookFile[]; language: string } {
    const $ = load(html);

    const authors = $('a[rel="marcrel:aut"]')
        .toArray()
        .map((a) => text($(a)).replace(/,\s*\d{3,4}\??-\d{0,4}\??$/, ""));

    const summary = $(".summary-text-container").clone();
    summary.find("label, input, .readmoredots, .readmore").remove();

    const tags = $('td[property="dcterms:subject"] a')
        .toArray()
        .map((a) => ({
            id: $(a).attr("href") ?? text($(a)),
            title: text($(a)),
            isNonInteractive: true,
        }));

    const language = chapterLanguage(bibliography($, "Language")[0]);
    const released = parseDate(bibliography($, "Release Date")[0]);

    const content: Content = {
        title: text($('td[itemprop="headline"]')) || text($("h1")),
        cover: $('meta[property="og:image"]').attr("content") ?? "",
        summary: text(summary).replace(GENERATED_NOTE, ""),
        status: PublicationStatus.COMPLETED,
        contentType: ContentType.NOVEL,
        additionalTitles: authors.length ? [`by ${authors.join(", ")}`] : undefined,
        tags,
        webUrl: `${BASE_URL}/ebooks/${id}`,
    };

    const files: BookFile[] = [];
    const seen = new Set<string>();

    $(`a[href^="/ebooks/${id}."]`).each((_, element) => {
        const href = $(element).attr("href") ?? "";
        if (seen.has(href)) return;
        seen.add(href);

        const file = fileFor(href);
        if (file) files.push({ ...file, id: href, date: released, webUrl: `${BASE_URL}${href}` });
    });

    return { content, files, language };
}

/** The formats worth offering; the older "images" EPUB duplicates EPUB3 for this reader. */
function fileFor(href: string): Pick<BookFile, "format" | "label"> | undefined {
    if (href.endsWith(".epub3.images")) return { format: "epub", label: "EPUB3" };
    if (href.endsWith(".epub.noimages")) return { format: "epub", label: "EPUB (no images)" };
    if (href.endsWith(".txt.utf-8")) return { format: "txt", label: "Plain Text" };
    return undefined;
}

async function page(http: HttpClient, url: string): Promise<CheerioAPI> {
    return load(await getText(http, url));
}

/** A site list that came back empty is a changed or broken page, not an empty list. */
function nonEmpty<T>(list: T[], what: string): T[] {
    if (!list.length) throw new SourceError(`Project Gutenberg's ${what} did not load.`);

    return list;
}

/** Shelf links in the page's alphabetical or grouped lists, without its search shortcuts. */
function shelfLinks($: CheerioAPI): Option[] {
    const seen = new Set<string>();
    const shelves: Option[] = [];

    $(".book-list a[href]").each((_, element) => {
        const link = $(element);
        const id = /^\/ebooks\/bookshelf\/(\d+)$/.exec(link.attr("href") ?? "")?.[1];
        const title = text(link);
        if (!id || !title || seen.has(id)) return;

        seen.add(id);
        shelves.push({ id, title });
    });

    return shelves;
}

/** The volunteer-curated reading lists. */
export async function fetchShelves(http: HttpClient): Promise<Option[]> {
    const $ = await page(http, `${BASE_URL}/ebooks/bookshelf/`);

    return nonEmpty(shelfLinks($), "bookshelf list");
}

/** The bookstore-style categories the site assigns automatically; they are shelves too. */
export async function fetchCategories(http: HttpClient): Promise<Option[]> {
    const $ = await page(http, `${BASE_URL}/ebooks/categories`);

    return nonEmpty(shelfLinks($), "category list");
}

export type SearchOptions = { languages: Option[]; subjectClasses: Option[] };

function selectOptions($: CheerioAPI, selector: string): Option[] {
    return $(`${selector} option`)
        .toArray()
        .map((option) => ({ id: $(option).attr("value") ?? "", title: text($(option)) }))
        .filter((option) => option.id && option.title);
}

/** The advanced search form's language and Library of Congress class menus. */
export async function fetchSearchOptions(http: HttpClient): Promise<SearchOptions> {
    const $ = await page(http, `${BASE_URL}/ebooks/`);

    return {
        languages: nonEmpty(selectOptions($, "select#lang"), "language list"),
        subjectClasses: selectOptions($, "select#locc"),
    };
}

/** The sort menu names the active sort without its id and links every other one. */
function sortMenu($: CheerioAPI): { active: string; others: Option[] } {
    const menu = $(".sort-dropdown").first();
    const active = text(menu.find(".sort-dropdown-toggle span").first());

    const others = menu
        .find("a[href]")
        .toArray()
        .map((a) => {
            const id = /[?&]sort_order=([^&#]+)/.exec($(a).attr("href") ?? "")?.[1] ?? "";

            return { id, title: text($(a)) };
        })
        .filter((option) => option.id && option.title);

    return { active, others };
}

/**
 * The search page's sorts. The default one only shows up as a link once another sort is
 * active, so a second page reveals its id.
 */
export async function fetchSorts(http: HttpClient): Promise<SortOption[]> {
    const url = (sort?: string) =>
        withQuery(`${BASE_URL}/ebooks/search/`, { query: SORT_MENU_QUERY, sort_order: sort });

    const first = sortMenu(await page(http, url()));
    const other = nonEmpty(first.others, "sort menu")[0] as Option;

    const second = sortMenu(await page(http, url(other.id)));
    const byDefault = second.others.find((sort) => sort.title === first.active);
    const defaultSort = byDefault ? [{ ...byDefault, isDefault: true }] : [];

    return [...defaultSort, ...first.others];
}
