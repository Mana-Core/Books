/* SPDX-License-Identifier: GPL-3.0-or-later */

import { load, type Cheerio, type CheerioAPI } from "cheerio";
import type { AnyNode, Element } from "domhandler";

import { resolveUrl } from "./url";

export { load };
export type { AnyNode, Cheerio, CheerioAPI, Element };

/** Text with whitespace collapsed. */
export function text(node: Cheerio<AnyNode>): string {
    return node.text().replace(/\s+/g, " ").trim();
}

const BADGE = /^(?:hot|new|updated?|complete(?:d)?|free|vip|trending|popular|exclusive|original)$/i;

/**
 * A name as scraped from a card, cleaned for display: layout newlines and runs of spaces
 * collapse, and badge words the card printed on their own line above the name ("HOT",
 * "NEW") are dropped. A badge word is only dropped when a real name follows on a later
 * line, so a title that merely starts with "Hot" is left alone.
 */
export function cleanTitle(value: string): string {
    const lines = value
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean);

    while (lines.length > 1 && BADGE.test(lines[0] as string)) lines.shift();

    return lines.join(" ");
}

/** The first non-empty attribute among `names` — lazy loaders move `src` elsewhere. */
export function attr(node: Cheerio<AnyNode>, ...names: string[]): string | undefined {
    for (const name of names) {
        const value = node.attr(name)?.trim();
        if (value) return value;
    }

    return undefined;
}

export function imageOf(node: Cheerio<AnyNode>, base: string): string {
    const src = attr(node, "data-src", "data-lazy-src", "data-original", "src");

    // A `srcset`-style value lists its first candidate first.
    return resolveUrl(base, src?.split(/\s+/)[0]) ?? "";
}

/** Paragraphs from an HTML summary, keeping the breaks the site wrote. */
export function summaryOf($: CheerioAPI, node: Cheerio<AnyNode>): string {
    const blocks = node.find("p");
    if (blocks.length === 0) return text(node);

    const paragraphs = blocks.toArray().map((p) => text($(p)));

    return paragraphs.filter(Boolean).join("\n\n");
}

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export type CleanOptions = {
    /** Base for relative links and images. */
    baseUrl: string;
    /** Site-specific selectors to remove: ads, navigation, comment widgets. */
    remove?: string[];
    /**
     * Paragraphs whose text matches anywhere are dropped — watermarks and "read at" lines.
     * Anchor the pattern (`^…$`) to require a whole-text match.
     */
    dropText?: RegExp[];
};

const ALWAYS_REMOVE = [
    "script",
    "style",
    "noscript",
    "iframe",
    "form",
    "button",
    "input",
    "select",
    "textarea",
    "ins",
    "video",
    "audio",
    "link",
    "meta",
    ".adsbygoogle",
    "[id^=ad-]",
    "[class*=advert]",
];

const KEPT_ATTRIBUTES: Record<string, string[]> = {
    a: ["href"],
    img: ["src", "alt"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan"],
    ol: ["start"],
};

/**
 * The reading body of a chapter as clean markup. Images stay, with absolute URLs: the app
 * downloads them through the source and leaves out any that fail to load.
 */
export function cleanChapterHtml(
    $: CheerioAPI,
    root: Cheerio<Element>,
    options: CleanOptions,
): string {
    const body = root.clone();

    const unwanted = [...ALWAYS_REMOVE, ...(options.remove ?? [])];
    body.find(unwanted.join(",")).remove();

    // Images: absolute URLs, or gone when there is nothing the app could load.
    body.find("img").each((_, element) => {
        const image = $(element);
        const src = imageOf(image, options.baseUrl);

        if (/^https?:\/\//.test(src)) {
            image.attr("src", src);
        } else {
            image.remove();
        }
    });

    // Attributes: only the few that carry meaning, with links made absolute.
    body.find("*").each((_, element) => {
        const keep = KEPT_ATTRIBUTES[element.tagName] ?? [];
        for (const name of Object.keys(element.attribs)) {
            if (!keep.includes(name)) delete element.attribs[name];
        }

        if (element.tagName !== "a") return;

        const href = resolveUrl(options.baseUrl, element.attribs.href);
        if (href) {
            element.attribs.href = href;
        } else {
            delete element.attribs.href;
        }
    });

    // Blocks: empty ones and watermark lines go.
    body.find("p, div, span").each((_, element) => {
        const node = $(element);
        const content = text(node);

        const isEmpty = !content && node.find("img, br, hr").length === 0;
        const isWatermark = options.dropText?.some((pattern) => pattern.test(content)) ?? false;

        if (isEmpty || isWatermark) node.remove();
    });

    return (body.html() ?? "").trim();
}

const INLINE_TAGS = /&lt;(\/?)(em|strong|i|b|u|s|sup|sub)&gt;|&lt;br\s*\/?&gt;/gi;

/**
 * Plain-text chapter bodies (one paragraph per line, as APIs serve them) as paragraphs.
 * The few inline tags such APIs leave in the text are kept as markup; everything else is escaped.
 */
export function textToHtml(value: string): string {
    const lines = value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    const paragraphs = lines.map((line) => {
        const markup = escapeHtml(line).replace(INLINE_TAGS, restoreInlineTag);
        return `<p>${markup}</p>`;
    });

    return paragraphs.join("");
}

function restoreInlineTag(_tag: string, close: string, name?: string): string {
    if (!name) return "<br/>";

    return `<${close}${name.toLowerCase()}>`;
}

/** A standalone document for the book reader. */
export function chapterDocument(title: string, bodyHtml: string, language = "en"): string {
    return [
        "<!DOCTYPE html>",
        `<html lang="${escapeHtml(language)}">`,
        `<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>`,
        `<body>${bodyHtml}</body>`,
        "</html>",
    ].join("");
}
