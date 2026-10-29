/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    ContentType,
    PublicationStatus,
    type Content,
    type Highlight,
    type HttpClient,
    type Option,
    type PagedSearchResult,
} from "@mana-app/types";

import type { BookFile } from "../lib/books";
import { parseDate } from "../lib/dates";
import { load } from "../lib/html";
import { getJson, SourceError } from "../lib/http";
import { chapterLanguage } from "../lib/language";
import { withQuery } from "../lib/url";
import {
    BASE_QUERY,
    BASE_URL,
    FACET_SIZE,
    FILE_FORMATS,
    OCR_TEXT_FORMAT,
    type FacetResponse,
    type ItemFile,
    type ItemResponse,
    type MetadataValue,
    type SearchResponse,
} from "./model";

function coverOf(identifier: string): string {
    return `${BASE_URL}/services/img/${encodeURIComponent(identifier)}`;
}

function list(value: MetadataValue): string[] {
    if (value === undefined) return [];

    const values = Array.isArray(value) ? value : [value];

    return values.map((v) => String(v).trim()).filter(Boolean);
}

function first(value: MetadataValue): string | undefined {
    return list(value)[0];
}

export function parseSearch(data: SearchResponse, pageSize: number): PagedSearchResult {
    if (!data.response) {
        throw new SourceError(data.error ? `Search failed: ${data.error}` : "Search failed.");
    }

    const { numFound, start, docs } = data.response;

    const results: Highlight[] = docs.map((doc) => {
        const creator = first(doc.creator);
        const info = doc.downloads
            ? [{ key: "Downloads", value: doc.downloads.toLocaleString("en-US") }]
            : undefined;

        return {
            id: doc.identifier,
            title: first(doc.title) ?? doc.identifier,
            subtitle: creator,
            cover: coverOf(doc.identifier),
            info,
            webUrl: `${BASE_URL}/details/${doc.identifier}`,
        };
    });

    const isLastPage = docs.length < pageSize || start + docs.length >= numFound;

    return { results, isLastPage };
}

/** Descriptions are uploader HTML; line breaks are kept so paragraphs survive. */
function plainText(html: string): string {
    const withBreaks = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d)>/gi, "\n\n");
    const $ = load(`<div>${withBreaks}</div>`);

    return $("div")
        .first()
        .text()
        .replace(/[ \t ]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/** Subjects arrive as a list, a single string, or a single string joined with semicolons. */
function subjectsOf(value: MetadataValue): string[] {
    const seen = new Set<string>();

    return list(value)
        .flatMap((s) => s.split(/\s*;\s*/))
        .map((s) => s.trim())
        .filter((s) => {
            const key = s.toLowerCase();
            if (!s || seen.has(key)) return false;

            seen.add(key);

            return true;
        });
}

/** The archive prints dates as "2006-12-05 11:01:57" in UTC, which `Date.parse` may not accept. */
function archiveDate(value: string | undefined): Date | undefined {
    if (!value) return undefined;

    const iso = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(value);

    return iso ? parseDate(`${iso[1]}T${iso[2]}Z`) : parseDate(value);
}

export function parseItem(
    data: ItemResponse,
    identifier: string,
): { content: Content; files: BookFile[]; language: string } {
    const meta = data.metadata;
    if (!meta || data.is_dark) {
        throw new SourceError("This item is no longer available on the Internet Archive.");
    }

    const creators = list(meta.creator);
    const description = list(meta.description).map(plainText).filter(Boolean).join("\n\n");
    const details = [
        first(meta.date) ? `Published: ${first(meta.date)}` : undefined,
        first(meta.publisher) ? `Publisher: ${first(meta.publisher)}` : undefined,
        first(meta.language) ? `Language: ${first(meta.language)}` : undefined,
    ].filter(Boolean);

    const language = chapterLanguage(first(meta.language));
    const added = archiveDate(first(meta.publicdate));

    const summary = [description, details.join("\n")].filter(Boolean).join("\n\n");
    const tags = subjectsOf(meta.subject).map((subject) => ({
        id: subject,
        title: subject,
        isNonInteractive: true,
    }));

    const content: Content = {
        title: first(meta.title) ?? identifier,
        cover: coverOf(identifier),
        summary,
        status: PublicationStatus.COMPLETED,
        contentType: ContentType.NOVEL,
        additionalTitles: creators.length ? [`by ${creators.join("; ")}`] : undefined,
        tags,
        webUrl: `${BASE_URL}/details/${identifier}`,
    };

    const files = filesOf(identifier, data.files ?? [], added);

    return { content, files, language };
}

/**
 * Lending copies keep their EPUB and PDF in the listing but mark them private (they answer
 * 401); encrypted LCP/ACS files need a licence the reader does not have.
 */
function isRestricted(file: ItemFile): boolean {
    const name = file.name.toLowerCase();

    return (
        file.private === true ||
        file.private === "true" ||
        /encrypted/i.test(file.format ?? "") ||
        name.includes("_encrypted") ||
        name.endsWith(".acsm") ||
        name.endsWith(".lcpdf") ||
        name.endsWith("_lcp.epub")
    );
}

function downloadPath(identifier: string, name: string): string {
    const item = encodeURIComponent(identifier);
    const file = name.split("/").map(encodeURIComponent).join("/");

    return `/download/${item}/${file}`;
}

function kindOf(file: ItemFile, format: string): string {
    if (file.format === OCR_TEXT_FORMAT) return "Text (OCR)";
    if (format === "txt") return "Text";

    return format.toUpperCase();
}

function filesOf(
    identifier: string,
    files: ItemFile[],
    fallbackDate: Date | undefined,
): BookFile[] {
    const readable = files.filter((f) => f.format && FILE_FORMATS[f.format] && !isRestricted(f));
    const hasBook = readable.some((f) => f.format !== OCR_TEXT_FORMAT);

    const chosen = readable
        .filter((f) => !hasBook || f.format !== OCR_TEXT_FORMAT)
        .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));

    const perFormat = new Map<string, number>();
    for (const file of chosen) {
        const format = FILE_FORMATS[file.format as string] as string;

        perFormat.set(format, (perFormat.get(format) ?? 0) + 1);
    }

    return chosen.map((file) => {
        const format = FILE_FORMATS[file.format as string]!;
        const kind = kindOf(file, format);
        const path = downloadPath(identifier, file.name);

        // Items that hold a whole series as one PDF per volume need the file name to tell
        // the copies apart.
        const shared = (perFormat.get(format) ?? 0) > 1;
        const label = shared ? `${kind} · ${file.name.replace(/^.*\//, "")}` : kind;

        const mtime = file.mtime ? Number(file.mtime) : Number.NaN;
        const modified = Number.isFinite(mtime) ? parseDate(mtime) : undefined;

        return {
            id: path,
            format,
            label,
            bytes: file.size ? Number(file.size) : undefined,
            date: modified ?? fallbackDate,
            webUrl: `${BASE_URL}${path}`,
        };
    });
}

export type Facets = { languages: Option[]; collections: Option[] };

function bucketKeys(data: FacetResponse, facet: string): string[] {
    const buckets = data.response?.body?.aggregations?.[facet]?.buckets ?? [];

    return buckets.flatMap((bucket) =>
        typeof bucket === "object" && bucket.key ? [bucket.key] : [],
    );
}

/**
 * The language and collection facets of the texts this source lists, the way archive.org's
 * search page loads them.
 */
export async function fetchFacets(http: HttpClient): Promise<Facets> {
    const url = withQuery(`${BASE_URL}/services/search/beta/page_production/`, {
        service_backend: "metadata",
        user_query: BASE_QUERY,
        hits_per_page: 0,
        aggregations: "language,collection",
        aggregations_size: FACET_SIZE,
    });

    const data = await getJson<FacetResponse>(http, url);
    const titles = data.response?.body?.collection_titles ?? {};

    // Values joined with ";" list several languages in one field and match nothing alone.
    const languages = bucketKeys(data, "language")
        .filter((key) => !key.includes(";"))
        .map((key) => ({ id: key, title: key }));

    const collections = bucketKeys(data, "collection").map((key) => ({
        id: key,
        title: titles[key] ?? key,
    }));

    const facets = { languages, collections };

    if (!facets.languages.length && !facets.collections.length) {
        throw new SourceError("The archive's search facets did not load.");
    }

    return facets;
}
