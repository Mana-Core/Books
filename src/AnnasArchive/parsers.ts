/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    ContentType,
    PublicationStatus,
    type Content,
    type Highlight,
    type Option,
    type PagedSearchResult,
    type SortOption,
} from "@mana-app/types";

import { formatOf, READABLE_FORMATS, type BookFile, type FileFormat } from "../lib/books";
import { load, text, type Cheerio, type CheerioAPI, type AnyNode } from "../lib/html";
import { SourceError } from "../lib/http";
import { chapterLanguage } from "../lib/language";
import { resolveUrl } from "../lib/url";
import { FILTER, RELEVANCE } from "./model";

export const MD5 = /^[a-f0-9]{32}$/;

/** The facts Anna's prints in one line: "English [en] · EPUB · 0.4MB · 2025 · 📕 Book (fiction) · 🚀/lgli/zlib". */
type RecordLine = {
    /** ISO codes, as the site's language filter takes them. */
    languages: string[];
    languageNames: string[];
    format?: FileFormat;
    extension?: string;
    size?: string;
    bytes?: number;
    year?: string;
    kind?: string;
};

const SIZE = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/i;
const UNIT: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

function parseRecordLine(line: string): RecordLine {
    const result: RecordLine = { languages: [], languageNames: [] };

    for (const raw of line.split("·")) {
        const part = raw.trim();
        if (!part || part.startsWith("🚀") || part === "Save") continue;

        const language = /^(.*?)\s*\[([a-z]{2,3}(?:-[A-Za-z]+)?)\]$/.exec(part);
        const size = SIZE.exec(part);

        if (language) {
            const code = language[2] as string;
            const name = (language[1] as string).replace(/^[^\p{L}]+/u, "");

            result.languages.push(code);
            result.languageNames.push(name || code);
        } else if (size) {
            const amount = Number.parseFloat(size[1] as string);
            const unit = UNIT[(size[2] as string).toUpperCase()] ?? 1;

            result.size = part;
            result.bytes = Math.round(amount * unit);
        } else if (/^\d{4}$/.test(part)) {
            result.year = part;
        } else if (/^[A-Z0-9]{2,5}$/.test(part)) {
            result.extension = part.toLowerCase();
            result.format = formatOf(part);
        } else if (/book|magazine|comic|document|score|other|journal/i.test(part)) {
            // Drop the leading emoji so the tag reads as words.
            result.kind = part.replace(/^[^\p{L}]+/u, "");
        }
    }

    return result;
}

function recordLineOf(node: Cheerio<AnyNode>): RecordLine {
    // The line ends in a "Save" button and inline scripts; only its leading text is data.
    const copy = node.clone();
    copy.find("a, script, span").remove();

    return parseRecordLine(text(copy));
}

function coverOf(node: Cheerio<AnyNode>, origin: string): string {
    const src = node.find('[id^="list_cover_aarecord_id__"] img').first().attr("src");

    return resolveUrl(origin, src) ?? "";
}

/**
 * One page of results. Only the first result list counts: Anna's appends looser
 * "partial matches" in a second, hidden list that would read as unrelated noise.
 */
export function parseSearch(html: string, origin: string): PagedSearchResult {
    const $ = load(html);
    const results: Highlight[] = [];
    const seen = new Set<string>();

    const links = $(".js-aarecord-list-outer").first().find('a.js-vim-focus[href^="/md5/"]');

    links.each((_, element) => {
        const link = $(element);
        const md5 = /^\/md5\/([a-f0-9]{32})/.exec(link.attr("href") ?? "")?.[1];
        if (!md5 || seen.has(md5)) return;

        seen.add(md5);

        const row = link.closest("div.pt-3");
        const line = recordLineOf(row.find("div.font-semibold.text-sm").first());
        const author = text(row.find('span[class*="mdi--user-edit"]').first().parent());

        const file = [line.extension?.toUpperCase(), line.size, line.year]
            .filter(Boolean)
            .join(" · ");

        results.push({
            id: md5,
            title: text(link) || md5,
            subtitle: author || undefined,
            cover: coverOf(row, origin),
            info: [{ key: "File", value: file }],
            webUrl: `${origin}/md5/${md5}`,
        });
    });

    const isLastPage = results.length === 0 || $("a.js-pagination-next-page").length === 0;

    return { results, isLastPage };
}

/** The orders and filter groups the search page offers, each group keyed by its query parameter. */
export type SearchFormData = { sorts: SortOption[]; facets: Partial<Record<string, Option[]>> };

const FACET_BUTTON = /\bjs-tristate-button--([a-z_]+)--(\S+)/;

function readable(extension: string): boolean {
    const format = formatOf(extension);

    return format !== undefined && READABLE_FORMATS.includes(format);
}

/**
 * A facet label as words: the page leads with an emoji ("📘 Book (non‑fiction)"), writes
 * hyphens as non-breaking ones, and ends sources and languages with their code
 * ("English [en]"), which the option id already is.
 */
function facetTitle(group: string, label: string): string {
    const title = label
        .replace(/\u2011/g, "-")
        .replace(/^[^\p{L}\p{N}]+/u, "")
        .replace(/\s*\[[^\]]+\]$/, "")
        .trim();

    return group === FILTER.ext ? title.toUpperCase() : title;
}

/**
 * The search page's own "Order by" menu and its tristate filter groups (content, file
 * type, access, source, language). The page lists every option of a group, the ones it
 * folds behind "more…" included, most records first; file types the reader opens are
 * moved to the front because those are the ones worth filtering for.
 */
export function parseSearchForm(html: string): SearchFormData {
    const $ = load(html);

    const sorts = $('select[name="sort"] option')
        .toArray()
        .map((element): SortOption => {
            const id = $(element).attr("value") ?? "";

            return id ? { id, title: text($(element)) || id } : RELEVANCE;
        });

    const facets: Partial<Record<string, Option[]>> = {};

    $('button[class*="js-tristate-button--"]').each((_, element) => {
        const match = FACET_BUTTON.exec($(element).attr("class") ?? "");
        const label = text($(element).find("span.flex-grow").first());
        if (!match || !label) return;

        const group = match[1] as string;
        const list = facets[group] ?? [];

        list.push({ id: match[2] as string, title: facetTitle(group, label) });
        facets[group] = list;
    });

    const ext = facets[FILTER.ext];
    if (ext) {
        facets[FILTER.ext] = [
            ...ext.filter((o) => readable(o.id)),
            ...ext.filter((o) => !readable(o.id)),
        ];
    }

    if (!sorts.length && !Object.keys(facets).length) {
        throw new SourceError("Anna's search page carried no filters.");
    }

    return { sorts, facets };
}

/** The labelled blocks under the title: description, alternative titles, dates. */
function freeformFields($: CheerioAPI): Map<string, string[]> {
    const fields = new Map<string, string[]>();

    $(".js-md5-top-box-description > div.uppercase").each((_, element) => {
        const label = text($(element)).toLowerCase();
        const value = text($(element).next("div"));

        if (value) fields.set(label, [...(fields.get(label) ?? []), value]);
    });

    return fields;
}

export function parseRecord(
    html: string,
    md5: string,
    origin: string,
): { content: Content; file: BookFile | undefined; language: string } {
    const $ = load(html);

    const heading = $("div.text-2xl.font-semibold").first().clone();
    heading.find(".select-none").remove();

    const author = text($('span[class*="mdi--user-edit"]').first().parent());
    const publisher = text($('span[class*="mdi--company"]').first().parent());
    const line = recordLineOf($("div.text-gray-800.font-semibold.text-sm").first());
    const fields = freeformFields($);

    const title = text(heading) || fields.get("alternative title")?.[0] || md5;
    const language = chapterLanguage(line.languages[0]);
    const webUrl = `${origin}/md5/${md5}`;

    const unreadable = line.format === undefined || !READABLE_FORMATS.includes(line.format);
    const formatName = line.extension?.toUpperCase() ?? "in a format";
    const warning = unreadable
        ? `This file is ${formatName} the reader cannot open. Look for an EPUB or PDF edition.`
        : undefined;

    const summary = [fields.get("description")?.[0], warning].filter(Boolean).join("\n\n");

    const additionalTitles = [
        author ? `by ${author}` : undefined,
        publisher || undefined,
        ...(fields.get("alternative title") ?? []),
    ]
        .filter((t): t is string => Boolean(t))
        .slice(0, 6);

    const tags = [line.kind, ...line.languageNames, line.year]
        .filter((t): t is string => Boolean(t))
        .map((t) => ({ id: t, title: t, isNonInteractive: true }));

    const content: Content = {
        title,
        cover: coverOf($.root(), origin),
        summary,
        status: PublicationStatus.COMPLETED,
        contentType: ContentType.NOVEL,
        additionalTitles,
        tags,
        webUrl,
    };

    const file: BookFile | undefined = line.format
        ? { id: md5, format: line.format, bytes: line.bytes, webUrl }
        : undefined;

    return { content, file, language };
}

/** The keyed `get.php` link on a Library Genesis `ads.php` page; absent when the file is not there. */
export function libgenLink(html: string, pageUrl: string): string | undefined {
    const href = load(html)('a[href*="get.php?md5="]').first().attr("href");

    return resolveUrl(pageUrl, href);
}

/** The reason a download server gave in an HTML page instead of the file. */
export function refusalReason(html: string): string | undefined {
    const $ = load(html);
    const reason = text($("h1").first()) || text($("title").first());

    return reason ? reason.slice(0, 160) : undefined;
}
