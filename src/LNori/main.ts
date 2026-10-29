/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    AbortError,
    CatalogRating,
    SearchListSection,
    SearchMultiPickerSheet,
    SearchSortSection,
    SectionStyle,
    type ChapterData,
    type Content,
    type PagedSearchResult,
    type SearchForm,
    type SearchRequest,
} from "@mana-app/types";

import { fileChapter, htmlChapter } from "../lib/books";
import { Memo } from "../lib/cache";
import { chapterDocument, cleanChapterHtml } from "../lib/html";
import { getText, requireOk, type ClientOptions } from "../lib/http";
import { FilterReader, singleSelect } from "../lib/search";
import type { HomeRow } from "../lib/sections";
import { HomeSource } from "../lib/source";
import { resolveUrl } from "../lib/url";
import { BASE_URL, CACHE_MS, FILES_URL, FILTER, PAGE_SIZE, SORTS, type BookData } from "./model";
import {
    fileMatches,
    highlightOf,
    normalizeTitle,
    parseBook,
    parseDdlFolder,
    parseDdlIndex,
    parseHome,
    parseLibrary,
    parseSeries,
    volumeChapters,
    volumeOfBookName,
} from "./parsers";

type Listing = { query?: string; genres?: string[]; year?: string; sort: string; page: number };

class LNori extends HomeSource {
    readonly info = {
        id: "mc.lnori",
        name: "LNori",
        version: "1.0.0",
        description:
            "A curated library of officially translated light novels, one EPUB per volume.",
        website: BASE_URL,
        rating: CatalogRating.MIXED,
        supportedLanguages: ["en_US"],
        thumbnail: "LNori.png",
    };

    protected readonly sorts = SORTS;
    protected override readonly clientOptions: ClientOptions = { requests: 2 };

    private readonly library = new Memo(
        async () => parseLibrary(await getText(this.http, `${BASE_URL}/library`)),
        CACHE_MS,
    );
    private readonly homePage = new Memo(
        async () => parseHome(await getText(this.http, `${BASE_URL}/`)),
        CACHE_MS,
    );
    private readonly ddlIndex = new Memo(
        async () => parseDdlIndex(await getText(this.http, `${FILES_URL}/`)),
        CACHE_MS,
    );

    /** The home page's own shelves, which change with the season. */
    protected async rows(): Promise<HomeRow[]> {
        const page = await this.homePage.get();
        const rows: HomeRow[] = [];

        if (page.featured.length) {
            rows.push({
                id: "featured",
                title: "Featured",
                style: SectionStyle.SimpleHeroPaged,
                load: async () => ({ results: page.featured.map(highlightOf), isLastPage: true }),
            });
        }

        for (const shelf of page.shelves) {
            // The popular shelf is the head of the library's popularity order, so its full list
            // is the library itself.
            const isPopular = shelf.id === "library";
            const listed = async () => ({
                results: shelf.items.map(highlightOf),
                isLastPage: true,
            });

            rows.push({
                id: `shelf-${shelf.id}`,
                title: shelf.title,
                style: isPopular ? SectionStyle.SimpleDoubleRow : SectionStyle.SimpleSingleRow,
                load: isPopular ? (p) => this.list({ sort: "relevance", page: p }) : listed,
            });
        }

        rows.push({
            id: "newest",
            title: "Newest Series",
            style: SectionStyle.SimpleSingleRow,
            load: (p) => this.list({ sort: "date", page: p }),
        });

        return rows;
    }

    protected find(request: SearchRequest): Promise<PagedSearchResult> {
        return this.list({
            query: request.query,
            genres: FilterReader.options(request, FILTER.genre),
            year: FilterReader.option(request, FILTER.year),
            sort: this.sortOf(request).id,
            page: request.page,
        });
    }

    async getSearchForm(): Promise<SearchForm> {
        const series = await this.library.get();

        const tags = [...new Set(series.flatMap((s) => s.tags))].sort();
        const genreOptions = tags.map((tag) => ({
            id: tag,
            title: tag.replace(/(^|\s)\w/g, (c) => c.toUpperCase()),
        }));

        const currentYear = new Date().getFullYear();
        const years = [...new Set(series.map((s) => s.year))]
            .filter((y) => y >= 1900 && y <= currentYear + 1)
            .sort((a, b) => b - a);
        const yearOptions = years.map((y) => ({ id: String(y), title: String(y) }));

        return {
            sections: [
                SearchSortSection(),
                SearchListSection({
                    footer: "A series must carry every selected genre. The year is when the series started.",
                    children: [
                        SearchMultiPickerSheet({
                            id: FILTER.genre,
                            title: "Genres",
                            options: genreOptions,
                        }),
                        singleSelect({
                            id: FILTER.year,
                            title: "Year",
                            options: [{ id: "", title: "Any" }, ...yearOptions],
                        }),
                    ],
                }),
            ],
        };
    }

    async getContent(contentId: string): Promise<Content> {
        const html = await getText(this.http, `${BASE_URL}${contentId}`);
        const { content, volumes, language } = parseSeries(html, contentId);

        const slug = contentId.replace(/^\/series\/\d+\//, "");

        return { ...content, chapters: volumeChapters(volumes, language, slug) };
    }

    async getChapterData(_contentId: string, chapterId: string): Promise<ChapterData> {
        const url = `${BASE_URL}${chapterId}`;
        const response = requireOk(await this.http.get(url), "Loading the volume");
        const { book, $ } = parseBook(await response.text());

        const file = await this.fileFor(book);
        if (file) {
            try {
                const path = file.split("/").map(encodeURIComponent).join("/");

                return await fileChapter(this.downloads, `${FILES_URL}/${path}`);
            } catch (error) {
                if (error instanceof AbortError) throw error;
                // The download host goes down on its own (Cloudflare 530 for days at a time); the
                // reader page carries the same volume's text, so it stands in.
            }
        }

        const body = cleanChapterHtml($, $("article.content-body").first(), { baseUrl: url });

        return htmlChapter(response, chapterDocument(book.name, body, book.language ?? "en"));
    }

    /**
     * The file the reader's download button names, unless it does not look like this series
     * and volume and the download index has one that does.
     */
    private async fileFor(book: BookData): Promise<string | undefined> {
        const series = book.seriesTitle;
        const volume = volumeOfBookName(book.name);

        if (!series) return book.epubFilename;
        if (book.epubFilename && fileMatches(book.epubFilename, series, volume)) {
            return book.epubFilename;
        }
        if (volume === undefined) return book.epubFilename;

        try {
            const folders = await this.ddlIndex.get();
            const folder = folders.find((f) => normalizeTitle(f.title) === normalizeTitle(series));
            if (!folder) return book.epubFilename;

            const folderUrl = resolveUrl(`${FILES_URL}/`, folder.href) ?? "";
            const listing = parseDdlFolder(await getText(this.http, folderUrl));
            const match = listing.find((name) => fileMatches(name, series, volume));

            return match ?? book.epubFilename;
        } catch {
            return book.epubFilename;
        }
    }

    private async list(listing: Listing): Promise<PagedSearchResult> {
        const query = listing.query?.trim().toLowerCase();
        const genres = (listing.genres ?? []).map((g) => g.toLowerCase());
        const library = await this.library.get();

        // Mirrors the library page's own filter: title or author substring, every genre, start year.
        const matches = library.filter((s) => {
            const named =
                !query ||
                s.title.toLowerCase().includes(query) ||
                s.author.toLowerCase().includes(query);
            const tagged = genres.every((g) => s.tags.includes(g));
            const started = !listing.year || String(s.year) === listing.year;

            return named && tagged && started;
        });

        const sorted = matches.sort((a, b) => {
            if (listing.sort === "title") return a.title.localeCompare(b.title);
            if (listing.sort === "date") return b.year - a.year;
            if (listing.sort === "volumes") return b.volumes - a.volumes;
            return b.rank - a.rank;
        });

        const page = Math.max(1, listing.page || 1);
        const start = (page - 1) * PAGE_SIZE;
        const end = page * PAGE_SIZE;
        const slice = sorted.slice(start, end);

        return { results: slice.map(highlightOf), isLastPage: end >= sorted.length };
    }
}

export class Target extends LNori {}
