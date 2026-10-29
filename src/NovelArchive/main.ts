/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    CatalogRating,
    SearchExcludableMultiPickerSheet,
    SearchListSection,
    SearchSortSection,
    SearchToggle,
    SectionStyle,
    type Chapter,
    type ChapterData,
    type Content,
    type Form,
    type HttpResponse,
    type PagedSearchResult,
    type SearchForm,
    type SearchRequest,
    type SortOption,
} from "@mana-app/types";

import { htmlChapter } from "../lib/books";
import { SiteData } from "../lib/cache";
import { chapterDocument, cleanChapterHtml, escapeHtml, load, textToHtml } from "../lib/html";
import { getJson, SourceError, type ClientOptions } from "../lib/http";
import { FilterReader, searchForm, singleSelect, sortOf } from "../lib/search";
import type { HomeRow } from "../lib/sections";
import { Preferences, readingSection } from "../lib/settings";
import { HomeSource } from "../lib/source";
import { withQuery } from "../lib/url";
import {
    API,
    BASE_URL,
    FILTER,
    PAGE_SIZE,
    ROW_LIMIT,
    type ArchiveChapter,
    type Novel,
    type NovelPage,
    type UpstreamChapter,
    type UpstreamChapterList,
    type Upstreams,
} from "./model";
import {
    archiveChapters,
    libraryFilters,
    looksMissing,
    NO_LIBRARY_FILTERS,
    novelUrl,
    parseChapterId,
    siteGenres,
    toContent,
    toResult,
    upstreamChapters,
} from "./parsers";

type BrowseOptions = {
    query?: string;
    sort: string;
    status?: string;
    genres?: string[];
    excludedGenres?: string[];
    anyGenre?: boolean;
    page: number;
};

type LoadedChapter = { response: HttpResponse; title: string; html: string; via?: string };

/** The upstream id of the archive's own copy. */
const ARCHIVE = "";

const READING_FOOTER = [
    "The archive keeps chapter text only. For novels with illustrated chapters, the upstream copy the site",
    "recommends still has the artwork, but it may be incomplete or numbered differently. Reopen a novel",
    "after changing this.",
].join(" ");

class NovelArchive extends HomeSource {
    readonly info = {
        id: "mc.novel-archive",
        name: "NovelArchive",
        version: "1.0.0",
        description: "A large archive of web novels collected from many upstream sites.",
        website: BASE_URL,
        rating: CatalogRating.MIXED,
        supportedLanguages: ["en_US"],
        thumbnail: "NovelArchive.png",
    };

    /** Fetched with the library's filters instead; see `getSortOptions`. */
    protected readonly sorts: SortOption[] = [];
    /** The API allows 900 requests per five minutes per client. */
    protected override readonly clientOptions: ClientOptions = { requests: 3, intervalMs: 1_000 };

    private readonly prefs = new Preferences({ illustrated: false });
    private readonly library = new SiteData("library", () => libraryFilters(this.http));
    private readonly genres = new SiteData("genres", () => siteGenres(this.http));

    protected rows(): HomeRow[] {
        return [
            {
                id: "trending",
                title: "Trending",
                style: SectionStyle.SimpleHeroPaged,
                load: (page) => this.fixed("trending", page),
            },
            {
                id: "editors-choice",
                title: "Editor's Choice",
                style: SectionStyle.DetailedSingleRowPaged,
                load: (page) => this.fixed("editors-choice", page),
            },
            {
                id: "popular",
                title: "Popular",
                style: SectionStyle.SimpleDoubleRow,
                load: (page) => this.browse({ sort: "popular", page }),
            },
            {
                id: "recently-updated",
                title: "Recently Updated",
                style: SectionStyle.DetailedDoubleRowPaged,
                load: (page) => this.fixed("recently-updated", page),
            },
            {
                id: "top-rated",
                title: "Top Rated",
                style: SectionStyle.DetailedSingleRowPaged,
                load: (page) => this.browse({ sort: "rating", page }),
            },
            {
                id: "new",
                title: "New in the Archive",
                style: SectionStyle.SimpleSingleRow,
                load: (page) => this.browse({ sort: "recent", page }),
            },
        ];
    }

    override async getSortOptions(): Promise<SortOption[]> {
        return (await this.library.getOr(NO_LIBRARY_FILTERS)).sorts;
    }

    protected async find(request: SearchRequest): Promise<PagedSearchResult> {
        const genres = FilterReader.excludable(request, FILTER.genre);
        const { sorts, adultGenres } = await this.library.getOr(NO_LIBRARY_FILTERS);
        const hideAdult = FilterReader.toggle(request, FILTER.hideAdult);

        const excludedGenres = hideAdult
            ? [...new Set([...genres.excluded, ...adultGenres])]
            : genres.excluded;

        return this.browse({
            query: request.query?.trim(),
            sort: sortOf(request, sorts).id,
            status: FilterReader.option(request, FILTER.status),
            genres: genres.included,
            excludedGenres,
            anyGenre: FilterReader.toggle(request, FILTER.anyGenre),
            page: request.page,
        });
    }

    async getSearchForm(): Promise<SearchForm> {
        const [library, genres] = await Promise.all([
            this.library.getOr(NO_LIBRARY_FILTERS),
            this.genres.getOr([]),
        ]);

        const genreOptions = genres.filter((g) => !library.nonGenres.includes(g.id));
        const adultToggle = library.adultGenres.length
            ? [SearchToggle({ id: FILTER.hideAdult, title: "Hide Adult Novels" })]
            : [];

        return searchForm([
            SearchSortSection({
                footer: "With search text the site always ranks by relevance; sorting applies when browsing without text.",
            }),
            SearchListSection({
                children: [
                    singleSelect({ id: FILTER.status, title: "Status", options: library.statuses }),
                    SearchExcludableMultiPickerSheet({
                        id: FILTER.genre,
                        title: "Genres",
                        options: genreOptions,
                    }),
                    SearchToggle({ id: FILTER.anyGenre, title: "Match Any Included Genre" }),
                    ...adultToggle,
                ],
            }),
        ]);
    }

    async getPreferenceMenu(): Promise<Form> {
        const illustrated = await this.prefs.toggle(
            "illustrated",
            "Read illustrated novels from upstream",
        );
        const reading = readingSection([illustrated], READING_FOOTER);

        return { sections: [reading] };
    }

    async getContent(contentId: string): Promise<Content> {
        const url = `${API}/${encodeURIComponent(contentId)}`;
        const { novel } = await getJson<{ novel: Novel }>(this.http, url);

        const content = toContent(novel);
        const chapters = await this.chaptersOf(novel);

        return { ...content, chapters };
    }

    async getChapterData(contentId: string, chapterId: string): Promise<ChapterData> {
        const ref = parseChapterId(chapterId);
        if (!ref) throw new SourceError("This chapter link is not one NovelArchive understands.");

        const chapter = await this.loadChapter(contentId, ref.number, ref.upstream ?? ARCHIVE);
        const $ = load(`<div id="chapter">${chapter.html}</div>`);
        let body = cleanChapterHtml($, $("#chapter").first(), {
            baseUrl: novelUrl(contentId),
        });

        if (chapter.via) {
            // A stand-in copy can be split or numbered differently, so say where the text came from.
            const note = `This chapter is missing from the chosen copy; this text comes from ${chapter.via}.`;
            body = `<p><em>${escapeHtml(note)}</em></p>${body}`;
        }

        return htmlChapter(chapter.response, chapterDocument(chapter.title, body));
    }

    /**
     * Tries the requested copy, then the others, the way the site's reader does: a chapter
     * the archive never scraped is often present on an upstream copy, and vice versa.
     */
    private async loadChapter(
        novelId: string,
        number: number,
        preferred: string,
    ): Promise<LoadedChapter> {
        const first = await this.fetchCopy(novelId, number, preferred);
        if (first) return first;

        let upstreams: Upstreams["sources"] = [];
        try {
            const url = `${API}/${encodeURIComponent(novelId)}/sources`;
            const list = await getJson<Upstreams>(this.http, url);
            upstreams = list.sources;
        } catch {
            // Without the list there is nothing to fall back to; the error below explains.
        }

        const archiveCopy = preferred === ARCHIVE ? [] : [{ id: ARCHIVE, label: "the archive" }];
        const upstreamCopies = upstreams
            .filter((u) => u.id !== preferred)
            .map((u) => ({ id: u.id, label: u.label || u.id }));
        const others = [...archiveCopy, ...upstreamCopies];

        for (const other of others) {
            const copy = await this.fetchCopy(novelId, number, other.id);
            if (copy) return { ...copy, via: other.label };
        }

        throw new SourceError(`Chapter ${number} is not available on NovelArchive yet.`, 404);
    }

    private async fetchCopy(
        novelId: string,
        number: number,
        upstream: string,
    ): Promise<LoadedChapter | undefined> {
        const base = `${API}/${encodeURIComponent(novelId)}`;

        if (upstream === ARCHIVE) {
            // `prefetch=1` drops the novel's full chapter-name list from every chapter response.
            const response = await this.http.get(`${base}/chapters/${number}?prefetch=1`);
            if (response.status === 404) return undefined;
            if (!response.ok) {
                const message = `Loading the chapter failed (HTTP ${response.status}).`;
                throw new SourceError(message, response.status);
            }

            const { chapter } = await response.json<ArchiveChapter>();
            const html = textToHtml(chapter.content ?? "");
            if (looksMissing(html)) return undefined;

            return { response, title: chapter.name || `Chapter ${number}`, html };
        }

        const url = `${base}/sources/${encodeURIComponent(upstream)}/chapters/${number}`;
        const response = await this.http.get(url);
        if (!response.ok) return undefined;

        const chapter = await response.json<UpstreamChapter>();
        if (looksMissing(chapter.content_html)) return undefined;

        return {
            response,
            title: chapter.title || `Chapter ${number}`,
            html: chapter.content_html,
        };
    }

    /**
     * The archive's own text by default: it is the complete list, numbered the way the
     * site links chapters. The upstream copy is opt-in because it only adds artwork.
     */
    private async chaptersOf(novel: Novel): Promise<Chapter[]> {
        const upstream = novel.preferred_source;
        const wantsUpstream =
            novel.has_image_chapters && upstream && (await this.prefs.get("illustrated"));

        if (wantsUpstream) {
            const url = `${API}/${encodeURIComponent(novel.id)}/sources/${encodeURIComponent(upstream)}/chapters`;
            const list = await getJson<UpstreamChapterList>(this.http, url).catch(() => undefined);
            if (list?.chapters.length) return upstreamChapters(novel.id, upstream, list);
        }

        return archiveChapters(novel);
    }

    private async browse(options: BrowseOptions): Promise<PagedSearchResult> {
        const url = withQuery(API, {
            search: options.query,
            fuzzy: options.query ? 1 : undefined,
            // "recent" is the API default; sending it would also override relevance for text searches.
            sort: options.sort === "recent" ? undefined : options.sort,
            status: options.status,
            genres_include: options.genres?.join(","),
            genres_exclude: options.excludedGenres?.join(","),
            genre_match: options.anyGenre ? "any" : undefined,
            page: Math.max(options.page, 1),
            per_page: PAGE_SIZE,
        });
        const page = await getJson<NovelPage>(this.http, url);

        return toResult(page, true);
    }

    /** Curated lists with no paging: the first page is the whole list. */
    private async fixed(list: string, page: number): Promise<PagedSearchResult> {
        if (page > 1) return { results: [], isLastPage: true };

        const url = withQuery(`${API}/${list}`, { limit: ROW_LIMIT });
        const novels = await getJson<NovelPage>(this.http, url);

        return toResult(novels, false);
    }
}

export class Target extends NovelArchive {}
