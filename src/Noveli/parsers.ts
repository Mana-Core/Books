/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    ContentType,
    PublicationStatus,
    type Content,
    type Highlight,
    type PagedSearchResult,
    type Tag,
} from "@mana-app/types";

import { type ListedChapter } from "../lib/books";
import { load, textToHtml } from "../lib/html";
import { SourceError } from "../lib/http";
import { parseDate } from "../lib/dates";
import { resolveUrl } from "../lib/url";
import {
    BASE_URL,
    PAGE_SIZE,
    type ChapterDetail,
    type ChapterListResponse,
    type ChapterParagraph,
    type ChapterRow,
    type NovelCard,
    type NovelDetail,
    type NovelListResponse,
} from "./model";

const UNKNOWN_AUTHOR = "Unknown Author";

export function novelPath(slug: string): string {
    return `/novel/${slug}`;
}

export function coverOf(value: string | null | undefined): string {
    return resolveUrl(BASE_URL, value ?? undefined) ?? "";
}

export function statusOf(value: string | null | undefined): PublicationStatus | undefined {
    switch (value) {
        case "Ongoing":
            return PublicationStatus.ONGOING;
        case "Completed":
            return PublicationStatus.COMPLETED;
        case "Hiatus":
            return PublicationStatus.HIATUS;
        case "Dropped":
        case "Cancelled":
            return PublicationStatus.CANCELLED;
        default:
            return undefined;
    }
}

function highlightOf(card: NovelCard): Highlight {
    const path = novelPath(card.slug);

    return {
        id: path,
        title: card.title,
        cover: coverOf(card.cover_image),
        subtitle: card.chapter_count ? `${card.chapter_count} chapters` : undefined,
        webUrl: `${BASE_URL}${path}`,
    };
}

export function parseList(json: NovelListResponse, page: number): PagedSearchResult {
    const total = json.pagination?.total ?? 0;

    return {
        results: (json.data ?? []).map(highlightOf),
        isLastPage: page * PAGE_SIZE >= total,
        totalResultCount: total,
    };
}

export function synopsisOf(raw: string | null | undefined): string | undefined {
    if (!raw?.trim()) return undefined;

    const withBreaks = raw.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n");
    const plain = load(`<div>${withBreaks}</div>`)("div").text();

    const paragraphs = plain
        .split(/\r?\n+/)
        .map((line) => line.trim())
        .filter(Boolean);

    return paragraphs.length ? paragraphs.join("\n\n") : undefined;
}

function tagsOf(detail: NovelDetail): Tag[] {
    const seen = new Set<string>();
    const tags: Tag[] = [];

    const add = (kind: "genre" | "tag", name: string) => {
        const key = `${kind}:${name.toLowerCase()}`;
        if (!name.trim() || seen.has(key)) return;

        seen.add(key);
        tags.push({ id: `${kind}:${name}`, title: name, isNonInteractive: true });
    };

    (detail.genres ?? []).forEach((name) => add("genre", name));
    (detail.tags ?? []).forEach((name) => add("tag", name));

    return tags;
}

export function parseDetail(json: { data?: NovelDetail }, slug: string): Content {
    const detail = json.data;
    if (!detail || detail.slug !== slug) {
        throw new SourceError("Noveli has no novel at this address.", 404);
    }

    const author = detail.author?.trim();

    return {
        title: detail.title,
        cover: coverOf(detail.cover_image),
        summary: synopsisOf(detail.description),
        status: statusOf(detail.status),
        contentType: ContentType.NOVEL,
        additionalTitles: author && author !== UNKNOWN_AUTHOR ? [`by ${author}`] : undefined,
        tags: tagsOf(detail),
        webUrl: `${BASE_URL}${novelPath(detail.slug)}`,
    };
}

export function parseChapters(json: ChapterListResponse, novelId: number): ListedChapter[] {
    return (json.chapters ?? [])
        .filter((row: ChapterRow) => row.novel_id === novelId)
        .map((row) => {
            const chapterId = `/read/${novelId}/${row.id}`;

            return {
                chapterId,
                title: row.title,
                number: row.chapter_number,
                date: parseDate(row.created_at ?? undefined),
                webUrl: `${BASE_URL}${chapterId}`,
            };
        });
}

function isInjected(paragraph: ChapterParagraph): boolean {
    if (paragraph.isHoneypot || paragraph.isMidWatermark) return true;
    const html = paragraph.html ?? "";
    return /class\s*=\s*["'][^"']*(?:watermark-notice|noveli-canary)/i.test(html);
}

function paragraphHtml(paragraph: ChapterParagraph): string {
    const value = (paragraph.html ?? paragraph.text ?? "").trim();
    if (!value) return "";

    if (/^<(p|div|blockquote|h[1-6]|ul|ol|figure|table)\b/i.test(value)) return value;

    return `<p>${value}</p>`;
}

export function parseChapter(detail: ChapterDetail): string {
    const paragraphs = (detail.paragraphs ?? []).filter((p) => !isInjected(p));
    if (paragraphs.length) {
        return paragraphs.map(paragraphHtml).filter(Boolean).join("");
    }

    const raw = detail.raw_content?.trim() ?? "";
    return raw ? textToHtml(raw) : "";
}
