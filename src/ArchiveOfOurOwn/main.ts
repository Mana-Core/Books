/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    Body,
    CatalogRating,
    HttpMethod,
    OutcomeKind,
    SearchListSection,
    SearchSortSection,
    SearchTextField,
    SearchToggle,
    SectionStyle,
    type BasicURL,
    type BooleanState,
    type Chapter,
    type ChapterData,
    type Content,
    type Form,
    type HttpClient,
    type HttpResponse,
    type PagedSearchResult,
    type SearchForm,
    type SearchRequest,
    type SortOption,
    type User,
    type WebViewAuthenticatable,
} from "@mana-app/types";

import { htmlChapter, sequenceChapters } from "../lib/books";
import { SiteData } from "../lib/cache";
import { chapterDocument } from "../lib/html";
import { SourceError, type ClientOptions } from "../lib/http";
import { FilterReader, multiSelect, searchForm, singleSelect, sortOf } from "../lib/search";
import type { HomeRow } from "../lib/sections";
import { Preferences, readingSection } from "../lib/settings";
import { HomeSource } from "../lib/source";
import { withQuery, type Query } from "../lib/url";
import { BASE_URL, FILTER, UPDATED } from "./model";
import {
    csrfToken,
    parseChapter,
    parseGreeting,
    parseNavigate,
    parseSearch,
    parseSearchForm,
    parseWork,
    type SearchFormLists,
} from "./parsers";

const NO_LISTS: SearchFormLists = {
    ratings: [],
    warnings: [],
    categories: [],
    completion: [],
    crossover: [],
    languages: [],
    sorts: [],
};

/**
 * Cloudflare answers 520–525 when it cannot reach AO3's origin, which happens in bursts
 * that a short retry usually rides out. A 429 is never retried: AO3 throttles per IP for
 * minutes, and retrying only extends the penalty.
 */
const TRANSIENT = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525]);

const RATE_LIMITED = "AO3 is limiting requests from this device. Wait a few minutes and try again.";

const SIGN_IN_REQUIRED =
    "This work is only visible to signed-in AO3 users. Sign in from the source's settings.";

class ArchiveOfOurOwn extends HomeSource implements WebViewAuthenticatable {
    readonly info = {
        id: "mc.archiveofourown",
        name: "ArchiveOfOurOwn",
        version: "1.0.0",
        description:
            "Archive of Our Own (AO3): millions of fan works, searchable by fandom, tag, rating and more.",
        website: BASE_URL,
        rating: CatalogRating.MIXED,
        supportedLanguages: ["en_US"],
        thumbnail: "ArchiveOfOurOwn.png",
    };

    /** The sorts come from the site's search form; see `getSortOptions`. */
    protected readonly sorts: SortOption[] = [];

    // AO3 starts answering 429 well below one request a second from one client.
    protected override readonly clientOptions: ClientOptions = {
        requests: 1,
        intervalMs: 1_500,
        timeoutMs: 60_000,
    };

    private readonly prefs = new Preferences({ notes: false });
    private client?: HttpClient;

    /** Every list of the search form, from one page that AO3 is often slow to serve. */
    private readonly formLists = new SiteData("archiveofourown.search-form", async () => {
        const html = await this.page(`${BASE_URL}/works/search`);

        return parseSearchForm(html);
    });

    protected override get http(): HttpClient {
        this.client ??= super.http.setRetry({
            maxRetries: 5,
            shouldRetry: ({ request, outcome }) =>
                request.method === HttpMethod.Get &&
                (outcome.kind === OutcomeKind.Error || TRANSIENT.has(outcome.status)),
        });

        return this.client;
    }

    protected rows(): HomeRow[] {
        return [
            {
                id: "kudos-recent",
                title: "Most Kudos This Month",
                style: SectionStyle.DetailedSingleRowPaged,
                load: (page) => this.list({ revised_at: "< 1 month" }, page, "kudos_count"),
            },
            {
                id: "updated",
                title: "Recently Updated",
                style: SectionStyle.DetailedDoubleRowPaged,
                load: (page) => this.list({}, page, "revised_at"),
            },
            {
                id: "complete-popular",
                title: "Popular Completed Works",
                style: SectionStyle.DetailedSingleRowPaged,
                load: (page) => this.list({ complete: "T" }, page, "kudos_count"),
            },
            {
                id: "hits-recent",
                title: "Most Read This Week",
                style: SectionStyle.DetailedDoubleRowPaged,
                load: (page) => this.list({ revised_at: "< 1 week" }, page, "hits"),
            },
        ];
    }

    protected async find(request: SearchRequest): Promise<PagedSearchResult> {
        const option = (id: string) => FilterReader.option(request, id);
        const text = (id: string) => FilterReader.text(request, id);

        // otwarchive's range syntax: a typed minimum of 1000 becomes "> 999".
        const atLeast = (id: string) => {
            const value = FilterReader.integer(request, id);

            return value ? `> ${value - 1}` : undefined;
        };

        const singleChapter = FilterReader.toggle(request, FILTER.singleChapter);
        const { sorts } = await this.formLists.getOr(NO_LISTS);
        const sort = sortOf(request, sorts);

        return this.list(
            {
                query: request.query?.trim(),
                rating_ids: option(FILTER.rating),
                archive_warning_ids: FilterReader.options(request, FILTER.warnings),
                category_ids: FilterReader.options(request, FILTER.categories),
                complete: option(FILTER.complete),
                crossover: option(FILTER.crossover),
                language_id: option(FILTER.language),
                words_from: FilterReader.integer(request, FILTER.wordsFrom),
                words_to: FilterReader.integer(request, FILTER.wordsTo),
                fandom_names: text(FILTER.fandoms),
                other_tag_names: text(FILTER.includeTags),
                excluded_tag_names: text(FILTER.excludeTags),
                title: text(FILTER.title),
                creators: text(FILTER.creators),
                character_names: text(FILTER.characters),
                relationship_names: text(FILTER.relationships),
                freeform_names: text(FILTER.freeforms),
                revised_at: option(FILTER.updated),
                single_chapter: singleChapter ? "1" : undefined,
                kudos_count: atLeast(FILTER.kudos),
                hits: atLeast(FILTER.hits),
                bookmarks_count: atLeast(FILTER.bookmarks),
                comments_count: atLeast(FILTER.comments),
            },
            request.page || 1,
            sort.id,
            sort.ascending,
        );
    }

    override async getSortOptions(): Promise<SortOption[]> {
        const { sorts } = await this.formLists.getOr(NO_LISTS);

        return sorts;
    }

    async getSearchForm(): Promise<SearchForm> {
        const lists = await this.formLists.getOr(NO_LISTS);

        return searchForm([
            SearchSortSection(),
            SearchListSection({
                header: "Work",
                children: [
                    singleSelect({ id: FILTER.rating, title: "Rating", options: lists.ratings }),
                    singleSelect({
                        id: FILTER.complete,
                        title: "Completion",
                        options: lists.completion,
                    }),
                    singleSelect({
                        id: FILTER.crossover,
                        title: "Crossovers",
                        options: lists.crossover,
                    }),
                    singleSelect({
                        id: FILTER.language,
                        title: "Language",
                        options: lists.languages,
                    }),
                    singleSelect({ id: FILTER.updated, title: "Updated", options: UPDATED }),
                    SearchToggle({ id: FILTER.singleChapter, title: "Single Chapter Only" }),
                ],
            }),
            multiSelect({
                id: FILTER.warnings,
                title: "Archive Warnings",
                options: lists.warnings,
            }),
            multiSelect({ id: FILTER.categories, title: "Categories", options: lists.categories }),
            SearchListSection({
                header: "Work Info",
                children: [
                    SearchTextField({
                        id: FILTER.title,
                        title: "Title",
                        placeholder: "A Study in Pink",
                    }),
                    SearchTextField({
                        id: FILTER.creators,
                        title: "Creators",
                        placeholder: "username",
                    }),
                ],
            }),
            SearchListSection({
                header: "Minimum Stats",
                children: [
                    SearchTextField({ id: FILTER.kudos, title: "Kudos", placeholder: "e.g. 1000" }),
                    SearchTextField({ id: FILTER.hits, title: "Hits", placeholder: "e.g. 10000" }),
                    SearchTextField({
                        id: FILTER.bookmarks,
                        title: "Bookmarks",
                        placeholder: "e.g. 100",
                    }),
                    SearchTextField({
                        id: FILTER.comments,
                        title: "Comments",
                        placeholder: "e.g. 50",
                    }),
                ],
            }),
            SearchListSection({
                header: "Word Count",
                children: [
                    SearchTextField({
                        id: FILTER.wordsFrom,
                        title: "From",
                        placeholder: "e.g. 10000",
                    }),
                    SearchTextField({
                        id: FILTER.wordsTo,
                        title: "To",
                        placeholder: "e.g. 100000",
                    }),
                ],
            }),
            SearchListSection({
                header: "Tags",
                footer: 'Separate tags with commas. Tag names must match AO3\'s canonical tags, e.g. "Alternate Universe - Coffee Shops & Cafés".',
                children: [
                    SearchTextField({
                        id: FILTER.fandoms,
                        title: "Fandoms",
                        placeholder: "Sherlock (TV)",
                    }),
                    SearchTextField({
                        id: FILTER.characters,
                        title: "Characters",
                        placeholder: "Sherlock Holmes",
                    }),
                    SearchTextField({
                        id: FILTER.relationships,
                        title: "Relationships",
                        placeholder: "Sherlock Holmes/John Watson",
                    }),
                    SearchTextField({
                        id: FILTER.freeforms,
                        title: "Additional Tags",
                        placeholder: "Fluff",
                    }),
                    SearchTextField({
                        id: FILTER.includeTags,
                        title: "Include Tags",
                        placeholder: "Fluff, Hurt/Comfort",
                    }),
                    SearchTextField({
                        id: FILTER.excludeTags,
                        title: "Exclude Tags",
                        placeholder: "Major Character Death",
                    }),
                ],
            }),
        ]);
    }

    async getPreferenceMenu(): Promise<Form> {
        const notes = await this.prefs.toggle("notes", "Include author notes");
        const reading = readingSection([notes]);

        return { sections: [reading] };
    }

    async getContent(contentId: string): Promise<Content> {
        const id = workId(contentId);

        const html = await this.workPage(id);
        const { content, language } = parseWork(html, id);
        const chapters = await this.chapters(id, language);

        return { ...content, chapters };
    }

    async getChapterData(_contentId: string, chapterId: string): Promise<ChapterData> {
        const url = `${BASE_URL}${chapterId}`;
        const response = await this.load(url, { view_adult: "true" });

        const includeNotes = await this.prefs.get("notes");

        const html = await response.text();
        const { title, body } = parseChapter(html, { url, includeNotes });

        return htmlChapter(response, chapterDocument(title, body));
    }

    // MARK: Authentication

    async getWebAuthRequestURL(): Promise<BasicURL> {
        return { url: `${BASE_URL}/users/login` };
    }

    /**
     * Every visitor gets `_otwarchive_session`, so it says nothing about a login.
     * `user_credentials` exists only while `logged_in?` is true (AO3's nginx uses it to bypass
     * the anonymous page cache); `remember_user_token` only when "Remember me" was ticked.
     */
    async didReceiveSessionCookieFromWebAuthResponse(name: string): Promise<BooleanState> {
        return { state: name === "user_credentials" };
    }

    async getAuthenticatedUser(): Promise<User | null> {
        const html = await this.page(`${BASE_URL}/`);

        return parseGreeting(html);
    }

    /**
     * Devise signs out on DELETE /users/logout with the page's CSRF token; Rails reads the
     * verb from `_method` on a form POST. The app clears the cookies itself afterwards, so a
     * failed request here still leaves the user signed out locally.
     */
    async handleUserSignOut(): Promise<void> {
        try {
            const home = await this.page(`${BASE_URL}/`);
            const token = csrfToken(home);
            if (!token) return;

            const body = Body.form({ _method: "delete", authenticity_token: token });

            await this.http.post(`${BASE_URL}/users/logout`, body, {
                headers: { Referer: `${BASE_URL}/` },
            });
        } catch {
            // Signing out locally must not fail because the site is unreachable.
        }
    }

    // MARK: Helpers

    private async chapters(id: string, language: string): Promise<Chapter[]> {
        const html = await this.page(`${BASE_URL}/works/${id}/navigate`, { view_adult: "true" });
        const listed = parseNavigate(html, id);

        if (listed.length > 1) return sequenceChapters(listed, language);

        // A one-chapter work reads in full from the work page itself, which also carries the
        // work-level notes that a lone chapter page leaves out.
        const only = listed[0];
        const whole = {
            chapterId: `/works/${id}`,
            title: only?.title ?? "Chapter 1",
            date: only?.date,
            webUrl: `${BASE_URL}/works/${id}`,
        };

        return sequenceChapters([whole], language);
    }

    /** `fields` are `work_search[…]` names; an array goes out as `name[]`. */
    private async list(
        fields: Query,
        page: number,
        sort: string,
        ascending = false,
    ): Promise<PagedSearchResult> {
        const all: Query = {
            ...fields,
            sort_column: sort,
            sort_direction: ascending ? "asc" : "desc",
        };

        const params: Query = {};
        for (const [name, value] of Object.entries(all)) {
            const key = Array.isArray(value) ? `work_search[${name}][]` : `work_search[${name}]`;
            params[key] = value;
        }
        params.page = page > 1 ? page : undefined;

        const html = await this.page(`${BASE_URL}/works/search`, params);

        return parseSearch(html);
    }

    /**
     * A multi-chapter work 302s to its first chapter without carrying `view_adult` along.
     * The `view_adult` cookie normally covers that hop, but where it is lost the adult-content
     * interstitial comes back instead, so the landing page is asked again.
     */
    private async workPage(id: string): Promise<string> {
        const response = await this.load(`${BASE_URL}/works/${id}`, { view_adult: "true" });
        const html = await response.text();

        const isWork = html.includes('class="work meta group"');
        const redirected = response.url.includes("/chapters/");
        if (isWork || !redirected) return html;

        return this.page(response.url.replace(/[?#].*$/, ""), { view_adult: "true" });
    }

    private async page(url: string, params?: Query): Promise<string> {
        const response = await this.load(url, params);

        return response.text();
    }

    private async load(url: string, params?: Query): Promise<HttpResponse> {
        const response = await this.http.get(withQuery(url, params));
        const { status } = response;

        if (status === 429) throw new SourceError(RATE_LIMITED, 429);

        if (status === 404) {
            throw new SourceError("This work was deleted or never existed.", 404);
        }

        if (status >= 520 && status <= 527) {
            const message = `AO3 is not reachable right now (HTTP ${status}). Try again shortly.`;
            throw new SourceError(message, status);
        }

        if (!response.ok) throw new SourceError(`AO3 answered HTTP ${status}.`, status);

        // Restricted works redirect anonymous visitors to the login form.
        const login = /\/users\/login/;
        if (login.test(response.url) && !login.test(url)) {
            throw new SourceError(SIGN_IN_REQUIRED, 401);
        }

        return response;
    }
}

/** Library entries store the bare work id; a pasted path or URL is accepted too. */
function workId(contentId: string): string {
    return /(?:^|\/works\/)(\d+)/.exec(contentId)?.[1] ?? contentId;
}

export class Target extends ArchiveOfOurOwn {}
