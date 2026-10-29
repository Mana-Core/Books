/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    ContentRating,
    ContentType,
    PublicationStatus,
    type Content,
    type Highlight,
    type HttpClient,
    type Option,
    type PagedSearchResult,
    type SortOption,
    type Tag,
} from "@mana-app/types";

import type { ListedChapter } from "../lib/books";
import { parseDate } from "../lib/dates";
import { load, summaryOf } from "../lib/html";
import { getJson, getText, SourceError } from "../lib/http";
import { withQuery } from "../lib/url";
import {
    apiOf,
    BEST_MATCH,
    type ApiChapterRef,
    type ApiEnvelope,
    type ApiGenre,
    type ApiNamed,
    type ApiPage,
    type ApiRejection,
    type ApiTitle,
} from "./model";

/** A title's site path: the API's `url`, or the slug when an endpoint leaves it out. */
function titlePath(title: ApiTitle): string | undefined {
    const path = title.url ?? (title.slug ? `/${title.slug}` : undefined);

    return path && /^\/[^/]+$/.test(path) ? path : undefined;
}

function toHighlight(title: ApiTitle, origin: string): Highlight | undefined {
    const id = titlePath(title);
    if (!id || !title.name) return undefined;

    const latest = title.latest_chapters?.[0]?.name;
    const count = title.stats?.chapters_count;
    const subtitle = latest ?? (count ? `${count} chapters` : undefined);

    return {
        id,
        title: title.name,
        subtitle,
        cover: title.cover ?? "",
        webUrl: `${origin}${id}`,
    };
}

export function toResults(titles: ApiTitle[] | undefined, origin: string): Highlight[] {
    const seen = new Set<string>();
    const highlights = (titles ?? []).map((t) => toHighlight(t, origin));

    return highlights.filter(
        (h): h is Highlight => h !== undefined && !seen.has(h.id) && Boolean(seen.add(h.id)),
    );
}

export function toPage(page: ApiPage | undefined, origin: string): PagedSearchResult {
    const pagination = page?.pagination;
    const hasNext =
        pagination?.has_next ??
        (pagination?.page !== undefined &&
            pagination.total_pages !== undefined &&
            pagination.page < pagination.total_pages);

    return { results: toResults(page?.items, origin), isLastPage: !hasNext };
}

function statusOf(value: string | undefined): PublicationStatus | undefined {
    switch (value?.toLowerCase().replace(/[^a-z]/g, "")) {
        case "ongoing":
            return PublicationStatus.ONGOING;
        case "completed":
            return PublicationStatus.COMPLETED;
        case "hiatus":
            return PublicationStatus.HIATUS;
        case "cancelled":
        case "canceled":
            return PublicationStatus.CANCELLED;
        default:
            return undefined;
    }
}

/** Distinct names; the API repeats an author once per role. */
function names(list: ApiNamed[] | null | undefined): string[] {
    const trimmed = (list ?? []).map((n) => n.name?.trim() ?? "").filter(Boolean);

    return [...new Set(trimmed)];
}

function tagsOf(list: ApiNamed[] | null | undefined, kind: string): Tag[] {
    return (list ?? [])
        .filter((n) => n.name)
        .map((n) => ({
            id: `${kind}:${n.slug ?? n.name}`,
            title: n.name as string,
            isNonInteractive: true,
        }));
}

export function toContent(title: ApiTitle, webUrl: string): Content {
    const name = title.name ?? "";
    const alternatives = names(title.alt_names).filter(
        (alt) => alt.toLowerCase() !== name.toLowerCase(),
    );
    const authors = names(title.authors);
    const byline = authors.length ? [`by ${authors.join(", ")}`] : [];

    // Summaries arrive as HTML paragraphs with <br> inside them.
    const paragraphs = (title.summary ?? "").replace(/<br\s*\/?>/gi, "</p><p>");
    const $ = load(`<div id="summary">${paragraphs}</div>`);

    const seenTags = new Set<string>();
    const tags = [...tagsOf(title.genres, "genre"), ...tagsOf(title.tags, "tag")].filter(
        (t) => !seenTags.has(t.title.toLowerCase()) && Boolean(seenTags.add(t.title.toLowerCase())),
    );

    return {
        title: name,
        cover: title.cover ?? "",
        summary: summaryOf($, $("#summary")),
        status: statusOf(title.status),
        contentType: ContentType.NOVEL,
        contentRating: title.is_adult ? ContentRating.MATURE : undefined,
        additionalTitles: [...alternatives, ...byline],
        tags,
        webUrl,
    };
}

/** The API lists chapters newest first; the app numbers from the oldest. */
export function toChapters(list: ApiChapterRef[] | undefined, origin: string): ListedChapter[] {
    const rows = list ?? [];
    const first = Number(rows[0]?.number);
    const last = Number(rows[rows.length - 1]?.number);
    // Checked rather than assumed, so a change of order upstream cannot flip the book.
    const oldestFirst = Number.isFinite(first) && Number.isFinite(last) && first < last;

    const chapters = rows
        .filter((c) => c.url && /^\/[^/]+\/[^/]+$/.test(c.url))
        .map((c) => ({
            chapterId: c.url as string,
            title: c.name?.trim() || `Chapter ${c.number ?? ""}`.trim(),
            date: parseDate(c.updated_at),
            webUrl: `${origin}${c.url}`,
        }));

    return oldestFirst ? chapters : chapters.reverse();
}

export async function siteGenres(http: HttpClient, origin: string): Promise<Option[]> {
    const url = `${apiOf(origin)}/genres`;
    const { data } = await getJson<ApiEnvelope<{ items?: ApiGenre[] }>>(http, url);

    return (data?.items ?? []).flatMap((g) =>
        g.slug && g.name ? [{ id: g.slug, title: g.name }] : [],
    );
}

/** The `{id:"…",name:"…"}` entries of the array literal in a script that holds `{id:"<anchor>"`. */
function menuWith(script: string, anchor: string): Option[] {
    const pattern = new RegExp(`\\[[^\\[\\]]*\\{id:"${anchor}",name:[^\\[\\]]*\\]`);
    const list = pattern.exec(script)?.[0] ?? "";
    const entries = [...list.matchAll(/\{id:"([^"]*)",name:"([^"]*)"/g)];

    return entries.map(([, id = "", title = ""]) => ({ id, title }));
}

/** Per filter, the values the API accepts, as its 400 for an invalid value lists them. */
async function acceptedValues(http: HttpClient, origin: string): Promise<Map<string, string[]>> {
    const url = withQuery(`${apiOf(origin)}/titles/search`, { sort: "-", status: "-", limit: 1 });
    const response = await http.get(url);
    const { details } = await response.json<ApiRejection>();

    const fields = (details ?? []).map((d): [string, string[]] => {
        const values = /one of:(.*)$/.exec(d.message ?? "")?.[1] ?? "";
        return [d.field ?? "", values.split(",").map((v) => v.trim())];
    });

    return new Map(fields);
}

export type SearchMenus = { sorts: SortOption[]; statuses: Option[] };
export const NO_MENUS: SearchMenus = { sorts: [], statuses: [] };

/**
 * The sort and status menus of the site's search page, which only its Next.js page script
 * defines. They also list values the API rejects (A-Z, Hiatus, Cancelled), so each is cut
 * down to what the API says it accepts.
 */
export async function siteMenus(http: HttpClient, origin: string): Promise<SearchMenus> {
    const page = await getText(http, `${origin}/search`);
    const script = /\/_next\/static\/chunks\/pages\/search-[\w-]+\.js/.exec(page)?.[0];
    if (!script) throw new SourceError("NovelBuddy's search page did not name its script.");

    const [menus, accepted] = await Promise.all([
        getText(http, `${origin}${script}`),
        acceptedValues(http, origin),
    ]);
    const allowed = (field: string) => (option: Option) =>
        accepted.get(field)?.includes(option.id) ?? false;

    const sorts = menuWith(menus, BEST_MATCH)
        .filter((o) => o.id === BEST_MATCH || allowed("sort")(o))
        // Every API sort takes `order=asc`; relevance has no reverse.
        .map(
            (o): SortOption =>
                o.id === BEST_MATCH ? { ...o, isDefault: true } : { ...o, isOrderable: true },
        );
    if (sorts.length < 2) throw new SourceError("NovelBuddy's sort menu could not be read.");

    const statuses = menuWith(menus, "ongoing").filter(allowed("status"));

    return { sorts, statuses };
}
