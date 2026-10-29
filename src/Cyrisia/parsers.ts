/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    ContentType,
    PublicationStatus,
    type Chapter,
    type Content,
    type Highlight,
} from "@mana-app/types";

import { formatBytes, sequenceChapters } from "../lib/books";
import { cleanTitle } from "../lib/html";
import { BASE_URL, type Series, type ShelfEntry } from "./model";

type Volume = Series["volumes"][number];

const enc = encodeURIComponent;

function seriesUrl(name: string): string {
    return `${BASE_URL}/series/${enc(name)}`;
}

export function readUrl(series: string, file: string): string {
    return `${BASE_URL}/read/${enc(series)}/${enc(file)}`;
}

/** The book file itself; the site serves it to its reader page, not to a bare request. */
export function fileUrl(series: string, file: string): string {
    return `${BASE_URL}/bibi-bookshelf/${enc(series)}/${enc(file)}`;
}

function coverUrl(series: string, firstFile: string | undefined): string {
    const url = `${BASE_URL}/api/cover?series=${enc(series)}`;

    return firstFile ? `${url}&v=${enc(firstFile)}` : url;
}

export function plural(count: number, unit: string): string {
    return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

export function toHighlight(entry: ShelfEntry): Highlight {
    const subtitle =
        entry.kind === "webnovel"
            ? `Web Novel · ${plural(entry.count, "chapter")}`
            : `Light Novel · ${plural(entry.count, "volume")}`;

    return {
        id: entry.name,
        title: entry.name,
        cover: coverUrl(entry.name, entry.epubs[0]),
        subtitle,
        webUrl: seriesUrl(entry.name),
    };
}

const STATUS: Record<string, PublicationStatus> = {
    ongoing: PublicationStatus.ONGOING,
    releasing: PublicationStatus.ONGOING,
    publishing: PublicationStatus.ONGOING,
    completed: PublicationStatus.COMPLETED,
    finished: PublicationStatus.COMPLETED,
    hiatus: PublicationStatus.HIATUS,
    cancelled: PublicationStatus.CANCELLED,
    discontinued: PublicationStatus.CANCELLED,
};

export function toContent(series: Series): Content {
    const meta = series.metadata ?? {};

    const otherTitles = [meta.title_ja, meta.romaji, ...(meta.aliases ?? [])].filter(
        (title): title is string => Boolean(title) && title !== series.name,
    );

    const labels = [...(meta.genres ?? []), ...(meta.tags ?? [])];
    const tags = labels.map((label) => ({
        id: label.toLowerCase(),
        title: label,
        isNonInteractive: true,
    }));

    return {
        title: meta.title_en || series.name,
        cover: meta.cover_url || coverUrl(series.name, series.volumes[0]?.filename),
        summary: meta.synopsis?.trim() || undefined,
        status: STATUS[(meta.publication_status ?? "").toLowerCase()],
        contentType: ContentType.NOVEL,
        additionalTitles: [...new Set(otherTitles)],
        tags,
        webUrl: seriesUrl(series.name),
    };
}

const VERSION = /\{v(\d+)\}/i;

/** Where a book's own label starts inside a release file name. */
const LABEL =
    /\b(?:Short Story Collection|Side Story|Volume|Vol\.?|Book|Chapters?|Part|v(?=\d))\s*\d/i;

/** Bracket groups that describe the book rather than the release: "[Book 1]", "[Chapters 73-174]". */
const DESCRIPTOR = /\[((?:Book|Vol(?:ume)?|Chapters?|Part)\b[^\]]*)\]/i;

/** The leading number of a text chapter's file name: "0042 - The Duel.txt". */
const CHAPTER_NUMBER = /^(\d{1,6})\s*-\s*/;

function isText(file: string): boolean {
    return /\.txt$/i.test(file);
}

/**
 * A file name as a chapter title. Release names repeat the series (often spelt
 * differently, "Re-ZERO" for "ReZero") and carry publisher and ripper brackets, so the
 * title is the book's own label — "Volume 3", "Short Story Collection 2", "Book 1".
 */
function titleOf(file: string): string {
    const base = file.replace(/\.(epub|txt)$/i, "");

    if (isText(file)) return cleanTitle(base.replace(CHAPTER_NUMBER, ""));

    const descriptor = DESCRIPTOR.exec(base)?.[1];
    const withoutBrackets = base
        .replace(VERSION, "")
        .replace(/\[[^\]]*\]/g, "")
        .trim();

    const labelStart = LABEL.exec(withoutBrackets)?.index;
    const label =
        labelStart === undefined
            ? (descriptor ?? withoutBrackets)
            : withoutBrackets.slice(labelStart);

    const spelledOut = label
        .replace(/^v(?=\d)/i, "Volume ")
        .replace(/\b(Volume|Vol\.?|Book|Part|Collection|Chapters?)\s*0+(\d)/gi, "$1 $2")
        .replace(/\s+-\s*$/, "");

    return cleanTitle(spelledOut);
}

/**
 * The API lists files in the site's reading order (books by number, short stories among
 * them, then text chapters). A re-release ("{v2}") takes its original's place rather than
 * sitting beside it as a second copy of the same book.
 */
function latestReleases(volumes: Volume[]): Volume[] {
    const slots = new Map<string, { volume: Volume; version: number }>();

    for (const volume of volumes) {
        const key = volume.filename.replace(VERSION, "").toLowerCase();
        const version = Number(VERSION.exec(volume.filename)?.[1] ?? 1);

        const known = slots.get(key);
        if (!known || version > known.version) slots.set(key, { volume, version });
    }

    return [...slots.values()].map((slot) => slot.volume);
}

export function toChapters({ name, volumes }: Series): Chapter[] {
    const listed = latestReleases(volumes).map((file) => {
        const title = titleOf(file.filename);

        if (isText(file.filename)) {
            const number = Number.parseInt(CHAPTER_NUMBER.exec(file.filename)?.[1] ?? "", 10);

            return {
                chapterId: file.filename,
                title,
                number: number || undefined,
                webUrl: readUrl(name, file.filename),
            };
        }

        const size = formatBytes(file.size_bytes);

        return {
            chapterId: file.filename,
            title: size ? `${title} · ${size}` : title,
            webUrl: readUrl(name, file.filename),
        };
    });

    return sequenceChapters(listed, "en_US");
}
