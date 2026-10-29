/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    BasicAuthenticationUIIdentifier,
    Body,
    CatalogRating,
    SearchListSection,
    SearchSortSection,
    SearchToggle,
    SectionStyle,
    type ChapterData,
    type Content,
    type PagedSearchResult,
    type SearchForm,
    type SearchRequest,
    type User,
} from "@mana-app/types";

import { htmlChapter } from "../lib/books";
import { chapterDocument, cleanChapterHtml, load, text } from "../lib/html";
import { SourceError, getJson, requireOk } from "../lib/http";
import { FilterReader, multiSelect, searchForm, singleSelect } from "../lib/search";
import type { HomeRow } from "../lib/sections";
import { HomeSource } from "../lib/source";
import { Catalogue, type Filters } from "./catalogue";
import {
    BASE_URL,
    FILTER,
    PAGE_SIZE,
    SORTS,
    TRANSLATIONS,
    TYPES,
    type CsrfResponse,
    type PicksResponse,
    type RecentResponse,
    type SeriesResponse,
    type SessionResponse,
    type TrendingResponse,
} from "./model";
import { fileUrl, plural, readUrl, toChapters, toContent, toHighlight } from "./parsers";

const SIGN_IN_REQUIRED =
    "Cyrisia only lets signed-in accounts download light novel volumes. " +
    "Sign in under the source's Account row (a free Cyrisia account works).";

class Cyrisia extends HomeSource {
    readonly info = {
        id: "mc.cyrisia",
        name: "Cyrisia",
        version: "1.0.0",
        description:
            "Official light novel EPUBs and translated web novels from cyrisia.com, no account needed.",
        website: BASE_URL,
        rating: CatalogRating.MIXED,
        supportedLanguages: ["en_US"],
        thumbnail: "Cyrisia.png",
    };

    protected readonly sorts = SORTS;

    // The bookshelf is about 9 MB; the default timeout would cut it off.
    protected override readonly clientOptions = { timeoutMs: 60_000 };

    // Sign-in asks for an email; the site's login field takes a username too.
    readonly BasicAuthenticationUIIdentifier = BasicAuthenticationUIIdentifier.EMAIL;

    private readonly catalogue = new Catalogue(() => this.http);

    // MARK: Home and search

    protected rows(): HomeRow[] {
        return [
            {
                id: "picks",
                title: "Monthly Picks",
                style: SectionStyle.SimpleHeroPaged,
                load: () => this.picks(),
            },
            {
                id: "trending",
                title: "Trending This Month",
                style: SectionStyle.SimpleDoubleRow,
                load: () => this.trending(),
            },
            {
                id: "recent-ln",
                title: "New Light Novel Volumes",
                style: SectionStyle.DetailedDoubleRowPaged,
                load: () => this.recent("ln", "volume"),
            },
            {
                id: "recent-wn",
                title: "New Web Novel Chapters",
                style: SectionStyle.DetailedDoubleRowPaged,
                load: () => this.recent("webnovel", "chapter"),
            },
            {
                id: "popular-ln",
                title: "Popular Light Novels",
                style: SectionStyle.SimpleSingleRow,
                load: (page) => this.browse({ type: "ln" }, "popular", page),
            },
            {
                id: "popular-wn",
                title: "Popular Web Novels",
                style: SectionStyle.SimpleSingleRow,
                load: (page) => this.browse({ type: "webnovel" }, "popular", page),
            },
        ];
    }

    protected find(request: SearchRequest): Promise<PagedSearchResult> {
        const genres = FilterReader.excludable(request, FILTER.genres);
        const tags = FilterReader.excludable(request, FILTER.tags);

        const filters = {
            query: request.query?.trim(),
            type: FilterReader.option(request, FILTER.type),
            translation: FilterReader.option(request, FILTER.translation),
            include: [...genres.included, ...tags.included],
            exclude: [...genres.excluded, ...tags.excluded],
            hideMature: FilterReader.toggle(request, FILTER.hideMature),
        };

        return this.browse(filters, this.sortOf(request).id, request.page);
    }

    async getSearchForm(): Promise<SearchForm> {
        // In turn, not together: the tags reuse the catalogue the genres just loaded.
        const genres = await this.catalogue.genres();
        const tags = await this.catalogue.tags();

        return searchForm([
            SearchSortSection({
                footer: "With search text, the closest titles come first; the sort orders equal matches.",
            }),
            SearchListSection({
                children: [
                    singleSelect({ id: FILTER.type, title: "Type", options: TYPES }),
                    singleSelect({
                        id: FILTER.translation,
                        title: "Translation",
                        options: TRANSLATIONS,
                    }),
                    SearchToggle({ id: FILTER.hideMature, title: "Hide Mature Series" }),
                ],
            }),
            multiSelect({
                id: FILTER.genres,
                title: "Genres",
                options: genres,
                excludable: true,
                footer: "Included genres and tags must all match.",
            }),
            multiSelect({ id: FILTER.tags, title: "Tags", options: tags, excludable: true }),
        ]);
    }

    private async browse(
        filters: Partial<Filters>,
        sort: string,
        page = 1,
    ): Promise<PagedSearchResult> {
        const complete: Filters = { include: [], exclude: [], hideMature: false, ...filters };
        const found = await this.catalogue.find(complete, sort);

        const start = (Math.max(1, page) - 1) * PAGE_SIZE;
        const end = start + PAGE_SIZE;

        return {
            results: found.slice(start, end).map(toHighlight),
            isLastPage: end >= found.length,
            totalResultCount: found.length,
        };
    }

    private async trending(): Promise<PagedSearchResult> {
        const { trending = [] } = await this.api<TrendingResponse>("/api/trending-month");

        // The month's list runs to hundreds; a home row only needs its head.
        const names = trending.slice(0, 60).map((item) => item.series_name);

        return this.listed(names);
    }

    private async picks(): Promise<PagedSearchResult> {
        const { series = [] } = await this.api<PicksResponse>("/api/monthly-picks");

        return this.listed(series);
    }

    private async listed(names: string[]): Promise<PagedSearchResult> {
        const entries = await this.catalogue.named(names);

        return { results: entries.map(toHighlight), isLastPage: true };
    }

    private async recent(type: string, unit: string): Promise<PagedSearchResult> {
        const path = `/api/account/catalog/recent?days=60&limit=30&type=${type}`;
        const { series = [] } = await this.api<RecentResponse>(path);

        const added = new Map(series.map((item) => [item.name, item.added_volumes]));
        const entries = await this.catalogue.named(series.map((item) => item.name));

        const results = entries.map((entry) => ({
            ...toHighlight(entry),
            subtitle: plural(added.get(entry.name) ?? 0, `new ${unit}`),
        }));

        return { results, isLastPage: true };
    }

    // MARK: Content

    async getContent(contentId: string): Promise<Content> {
        const path = `/api/account/catalog/series/${encodeURIComponent(contentId)}`;
        const { series } = await this.api<SeriesResponse>(path);

        if (!series) throw new SourceError(`Cyrisia has no series named "${contentId}".`);

        return { ...toContent(series), chapters: toChapters(series) };
    }

    async getChapterData(contentId: string, chapterId: string): Promise<ChapterData> {
        if (/\.epub$/i.test(chapterId)) return this.book(contentId, chapterId);

        // Text chapters come rendered into the reader page, the way the site serves them.
        const url = readUrl(contentId, chapterId);
        const response = requireOk(await this.http.get(url), "Loading the chapter");
        const $ = load(await response.text());

        const body = $("#ch-text").first();
        if (!body.length) throw new SourceError("This chapter has no text on Cyrisia.");

        const title = text($("main h1").first()) || chapterId;
        const html = cleanChapterHtml($, body, { baseUrl: url });

        return htmlChapter(response, chapterDocument(title, html));
    }

    /**
     * Opens a volume the way the site's reader does for any visitor, signed in or not: the
     * reader page names the file in `<meta name="book-path">` (with the server's `?v=`
     * version) and fetches it from the page. A bare request for the file is what the site
     * refuses as a download.
     */
    private async book(series: string, file: string): Promise<ChapterData> {
        const reader = readUrl(series, file);
        const page = requireOk(await this.http.get(reader), "Opening the reader");
        const $ = load(await page.text());

        const path = $('meta[name="book-path"]').attr("content");
        const url = path ? `${BASE_URL}${path}` : fileUrl(series, file);

        const response = await this.downloads.get(url, {
            headers: {
                Referer: reader,
                "Sec-Fetch-Site": "same-origin",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Dest": "empty",
            },
        });

        if (response.status === 401 || response.status === 403) {
            const body = await response
                .json<{ error?: string }>()
                .catch(() => ({ error: undefined }));
            const reason = body.error;

            const message =
                !reason || reason === "auth_required"
                    ? SIGN_IN_REQUIRED
                    : `Cyrisia refused the download (${reason}).`;

            throw new SourceError(message, response.status);
        }

        return { document: requireOk(response, "Downloading the volume") };
    }

    // MARK: Account

    async handleBasicAuth(identifier: string, password: string): Promise<void> {
        const token = await this.csrf();

        const response = await this.http.post(
            `${BASE_URL}/api/account/login`,
            Body.json({ login: identifier.trim(), password }),
            { headers: { "x-csrf-token": token } },
        );

        const body = await response
            .json<{ ok?: boolean; error?: string }>()
            .catch(() => ({ ok: false, error: undefined }));

        if (response.ok && body.ok) return;

        const message = body.error
            ? `Cyrisia refused the sign-in: ${body.error.replace(/_/g, " ")}.`
            : `Signing in failed (HTTP ${response.status}).`;

        throw new SourceError(message, response.status);
    }

    async getAuthenticatedUser(): Promise<User | null> {
        const { user } = await this.api<SessionResponse>("/api/account/session");

        if (!user?.authenticated || !user.username) return null;

        return {
            handle: user.username,
            displayName: user.display_name || undefined,
            avatar: user.avatar_url || undefined,
        };
    }

    async handleUserSignOut(): Promise<void> {
        try {
            const token = await this.csrf();

            await this.http.post(`${BASE_URL}/api/account/logout`, undefined, {
                headers: { "x-csrf-token": token },
            });
        } catch {
            // Signing out locally must not fail because the site is unreachable.
        }
    }

    private async csrf(): Promise<string> {
        const { csrf } = await this.api<CsrfResponse>("/api/account/csrf");

        if (!csrf) {
            throw new SourceError("Cyrisia did not hand out a sign-in token. Try again shortly.");
        }

        return csrf;
    }

    private api<T>(path: string): Promise<T> {
        return getJson<T>(this.http, `${BASE_URL}${path}`);
    }
}

export class Target extends Cyrisia {}
