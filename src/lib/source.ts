/* SPDX-License-Identifier: GPL-3.0-or-later */

import type {
    Chapter,
    ChapterData,
    ChapterSource,
    Content,
    HttpClient,
    PageLink,
    PageLinkResolver,
    PageSection,
    PagedSearchResult,
    ResolvedPageSection,
    SearchRequest,
    SortOption,
    SourceConfig,
    SourceInfo,
} from "@mana-app/types";

import { createClient, type ClientOptions } from "./http";
import { sortOf } from "./search";
import { Home, type HomeRow } from "./sections";

/**
 * What every source here has in common. Method presence is how the app decides which
 * features a source offers, so only methods every subclass can back live here.
 */
export abstract class BookSource implements ChapterSource {
    abstract readonly info: SourceInfo;
    readonly config?: SourceConfig;
    protected abstract readonly sorts: SortOption[];
    /** Pacing for the site; a subclass overrides it where the site needs gentler requests. */
    protected readonly clientOptions: ClientOptions = {};

    private clients: { api?: HttpClient; files?: HttpClient } = {};

    /** Created on first use: `onEnvironmentLoaded` is not awaited before the first call. */
    protected get http(): HttpClient {
        this.clients.api ??= createClient(this.clientOptions);
        return this.clients.api;
    }

    /** Book files run to hundreds of megabytes; the API timeout would cut them off. */
    protected get downloads(): HttpClient {
        this.clients.files ??= createClient({ requests: 2, intervalMs: 1_000, timeoutMs: 300_000 });
        return this.clients.files;
    }

    abstract search(request: SearchRequest): Promise<PagedSearchResult>;
    abstract getContent(contentId: string): Promise<Content>;
    abstract getChapterData(
        contentId: string,
        chapterId: string,
        chapter?: Chapter,
    ): Promise<ChapterData>;

    async getSortOptions(): Promise<SortOption[]> {
        return this.sorts;
    }

    // No `getChapters` here: a source that returns chapters with `getContent` leaves it out,
    // which is how the app learns that (the `chaptersInContent` intent) and reads them from
    // the content instead. Only a source that lists chapters separately defines it.

    protected sortOf(request: SearchRequest): { id: string; ascending: boolean } {
        return sortOf(request, this.sorts);
    }
}

/**
 * A source with a home page. Its rows double as "View more" lists, so `search` answers
 * those first and hands everything else to `find`.
 */
export abstract class HomeSource extends BookSource implements PageLinkResolver {
    protected abstract rows(): HomeRow[] | Promise<HomeRow[]>;
    protected abstract find(request: SearchRequest): Promise<PagedSearchResult>;

    private readonly home = new Home(() => this.rows());

    async getSectionsForPage(_link: PageLink): Promise<PageSection[]> {
        return this.home.sections();
    }

    async resolvePageSection(_link: PageLink, sectionId: string): Promise<ResolvedPageSection> {
        return this.home.resolve(sectionId);
    }

    async search(request: SearchRequest): Promise<PagedSearchResult> {
        return (await this.home.list(request)) ?? this.find(request);
    }
}
