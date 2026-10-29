/* SPDX-License-Identifier: GPL-3.0-or-later */

import type {
    Chapter,
    ChapterData,
    HttpClient,
    HttpResponse,
    RequestOptions,
} from "@mana-app/types";

import { SourceError } from "./http";

/**
 * Returns HTML as the chapter's document. `document` is the typed path and takes
 * precedence over legacy text in the app; the host normalises it into an EPUB itself.
 */
export function htmlChapter(response: HttpResponse, html: string): ChapterData {
    return { document: response.withBody(html, { contentType: "text/html; charset=utf-8" }) };
}

/**
 * Downloads a file and hands its body straight to the app, which sniffs EPUB, PDF or text
 * from the bytes. Only a refusal is read here — never the file itself.
 */
export async function fileChapter(
    client: HttpClient,
    url: string,
    options?: RequestOptions,
    explainRefusal?: (html: string) => string | undefined,
): Promise<ChapterData> {
    const response = await client.get(url, options);

    if (!response.ok) {
        throw new SourceError(`The download failed (HTTP ${response.status}).`, response.status);
    }

    // A limit or login page served with 200 would otherwise reach the reader as an
    // "unsupported document" error that tells the reader nothing.
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
        const html = await response.text();
        const reason = explainRefusal?.(html);

        throw new SourceError(reason ?? "The site returned a web page instead of the book file.");
    }

    return { document: response };
}

export type FileFormat = "epub" | "pdf" | "txt" | "mobi" | "azw3" | "fb2" | "djvu" | "cbz" | "html";

/** EPUB first: it reflows, so it reads best on a phone. */
const FORMAT_ORDER: FileFormat[] = [
    "epub",
    "pdf",
    "txt",
    "html",
    "cbz",
    "fb2",
    "mobi",
    "azw3",
    "djvu",
];

/** Formats the book reader can open. Everything else is filtered out of chapter lists. */
export const READABLE_FORMATS: readonly FileFormat[] = ["epub", "pdf", "txt", "html", "cbz"];

export type BookFile = {
    id: string;
    format: FileFormat;
    /** Overrides the format name in the chapter title, e.g. "EPUB (no images)". */
    label?: string;
    bytes?: number;
    date?: Date;
    webUrl?: string;
};

/** One chapter per readable file, best format first. */
export function fileChapters(files: BookFile[], language: string): Chapter[] {
    const readable = files.filter((file) => READABLE_FORMATS.includes(file.format));
    const rank = (file: BookFile) => FORMAT_ORDER.indexOf(file.format);
    readable.sort((a, b) => rank(a) - rank(b));

    return readable.map((file, index) => {
        const name = file.label ?? file.format.toUpperCase();
        const size = formatBytes(file.bytes);

        return {
            chapterId: file.id,
            index,
            number: index + 1,
            title: size ? `${name} · ${size}` : name,
            language,
            date: file.date ?? new Date(0),
            webUrl: file.webUrl,
        };
    });
}

export function formatOf(value: string | undefined): FileFormat | undefined {
    const normalized = value?.toLowerCase().replace(/^\./, "").trim();

    return FORMAT_ORDER.find((format) => format === normalized);
}

export function formatBytes(bytes: number | undefined): string | undefined {
    if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return undefined;

    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }

    // "512 B", "2.1 MB", "14 MB": one decimal only where it still says something.
    const shown = value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1);

    return `${shown} ${units[unit]}`;
}

export type ListedChapter = {
    chapterId: string;
    title: string;
    /** A number the site states outright; preferred over one parsed from the title. */
    number?: number;
    date?: Date;
    webUrl?: string;
    volume?: number;
};

/**
 * Turns a chapter list given oldest-first into app chapters.
 *
 * Numbers come from the site or the titles only when every chapter has one and they never go
 * backwards; otherwise the position is used. A list that mixes "Chapter 12" with
 * "Side Story" would else file the side story ahead of chapter 1.
 */
export function sequenceChapters(chapters: ListedChapter[], language: string): Chapter[] {
    const parsed = chapters.map((c) => c.number ?? chapterNumber(c.title));

    const usable = parsed.every((n, i) => {
        const previous = i === 0 ? undefined : parsed[i - 1];
        return n !== undefined && (previous === undefined || n >= previous);
    });

    return chapters.map((chapter, index) => ({
        chapterId: chapter.chapterId,
        index,
        number: usable ? (parsed[index] as number) : index + 1,
        volume: chapter.volume,
        title: chapter.title,
        language,
        date: chapter.date ?? new Date(0),
        webUrl: chapter.webUrl,
    }));
}

export function chapterNumber(title: string): number | undefined {
    const match =
        /(?:chapter|chap|ch|episode|ep|part)\.?\s*(\d+(?:\.\d+)?)/i.exec(title) ??
        /^\s*(\d+(?:\.\d+)?)\b/.exec(title);
    if (!match) return undefined;

    const value = Number.parseFloat(match[1] as string);

    return Number.isFinite(value) ? value : undefined;
}
