/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    CatalogRating,
    SearchListSection,
    SearchSortSection,
    SectionStyle,
    type Chapter,
    type ChapterData,
    type Content,
    type Option,
    type PagedSearchResult,
    type SearchForm,
    type SearchRequest,
    type SortOption,
    type SourceConfig,
} from "@mana-app/types";

import { htmlChapter, sequenceChapters } from "../lib/books";
import { SiteData } from "../lib/cache";
import { chapterDocument } from "../lib/html";
import { getText, requireOk, SourceError, type ClientOptions } from "../lib/http";
import { FilterReader, searchForm, singleSelect, sortOf } from "../lib/search";
import type { HomeRow } from "../lib/sections";
import { HomeSource } from "../lib/source";
import { withQuery } from "../lib/url";
import {
    BASE_URL,
    CHAPTER_PATH,
    FILTER,
    NOVEL_PATH,
    STATUS_PATHS,
    type StatusFilter,
} from "./model";
import {
    parseChapterBody,
    parseChapters,
    parseFilterOptions,
    parseList,
    parseNovel,
    pathFromLink,
} from "./parsers";

const NO_CHAPTERS = "No chapters were found for this novel.";
const NO_CHAPTER_TEXT = "The chapter page had no text. It may have moved or been removed.";

type FilterOptions = { genres: Option[]; sorts: SortOption[] };

const NO_FILTERS: FilterOptions = { genres: [], sorts: [] };

const STATUS_OPTIONS: Option[] = [
    { id: "ongoing", title: "Ongoing" },
    { id: "completed", title: "Completed" },
];

function statusFilter(value: string | undefined): StatusFilter | undefined {
    return value === "ongoing" || value === "completed" ? value : undefined;
}

function novelPath(contentId: string): string {
    const path = pathFromLink(contentId);
    if (!NOVEL_PATH.test(path)) throw new SourceError("This link is not an XNovel novel.");

    return path;
}

class XNovel extends HomeSource {
    readonly info = {
        id: "mc.xnovel",
        name: "XNovel",
        version: "1.0.0",
        description:
            "English web novels from Xnovel, with its hot, latest and completed lists and search by genre and status.",
        website: BASE_URL,
        rating: CatalogRating.MIXED,
        supportedLanguages: ["en_US"],
        thumbnail: "XNovel.png",
    };

    /** The site is one domain behind Cloudflare, so the app resolves its challenges there. */
    override readonly config: SourceConfig = { cloudflareResolutionURL: BASE_URL };

    /** The site's sorts are read from its search page; see `getSortOptions`. */
    protected readonly sorts: SortOption[] = [];
    protected override readonly clientOptions: ClientOptions = { requests: 2 };

    /**
     * Genres come from the home page's genre menu and sorts from the search page's sort
     * menu. Both are the site's own lists, cached so that opening the search form is quick.
     */
    private readonly filters = new SiteData<FilterOptions>("xnovel.filters", async () => {
        const [home, search] = await Promise.all([
            getText(this.http, `${BASE_URL}/`),
            getText(this.http, `${BASE_URL}/search`),
        ]);

        return parseFilterOptions(home, search);
    });

    protected rows(): HomeRow[] {
        return [
            {
                id: "hot",
                title: "Hot Novels",
                style: SectionStyle.SimpleHeroPaged,
                load: (page) => this.browse("/popular", page),
            },
            {
                id: "latest",
                title: "Latest Releases",
                style: SectionStyle.DetailedDoubleRowPaged,
                load: (page) => this.browse("/latest", page),
            },
            {
                id: "completed",
                title: "Completed Novels",
                style: SectionStyle.SimpleDoubleRow,
                load: (page) => this.browse(STATUS_PATHS.completed, page),
            },
            {
                id: "ongoing",
                title: "Ongoing Novels",
                style: SectionStyle.SimpleSingleRow,
                load: (page) => this.browse(STATUS_PATHS.ongoing, page),
            },
        ];
    }

    protected async find(request: SearchRequest): Promise<PagedSearchResult> {
        const page = request.page || 1;
        const query = request.query?.trim();
        const genre = FilterReader.option(request, FILTER.genre);
        const status = statusFilter(FilterReader.option(request, FILTER.status));

        // The browse lists take a status and a genre in their path but no text or sort, so a
        // status applies only when the search text is empty.
        if (!query && status) {
            const genrePath = genre ? `/${encodeURIComponent(genre)}` : "";

            return this.browse(`${STATUS_PATHS[status]}${genrePath}`, page);
        }

        const { sorts } = await this.filters.getOr(NO_FILTERS);

        const url = withQuery(`${BASE_URL}/search`, {
            word: query || undefined,
            genres: genre,
            sortby: sortOf(request, sorts).id,
            page: page > 1 ? page : undefined,
        });

        return parseList(await getText(this.http, url));
    }

    override async getSortOptions(): Promise<SortOption[]> {
        const { sorts } = await this.filters.getOr(NO_FILTERS);

        return sorts;
    }

    async getSearchForm(): Promise<SearchForm> {
        const { genres } = await this.filters.getOr(NO_FILTERS);

        return searchForm([
            SearchSortSection({
                footer: "Sorting applies to searches. A status applies when the search text is empty.",
            }),
            SearchListSection({
                header: "Filters",
                children: [
                    singleSelect({ id: FILTER.genre, title: "Genre", options: genres }),
                    singleSelect({ id: FILTER.status, title: "Status", options: STATUS_OPTIONS }),
                ],
            }),
        ]);
    }

    async getContent(contentId: string): Promise<Content> {
        const path = novelPath(contentId);
        const html = await getText(this.http, `${BASE_URL}${path}`);

        const listed = parseChapters(html, path);
        if (!listed.length) throw new SourceError(NO_CHAPTERS);

        const linked = listed.map((chapter) => ({
            ...chapter,
            webUrl: `${BASE_URL}${chapter.chapterId}`,
        }));

        return { ...parseNovel(html, path), chapters: sequenceChapters(linked, "en_US") };
    }

    async getChapterData(
        _contentId: string,
        chapterId: string,
        chapter?: Chapter,
    ): Promise<ChapterData> {
        const path = pathFromLink(chapterId);
        if (!CHAPTER_PATH.test(path)) {
            throw new SourceError("This chapter link is not an XNovel chapter.");
        }

        const url = `${BASE_URL}${path}`;
        const response = requireOk(await this.http.get(url), "Loading the chapter");
        const body = parseChapterBody(await response.text(), url);
        if (body === undefined) throw new SourceError(NO_CHAPTER_TEXT);

        return htmlChapter(response, chapterDocument(chapter?.title ?? "", body, "en"));
    }

    /** One page of a browse list, whose pages are `<path>/<n>` after the first. */
    private async browse(path: string, page: number): Promise<PagedSearchResult> {
        const url = `${BASE_URL}${path}${page > 1 ? `/${page}` : ""}`;

        return parseList(await getText(this.http, url));
    }
}

export class Target extends XNovel {}
