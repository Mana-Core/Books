/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    CatalogRating,
    SearchExcludableMultiPickerSheet,
    SearchListSection,
    SearchSortSection,
    SearchTextField,
    SearchToggle,
    SectionStyle,
    type Chapter,
    type ChapterData,
    type Content,
    type PagedSearchResult,
    type SearchForm,
    type SearchRequest,
} from "@mana-app/types";

import { htmlChapter } from "../lib/books";
import { chapterDocument, cleanChapterHtml, load, textToHtml } from "../lib/html";
import { SourceError, getJson, requireOk, type ClientOptions } from "../lib/http";
import { SiteData } from "../lib/cache";
import { FilterReader, multiSelect, searchForm } from "../lib/search";
import type { HomeRow } from "../lib/sections";
import { HomeSource } from "../lib/source";
import { withQuery } from "../lib/url";
import {
    API,
    BASE_URL,
    CHAPTER_PAGE_SIZE,
    FILTER,
    LIST_API,
    PAGE_SIZE,
    SORTS,
    STATUSES,
    type ChapterList,
    type ChapterRead,
    type NovelDetail,
    type NovelList,
} from "./model";
import { novelUrl, siteGenres, siteTags, toChapters, toContent, toResult } from "./parsers";

const HUMAN_CHECK_REQUIRED =
    "Chikari wants a human check after many chapters in a row. " +
    "Wait a while, or open the chapter on chikari.moe.";

const RATE_LIMITED = "Chikari is rate limiting requests. Try again in a moment.";

type Listing = {
    sort?: string;
    query?: string;
    genres?: string[];
    excludedGenres?: string[];
    tags?: string[];
    excludedTags?: string[];
    minChapters?: number;
    statuses?: string[];
    adult?: boolean;
    page: number;
};

class ChikariNovels extends HomeSource {
    readonly info = {
        id: "mc.chikari-novels",
        name: "ChikariNovels",
        version: "1.0.0",
        description:
            "Web novels from Chikari (formerly Light Novel World), with clean chapter text.",
        website: `${BASE_URL}/novels`,
        rating: CatalogRating.MIXED,
        supportedLanguages: ["en_US"],
        thumbnail: "ChikariNovels.png",
    };

    protected readonly sorts = SORTS;
    protected override readonly clientOptions: ClientOptions = { requests: 4 };

    private readonly genres = new SiteData("genres", () => siteGenres(this.http));
    private readonly tags = new SiteData("tags", () => siteTags(this.http));

    // One list request per row: the site's own /home endpoint returns every row at once and
    // would be fetched again for each row the app resolves.
    protected rows(): HomeRow[] {
        return [
            {
                id: "trending",
                title: "Trending",
                style: SectionStyle.SimpleHeroPaged,
                load: (page) => this.list({ sort: "trending-week", page }),
            },
            {
                id: "popular",
                title: "Popular",
                style: SectionStyle.SimpleDoubleRow,
                load: (page) => this.list({ sort: "popular", page }),
            },
            {
                id: "top-rated",
                title: "Top Rated",
                style: SectionStyle.DetailedSingleRowPaged,
                load: (page) => this.list({ sort: "top_rated", page }),
            },
            {
                id: "updated",
                title: "Recently Updated",
                style: SectionStyle.DetailedDoubleRowPaged,
                load: (page) => this.list({ sort: "updated", page }),
            },
            {
                id: "added",
                title: "Recently Added",
                style: SectionStyle.SimpleSingleRow,
                load: (page) => this.list({ sort: "added", page }),
            },
            {
                id: "bookmarked",
                title: "Most Bookmarked",
                style: SectionStyle.SimpleSingleRow,
                load: (page) => this.list({ sort: "most_bookmarked", page }),
            },
        ];
    }

    protected find(request: SearchRequest): Promise<PagedSearchResult> {
        const query = request.query?.trim();
        const genres = FilterReader.excludable(request, FILTER.genre);
        const tags = FilterReader.excludable(request, FILTER.tag);

        // Without a sort the API ranks text matches by relevance, and any sort overrides that.
        const sort = query && !request.sort ? undefined : this.sortOf(request).id;

        return this.list({
            query,
            sort,
            genres: genres.included,
            excludedGenres: genres.excluded,
            tags: tags.included,
            excludedTags: tags.excluded,
            minChapters: FilterReader.integer(request, FILTER.minChapters),
            statuses: FilterReader.options(request, FILTER.status),
            adult: FilterReader.toggle(request, FILTER.content),
            page: request.page,
        });
    }

    async getSearchForm(): Promise<SearchForm> {
        const [genres, tags] = await Promise.all([this.genres.getOr([]), this.tags.getOr([])]);

        return searchForm([
            SearchSortSection({
                footer: "Searching by text ranks by relevance unless a sort is picked.",
            }),
            SearchListSection({
                // `adult=true` switches the API to the adult catalogue rather than adding it.
                footer: "Adult Catalogue Only shows the site's adult novels instead of its general ones.",
                children: [
                    SearchToggle({ id: FILTER.content, title: "Adult Catalogue Only" }),
                    SearchTextField({
                        id: FILTER.minChapters,
                        title: "Minimum Chapters",
                        placeholder: "100",
                    }),
                    SearchExcludableMultiPickerSheet({
                        id: FILTER.genre,
                        title: "Genres",
                        options: genres,
                    }),
                    SearchExcludableMultiPickerSheet({
                        id: FILTER.tag,
                        title: "Tags",
                        options: tags,
                    }),
                ],
            }),
            multiSelect({ id: FILTER.status, title: "Status", options: STATUSES }),
        ]);
    }

    async getContent(contentId: string): Promise<Content> {
        const url = `${API}/${encodeURIComponent(contentId)}`;
        const novel = await getJson<NovelDetail>(this.http, url);

        return toContent(novel);
    }

    async getChapters(contentId: string): Promise<Chapter[]> {
        const url = (offset: number) =>
            withQuery(`${API}/${encodeURIComponent(contentId)}/chapters`, {
                order: "asc",
                limit: CHAPTER_PAGE_SIZE,
                offset,
            });

        const first = await getJson<ChapterList>(this.http, url(0));

        const offsets: number[] = [];
        for (let offset = CHAPTER_PAGE_SIZE; offset < first.total; offset += CHAPTER_PAGE_SIZE) {
            offsets.push(offset);
        }

        const rest = await Promise.all(
            offsets.map((offset) => getJson<ChapterList>(this.http, url(offset))),
        );
        const rows = [first, ...rest].flatMap((page) => page.items);

        return toChapters(contentId, rows);
    }

    async getChapterData(contentId: string, chapterId: string): Promise<ChapterData> {
        const novel = encodeURIComponent(contentId);
        const url = `${API}/${novel}/chapters/${encodeURIComponent(chapterId)}/read`;
        const response = await this.http.get(url);

        if (response.status === 429) {
            // Bursts of reading get a human check that only the site's web page can solve.
            const payload = await response
                .json<{ code?: string }>()
                .catch(() => ({ code: undefined }));

            const message =
                payload.code === "challenge_required" ? HUMAN_CHECK_REQUIRED : RATE_LIMITED;

            throw new SourceError(message, 429);
        }

        const chapter = await requireOk(response, "Loading the chapter").json<ChapterRead>();

        if (chapter.club_block) {
            throw new SourceError("This chapter is only open to members of a Chikari club.");
        }
        if (chapter.locked || !chapter.body) {
            throw new SourceError(chapter.lock_reason || "This chapter is locked on Chikari.");
        }

        const $ = load(`<div id="chapter">${textToHtml(chapter.body)}</div>`);
        const body = cleanChapterHtml($, $("#chapter").first(), {
            baseUrl: `${novelUrl(contentId)}/${chapterId}`,
        });

        return htmlChapter(response, chapterDocument(chapter.title, body));
    }

    private async list(listing: Listing): Promise<PagedSearchResult> {
        const offset = (Math.max(listing.page, 1) - 1) * PAGE_SIZE;

        const url = withQuery(LIST_API, {
            type: "novel",
            sort: listing.sort,
            q: listing.query,
            genre: listing.genres,
            genre_exclude: listing.excludedGenres,
            tag: listing.tags,
            tag_exclude: listing.excludedTags,
            min_chapters: listing.minChapters,
            status: listing.statuses,
            adult: listing.adult ? "true" : undefined,
            limit: PAGE_SIZE,
            offset,
        });
        const novels = await getJson<NovelList>(this.http, url);

        return toResult(novels);
    }
}

export class Target extends ChikariNovels {}
