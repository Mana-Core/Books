/* SPDX-License-Identifier: GPL-3.0-or-later */

import { ContentType, type Chapter, type Content, type Highlight } from "@mana-app/types";

import { attr, load, text, type Cheerio, type CheerioAPI, type Element } from "../lib/html";
import { chapterLanguage } from "../lib/language";
import { resolveUrl } from "../lib/url";
import {
    BASE_URL,
    type BookData,
    type DdlFolder,
    type HomeItem,
    type HomePage,
    type Series,
    type Volume,
} from "./model";

export function highlightOf(item: HomeItem): Highlight {
    return {
        id: item.path,
        title: item.title,
        subtitle: item.author || undefined,
        cover: item.cover,
        webUrl: `${BASE_URL}${item.path}`,
    };
}

function seriesPath(href: string | undefined): string | undefined {
    return /^(?:https:\/\/lnori\.com)?(\/series\/\d+\/[^/?#"]+)/.exec(href ?? "")?.[1];
}

/** The whole catalogue ships in one static page; search, filters and sorts run on its card attributes. */
export function parseLibrary(html: string): Series[] {
    const $ = load(html);
    const series: Series[] = [];

    $("#grid article.card").each((_, element) => {
        const card = $(element);
        const path = seriesPath(card.find("a[href^='/series/']").first().attr("href"));
        const title = card.attr("data-t")?.trim();
        if (!path || !title) return;

        const tags = (card.attr("data-tags") ?? "")
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean);
        const cover = resolveUrl(BASE_URL, card.find("figure img").first().attr("src")) ?? "";

        series.push({
            id: card.attr("data-id") ?? path,
            path,
            title,
            author: card.attr("data-a")?.trim() ?? "",
            year: Number.parseInt(card.attr("data-d") ?? "", 10) || 0,
            volumes: Number.parseInt(card.attr("data-v") ?? "", 10) || 0,
            tags,
            rank: Number.parseInt(card.attr("data-rel") ?? "", 10) || 0,
            cover,
        });
    });

    return series;
}

/** The site writes its shelf headings in capitals ("SUMMER 2026 ANIME"), which reads as shouting in a row title. */
function headingCase(value: string): string {
    return value
        .toLowerCase()
        .replace(
            /(^|\s)(\p{L})/gu,
            (_, space: string, letter: string) => space + letter.toUpperCase(),
        );
}

/** One titled grid of the home page, with the series cards it links. */
function homeShelf($: CheerioAPI, section: Cheerio<Element>): HomePage["shelves"][number] {
    const heading = text(section.find("h2").first());
    const items: HomeItem[] = [];

    section.find(".catalog-grid a[href^='/series/']").each((_, link) => {
        const anchor = $(link);
        const path = seriesPath(anchor.attr("href"));
        const image = anchor.find("img").first();
        const title = text(anchor.find("h3, span").last()) || image.attr("alt")?.trim();

        if (path && title) items.push({ path, title, cover: image.attr("src") ?? "" });
    });

    const id = section.attr("id") ?? heading.toLowerCase().replace(/\W+/g, "-");

    return { id, title: headingCase(heading), items };
}

export function parseHome(html: string): HomePage {
    const $ = load(html);
    const featured: HomeItem[] = [];

    $("#hero-stack .hero-carousel-card").each((_, element) => {
        const card = $(element);
        const path = seriesPath(card.attr("data-link"));
        const title = card.attr("data-title")?.trim();
        if (!path || !title) return;

        featured.push({
            path,
            title,
            author: card.attr("data-author")?.trim(),
            cover: card.attr("data-image") ?? "",
        });
    });

    // Seasonal shelves change their id and heading every season, so every titled grid is read.
    const shelves = $("main section")
        .toArray()
        .map((element) => homeShelf($, $(element)))
        .filter((shelf) => shelf.title && shelf.items.length > 0);

    return { featured, shelves };
}

type JsonLd = Record<string, unknown>;

function jsonLd($: CheerioAPI, selector: string): JsonLd[] {
    return $(selector)
        .toArray()
        .flatMap((element) => {
            try {
                const value = JSON.parse($(element).text()) as unknown;
                return value && typeof value === "object" ? [value as JsonLd] : [];
            } catch {
                return [];
            }
        });
}

const VOLUME = /^Volume\s+(\d+(?:\.\d+)?)$/i;

/**
 * Card titles carry only the integer ("Volume 5"); a half volume puts ".5" where the
 * subtitle goes, which the site's own structured data then prints as "Volume 5: .5".
 */
function volumeOf(title: string, subtitle: string): { label: string; number?: number } {
    const match = VOLUME.exec(title);
    if (!match) return { label: subtitle ? `${title}: ${subtitle}` : title };

    const fraction = /^\.(\d+)\s*(.*)$/.exec(subtitle);
    const digits = fraction ? `${match[1]}.${fraction[1]}` : (match[1] as string);
    const number = Number.parseFloat(digits);
    const rest = fraction ? (fraction[2] ?? "").trim() : subtitle;

    const label = rest ? `Volume ${number}: ${rest}` : `Volume ${number}`;

    return { label, number };
}

export function parseSeries(
    html: string,
    path: string,
): { content: Content; volumes: Volume[]; language: string } {
    const $ = load(html);

    const linkedData = jsonLd($, 'script[type="application/ld+json"]');
    const data = linkedData.find((entry) => entry["@type"] === "Book");
    const dataName = typeof data?.name === "string" ? data.name : "";
    const dataSummary = typeof data?.description === "string" ? data.description : "";
    const dataLanguage = typeof data?.inLanguage === "string" ? data.inLanguage : undefined;

    const language = chapterLanguage(dataLanguage);
    const author = text($(".s-info .author").first());

    const tags = $(".tags-box.desktop a.tag")
        .toArray()
        .map((a) => {
            const tag = text($(a));
            return { id: tag, title: tag, isNonInteractive: true };
        });

    const content: Content = {
        title: text($("h1.s-title").first()) || dataName,
        cover: resolveUrl(BASE_URL, $(".cover-wrap img").first().attr("src")) ?? "",
        summary: text($(".desc-box .description").first()) || dataSummary,
        contentType: ContentType.NOVEL,
        additionalTitles: author ? [`by ${author}`] : undefined,
        tags,
        webUrl: `${BASE_URL}${path}`,
    };

    const volumes: Volume[] = [];

    $(".vol-grid article.card").each((_, element) => {
        const card = $(element);
        const href = card.find("a[href^='/book/']").first().attr("href");
        const chapterId = /^\/book\/\d+\/[^/?#]+/.exec(href ?? "")?.[0];
        if (!chapterId) return;

        const title = text(card.find(".card-title").first());
        const meta = text(card.find(".card-meta").first());
        const { label, number } = volumeOf(title, meta);

        volumes.push({ chapterId, title: label, number, webUrl: `${BASE_URL}${chapterId}` });
    });

    return { content, volumes, language };
}

/** "Volume 1" twice in one series (Index and Index SS share a page) gets the book's own slug prefix. */
function disambiguate(volumes: Volume[], seriesSlug: string): string[] {
    const counts = new Map<string, number>();
    for (const v of volumes) counts.set(v.title, (counts.get(v.title) ?? 0) + 1);

    return volumes.map((volume) => {
        if ((counts.get(volume.title) ?? 0) < 2) return volume.title;

        const slug = volume.chapterId.replace(/^\/book\/\d+\//, "");
        const extra = slug.startsWith(`${seriesSlug}-`) ? slug.slice(seriesSlug.length + 1) : "";
        const prefix = /^(.+?)-vol(?:ume)?-/.exec(extra)?.[1];
        if (!prefix) return volume.title;

        const words = prefix
            .split("-")
            .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)));

        return `${words.join(" ")} ${volume.title}`;
    });
}

/**
 * Printed volume numbers are used only when every volume has one and they rise; a series
 * page that mixes in a spin-off ("Volume 1" again) or unnumbered books falls back to the
 * position, so ordering and read progress stay consistent.
 */
export function volumeChapters(volumes: Volume[], language: string, seriesSlug: string): Chapter[] {
    const numbers = volumes.map((v) => v.number);
    const usable = numbers.every(
        (n, i) => n !== undefined && (i === 0 || n > (numbers[i - 1] as number)),
    );

    const titles = disambiguate(volumes, seriesSlug);

    return volumes.map((volume, index) => ({
        chapterId: volume.chapterId,
        index,
        number: usable ? (volume.number as number) : index + 1,
        volume: usable ? volume.number : undefined,
        title: titles[index] ?? volume.title,
        language,
        date: new Date(0),
        webUrl: volume.webUrl,
    }));
}

export function parseBook(html: string): { book: BookData; $: CheerioAPI } {
    const $ = load(html);
    const data = jsonLd($, "script#app-data")[0] ?? {};

    const properties = new Map<string, string>();
    if (Array.isArray(data.additionalProperty)) {
        for (const entry of data.additionalProperty as unknown[]) {
            const property = entry as { name?: unknown; value?: unknown };
            if (typeof property.name === "string" && typeof property.value === "string") {
                properties.set(property.name, property.value);
            }
        }
    }

    const dataName = typeof data.name === "string" ? data.name : "";

    const book: BookData = {
        name: dataName || text($("#book-title").first()),
        seriesTitle: properties.get("series_title"),
        epubFilename: properties.get("epub_filename"),
        language: typeof data.inLanguage === "string" ? data.inLanguage : undefined,
    };

    return { book, $ };
}

export function parseDdlIndex(html: string): DdlFolder[] {
    const $ = load(html);

    return $("#files a.folder")
        .toArray()
        .map((a) => ({
            href: $(a).attr("href") ?? "",
            title: (attr($(a), "title") ?? text($(a))).replace(/\/$/, "").trim(),
        }))
        .filter((folder) => folder.href && folder.title);
}

export function parseDdlFolder(html: string): string[] {
    const $ = load(html);

    return $("#files a.file")
        .toArray()
        .map((a) => attr($(a), "title") ?? text($(a)))
        .filter((name) => /\.epub$/i.test(name));
}

// The DDL index hands out the wrong novel now and then: a book page can name another
// series' file, and some folders list a sibling series' files. These decide whether a file
// name plausibly belongs to a given series and volume.

/** Letters and digits only, so "Re:ZERO" and "ReZero", or ": " and " - ", compare equal. */
export function normalizeTitle(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
}

/** "Overlord - Volume 05.5 [Yen Press][Kobo].epub" → series "Overlord", volume 5.5. */
function describeFile(name: string): { series: string; volume?: number } {
    const match = /^(.*?)\s+-\s+Volume\s+(\d+(?:\.\d+)?)\b/i.exec(name);
    if (match) {
        return {
            series: (match[1] as string).trim(),
            volume: Number.parseFloat(match[2] as string),
        };
    }

    const series = name
        .replace(/\.epub$/i, "")
        .replace(/\s*\[[^\]]*\]\s*/g, " ")
        .trim();

    return { series };
}

/** The volume a reader page is for, from names like "Overlord, Vol. 5.5: …" or "… Volume 12". */
export function volumeOfBookName(name: string): number | undefined {
    const match = /\bVol(?:ume)?\.?\s*(\d+(?:\.\d+)?)/i.exec(name);
    return match ? Number.parseFloat(match[1] as string) : undefined;
}

/**
 * Whether a file is safely this series and volume. File names often shorten the title
 * ("86 - Volume 01" for "86--EIGHTY-SIX"), so a miss does not mean the file is wrong — only
 * that another file has to match strictly before it replaces the site's choice.
 */
export function fileMatches(
    name: string,
    seriesTitle: string,
    volume: number | undefined,
): boolean {
    const file = describeFile(name);
    if (normalizeTitle(file.series) !== normalizeTitle(seriesTitle)) return false;

    return volume === undefined || file.volume === volume;
}
