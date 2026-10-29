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

import { htmlChapter, sequenceChapters, type ListedChapter } from "../lib/books";
import { SiteData } from "../lib/cache";
import { chapterDocument, cleanChapterHtml, load, text } from "../lib/html";
import { getJson, getText, requireOk, SourceError } from "../lib/http";
import { MirrorSet } from "../lib/mirrors";
import { FilterReader, multiSelect, searchForm, singleSelect, sortOf } from "../lib/search";
import type { HomeRow } from "../lib/sections";
import { HomeSource } from "../lib/source";
import { encodeQuery, withQuery } from "../lib/url";
import {
    BOOK_PATH,
    canonicalPath,
    CHAPTER_LIST_QUERY,
    CHAPTER_PATH,
    FILTER,
    homePathFor,
    MIRRORS,
    PROBE_MARKER,
    PROBE_PATH,
    routeFor,
    type TagLookup,
} from "./model";
import {
    NO_SEARCH_OPTIONS,
    parseBook,
    parseChapterPage,
    parseChapterRows,
    parseHomeRow,
    parseList,
    parseSearchOptions,
    redirectTarget,
    type ChapterRows,
} from "./parsers";

/** Chapter pages bounce through readnovel.site before landing; a loop would never end. */
const MAX_REDIRECTS = 3;

/** Row pages that only exist on the home page are cached so one home load serves both. */
const HOME_TTL_MS = 60_000;

/** Hidden boxes in chapter text that carry the site's watermark. */
const HIDDEN_BOXES = [
    ".nf-ads",
    "[hidden]",
    '[style*="display:none"]',
    '[style*="display: none"]',
    '[style*="font-size:0"]',
];

const WATERMARKS = [
    /novel\s*(fire|phoenix)\s*\.\s*(net|com)/i,
    /readnovel\s*\.\s*site/i,
    /\b(read|visit|find)\b.{0,40}\bnovel\s*(fire|phoenix)\b/i,
];

const NO_CHAPTER_TEXT = "The chapter page had no text. It may have moved or been removed.";

class NovelFire extends HomeSource {
    readonly info = {
        id: "mc.novelfire",
        name: "NovelFire",
        version: "1.0.0",
        description:
            "Translated Chinese, Japanese and English web novels from Novel Fire and its mirrors.",
        website: MIRRORS[0] ?? "https://novelfire.net",
        rating: CatalogRating.MIXED,
        supportedLanguages: ["en_US"],
        thumbnail: "NovelFire.png",
    };

    /** The site's sorts are read from its search form; see `getSortOptions`. */
    protected readonly sorts: SortOption[] = [];

    private readonly mirrors = new MirrorSet({
        builtIn: MIRRORS,
        probePath: PROBE_PATH,
        marker: PROBE_MARKER,
    });
    private readonly searchOptions = new SiteData("novelfire.search-adv", () =>
        this.mirrors.run(async (origin) =>
            parseSearchOptions(await getText(this.http, `${origin}/search-adv`)),
        ),
    );
    private homeCache: { origin: string; at: number; html: string } | undefined;

    protected rows(): HomeRow[] {
        return [
            {
                id: "recommends",
                title: "Recommends",
                style: SectionStyle.SimpleHeroPaged,
                load: () => this.homeRow(/^recommend/i),
            },
            {
                id: "ranking",
                title: "Ranking",
                style: SectionStyle.SimpleDoubleRow,
                load: () => this.list("/ranking", 1),
            },
            {
                id: "most-read",
                title: "Most Read",
                style: SectionStyle.SimpleSingleRow,
                load: () => this.list("/ranking/most-read", 1),
            },
            {
                id: "new-trend",
                title: "New Trend",
                style: SectionStyle.SimpleSingleRow,
                load: () => this.homeRow(/^new trend$/i),
            },
            {
                id: "user-rated",
                title: "User Rated",
                style: SectionStyle.DetailedSingleRowPaged,
                load: () => this.list("/ranking/ratings", 1),
            },
            {
                id: "latest",
                title: "Latest Novels",
                style: SectionStyle.SimpleSingleRow,
                load: (page) => this.list("/genre-all/sort-new/status-all/all-novel", page),
            },
            {
                id: "completed",
                title: "Completed Stories",
                style: SectionStyle.SimpleSingleRow,
                load: (page) =>
                    this.list("/genre-all/sort-popular/status-completed/all-novel", page),
            },
            {
                id: "updates",
                title: "Latest Chapters",
                style: SectionStyle.DetailedDoubleRowPaged,
                load: (page) => this.list("/latest-release-novels", page),
            },
        ];
    }

    async getPreferenceMenu(): Promise<Form> {
        return { sections: [await this.mirrors.section()] };
    }

    protected async find(request: SearchRequest): Promise<PagedSearchResult> {
        const page = request.page || 1;
        const query = request.query?.trim();

        if (query) {
            const path = withQuery("/search", {
                keyword: query,
                type: FilterReader.option(request, FILTER.searchIn) ?? "title",
                page: page > 1 ? page : undefined,
            });

            return this.list(path, 1);
        }

        // The site combines genres with a single mode (all, any or none), so an include list
        // and an exclude list cannot both apply; included genres take precedence.
        const genres = FilterReader.excludable(request, FILTER.genres);
        const excluding = genres.included.length === 0 && genres.excluded.length > 0;

        const [tags, excludedTags] = await Promise.all([
            this.tagIds(FilterReader.text(request, FILTER.tags)),
            this.tagIds(FilterReader.text(request, FILTER.excludedTags)),
        ]);
        const { sorts } = await this.searchOptions.getOr(NO_SEARCH_OPTIONS);

        const genreMatch = excluding
            ? "exclude"
            : (FilterReader.option(request, FILTER.genreMatch) ?? "and");

        // The fallbacks are the form's own "any" values, which it submits when nothing is picked.
        const params = encodeQuery({
            "country_id[]": FilterReader.options(request, FILTER.origin),
            ctgcon: genreMatch,
            "categories[]": excluding ? genres.excluded : genres.included,
            totalchapter: FilterReader.option(request, FILTER.chapters) ?? "0",
            ratcon: FilterReader.option(request, FILTER.ratingMatch) ?? "min",
            rating: FilterReader.option(request, FILTER.rating) ?? "0",
            // "Any status" must be sent as `-1`; without it the page lists nothing.
            status: FilterReader.option(request, FILTER.status) ?? "-1",
            sort: sortOf(request, sorts).id,
            tagcon: FilterReader.option(request, FILTER.tagMatch) ?? "and",
            "tags[]": tags,
            "tags_excluded[]": excludedTags,
            page: page > 1 ? page : undefined,
        });

        return this.list(`/search-adv?${params}`, 1);
    }

    /**
     * Typed tag names as the site's ids, through the lookup its own tag picker uses. An
     * exact name wins over the first suggestion, so "System" is not "System Administration".
     */
    private async tagIds(names: string | undefined): Promise<string[]> {
        const wanted = (names ?? "")
            .split(",")
            .map((n) => n.trim())
            .filter(Boolean);

        const ids = await Promise.all(wanted.map((name) => this.tagId(name)));

        return [...new Set(ids)];
    }

    private async tagId(name: string): Promise<string> {
        const found = await this.mirrors.run((origin) => {
            const url = withQuery(`${origin}/ajax/getTags`, { term: name });
            return getJson<TagLookup>(this.http, url);
        });

        const tags = found.data ?? [];
        const match = tags.find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? tags[0];
        if (!match) throw new SourceError(`Novel Fire has no tag named "${name}".`);

        return String(match.id);
    }

    override async getSortOptions(): Promise<SortOption[]> {
        const { sorts } = await this.searchOptions.getOr(NO_SEARCH_OPTIONS);

        return sorts;
    }

    async getSearchForm(): Promise<SearchForm> {
        const site = await this.searchOptions.getOr(NO_SEARCH_OPTIONS);

        return searchForm([
            SearchSortSection({
                footer: "Sorting and filters apply when the search text is empty.",
            }),
            SearchListSection({
                header: "Text Search",
                children: [
                    singleSelect({
                        id: FILTER.searchIn,
                        title: "Search In",
                        options: site.searchIn,
                    }),
                ],
            }),
            SearchListSection({
                header: "Filters",
                footer: "The site cannot include and exclude genres at once; included genres win.",
                children: [
                    SearchExcludableMultiPickerSheet({
                        id: FILTER.genres,
                        title: "Genres",
                        options: site.genres,
                    }),
                    singleSelect({
                        id: FILTER.genreMatch,
                        title: "Genre Match",
                        options: site.genreMatch,
                    }),
                    singleSelect({ id: FILTER.status, title: "Status", options: site.statuses }),
                    singleSelect({
                        id: FILTER.chapters,
                        title: "Chapters",
                        options: site.chapters,
                    }),
                    singleSelect({ id: FILTER.rating, title: "Rating", options: site.ratings }),
                    singleSelect({
                        id: FILTER.ratingMatch,
                        title: "Rating Is",
                        options: site.ratingMatch,
                    }),
                ],
            }),
            multiSelect({ id: FILTER.origin, title: "Origin", options: site.origins }),
            SearchListSection({
                header: "Tags",
                footer: "Tag names, separated by commas, as the site lists them — e.g. System, Weak to Strong.",
                children: [
                    SearchTextField({
                        id: FILTER.tags,
                        title: "Include Tags",
                        placeholder: "System, Weak to Strong",
                    }),
                    SearchTextField({
                        id: FILTER.excludedTags,
                        title: "Exclude Tags",
                        placeholder: "Harem",
                    }),
                    singleSelect({
                        id: FILTER.tagMatch,
                        title: "Tag Match",
                        options: site.tagMatch,
                    }),
                ],
            }),
        ]);
    }

    async getContent(contentId: string): Promise<Content> {
        const path = bookPath(contentId);

        const { content, postId, origin } = await this.mirrors.run(async (origin) => {
            const url = `${origin}${routeFor(origin, path)}`;
            const html = await getText(this.http, url);

            return { ...parseBook(html, origin, url), origin };
        });

        const chapters = await this.chapters(path, postId, origin);

        return { ...content, chapters };
    }

    async getChapterData(_contentId: string, chapterId: string): Promise<ChapterData> {
        if (!CHAPTER_PATH.test(chapterId)) {
            throw new SourceError("This chapter link is not a NovelFire chapter.");
        }

        return this.mirrors.run(async (origin) => {
            let url = `${origin}${routeFor(origin, chapterId)}`;

            for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
                const response = requireOk(await this.http.get(url), "Loading the chapter");
                const html = await response.text();
                const $ = load(html);

                const root = $("#content").first();
                if (root.length) {
                    const title = text($(".chapter-title").first()) || text($("title"));
                    const body = cleanChapterHtml($, root, {
                        baseUrl: response.url || url,
                        remove: HIDDEN_BOXES,
                        dropText: WATERMARKS,
                    });

                    return htmlChapter(response, chapterDocument(title, body));
                }

                // novelfire.net answers chapter URLs with a page that hands over to the current
                // chapter host through script, which the HTTP client cannot follow on its own.
                const next = redirectTarget(html);
                if (!next) break;

                url = next;
            }

            throw new SourceError(NO_CHAPTER_TEXT);
        });
    }

    private async chapters(
        path: string,
        postId: string | undefined,
        origin: string,
    ): Promise<Chapter[]> {
        let listed: ListedChapter[] = [];

        if (postId) {
            try {
                const url = `${origin}/ajax/listChapterDataAjax?${CHAPTER_LIST_QUERY}&post_id=${postId}`;
                const json = await this.http.get(url);
                if (json.ok) listed = parseChapterRows(await json.json<ChapterRows>(), path);
            } catch {
                // The paged list below covers a mirror without the endpoint.
            }
        }

        if (!listed.length) listed = await this.pagedChapters(path, origin);
        if (!listed.length) throw new SourceError("No chapters were found for this novel.");

        const linked = listed.map((c) => ({
            ...c,
            webUrl: `${origin}${routeFor(origin, c.chapterId)}`,
        }));

        return sequenceChapters(linked, "en_US");
    }

    /** Every page of `/chapters` (100 per page), fetched after the first reveals the count. */
    private async pagedChapters(path: string, origin: string): Promise<ListedChapter[]> {
        const base = `${origin}${routeFor(origin, path)}/chapters`;
        const first = parseChapterPage(await getText(this.http, base));

        const laterPages = Array.from({ length: first.lastPage - 1 }, (_, i) => i + 2);
        const rest = await Promise.all(
            laterPages.map(async (page) => {
                const html = await getText(this.http, `${base}?page=${page}`);
                return parseChapterPage(html).chapters;
            }),
        );

        const seen = new Set<string>();
        const chapters = [...first.chapters, ...rest.flat()];

        return chapters.filter((c) => !seen.has(c.chapterId) && seen.add(c.chapterId));
    }

    private async list(path: string, page: number): Promise<PagedSearchResult> {
        return this.mirrors.run(async (origin) => {
            const url = withQuery(`${origin}${path}`, { page: page > 1 ? page : undefined });
            return parseList(await getText(this.http, url), origin);
        });
    }

    private async homeRow(heading: RegExp): Promise<PagedSearchResult> {
        return this.mirrors.run(async (origin) => {
            const cached = this.homeCache;
            if (cached && cached.origin === origin && Date.now() - cached.at < HOME_TTL_MS) {
                return parseHomeRow(cached.html, origin, heading);
            }

            const html = await getText(this.http, `${origin}${homePathFor(origin)}`);
            this.homeCache = { origin, at: Date.now(), html };

            return parseHomeRow(html, origin, heading);
        });
    }
}

/** Accepts a stored path or a pasted link from any mirror. */
function bookPath(contentId: string): string {
    const path = canonicalPath(contentId);
    if (!BOOK_PATH.test(path)) throw new SourceError("This link is not a NovelFire novel.");

    return path;
}

export class Target extends NovelFire {}
