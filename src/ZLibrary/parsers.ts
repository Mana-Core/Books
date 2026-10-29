/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    ContentType,
    PublicationStatus,
    type Content,
    type Highlight,
    type Option,
} from "@mana-app/types";

import { formatOf, READABLE_FORMATS, type BookFile } from "../lib/books";
import { load, text } from "../lib/html";
import { SourceError } from "../lib/http";
import { chapterLanguage } from "../lib/language";

/** Every eAPI answer: `success` is 1 or 0, and a failure carries `error`. */
export type ApiResult = { success?: number; error?: string };

/** A book as `/eapi/book/search` and `/eapi/book/{id}/{hash}` return it. */
type ApiBook = {
    id: number | string;
    hash: string;
    title?: string;
    author?: string;
    volume?: string;
    year?: number | string;
    edition?: string | null;
    publisher?: string | null;
    language?: string;
    pages?: number;
    series?: string | null;
    cover?: string;
    filesize?: number;
    extension?: string;
    description?: string | null;
    href?: string;
    /** Only in `/eapi/book/most-popular`, which has no `href`. */
    url?: string;
};

export type SearchResponse = ApiResult & {
    books?: ApiBook[];
    pagination?: { current?: number; next?: number | false; total_pages?: number };
};

export type BookResponse = ApiResult & { book?: ApiBook };

export type FileResponse = ApiResult & {
    file?: {
        downloadLink?: string;
        extension?: string;
        allowDownload?: boolean;
        disallowDownloadMessage?: string;
    };
};

export type ApiUser = {
    id?: number | string;
    email?: string;
    name?: string;
    remix_userkey?: string;
    downloads_today?: number;
    downloads_limit?: number;
    isPremium?: number | boolean;
};

export type UserResponse = ApiResult & { user?: ApiUser };

/** `/eapi/info/extensions`: lower-case extensions, most common first. */
export type ExtensionsResponse = ApiResult & { extensions?: string[] };

/** `/eapi/info/languages`: the filter value (a lower-case English name) to its label. */
export type LanguagesResponse = ApiResult & { languages?: Record<string, string> };

function readable(extension: string): boolean {
    const format = formatOf(extension);

    return format !== undefined && READABLE_FORMATS.includes(format);
}

/**
 * The search filter's file types, with those the reader opens first. An empty list throws
 * so that it is never cached in place of the last good one.
 */
export function extensionOptions(body: ExtensionsResponse): Option[] {
    const list = (body.extensions ?? []).filter((e) => typeof e === "string" && e.length > 0);

    if (!list.length) {
        const message = body.error ? `Z-Library: ${body.error}` : "Z-Library listed no file types.";
        throw new SourceError(message);
    }

    const ordered = [...list.filter(readable), ...list.filter((e) => !readable(e))];

    return ordered.map((id) => ({ id, title: id.toUpperCase() }));
}

/** The search filter's languages, in the eAPI's order (most books first). */
export function languageOptions(body: LanguagesResponse): Option[] {
    const entries = Object.entries(body.languages ?? {});
    const list = entries.map(([id, title]) => ({ id, title: title.trim() || id }));

    if (!list.length) {
        const message = body.error ? `Z-Library: ${body.error}` : "Z-Library listed no languages.";
        throw new SourceError(message);
    }

    return list;
}

/** Ids carry no host so that a library entry survives a domain change. */
function bookId(book: Pick<ApiBook, "id" | "hash">): string {
    return `${book.id}/${book.hash}`;
}

export function splitId(id: string): { id: string; hash: string } | undefined {
    const match = /^(\d+)\/([A-Za-z0-9]+)$/.exec(id.trim());

    return match ? { id: match[1] as string, hash: match[2] as string } : undefined;
}

function yearOf(book: ApiBook): string | undefined {
    const year = Number(book.year);

    return Number.isFinite(year) && year > 0 ? String(year) : undefined;
}

function sizeOf(bytes: number | undefined): string | undefined {
    if (!bytes) return undefined;

    return bytes >= 1024 * 1024
        ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
        : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function webUrl(book: ApiBook, origin: string): string | undefined {
    if (book.href) return book.href;

    return book.url ? `${origin}${book.url}` : undefined;
}

export function toHighlight(book: ApiBook, origin: string): Highlight {
    const file = [book.extension?.toUpperCase(), sizeOf(book.filesize), yearOf(book)]
        .filter(Boolean)
        .join(" · ");

    return {
        id: bookId(book),
        title: book.title?.trim() || "Untitled",
        subtitle: book.author?.trim() || undefined,
        cover: book.cover ?? "",
        info: file ? [{ key: "File", value: file }] : undefined,
        webUrl: webUrl(book, origin),
    };
}

/** Descriptions arrive as HTML from some uploaders and as plain text from others. */
function plain(value: string | null | undefined): string {
    if (!value) return "";

    const html = `<div>${value.replace(/<br\s*\/?>/gi, "\n")}</div>`;

    return text(load(html)("div").first());
}

export function toContent(
    book: ApiBook,
    origin: string,
): { content: Content; files: BookFile[]; language: string } {
    const format = formatOf(book.extension);
    const readable = format !== undefined && READABLE_FORMATS.includes(format);
    const edition = [book.publisher, book.edition, yearOf(book)].filter(Boolean).join(", ");

    const formatName = book.extension?.toUpperCase() ?? "in a format";
    const warning = readable
        ? undefined
        : `This file is ${formatName} the reader cannot open. Look for an EPUB or PDF edition.`;

    const summary = [plain(book.description), warning].filter(Boolean).join("\n\n");

    const additionalTitles = [
        book.author ? `by ${book.author}` : undefined,
        edition || undefined,
        book.series ? `Series: ${book.series}` : undefined,
    ].filter((t): t is string => Boolean(t));

    const tags = [
        book.language,
        book.extension?.toUpperCase(),
        book.pages ? `${book.pages} pages` : undefined,
    ]
        .filter((t): t is string => Boolean(t))
        .map((t) => ({ id: t, title: t, isNonInteractive: true }));

    const content: Content = {
        title: book.title?.trim() || "Untitled",
        cover: book.cover ?? "",
        summary,
        status: PublicationStatus.COMPLETED,
        contentType: ContentType.NOVEL,
        additionalTitles,
        tags,
        webUrl: webUrl(book, origin),
    };

    const files: BookFile[] = format
        ? [{ id: bookId(book), format, bytes: book.filesize, webUrl: webUrl(book, origin) }]
        : [];

    return { content, files, language: chapterLanguage(book.language) };
}

/**
 * With HTTP 400, Z-Library answers "Please login" when the session cookie is missing and
 * "Invalid credentials" when the stored session is no longer accepted.
 */
export function isLoginError(status: number, error: string | undefined): boolean {
    return (
        status === 401 ||
        /log\s*in|sign\s*in|invalid credentials|unauthori[sz]ed/i.test(error ?? "")
    );
}

export function isLimitError(error: string | undefined): boolean {
    return /limit/i.test(error ?? "");
}
