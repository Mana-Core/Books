/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    BasicAuthenticationUIIdentifier,
    Body,
    CloudflareError,
    CatalogRating,
    SearchListSection,
    SearchMultiPickerSheet,
    SearchSortSection,
    SearchTextField,
    SectionStyle,
    type BasicAuthenticatable,
    type ChapterData,
    type Content,
    type Form,
    type HttpResponse,
    type PagedSearchResult,
    type SearchForm,
    type SearchRequest,
    type User,
} from "@mana-app/types";

import { fileChapter, fileChapters } from "../lib/books";
import { SiteData } from "../lib/cache";
import { load } from "../lib/html";
import { isBrowserCheck, SourceError } from "../lib/http";
import { MirrorSet } from "../lib/mirrors";
import { FilterReader, multiSelect, searchForm } from "../lib/search";
import type { HomeRow } from "../lib/sections";
import { Secrets } from "../lib/settings";
import { HomeSource } from "../lib/source";
import { pathOf, resolveUrl } from "../lib/url";
import {
    FILTER,
    KEY_USER_ID,
    KEY_USER_KEY,
    MIRRORS,
    PAGE_SIZE,
    PROBE_MARKER,
    PROBE_PATH,
    SORTS,
} from "./model";
import {
    extensionOptions,
    isLimitError,
    isLoginError,
    languageOptions,
    splitId,
    toContent,
    toHighlight,
    type ApiResult,
    type ApiUser,
    type BookResponse,
    type ExtensionsResponse,
    type FileResponse,
    type LanguagesResponse,
    type SearchResponse,
    type UserResponse,
} from "./parsers";

type Session = { userId: string; userKey: string };
type FormFields = Record<string, string | number | string[]>;
type Listing = {
    message?: string;
    order: string;
    extensions?: string[];
    languages?: string[];
    yearFrom?: number;
    yearTo?: number;
    page: number;
};

/** Files can be large and the download servers slow; API calls keep the default timeout. */
const FILE_TIMEOUT_MS = 180_000;

class ZLibrary extends HomeSource implements BasicAuthenticatable {
    readonly info = {
        id: "mc.zlibrary",
        name: "ZLibrary",
        version: "1.0.0",
        description:
            "Z-Library's catalogue of books as EPUB and PDF. Searching is open; downloading needs a free account.",
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
        thumbnail: "ZLibrary.png",
    };

    /**
     * Browsing and search work without an account; only the file needs one, and that step
     * explains how to sign in. Requiring sign-in up front would hide a usable catalogue.
     */
    protected readonly sorts = SORTS;
    readonly BasicAuthenticationUIIdentifier = BasicAuthenticationUIIdentifier.EMAIL;
    readonly BasicAuthUIIdentifier = BasicAuthenticationUIIdentifier.EMAIL;

    private readonly mirrors = new MirrorSet({
        builtIn: MIRRORS,
        probePath: PROBE_PATH,
        marker: PROBE_MARKER,
    });

    private readonly extensions = new SiteData("zlibrary.extensions", async () => {
        const { body } = await this.api<ExtensionsResponse>("/eapi/info/extensions");

        return extensionOptions(body);
    });

    private readonly languages = new SiteData("zlibrary.languages", async () => {
        const { body } = await this.api<LanguagesResponse>("/eapi/info/languages");

        return languageOptions(body);
    });

    protected rows(): HomeRow[] {
        return [
            {
                id: "popular",
                title: "Most Popular",
                style: SectionStyle.SimpleDoubleRow,
                // The endpoint returns one fixed list of 100, so it is a single page.
                load: async () => {
                    const { origin, body } =
                        await this.api<SearchResponse>("/eapi/book/most-popular");

                    const results = (body.books ?? []).map((b) => toHighlight(b, origin));

                    return { results, isLastPage: true };
                },
            },
            {
                id: "recent-epub",
                title: "Recently Added EPUBs",
                style: SectionStyle.SimpleSingleRow,
                load: (page) => this.list({ order: "date", extensions: ["epub"], page }),
            },
            {
                id: "recent",
                title: "Recently Added",
                style: SectionStyle.DetailedDoubleRowPaged,
                load: (page) => this.list({ order: "date", page }),
            },
        ];
    }

    protected find(request: SearchRequest): Promise<PagedSearchResult> {
        return this.list({
            message: request.query?.trim(),
            order: this.sortOf(request).id,
            extensions: FilterReader.options(request, FILTER.ext),
            languages: FilterReader.options(request, FILTER.lang),
            yearFrom: FilterReader.integer(request, FILTER.yearFrom),
            yearTo: FilterReader.integer(request, FILTER.yearTo),
            page: request.page,
        });
    }

    async getPreferenceMenu(): Promise<Form> {
        return { sections: [await this.mirrors.section()] };
    }

    async getSearchForm(): Promise<SearchForm> {
        const [extensions, languages] = await Promise.all([
            this.extensions.getOr([]),
            this.languages.getOr([]),
        ]);

        return searchForm([
            SearchSortSection(),
            multiSelect({ id: FILTER.ext, title: "File Type", options: extensions }),
            SearchListSection({
                children: [
                    SearchMultiPickerSheet({
                        id: FILTER.lang,
                        title: "Language",
                        options: languages,
                    }),
                    SearchTextField({
                        id: FILTER.yearFrom,
                        title: "Year From",
                        placeholder: "1990",
                    }),
                    SearchTextField({ id: FILTER.yearTo, title: "Year To", placeholder: "2025" }),
                ],
            }),
        ]);
    }

    async getContent(contentId: string): Promise<Content> {
        const ids = requireId(contentId);
        const { origin, body } = await this.api<BookResponse>(`/eapi/book/${ids.id}/${ids.hash}`);

        if (!body.book) {
            const message = body.error ? `Z-Library: ${body.error}` : "Z-Library returned no book.";
            throw new SourceError(message);
        }

        const { content, files, language } = toContent(body.book, origin);

        return { ...content, chapters: fileChapters(files, language) };
    }

    async getChapterData(_contentId: string, chapterId: string): Promise<ChapterData> {
        const ids = requireId(chapterId);

        const session = await this.session();
        if (!session) return this.guestDownload(ids);

        const path = `/eapi/book/${ids.id}/${ids.hash}/file`;
        const { status, body } = await this.api<FileResponse>(path, { session });

        const link = body.file?.downloadLink;
        if (body.success === 1 && link && body.file?.allowDownload !== false) {
            return fileChapter(this.http, link, { timeoutMs: FILE_TIMEOUT_MS }, explainRefusal);
        }

        if (isLoginError(status, body.error)) {
            await this.signOut();
            throw new SourceError(SIGNED_OUT, 401);
        }

        const reason = body.error ?? body.file?.disallowDownloadMessage;
        if (isLimitError(reason) || body.file?.allowDownload === false) {
            throw new SourceError(await this.limitMessage(session));
        }

        const message = reason
            ? `Z-Library refused the download: ${reason}`
            : "Z-Library returned no download link.";

        throw new SourceError(message);
    }

    /**
     * The download a signed-out visitor gets on the website: the book's page links its file
     * (`a.addDownloadedBook` → `/dl/<id>`), which the site serves without an account within
     * its guest limit. Only the app API's `/file` route insists on a login.
     */
    private async guestDownload(ids: { id: string; hash: string }): Promise<ChapterData> {
        const { origin, body } = await this.api<BookResponse>(`/eapi/book/${ids.id}/${ids.hash}`);

        const path = body.book?.href ? pathOf(body.book.href) : body.book?.url;
        if (!path) throw new SourceError("Z-Library returned no page for this book.");

        const pageUrl = `${origin}${path}`;

        const page = await this.http.get(pageUrl);
        const html = await page.text();

        if (isBrowserCheck(page.status, html)) throw new CloudflareError(pageUrl);

        if (!page.ok) {
            const message = `Z-Library did not open the book page (HTTP ${page.status}).`;
            throw new SourceError(message, page.status);
        }

        const href = load(html)("a.addDownloadedBook").first().attr("href");
        const link = resolveUrl(pageUrl, href);
        if (!link) throw new SourceError(explainRefusal(html));

        const file = await this.http.get(link, {
            headers: { Referer: pageUrl },
            timeoutMs: FILE_TIMEOUT_MS,
        });

        const contentType = file.headers.get("content-type") ?? "";
        if (contentType.includes("text/html")) {
            const refusal = await file.text();
            if (isBrowserCheck(file.status, refusal)) throw new CloudflareError(pageUrl);

            throw new SourceError(explainRefusal(refusal));
        }

        if (!file.ok) {
            throw new SourceError(`The download failed (HTTP ${file.status}).`, file.status);
        }

        return { document: file };
    }

    // MARK: Authentication

    async handleBasicAuth(identifier: string, password: string): Promise<void> {
        const form = { email: identifier.trim(), password };
        const { body } = await this.api<UserResponse>("/eapi/user/login", { form });

        const userId = body.user?.id;
        const userKey = body.user?.remix_userkey;

        if (body.success !== 1 || userId === undefined || !userKey) {
            const message = body.error
                ? `Z-Library: ${body.error}`
                : "Z-Library did not accept the sign-in.";

            throw new SourceError(message);
        }

        // Only the session pair is kept; the password never leaves this call.
        await Secrets.set(KEY_USER_ID, String(userId));
        await Secrets.set(KEY_USER_KEY, userKey);
    }

    async getAuthenticatedUser(): Promise<User | null> {
        const session = await this.session();
        if (!session) return null;

        const user = await this.profile(session);

        // An expired session reads as signed out, so the account screen offers to sign in.
        if (!user) return null;

        const lines = [downloadsLine(user), user.isPremium ? "Premium account" : undefined];

        return {
            handle: user.email ?? user.name ?? session.userId,
            displayName: user.name || undefined,
            info: lines.filter((l): l is string => Boolean(l)),
        };
    }

    async handleUserSignOut(): Promise<void> {
        await this.signOut();
    }

    // MARK: Requests

    private async list(listing: Listing): Promise<PagedSearchResult> {
        const page = Math.max(1, listing.page || 1);

        const form: FormFields = {
            message: listing.message ?? "",
            limit: PAGE_SIZE,
            page,
            order: listing.order,
        };

        // PHP reads repeated `name[]` keys as a list; undefined values must not reach the body.
        if (listing.extensions?.length) form["extensions[]"] = listing.extensions;
        if (listing.languages?.length) form["languages[]"] = listing.languages;
        if (listing.yearFrom) form.yearFrom = listing.yearFrom;
        if (listing.yearTo) form.yearTo = listing.yearTo;

        const { origin, body } = await this.api<SearchResponse>("/eapi/book/search", { form });

        const results = (body.books ?? []).map((b) => toHighlight(b, origin));
        const isLastPage = results.length === 0 || !body.pagination?.next;

        return { results, isLastPage };
    }

    /**
     * One eAPI call on the active mirror. Failures come back as JSON with HTTP 400, so the
     * body is returned with its status rather than thrown; only a host that is down or does
     * not speak the API at all becomes an error, which lets the mirror set fail over.
     */
    private async api<T extends ApiResult>(
        path: string,
        options: { form?: FormFields; session?: Session } = {},
    ): Promise<{ origin: string; status: number; body: T }> {
        return this.mirrors.run(async (origin) => {
            const { session, form } = options;

            const cookie = session
                ? `remix_userid=${session.userId}; remix_userkey=${session.userKey}`
                : undefined;
            const headers = cookie ? { cookie } : undefined;

            const url = `${origin}${path}`;
            const response = form
                ? await this.http.post(url, Body.form(form), { headers })
                : await this.http.get(url, { headers });

            const body = await readApi<T>(response);

            return { origin, status: response.status, body };
        });
    }

    private async session(): Promise<Session | undefined> {
        const [userId, userKey] = await Promise.all([
            Secrets.get(KEY_USER_ID),
            Secrets.get(KEY_USER_KEY),
        ]);

        return userId && userKey ? { userId, userKey } : undefined;
    }

    private async signOut(): Promise<void> {
        await Promise.all([
            Secrets.set(KEY_USER_ID, undefined),
            Secrets.set(KEY_USER_KEY, undefined),
        ]);
    }

    /** The signed-in user, or `undefined` after clearing a session the site no longer accepts. */
    private async profile(session: Session): Promise<ApiUser | undefined> {
        const { status, body } = await this.api<UserResponse>("/eapi/user/profile", { session });

        if (body.success === 1 && body.user) return body.user;

        if (isLoginError(status, body.error)) {
            await this.signOut();
            return undefined;
        }

        const message = body.error ? `Z-Library: ${body.error}` : "Z-Library returned no profile.";

        throw new SourceError(message);
    }

    private async limitMessage(session: Session): Promise<string> {
        const user = await this.profile(session).catch(() => undefined);
        const used = user ? downloadsLine(user) : undefined;
        const detail = used ? ` (${used.replace("Downloads today: ", "")})` : "";

        return `Z-Library's daily download limit is reached${detail}. Try again tomorrow.`;
    }
}

const SIGNED_OUT = "Signed out — sign in again in the source's account settings.";

const ACCOUNT_REQUIRED =
    "Z-Library wants an account for this download. Sign in under the source's account settings.";

function explainRefusal(html: string): string {
    if (/limit/i.test(html)) {
        return "Z-Library's daily download limit is reached. Try again tomorrow.";
    }

    if (/log\s*in|sign\s*in/i.test(html)) return ACCOUNT_REQUIRED;

    return "Z-Library's download server sent a web page instead of the book. Try again later.";
}

async function readApi<T extends ApiResult>(response: HttpResponse): Promise<T> {
    if (response.status >= 500) {
        throw new SourceError(`Z-Library answered HTTP ${response.status}.`, response.status);
    }

    try {
        return await response.json<T>();
    } catch {
        // A block or parked page instead of JSON means this domain cannot serve the API;
        // reporting it as a gateway failure moves the mirror set to the next domain.
        throw new SourceError(`Z-Library answered HTTP ${response.status} without API data.`, 502);
    }
}

function requireId(id: string): { id: string; hash: string } {
    const ids = splitId(id);
    if (!ids) throw new SourceError(`"${id}" is not a Z-Library book id.`);

    return ids;
}

function downloadsLine(user: ApiUser): string | undefined {
    if (typeof user.downloads_today !== "number" || typeof user.downloads_limit !== "number") {
        return undefined;
    }

    return `Downloads today: ${user.downloads_today} / ${user.downloads_limit}`;
}

export class Target extends ZLibrary {}
