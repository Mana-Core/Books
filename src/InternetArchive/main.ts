/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    CatalogRating,
    SearchListSection,
    SearchSortSection,
    SearchTextField,
    type ChapterData,
    type Content,
    type PagedSearchResult,
    type SearchForm,
    type SearchRequest,
} from "@mana-app/types";

import { fileChapter, fileChapters } from "../lib/books";
import { SiteData } from "../lib/cache";
import { getJson, SourceError } from "../lib/http";
import { FilterReader, searchForm, singleSelect } from "../lib/search";
import type { HomeRow } from "../lib/sections";
import { HomeSource } from "../lib/source";
import { withQuery } from "../lib/url";
import {
    BASE_QUERY,
    BASE_URL,
    FILTER,
    FORMATS,
    HOME_ROWS,
    LANGUAGE_CODES,
    PAGE_SIZE,
    RELEVANCE,
    SEARCH_FIELDS,
    SORTS,
    type ItemResponse,
    type SearchResponse,
} from "./model";
import { fetchFacets, parseItem, parseSearch } from "./parsers";

/** Lucene syntax in a typed query would otherwise turn "C++" or "Re:Zero" into a syntax error. */
function escapeQuery(text: string): string {
    return text.replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, "\\$1");
}

const FREE_ONLY_FOOTER =
    "Only items with a freely downloadable EPUB or PDF are listed; lending-only books are left out.";

const BORROW_ONLY = "This file is only available to borrow on archive.org.";

type Listing = {
    query?: string;
    language?: string;
    collection?: string;
    format?: string;
    creator?: string;
    subject?: string;
    yearFrom?: number;
    yearTo?: number;
    sort: string;
    ascending: boolean;
    page: number;
};

class InternetArchive extends HomeSource {
    readonly info = {
        id: "mc.internetarchive",
        name: "InternetArchive",
        version: "1.0.0",
        description:
            "Millions of freely downloadable books and texts from archive.org as EPUB, PDF and plain text.",
        website: BASE_URL,
        // Uploads are unmoderated community texts as well as library scans.
        rating: CatalogRating.MIXED,
        supportedLanguages: [
            "en_US",
            "de_DE",
            "fr_FR",
            "es_ES",
            "it_IT",
            "pt_BR",
            "nl_NL",
            "ru_RU",
            "pl_PL",
            "ja_JP",
            "zh-CN",
        ],
        thumbnail: "InternetArchive.png",
    };

    protected readonly sorts = SORTS;

    private readonly facets = new SiteData("internetarchive.facets", () => fetchFacets(this.http));

    protected rows(): HomeRow[] {
        return HOME_ROWS.map((row) => ({
            id: row.id,
            title: row.title,
            style: row.style,
            load: (page) =>
                this.list({ sort: row.sort, ascending: false, collection: row.collection, page }),
        }));
    }

    protected find(request: SearchRequest): Promise<PagedSearchResult> {
        const sort = this.sortOf(request);

        return this.list({
            query: request.query,
            language: FilterReader.option(request, FILTER.language),
            collection: FilterReader.option(request, FILTER.collection),
            format: FilterReader.option(request, FILTER.format),
            creator: FilterReader.text(request, FILTER.creator),
            subject: FilterReader.text(request, FILTER.subject),
            yearFrom: FilterReader.integer(request, FILTER.yearFrom, 9_999),
            yearTo: FilterReader.integer(request, FILTER.yearTo, 9_999),
            sort: sort.id,
            ascending: sort.ascending,
            page: request.page,
        });
    }

    async getSearchForm(): Promise<SearchForm> {
        const { languages, collections } = await this.facets.getOr({
            languages: [],
            collections: [],
        });

        return searchForm([
            SearchSortSection(),
            SearchListSection({
                footer: FREE_ONLY_FOOTER,
                children: [
                    singleSelect({ id: FILTER.language, title: "Language", options: languages }),
                    singleSelect({
                        id: FILTER.collection,
                        title: "Collection",
                        options: collections,
                    }),
                    singleSelect({ id: FILTER.format, title: "File Format", options: FORMATS }),
                ],
            }),
            SearchListSection({
                header: "Match",
                footer: "Year is the item's publication year as catalogued.",
                children: [
                    SearchTextField({
                        id: FILTER.creator,
                        title: "Creator",
                        placeholder: "Austen",
                    }),
                    SearchTextField({
                        id: FILTER.subject,
                        title: "Subject",
                        placeholder: "Science fiction",
                    }),
                    SearchTextField({
                        id: FILTER.yearFrom,
                        title: "Year From",
                        placeholder: "1800",
                    }),
                    SearchTextField({ id: FILTER.yearTo, title: "Year To", placeholder: "1900" }),
                ],
            }),
        ]);
    }

    async getContent(contentId: string): Promise<Content> {
        const url = `${BASE_URL}/metadata/${encodeURIComponent(contentId)}`;
        const data = await getJson<ItemResponse>(this.http, url);

        const { content, files, language } = parseItem(data, contentId);

        return { ...content, chapters: fileChapters(files, language) };
    }

    async getChapterData(_contentId: string, chapterId: string): Promise<ChapterData> {
        try {
            return await fileChapter(this.downloads, `${BASE_URL}${chapterId}`);
        } catch (error) {
            // A file that turned private after the chapter list was saved answers 401.
            if (error instanceof SourceError && (error.status === 401 || error.status === 403)) {
                throw new SourceError(BORROW_ONLY, error.status);
            }

            throw error;
        }
    }

    private async list(listing: Listing): Promise<PagedSearchResult> {
        const text = listing.query?.trim();
        const clauses = [BASE_QUERY];

        if (text) {
            const escaped = escapeQuery(text);
            clauses.push(`(title:(${escaped}) OR creator:(${escaped}) OR subject:(${escaped}))`);
        }

        if (listing.language) {
            const variants = [listing.language, ...(LANGUAGE_CODES[listing.language] ?? [])];
            const quoted = variants.map((v) => `"${v.replace(/["\\]/g, "\\$&")}"`);

            clauses.push(`language:(${quoted.join(" OR ")})`);
        }

        if (listing.collection) clauses.push(`collection:"${listing.collection}"`);
        if (listing.format) clauses.push(`format:${listing.format}`);
        if (listing.creator) clauses.push(`creator:(${escapeQuery(listing.creator)})`);
        if (listing.subject) clauses.push(`subject:(${escapeQuery(listing.subject)})`);
        if (listing.yearFrom || listing.yearTo) {
            clauses.push(`year:[${listing.yearFrom ?? "*"} TO ${listing.yearTo ?? "*"}]`);
        }

        const direction = listing.ascending ? "asc" : "desc";
        const sort = listing.sort === RELEVANCE ? undefined : `${listing.sort} ${direction}`;

        const url = withQuery(`${BASE_URL}/advancedsearch.php`, {
            q: clauses.join(" AND "),
            "fl[]": SEARCH_FIELDS,
            "sort[]": sort,
            rows: PAGE_SIZE,
            page: Math.max(1, listing.page || 1),
            output: "json",
        });

        const response = await getJson<SearchResponse>(this.http, url);

        return parseSearch(response, PAGE_SIZE);
    }
}

export class Target extends InternetArchive {}
