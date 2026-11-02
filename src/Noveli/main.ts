/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    CatalogRating,
    SearchListSection,
    SearchSortSection,
    SearchTextField,
    type ChapterData,
    type Content,
    type Option,
    type PagedSearchResult,
    type SearchForm,
    type SearchRequest,
    type Chapter,
} from "@mana-app/types";

import { htmlChapter, sequenceChapters } from "../lib/books";
import { SiteData } from "../lib/cache";
import { chapterDocument } from "../lib/html";
import { getJson, SourceError, type ClientOptions } from "../lib/http";
import { FilterReader, multiSelect, searchForm, singleSelect } from "../lib/search";
import type { HomeRow } from "../lib/sections";
import { HomeSource } from "../lib/source";
import { pathOf, withQuery, type Query } from "../lib/url";
import {
    API_URL,
    BASE_URL,
    FILTER,
    HOME_ROWS,
    NOVEL_PATH,
    PAGE_SIZE,
    SORTS,
    STATUSES,
    type ChapterDetailResponse,
    type ChapterListResponse,
    type NovelDetailResponse,
    type NovelListResponse,
    type TagListResponse,
} from "./model";
import { parseChapter, parseChapters, parseDetail, parseList } from "./parsers";

const NOT_FOUND = "Noveli has no novel at this address.";

type TagOptions = Option[];

class Noveli extends HomeSource {
    readonly info = {
        id: "mc.noveli",
        name: "Noveli",
        version: "1.0.0",
        description:
            "Web novels and light novels from Noveli.to, with its genre and status filters.",
        website: BASE_URL,
        rating: CatalogRating.MIXED,
        supportedLanguages: ["en_US"],
        thumbnail: "Noveli.png",
    };

    protected readonly sorts = SORTS;
    protected override readonly clientOptions: ClientOptions = { requests: 2 };

    private readonly tags = new SiteData("noveli.tags", async (): Promise<TagOptions> => {
        const json = await getJson<TagListResponse>(this.http, `${API_URL}/novels/tags`);
        return (json.tags ?? []).map((name) => ({ id: name, title: name }));
    });

    protected rows(): HomeRow[] {
        return HOME_ROWS.map((row) => ({
            id: row.id,
            title: row.title,
            style: row.style,
            load: (page) => this.list({ sort: row.sort, status: row.status }, page),
        }));
    }

    protected async find(request: SearchRequest): Promise<PagedSearchResult> {
        const genres = FilterReader.excludable(request, FILTER.genres);

        return this.list(
            {
                search: request.query?.trim() || undefined,
                genres: joined(genres.included),
                exclude_genres: joined(genres.excluded),
                status: FilterReader.option(request, FILTER.status),
                minChapters: FilterReader.integer(request, FILTER.minChapters),
                maxChapters: FilterReader.integer(request, FILTER.maxChapters),
                sort: this.sortOf(request).id,
            },
            request.page || 1,
        );
    }

    async getSearchForm(): Promise<SearchForm> {
        const tags = await this.tags.getOr([]);

        return searchForm([
            SearchSortSection(),
            SearchListSection({
                header: "Filters",
                children: [singleSelect({ id: FILTER.status, title: "Status", options: STATUSES })],
            }),
            multiSelect({
                id: FILTER.genres,
                title: "Genres & Tags",
                options: tags,
                excludable: true,
                footer: "A novel must have every included genre or tag. Excluded ones are left out.",
            }),
            SearchListSection({
                header: "Chapters",
                footer: "Whole numbers. Leave a field empty to leave that end open.",
                children: [
                    SearchTextField({
                        id: FILTER.minChapters,
                        title: "Minimum",
                        placeholder: "100",
                    }),
                    SearchTextField({
                        id: FILTER.maxChapters,
                        title: "Maximum",
                        placeholder: "500",
                    }),
                ],
            }),
        ]);
    }

    async getContent(contentId: string): Promise<Content> {
        const path = pathOf(contentId);
        if (!NOVEL_PATH.test(path)) throw new SourceError("This link is not a Noveli novel.");

        const slug = path.slice("/novel/".length);
        const detail = await this.api<NovelDetailResponse>(`/novels/${encodeURIComponent(slug)}`);
        const content = parseDetail(detail ?? {}, slug);

        const novelId = detail?.data?.id;
        if (novelId === undefined) throw new SourceError(NOT_FOUND, 404);

        const list = await this.api<ChapterListResponse>(`/novels/${novelId}/chapters`);
        const listed = parseChapters(list ?? { success: false }, novelId);
        if (!listed.length) throw new SourceError("No chapters were found for this novel.");

        return { ...content, chapters: sequenceChapters(listed, "en_US") };
    }

    async getChapterData(
        _contentId: string,
        chapterId: string,
        chapter?: Chapter,
    ): Promise<ChapterData> {
        const [, novelId, id] = /^\/read\/(\d+)\/(\d+)$/.exec(pathOf(chapterId)) ?? [];
        if (!novelId || !id) throw new SourceError("This link is not a Noveli chapter.");

        const response = await this.http.get(`${API_URL}/novels/${novelId}/chapters/${id}`, {
            headers: { Referer: `${BASE_URL}/read/${novelId}/${id}` },
        });
        if (response.status === 404) throw new SourceError(NOT_FOUND, 404);
        if (!response.ok) {
            throw new SourceError(
                `Noveli did not answer (HTTP ${response.status}).`,
                response.status,
            );
        }

        const detail = (await response.json<ChapterDetailResponse>()).chapter;
        if (!detail) throw new SourceError(NOT_FOUND, 404);

        const body = parseChapter(detail);
        if (!body) throw new SourceError("This chapter has no readable text.");

        return htmlChapter(response, chapterDocument(detail.title ?? chapter?.title ?? "", body));
    }

    private async list(params: Query, page: number): Promise<PagedSearchResult> {
        const json = await this.api<NovelListResponse>("/novels", {
            ...params,
            page,
            limit: PAGE_SIZE,
        });

        return parseList(json ?? { success: false }, page);
    }

    private async api<T extends object>(path: string, params?: Query): Promise<T | undefined> {
        const response = await this.http.get(withQuery(`${API_URL}${path}`, params));

        if (response.status === 404) return undefined;
        if (!response.ok) {
            throw new SourceError(
                `Noveli did not answer (HTTP ${response.status}).`,
                response.status,
            );
        }

        return response.json<T>();
    }
}

function joined(values: string[]): string | undefined {
    return values.length ? values.join(",") : undefined;
}

export class Target extends Noveli { }
