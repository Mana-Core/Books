/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    Body,
    CatalogRating,
    SearchExcludableMultiPickerSheet,
    SearchListSection,
    SearchSortSection,
    SearchTextField,
    SectionStyle,
    type Chapter,
    type ChapterData,
    type Content,
    type Form,
    type PagedSearchResult,
    type SearchForm,
    type SearchRequest,
    type SortOption,
} from "@mana-app/types";

import { htmlChapter, sequenceChapters } from "../lib/books";
import { SiteData } from "../lib/cache";
import { chapterDocument, load } from "../lib/html";
import { getText, requireOk, type ClientOptions } from "../lib/http";
import { FilterReader, multiSelect, searchForm, singleSelect, sortOf } from "../lib/search";
import type { HomeRow } from "../lib/sections";
import { Preferences, readingSection } from "../lib/settings";
import { HomeSource } from "../lib/source";
import { withQuery, type Query } from "../lib/url";
import { BASE_URL, FILTER } from "./model";
import {
    parseCarousel,
    parseChapter,
    parseFinder,
    parseFinderForm,
    parseSeries,
    parseToc,
    seriesPath,
    type FinderLists,
    type OrderedChapter,
} from "./parsers";

const LANGUAGE = "en_US";

const NO_LISTS: FinderLists = {
    genres: [],
    tags: [],
    warnings: [],
    statuses: [],
    matchModes: [],
    sorts: [],
};

class ScribbleHub extends HomeSource {
    readonly info = {
        id: "mc.scribblehub",
        name: "ScribbleHub",
        version: "1.0.0",
        description: "Original web novels and fan fiction from Scribble Hub.",
        website: BASE_URL,
        rating: CatalogRating.MIXED,
        supportedLanguages: ["en_US"],
        thumbnail: "ScribbleHub.png",
    };

    override readonly config = {
        // The whole site sits behind a Cloudflare managed challenge.
        cloudflareResolutionURL: `${BASE_URL}/`,
    };

    /** The sorts come from the series finder; see `getSortOptions`. */
    protected readonly sorts: SortOption[] = [];

    protected override readonly clientOptions: ClientOptions = {
        requests: 2,
        intervalMs: 1_000,
        headers: { Referer: `${BASE_URL}/` },
    };

    private readonly prefs = new Preferences({ notes: false });

    /**
     * Every list of the search form, from the one finder page. Behind Cloudflare it can fail
     * until the app has cleared the challenge, so readers fall back to empty lists.
     */
    private readonly finderLists = new SiteData("scribblehub.series-finder", async () => {
        const html = await getText(this.http, `${BASE_URL}/series-finder/`);

        return parseFinderForm(html);
    });

    protected rows(): HomeRow[] {
        return [
            {
                id: "trending",
                title: "Trending",
                style: SectionStyle.SimpleHeroPaged,
                load: () => this.trending(),
            },
            {
                id: "latest-updates",
                title: "Latest Updates",
                style: SectionStyle.DetailedDoubleRowPaged,
                load: (page) => this.list({}, page, "lastchpdate"),
            },
            {
                id: "new-series",
                title: "New Series",
                style: SectionStyle.SimpleSingleRow,
                load: (page) => this.list({}, page, "dateadded"),
            },
            {
                id: "popular",
                title: "Most Viewed",
                style: SectionStyle.SimpleDoubleRow,
                load: (page) => this.list({}, page, "pageviews"),
            },
            {
                id: "completed",
                title: "Popular Completed",
                load: (page) => this.list({ cp: "completed" }, page, "pageviews"),
            },
        ];
    }

    protected async find(request: SearchRequest): Promise<PagedSearchResult> {
        const joined = (id: string) => {
            const { included, excluded } = FilterReader.excludable(request, id);

            return [included.join(",") || undefined, excluded.join(",") || undefined];
        };

        const [gi, ge] = joined(FILTER.genres);
        const [tgi, tge] = joined(FILTER.tags);
        const [cti, cte] = joined(FILTER.warnings);
        const genreMode = FilterReader.option(request, FILTER.genreMode) ?? "and";
        const tagMode = FilterReader.option(request, FILTER.tagMode) ?? "and";

        const { sorts } = await this.finderLists.getOr(NO_LISTS);
        const sort = sortOf(request, sorts);

        return this.list(
            {
                sh: request.query?.trim(),
                gi,
                mgi: gi && genreMode,
                ge,
                tgi,
                mtgi: tgi && tagMode,
                tge,
                cti,
                mct: cti && "and",
                cte,
                mnc: FilterReader.integer(request, FILTER.minChapters),
                cp: FilterReader.option(request, FILTER.status),
            },
            request.page || 1,
            sort.id,
            sort.ascending,
        );
    }

    override async getSortOptions(): Promise<SortOption[]> {
        const { sorts } = await this.finderLists.getOr(NO_LISTS);

        return sorts;
    }

    async getSearchForm(): Promise<SearchForm> {
        const lists = await this.finderLists.getOr(NO_LISTS);

        return searchForm([
            SearchSortSection({ footer: "Search text matches series titles." }),
            SearchListSection({
                header: "Series",
                children: [
                    singleSelect({ id: FILTER.status, title: "Status", options: lists.statuses }),
                    SearchTextField({
                        id: FILTER.minChapters,
                        title: "Minimum Chapters",
                        placeholder: "e.g. 50",
                    }),
                ],
            }),
            multiSelect({
                id: FILTER.warnings,
                title: "Content Warnings",
                options: lists.warnings,
                excludable: true,
            }),
            SearchListSection({
                header: "Genres",
                children: [
                    SearchExcludableMultiPickerSheet({
                        id: FILTER.genres,
                        title: "Genres",
                        options: lists.genres,
                    }),
                    singleSelect({
                        id: FILTER.genreMode,
                        title: "Included Genres Match",
                        options: lists.matchModes,
                    }),
                ],
            }),
            SearchListSection({
                header: "Tags",
                children: [
                    SearchExcludableMultiPickerSheet({
                        id: FILTER.tags,
                        title: "Tags",
                        options: lists.tags,
                    }),
                    singleSelect({
                        id: FILTER.tagMode,
                        title: "Included Tags Match",
                        options: lists.matchModes,
                    }),
                ],
            }),
        ]);
    }

    async getPreferenceMenu(): Promise<Form> {
        const notes = await this.prefs.toggle("notes", "Keep author's notes");
        const reading = readingSection([notes]);

        return { sections: [reading] };
    }

    async getContent(contentId: string): Promise<Content> {
        const path = seriesPath(contentId) ?? contentId;
        const [html, listed] = await Promise.all([
            getText(this.http, `${BASE_URL}${path}`),
            this.fullToc(path),
        ]);

        const series = parseSeries(html, path);

        // `pagenum=-1` is undocumented; were it ever ignored, the endpoint would answer with
        // one page, so a list no longer than the series page's own falls back to `?toc=`.
        const onePage = series.tocPages <= 1;
        const complete = listed.length > 0 && (onePage || listed.length > series.chapters.length);

        const chapters = complete
            ? listed
            : await this.pagedToc(path, series.chapters, series.tocPages);

        return { ...series.content, chapters: ordered(chapters) };
    }

    async getChapterData(_contentId: string, chapterId: string): Promise<ChapterData> {
        const url = `${BASE_URL}${chapterId}`;
        const response = requireOk(await this.http.get(url), "Loading the chapter");

        const keepNotes = await this.prefs.get("notes");

        const html = await response.text();
        const { title, body } = parseChapter(html, { url, keepNotes });

        return htmlChapter(response, chapterDocument(title, body));
    }

    private async trending(): Promise<PagedSearchResult> {
        const html = await getText(this.http, `${BASE_URL}/`);

        return parseCarousel(html, "Trending");
    }

    /**
     * Every chapter in one request: the series page's own TOC widget pages through this
     * endpoint, and `pagenum=-1` asks for all pages at once.
     */
    private async fullToc(path: string): Promise<OrderedChapter[]> {
        const id = /^\/series\/(\d+)\//.exec(path)?.[1];
        if (!id) return [];

        const body = Body.form({
            action: "wi_getreleases_pagination",
            pagenum: "-1",
            mypostid: id,
        });

        const response = await this.http.post(`${BASE_URL}/wp-admin/admin-ajax.php`, body);
        if (!response.ok) return [];

        const html = await response.text();

        return parseToc(load(html));
    }

    /** The series page shows one TOC page of 15 chapters, newest first; `?toc=N` serves the others. */
    private async pagedToc(
        path: string,
        first: OrderedChapter[],
        pages: number,
    ): Promise<OrderedChapter[]> {
        const tocPage = async (page: number) => {
            const html = await getText(this.http, `${BASE_URL}${path}?toc=${page}`);

            return parseToc(load(html));
        };

        const others = Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2);
        const rest = await Promise.all(others.map(tocPage));

        return [first, ...rest].flat();
    }

    /** `filters` are series-finder parameters; `order` carries the sort direction. */
    private async list(
        filters: Query,
        page: number,
        sort: string,
        ascending = false,
    ): Promise<PagedSearchResult> {
        const params: Query = {
            sf: 1,
            ...filters,
            sort,
            order: ascending ? "asc" : "desc",
            pg: page > 1 ? page : undefined,
        };

        const html = await getText(this.http, withQuery(`${BASE_URL}/series-finder/`, params));

        return parseFinder(html);
    }
}

/**
 * Oldest first by each row's absolute `order`, which also merges TOC pages that overlap
 * when a chapter is posted between two requests.
 */
function ordered(chapters: OrderedChapter[]): Chapter[] {
    const byOrder = new Map<number, OrderedChapter>();
    for (const chapter of chapters) byOrder.set(chapter.order, chapter);

    const sorted = [...byOrder.values()].sort((a, b) => a.order - b.order);
    const listed = sorted.map(({ order: _order, ...chapter }) => chapter);

    return sequenceChapters(listed, LANGUAGE);
}

export class Target extends ScribbleHub {}
