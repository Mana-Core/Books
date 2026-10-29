/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
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
import { chapterDocument, cleanChapterHtml, load } from "../lib/html";
import { getJson, requireOk, SourceError } from "../lib/http";
import { MirrorSet } from "../lib/mirrors";
import { FilterReader, searchForm, singleSelect, sortOf } from "../lib/search";
import type { HomeRow } from "../lib/sections";
import { HomeSource } from "../lib/source";
import { pathOf, withQuery, type Query } from "../lib/url";
import {
    apiOf,
    BEST_MATCH,
    FILTER,
    MIRRORS,
    PAGE_SIZE,
    PROBE_MARKER,
    probeUrl,
    TYPES,
    type ApiChapter,
    type ApiChapterRef,
    type ApiEnvelope,
    type ApiPage,
    type ApiTitle,
} from "./model";
import {
    NO_MENUS,
    siteGenres,
    siteMenus,
    toChapters,
    toContent,
    toPage,
    toResults,
} from "./parsers";

/** Ad slots are injected as empty or zero-size boxes that may later hold a watermark. */
const AD_SLOTS = [
    '[style*="font-size:0"]',
    '[style*="display:none"]',
    '[style*="display: none"]',
    "[hidden]",
];

const WATERMARKS = [
    /(novel\s*buddy|light\s*novel\s*pub|novel\s*fab)\s*\.\s*(me|com|io|net|org)/i,
    /\b(read|visit|find)\b.{0,40}\b(novel\s*buddy|light\s*novel\s*pub|novel\s*fab)\b/i,
];

const NO_CHAPTER_TEXT = "The chapter has no text. It may have been removed.";

class NovelBuddy extends HomeSource {
    readonly info = {
        id: "mc.novelbuddy",
        name: "NovelBuddy",
        version: "1.0.0",
        description: "Korean, Chinese and Japanese web novels and light novels from NovelBuddy.",
        website: MIRRORS[0] ?? "https://novelbuddy.me",
        rating: CatalogRating.MIXED,
        supportedLanguages: ["en_US"],
        thumbnail: "NovelBuddy.png",
    };

    /** Fetched with the site's search menus instead; see `getSortOptions`. */
    protected readonly sorts: SortOption[] = [];

    private readonly mirrors = new MirrorSet({ builtIn: MIRRORS, probeUrl, marker: PROBE_MARKER });
    private readonly genres = new SiteData("genres", () =>
        this.mirrors.run((origin) => siteGenres(this.http, origin)),
    );
    private readonly menus = new SiteData("search-menus", () =>
        this.mirrors.run((origin) => siteMenus(this.http, origin)),
    );

    protected rows(): HomeRow[] {
        return [
            {
                id: "trending",
                title: "Trending",
                style: SectionStyle.SimpleHeroPaged,
                load: () => this.titles("/trending/titles", "items", { limit: 50 }),
            },
            {
                id: "popular-updates",
                title: "Popular Updates",
                style: SectionStyle.DetailedSingleRowPaged,
                load: () => this.titles("/titles/home", "popular"),
            },
            {
                id: "latest",
                title: "Latest Updates",
                style: SectionStyle.DetailedDoubleRowPaged,
                load: (page) => this.browse({ sort: "latest" }, page),
            },
            {
                id: "popular",
                title: "Most Popular",
                style: SectionStyle.SimpleDoubleRow,
                load: (page) => this.browse({ sort: "views" }, page),
            },
            {
                id: "newest",
                title: "Newest Novels",
                style: SectionStyle.SimpleSingleRow,
                load: (page) => this.browse({ sort: "newest" }, page),
            },
        ];
    }

    async getPreferenceMenu(): Promise<Form> {
        return { sections: [await this.mirrors.section()] };
    }

    override async getSortOptions(): Promise<SortOption[]> {
        return (await this.menus.getOr(NO_MENUS)).sorts;
    }

    protected async find(request: SearchRequest): Promise<PagedSearchResult> {
        const query = request.query?.trim();
        const chosen = sortOf(request, await this.getSortOptions());
        const relevance = !chosen.id || chosen.id === BEST_MATCH;
        const genres = FilterReader.excludable(request, FILTER.genres);

        // Without search text there is nothing to match, so the site falls back to updates.
        const relevanceSort = query ? undefined : "latest";

        const params: Query = {
            q: query,
            sort: relevance ? relevanceSort : chosen.id,
            order: chosen.ascending && !relevance ? "asc" : undefined,
            genres: genres.included.join(","),
            exclude: genres.excluded.join(","),
            status: FilterReader.option(request, FILTER.status),
            type: FilterReader.option(request, FILTER.type),
            min_ch: FilterReader.integer(request, FILTER.chapters),
            max_ch: FilterReader.integer(request, FILTER.maxChapters),
            author: FilterReader.text(request, FILTER.author),
            tag: FilterReader.text(request, FILTER.tag),
        };

        return this.browse(params, request.page || 1);
    }

    async getSearchForm(): Promise<SearchForm> {
        const [genres, { statuses }] = await Promise.all([
            this.genres.getOr([]),
            this.menus.getOr(NO_MENUS),
        ]);

        return searchForm([
            SearchSortSection({
                footer: "Best Match ranks by the search text; without text it shows the latest updates.",
            }),
            SearchListSection({
                children: [
                    SearchExcludableMultiPickerSheet({
                        id: FILTER.genres,
                        title: "Genres",
                        options: genres,
                    }),
                    singleSelect({ id: FILTER.status, title: "Status", options: statuses }),
                    singleSelect({ id: FILTER.type, title: "Origin", options: TYPES }),
                    // The site asks for both as free numbers.
                    SearchTextField({
                        id: FILTER.chapters,
                        title: "Min Chapters",
                        placeholder: "100",
                    }),
                    SearchTextField({
                        id: FILTER.maxChapters,
                        title: "Max Chapters",
                        placeholder: "1000",
                    }),
                    SearchTextField({
                        id: FILTER.author,
                        title: "Author",
                        placeholder: "Guiltythree",
                    }),
                    SearchTextField({ id: FILTER.tag, title: "Tag", placeholder: "System" }),
                ],
            }),
        ]);
    }

    async getContent(contentId: string): Promise<Content> {
        const path = slugPath(contentId);
        const slug = encodeURIComponent(path.slice(1));

        const { data, origin } = await this.api<{ title?: ApiTitle }>(`/titles/by-slug/${slug}`, {
            include: "details",
        });

        const title = data?.title;
        if (!title?.id) throw new SourceError("This novel was not found on NovelBuddy.");

        const content = toContent(title, `${origin}${path}`);
        const chapters = await this.chaptersOf(title, origin);

        return { ...content, chapters };
    }

    async getChapterData(_contentId: string, chapterId: string): Promise<ChapterData> {
        const [, slug, chapterSlug] = /^\/([^/]+)\/([^/?#]+)$/.exec(pathOf(chapterId)) ?? [];
        if (!slug || !chapterSlug) {
            throw new SourceError("This chapter link is not a NovelBuddy chapter.");
        }

        const path = `/titles/by-slug/${encodeURIComponent(slug)}/chapters/${encodeURIComponent(chapterSlug)}`;

        return this.mirrors.run(async (origin) => {
            const url = withQuery(`${apiOf(origin)}${path}`, { include: "details" });
            const response = requireOk(await this.http.get(url), "Loading the chapter");

            const envelope = await response.json<ApiEnvelope<{ chapter?: ApiChapter }>>();
            const chapter = envelope.data?.chapter;
            if (!chapter?.content) throw new SourceError(NO_CHAPTER_TEXT);

            const $ = load(`<div id="chapter">${chapter.content}</div>`);
            const body = cleanChapterHtml($, $("#chapter"), {
                baseUrl: `${origin}${chapterId}`,
                remove: AD_SLOTS,
                dropText: WATERMARKS,
            });
            if (!body) throw new SourceError(NO_CHAPTER_TEXT);

            return htmlChapter(response, chapterDocument(chapter.name ?? "", body));
        });
    }

    private async chaptersOf(title: ApiTitle, origin: string): Promise<Chapter[]> {
        // `cv` is the title's content version; without it the API can serve a cached list
        // that is missing the newest chapter.
        const path = `/titles/${encodeURIComponent(title.id ?? "")}/chapters`;
        const { data } = await this.api<{ chapters?: ApiChapterRef[] }>(path, {
            cv: title.content_version ?? title.cv,
        });

        const listed = toChapters(data?.chapters, origin);
        if (!listed.length) throw new SourceError("No chapters were found for this novel.");

        return sequenceChapters(listed, "en_US");
    }

    /** A fixed home list, found under `key` in the endpoint's data. */
    private async titles(path: string, key: string, query?: Query): Promise<PagedSearchResult> {
        const { data, origin } = await this.api<Record<string, ApiTitle[] | undefined>>(
            path,
            query,
        );

        return { results: toResults(data?.[key], origin), isLastPage: true };
    }

    private async browse(params: Query, page: number): Promise<PagedSearchResult> {
        const query = { ...params, page, limit: PAGE_SIZE };
        const { data, origin } = await this.api<ApiPage>("/titles/search", query);

        return toPage(data, origin);
    }

    private async api<T>(
        path: string,
        query?: Query,
    ): Promise<{ data: T | undefined; origin: string }> {
        return this.mirrors.run(async (origin) => {
            const url = withQuery(`${apiOf(origin)}${path}`, query);
            const envelope = await getJson<ApiEnvelope<T>>(this.http, url);
            if (envelope.success === false) {
                throw new SourceError(envelope.message ?? "NovelBuddy refused the request.");
            }

            return { data: envelope.data, origin };
        });
    }
}

/** Accepts a stored path or a pasted link to the novel or one of its chapters. */
function slugPath(contentId: string): string {
    const slug = /^\/([^/?#]+)/.exec(pathOf(contentId))?.[1];
    if (!slug) throw new SourceError("This link is not a NovelBuddy novel.");

    return `/${slug}`;
}

export class Target extends NovelBuddy {}
