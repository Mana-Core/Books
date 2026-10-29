/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    CatalogRating,
    SearchListSection,
    SearchSortSection,
    SearchTextField,
    SectionStyle,
    type ChapterData,
    type Content,
    type PagedSearchResult,
    type SearchForm,
    type SearchRequest,
    type SortOption,
} from "@mana-app/types";

import { fileChapter, fileChapters } from "../lib/books";
import { SiteData } from "../lib/cache";
import { getText, SourceError, type ClientOptions } from "../lib/http";
import { FilterReader, searchForm, singleSelect, sortOf } from "../lib/search";
import type { HomeRow } from "../lib/sections";
import { HomeSource } from "../lib/source";
import { withQuery } from "../lib/url";
import { BASE_URL, FILTER, HOME_SHELVES, PAGE_SIZE } from "./model";
import {
    fetchCategories,
    fetchSearchOptions,
    fetchShelves,
    fetchSorts,
    parseBook,
    parseList,
} from "./parsers";

const SHELVES_UNAVAILABLE =
    "Project Gutenberg's bookshelf list could not be loaded to combine it with a search.";

type Listing = {
    query?: string;
    language?: string;
    shelves?: string[];
    subjectClass?: string;
    author?: string;
    subject?: string;
    title?: string;
    sort: string;
    page: number;
};

class Gutenberg extends HomeSource {
    readonly info = {
        id: "mc.gutenberg",
        name: "Gutenberg",
        version: "1.0.0",
        description: "Over 75,000 free public-domain ebooks as EPUB and plain text.",
        website: BASE_URL,
        rating: CatalogRating.SAFE,
        supportedLanguages: ["en_US", "fr_FR", "de_DE", "es_ES", "it_IT", "pt_BR"],
        thumbnail: "Gutenberg.png",
    };

    /** The site's sorts are read from its search page; see `getSortOptions`. */
    protected readonly sorts: SortOption[] = [];
    protected override readonly clientOptions: ClientOptions = { requests: 2 };

    private readonly shelves = new SiteData("gutenberg.bookshelves", () => fetchShelves(this.http));
    private readonly categories = new SiteData("gutenberg.categories", () =>
        fetchCategories(this.http),
    );
    private readonly searchOptions = new SiteData("gutenberg.search-options", () =>
        fetchSearchOptions(this.http),
    );
    private readonly sortList = new SiteData("gutenberg.sorts", () => fetchSorts(this.http));

    protected rows(): HomeRow[] {
        const shelfRows = HOME_SHELVES.map(
            ([shelf, title]): HomeRow => ({
                id: `shelf-${shelf}`,
                title,
                load: (page) => this.list({ shelves: [shelf], sort: "downloads", page }),
            }),
        );

        return [
            {
                id: "popular",
                title: "Popular",
                style: SectionStyle.DetailedSingleRowPaged,
                load: (page) => this.list({ sort: "downloads", page }),
            },
            {
                id: "newest",
                title: "New Releases",
                style: SectionStyle.SimpleSingleRow,
                load: (page) => this.list({ sort: "release_date", page }),
            },
            ...shelfRows,
        ];
    }

    protected async find(request: SearchRequest): Promise<PagedSearchResult> {
        const shelves = [
            FilterReader.option(request, FILTER.category),
            FilterReader.option(request, FILTER.shelf),
        ].filter((id): id is string => id !== undefined);

        const sorts = await this.sortList.getOr([]);

        return this.list({
            query: request.query,
            language: FilterReader.option(request, FILTER.language),
            shelves,
            subjectClass: FilterReader.option(request, FILTER.subjectClass),
            author: FilterReader.text(request, FILTER.author),
            subject: FilterReader.text(request, FILTER.subject),
            title: FilterReader.text(request, FILTER.title),
            sort: sortOf(request, sorts).id,
            page: request.page,
        });
    }

    override async getSortOptions(): Promise<SortOption[]> {
        return this.sortList.getOr([]);
    }

    async getSearchForm(): Promise<SearchForm> {
        const [options, categories, shelves] = await Promise.all([
            this.searchOptions.getOr({ languages: [], subjectClasses: [] }),
            this.categories.getOr([]),
            this.shelves.getOr([]),
        ]);

        return searchForm([
            SearchSortSection(),
            SearchListSection({
                children: [
                    singleSelect({
                        id: FILTER.language,
                        title: "Language",
                        options: options.languages,
                    }),
                    singleSelect({ id: FILTER.category, title: "Category", options: categories }),
                    singleSelect({ id: FILTER.shelf, title: "Bookshelf", options: shelves }),
                    singleSelect({
                        id: FILTER.subjectClass,
                        title: "Library of Congress Class",
                        options: options.subjectClasses,
                    }),
                ],
            }),
            SearchListSection({
                header: "Match",
                footer: "Each word must appear in that field.",
                children: [
                    SearchTextField({
                        id: FILTER.author,
                        title: "Author",
                        placeholder: "Stevenson",
                    }),
                    SearchTextField({
                        id: FILTER.subject,
                        title: "Subject",
                        placeholder: "Pirates",
                    }),
                    SearchTextField({ id: FILTER.title, title: "Title", placeholder: "Island" }),
                ],
            }),
        ]);
    }

    async getContent(contentId: string): Promise<Content> {
        const html = await getText(this.http, `${BASE_URL}/ebooks/${contentId}`);
        const { content, files, language } = parseBook(html, contentId);

        return { ...content, chapters: fileChapters(files, language) };
    }

    getChapterData(_contentId: string, chapterId: string): Promise<ChapterData> {
        return fileChapter(this.http, `${BASE_URL}${chapterId}`);
    }

    private async list(listing: Listing): Promise<PagedSearchResult> {
        // The site's search syntax: `l.` language, `lcc.` Library of Congress class, `a.` author,
        // `s.` subject, `t.` title and `bs.` bookshelf name, each word prefixed, all combinable
        // with free text.
        const prefixed = (prefix: string, value?: string) =>
            (value ?? "")
                .split(/\s+/)
                .filter(Boolean)
                .map((word) => `${prefix}.${word}`);

        const terms = [
            listing.query?.trim(),
            listing.language && `l.${listing.language}`,
            listing.subjectClass && `lcc.${listing.subjectClass}`,
            ...prefixed("a", listing.author),
            ...prefixed("s", listing.subject),
            ...prefixed("t", listing.title),
        ].filter(Boolean);

        // A shelf alone is its own page with the full list; mixed with other terms each shelf
        // becomes a `bs.` term, which matches the shelf's name with underscores for spaces.
        const shelves = listing.shelves ?? [];
        const alone = !terms.length && shelves.length === 1 ? shelves[0] : undefined;

        if (!alone) {
            for (const name of await this.shelfNames(shelves)) {
                terms.push(`bs.${name.replace(/\s+/g, "_")}`);
            }
        }

        const query = terms.join(" ");
        const path = alone ? `/ebooks/bookshelf/${alone}` : "/ebooks/search/";
        const startIndex = listing.page > 1 ? (listing.page - 1) * PAGE_SIZE + 1 : undefined;

        const url = withQuery(`${BASE_URL}${path}`, {
            query: query || undefined,
            sort_order: listing.sort,
            start_index: startIndex,
        });
        const html = await getText(this.http, url);

        return parseList(html);
    }

    private async shelfNames(ids: string[]): Promise<string[]> {
        if (!ids.length) return [];

        const categories = await this.categories.getOr([]);
        const shelves = await this.shelves.getOr([]);
        const known = [...categories, ...shelves];

        return ids.map((id) => {
            const shelf = known.find((s) => s.id === id);
            if (!shelf) throw new SourceError(SHELVES_UNAVAILABLE);

            return shelf.title;
        });
    }
}

export class Target extends Gutenberg {}
