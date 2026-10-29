/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    Body,
    CatalogRating,
    CloudflareError,
    SearchSortSection,
    SectionStyle,
    UIListSection,
    type ChapterData,
    type Content,
    type Form,
    type PagedSearchResult,
    type Option,
    type SearchForm,
    type SearchRequest,
    type SortOption,
} from "@mana-app/types";

import { fileChapter, fileChapters } from "../lib/books";
import { SiteData } from "../lib/cache";
import { isBrowserCheck, isHostFailure, SourceError, type ClientOptions } from "../lib/http";
import { MirrorSet } from "../lib/mirrors";
import { FilterReader, multiSelect, searchForm, sortOf } from "../lib/search";
import type { HomeRow } from "../lib/sections";
import { Secrets } from "../lib/settings";
import { HomeSource } from "../lib/source";
import { withQuery, type Query } from "../lib/url";
import {
    FILTER,
    KEY_QUOTA,
    KEY_SECRET,
    LAST_PAGE,
    LIBGEN_MIRRORS,
    MIRRORS,
    PROBE_MARKER,
    PROBE_PATH,
    RELEVANCE,
    SUMMARY_MD5,
} from "./model";
import {
    libgenLink,
    MD5,
    parseRecord,
    parseSearch,
    parseSearchForm,
    refusalReason,
    type SearchFormData,
} from "./parsers";

type FastDownload = {
    download_url?: string | null;
    error?: string;
    account_fast_download_info?: { downloads_left?: number; downloads_per_day?: number };
};

type AccountSummary = { downloads_left?: number; is_member?: number };
const FILE_TIMEOUT_MS = 180_000;
const FORM_PAGE_MS = 60_000;

class AnnasArchive extends HomeSource {
    readonly info = {
        id: "mc.annas-archive",
        name: "AnnasArchive",
        version: "1.0.1",
        description:
            "Search engine over LibGen, Z-Library, Sci-Hub and more; reads EPUB and PDF files.",
        website: MIRRORS[0] as string,
        rating: CatalogRating.MIXED,
        supportedLanguages: [
            "en_US",
            "de_DE",
            "fr_FR",
            "es_ES",
            "it_IT",
            "pt_BR",
            "ru_RU",
            "zh-CN",
            "ja_JP",
        ],
        thumbnail: "AnnasArchive.png",
    };

    protected readonly sorts = [RELEVANCE];
    protected override readonly clientOptions: ClientOptions = { requests: 2 };

    private readonly mirrors = new MirrorSet({
        builtIn: MIRRORS,
        probePath: PROBE_PATH,
        marker: PROBE_MARKER,
    });

    private readonly signedIn = new Map<string, string>();

    private formPage: { at: number; data: Promise<SearchFormData> } | undefined;

    private readonly siteSorts = new SiteData("annas.sorts", async () =>
        nonEmpty((await this.searchFormData()).sorts),
    );

    private readonly facets = {
        ext: this.facet(FILTER.ext),
        content: this.facet(FILTER.content),
        lang: this.facet(FILTER.lang),
        acc: this.facet(FILTER.acc),
        src: this.facet(FILTER.src),
    };

    async getPreferenceMenu(): Promise<Form> {
        const key = await Secrets.get(KEY_SECRET);

        const mirrors = await this.mirrors.section();
        const footer = key ? await this.accountStatus() : NO_KEY_FOOTER;
        const keyField = await Secrets.field(
            KEY_SECRET,
            "Member Key",
            "Secret key from your account page",
        );

        const membership = UIListSection({ header: "Membership", footer, children: [keyField] });

        return { sections: [mirrors, membership] };
    }

    override async getSortOptions(): Promise<SortOption[]> {
        return this.siteSorts.getOr(this.sorts);
    }

    async getSearchForm(): Promise<SearchForm> {
        const [ext, content, lang, acc, src] = await Promise.all([
            this.facets.ext.getOr([]),
            this.facets.content.getOr([]),
            this.facets.lang.getOr([]),
            this.facets.acc.getOr([]),
            this.facets.src.getOr([]),
        ]);

        return searchForm([
            SearchSortSection(),
            multiSelect({
                id: FILTER.ext,
                title: "File Type",
                options: ext,
                excludable: true,
                footer: "Tap once to include, twice to exclude.",
            }),
            multiSelect({
                id: FILTER.content,
                title: "Content",
                options: content,
                excludable: true,
            }),
            multiSelect({ id: FILTER.lang, title: "Language", options: lang, excludable: true }),
            multiSelect({ id: FILTER.acc, title: "Access", options: acc, excludable: true }),
            multiSelect({ id: FILTER.src, title: "Source", options: src, excludable: true }),
        ]);
    }

    protected rows(): HomeRow[] {
        return [
            {
                id: "added",
                title: "Recently Added",
                style: SectionStyle.SimpleDoubleRow,
                load: (page) => this.results(page, { q: "", sort: "newest_added" }),
            },
            {
                id: "newest",
                title: "Newest Publications",
                load: (page) => this.results(page, { q: "", sort: "newest" }),
            },
        ];
    }

    protected async find(request: SearchRequest): Promise<PagedSearchResult> {
        const sort = request.sort
            ? sortOf(request, await this.siteSorts.getOr(this.sorts)).id
            : RELEVANCE.id;

        return this.results(request.page, {
            q: request.query?.trim() ?? "",
            sort: sort === RELEVANCE.id ? undefined : sort,
            ext: tristate(request, FILTER.ext),
            content: tristate(request, FILTER.content),
            lang: tristate(request, FILTER.lang),
            acc: tristate(request, FILTER.acc),
            src: tristate(request, FILTER.src),
        });
    }

    private results(requestedPage: number | undefined, query: Query): Promise<PagedSearchResult> {
        const page = Math.max(1, requestedPage || 1);
        const path = withQuery("/search", { ...query, page: page > 1 ? page : undefined });

        return this.mirrors.run(async (origin) => {
            const html = await this.page(origin, path);
            const result = parseSearch(html, origin);

            return page >= LAST_PAGE ? { ...result, isLastPage: true } : result;
        });
    }

    async getContent(contentId: string): Promise<Content> {
        const md5 = requireMd5(contentId);

        const { content, file, language } = await this.mirrors.run(async (origin) => {
            const html = await this.page(origin, `/md5/${md5}`);

            return parseRecord(html, md5, origin);
        });

        const files = file ? [file] : [];

        return { ...content, chapters: fileChapters(files, language) };
    }

    async getChapterData(_contentId: string, chapterId: string): Promise<ChapterData> {
        const md5 = requireMd5(chapterId);
        const key = await Secrets.get(KEY_SECRET);

        let memberProblem: string | undefined;
        if (key) {
            const fast = await this.fastDownload(md5, key);

            if (fast.url) {
                const refusal = explainRefusal("Anna's partner server");

                return fileChapter(this.http, fast.url, { timeoutMs: FILE_TIMEOUT_MS }, refusal);
            }

            memberProblem = fast.problem;
        }

        const free = await this.libgenDownload(md5);
        if (free) {
            const refusal = explainRefusal("Library Genesis");

            return fileChapter(this.http, free, { timeoutMs: FILE_TIMEOUT_MS }, refusal);
        }

        const message = memberProblem
            ? `${memberProblem} The file is not on the free Library Genesis mirrors either.`
            : NOT_ON_LIBGEN;

        throw new SourceError(message);
    }

    /**
     * A record or search page. DDoS-Guard checks visitors on these pages; a member whose
     * tier skips the check is signed in once per mirror, and anyone else gets the check as
     * a `CloudflareError` so the app opens it in a WebView.
     */
    private async page(origin: string, path: string): Promise<string> {
        let response = await this.http.get(`${origin}${path}`);
        let html = await response.text();

        if (isBrowserCheck(response.status, html) && (await this.signIn(origin))) {
            response = await this.http.get(`${origin}${path}`);
            html = await response.text();
        }

        if (isBrowserCheck(response.status, html)) throw new CloudflareError(response.url);

        if (!response.ok) {
            const message = `Anna's Archive answered HTTP ${response.status}.`;
            throw new SourceError(message, response.status);
        }

        return html;
    }

    /**
     * The orders and filters as the search page lists them. They load together when the form
     * opens, so the lists share this one page instead of fetching it each.
     */
    private searchFormData(): Promise<SearchFormData> {
        if (!this.formPage || Date.now() - this.formPage.at > FORM_PAGE_MS) {
            const data = this.mirrors.run(async (origin) => {
                const html = await this.page(origin, "/search");

                return parseSearchForm(html);
            });

            this.formPage = { at: Date.now(), data };

            data.catch(() => {
                if (this.formPage?.data === data) this.formPage = undefined;
            });
        }

        return this.formPage.data;
    }

    private facet(group: string): SiteData<Option[]> {
        return new SiteData(`annas.${group}`, async () => {
            const { facets } = await this.searchFormData();

            return nonEmpty(facets[group] ?? []);
        });
    }

    /** Signs in with the member key; `false` when there is no key or it was already used here. */
    private async signIn(origin: string, force = false): Promise<boolean> {
        const key = await Secrets.get(KEY_SECRET);
        if (!key || (!force && this.signedIn.get(origin) === key)) return false;

        const response = await this.http.post(`${origin}/account/`, Body.form({ key }));
        const html = await response.text();

        if (isBrowserCheck(response.status, html)) throw new CloudflareError(response.url);

        if (/Invalid secret key/i.test(html)) {
            throw new SourceError(
                "Anna's Archive rejected the member key. Check it in the source settings.",
            );
        }

        if (!response.ok) {
            throw new SourceError(`Signing in failed (HTTP ${response.status}).`, response.status);
        }

        this.signedIn.set(origin, key);

        return true;
    }

    private async accountStatus(): Promise<string> {
        try {
            const summary = await this.mirrors.run(async (origin) => {
                await this.signIn(origin, true);

                const response = await this.http.get(`${origin}/dyn/md5/summary/${SUMMARY_MD5}`);
                if (!response.ok) throw new SourceError(`HTTP ${response.status}`, response.status);

                return response.json<AccountSummary>();
            });

            if (summary.is_member !== 1) return NO_MEMBERSHIP_FOOTER;

            const perDay = await ObjectStore.get(KEY_QUOTA);
            const left = summary.downloads_left ?? 0;
            const count = typeof perDay === "number" ? `${left} of ${perDay}` : left;

            return `Fast downloads left today: ${count}. Files not available that way fall back to Library Genesis.`;
        } catch (error) {
            if (error instanceof CloudflareError) {
                return "Could not check the key: the mirror asked for a browser check.";
            }

            const reason = error instanceof Error ? error.message : String(error);

            return `Could not check the key: ${reason}`;
        }
    }

    private async fastDownload(
        md5: string,
        key: string,
    ): Promise<{ url?: string; problem?: string }> {
        const result = await this.mirrors.run(async (origin) => {
            const url = withQuery(`${origin}/dyn/api/fast_download.json`, { md5, key });
            const response = await this.http.get(url);

            if (response.status >= 500) {
                throw new SourceError(`HTTP ${response.status}`, response.status);
            }

            return response.json<FastDownload>();
        });

        const perDay = result.account_fast_download_info?.downloads_per_day;
        if (typeof perDay === "number") await ObjectStore.set(KEY_QUOTA, perDay);

        if (result.download_url) return { url: result.download_url };

        return { problem: describeFastDownloadError(result.error, perDay) };
    }

    /** The first Library Genesis mirror that answers decides: they share one catalogue. */
    private async libgenDownload(md5: string): Promise<string | undefined> {
        let lastError: unknown;

        for (const mirror of LIBGEN_MIRRORS) {
            const page = `${mirror}/ads.php?md5=${md5}`;

            try {
                const response = await this.http.get(page);

                if (response.status >= 500) {
                    throw new SourceError(`HTTP ${response.status}`, response.status);
                }

                if (!response.ok) return undefined;

                const html = await response.text();

                return libgenLink(html, response.url || page);
            } catch (error) {
                if (!(error instanceof CloudflareError) && !isHostFailure(error)) throw error;

                lastError = error;
            }
        }

        throw lastError instanceof Error
            ? lastError
            : new SourceError("No Library Genesis mirror answered.");
    }
}

const NO_KEY_FOOTER =
    "Without a key, search and record pages may ask for a browser check, and downloads come from the free Library Genesis mirrors. Members whose tier skips the check are signed in with the key.";

const NO_MEMBERSHIP_FOOTER =
    "This key has no active membership, so downloads use the free Library Genesis mirrors.";

const NOT_ON_LIBGEN =
    "This file is not on the free Library Genesis mirrors. Add a member key in the source settings to download it from Anna's Archive.";

/** A list the page did not carry throws, so the last good one is kept rather than replaced. */
function nonEmpty<T>(list: T[]): T[] {
    if (!list.length) throw new SourceError("Anna's search page did not list these options.");

    return list;
}

function requireMd5(id: string): string {
    const md5 = id.trim().toLowerCase();
    if (!MD5.test(md5)) throw new SourceError(`"${id}" is not an Anna's Archive record id.`);

    return md5;
}

/** Anna's filters take a value to include it and `anti__<value>` to exclude it. */
function tristate(request: SearchRequest, id: string): string[] {
    const { included, excluded } = FilterReader.excludable(request, id);

    return [...included, ...excluded.map((value) => `anti__${value}`)];
}

function describeFastDownloadError(error: string | undefined, perDay: number | undefined): string {
    switch (error) {
        case "Invalid secret key":
            return "Anna's Archive rejected the member key.";
        case "Not a member":
            return "The member key has no active membership.";
        case "No downloads left":
            return `No fast downloads left today${perDay ? ` (0 of ${perDay})` : ""}.`;
        case "Record not found":
            return "Anna's Archive has no fast download for this file.";
        default:
            return `Anna's Archive could not prepare a fast download${error ? ` (${error})` : ""}.`;
    }
}

function explainRefusal(server: string): (html: string) => string {
    return (html) => {
        const reason = refusalReason(html);
        const quoted = reason ? `: "${reason}"` : "";

        return `${server} sent a web page instead of the book${quoted}. Try again later.`;
    };
}

export class Target extends AnnasArchive { }
