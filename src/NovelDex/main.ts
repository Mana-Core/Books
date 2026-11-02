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
} from "@mana-app/types";

import { SiteData } from "../lib/cache";
import { getJson, SourceError, type ClientOptions } from "../lib/http";
import { FilterReader, multiSelect, searchForm, singleSelect } from "../lib/search";
import type { HomeRow } from "../lib/sections";
import { HomeSource } from "../lib/source";
import { pathOf, withQuery, type Query } from "../lib/url";
import {
    BASE_URL,
    FILTER,
    HOME_ROWS,
    NOVEL_PATH,
    NOVEL_TYPES,
    ORIGINS,
    PAGE_SIZE,
    SORTS,
    STATUSES,
    type Facets,
    type SeriesPage,
} from "./model";
import { parseDetail, parseFacets, parseSeriesPage } from "./parsers";

/**
 * NovelDex serves each chapter's text encrypted and its DOM scrambled, with the key split
 * between the page and the client. The source does not decode that, so no chapter can be
 * read here; the reader is told why rather than shown an empty page.
 */
const CHAPTERS_UNREADABLE =
    "NovelDex sends its chapter text encrypted and scrambled for its own reader, so this source cannot show the chapters.";

const TAGS_UNAVAILABLE = "NovelDex's tag list could not be loaded to look up the tags you typed.";

type Facet = Facets["tags"][number];
type FacetLists = { genres: Option[]; tags: Facet[] };

const NO_FACETS: FacetLists = { genres: [], tags: [] };

class NovelDex extends HomeSource {
    readonly info = {
        id: "mc.noveldex",
        name: "NovelDex",
        version: "1.0.0",
        description: "Web novels and light novels from NovelDex, with its genre and tag filters.",
        website: BASE_URL,
        rating: CatalogRating.MIXED,
        supportedLanguages: ["en_US"],
        thumbnail: "NovelDex.png",
    };

    /** The site's sorts are the browse feed's own; see `SORTS`. */
    protected readonly sorts = SORTS;
    protected override readonly clientOptions: ClientOptions = { requests: 2 };

    /** The genre and tag lists the site's browse page reads, cached so a search form opens quickly. */
    private readonly facets = new SiteData(
        "noveldex.facets",
        async (): Promise<FacetLists> =>
            parseFacets(await getJson<Facets>(this.http, `${BASE_URL}/api/series/facets`)),
    );

    protected rows(): HomeRow[] {
        return HOME_ROWS.map((row) => ({
            id: row.id,
            title: row.title,
            style: row.style,
            load: (page) => this.feed({ sort: row.sort, status: row.status }, page),
        }));
    }

    protected async find(request: SearchRequest): Promise<PagedSearchResult> {
        const facets = await this.facets.getOr(NO_FACETS);
        const genres = FilterReader.excludable(request, FILTER.genres);

        return this.feed(
            {
                q: request.query?.trim() || undefined,
                status: FilterReader.option(request, FILTER.status),
                origin: joined(FilterReader.options(request, FILTER.origins)),
                type: joined(FilterReader.options(request, FILTER.types)),
                // A comma list means every genre must match; the site has no "any" mode.
                genre: joined(genres.included),
                exgenre: joined(genres.excluded),
                tag: joined(this.tagSlugs(FilterReader.text(request, FILTER.tags), facets)),
                extag: joined(
                    this.tagSlugs(FilterReader.text(request, FILTER.excludedTags), facets),
                ),
                sort: this.sortOf(request).id,
            },
            request.page || 1,
        );
    }

    async getSearchForm(): Promise<SearchForm> {
        const facets = await this.facets.getOr(NO_FACETS);

        return searchForm([
            SearchSortSection(),
            SearchListSection({
                header: "Filters",
                children: [singleSelect({ id: FILTER.status, title: "Status", options: STATUSES })],
            }),
            multiSelect({ id: FILTER.origins, title: "Origin", options: ORIGINS }),
            multiSelect({ id: FILTER.types, title: "Type", options: NOVEL_TYPES }),
            multiSelect({
                id: FILTER.genres,
                title: "Genres",
                options: facets.genres,
                excludable: true,
                footer: "A novel must have every included genre. Excluded genres are left out.",
            }),
            SearchListSection({
                header: "Tags",
                footer: "Tag names, separated by commas, as the site lists them, e.g. Weak to Strong.",
                children: [
                    SearchTextField({
                        id: FILTER.tags,
                        title: "Include Tags",
                        placeholder: "Weak to Strong",
                    }),
                    SearchTextField({
                        id: FILTER.excludedTags,
                        title: "Exclude Tags",
                        placeholder: "Harem",
                    }),
                ],
            }),
        ]);
    }

    async getContent(contentId: string): Promise<Content> {
        const path = pathOf(contentId);
        if (!NOVEL_PATH.test(path)) throw new SourceError("This link is not a NovelDex novel.");

        const response = await this.http.get(`${BASE_URL}${path}`);
        if (response.status === 404) {
            throw new SourceError("NovelDex has no novel at this address.", 404);
        }
        if (!response.ok) {
            throw new SourceError(`Loading the novel failed (HTTP ${response.status}).`);
        }

        return parseDetail(await response.text(), path);
    }

    async getChapterData(_contentId: string, _chapterId: string): Promise<ChapterData> {
        throw new SourceError(CHAPTERS_UNREADABLE);
    }

    private async feed(params: Query, page: number): Promise<PagedSearchResult> {
        const url = withQuery(`${BASE_URL}/api/series`, {
            ...params,
            contentMode: "novels",
            page,
            limit: PAGE_SIZE,
        });

        return parseSeriesPage(await getJson<SeriesPage>(this.http, url));
    }

    /** Typed tag names as the site's slugs. An exact name wins, so "Harem" is not "Harem Ending". */
    private tagSlugs(names: string | undefined, facets: FacetLists): string[] {
        const wanted = (names ?? "")
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean);
        if (!wanted.length) return [];
        if (!facets.tags.length) throw new SourceError(TAGS_UNAVAILABLE);

        return wanted.map((name) => {
            const match = facets.tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
            if (!match) throw new SourceError(`NovelDex has no tag named "${name}".`);

            return match.slug;
        });
    }
}

/** A list as the comma-separated value the site reads, or nothing when it is empty. */
function joined(values: string[]): string | undefined {
    return values.length ? values.join(",") : undefined;
}

export class Target extends NovelDex {}
