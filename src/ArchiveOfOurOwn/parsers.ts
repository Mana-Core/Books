/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    AdditionalInfoType,
    ContentType,
    PublicationStatus,
    type AdditionalInfoSection,
    type Content,
    type Highlight,
    type Option,
    type PagedSearchResult,
    type SortOption,
    type Tag,
    type User,
} from "@mana-app/types";

import type { ListedChapter } from "../lib/books";
import { parseDate } from "../lib/dates";
import {
    cleanChapterHtml,
    load,
    summaryOf,
    text,
    type Cheerio,
    type CheerioAPI,
    type Element,
} from "../lib/html";
import { chapterLanguage } from "../lib/language";
import { SourceError } from "../lib/http";
import { resolveUrl } from "../lib/url";
import { BASE_URL, ratingOf } from "./model";

/** The lists of AO3's own work-search form, keyed by what they fill in the source's form. */
export type SearchFormLists = {
    ratings: Option[];
    warnings: Option[];
    categories: Option[];
    completion: Option[];
    crossover: Option[];
    languages: Option[];
    sorts: SortOption[];
};

/**
 * The page always preselects "Descending"; otwarchive's WorkSearchForm only turns that to
 * ascending for the alphabetical columns when no direction is sent.
 */
const ALPHABETICAL = /_to_sort_on$/;

export function parseSearchForm(html: string): SearchFormLists {
    const $ = load(html);
    const form = $("form#new_work_search");

    // Checkbox groups post as `name[]`.
    const field = (name: string, many = false) => {
        const suffix = many ? "[]" : "";

        return choices($, form, `work_search[${name}]${suffix}`);
    };

    const ratings = field("rating_ids");
    // An error page can still answer 200; caching its empty lists would hide them for a day.
    if (!ratings.length) throw new SourceError("AO3's search form could not be read.");

    const preselected = form
        .find('select[name="work_search[sort_column]"] option[selected]')
        .attr("value");
    const sorts = field("sort_column").map((sort) => ({
        ...sort,
        isDefault: sort.id === preselected || undefined,
        isOrderable: true,
        defaultAscending: ALPHABETICAL.test(sort.id),
    }));

    return {
        ratings,
        warnings: field("archive_warning_ids", true),
        categories: field("category_ids", true),
        completion: field("complete"),
        crossover: field("crossover"),
        languages: field("language_id"),
        sorts,
    };
}

/** A select's options, or the labelled checkboxes or radios sharing `name`. */
function choices($: CheerioAPI, form: Cheerio<Element>, name: string): Option[] {
    const select = form.find(`select[name="${name}"]`);

    const fromSelect = () =>
        select
            .find("option")
            .toArray()
            .map((option) => ({ id: $(option).attr("value") ?? "", title: text($(option)) }));

    const fromInputs = () =>
        form
            .find(`input[name="${name}"]:not([type=hidden])`)
            .toArray()
            .map((input) => {
                const label = form.find(`label[for="${$(input).attr("id")}"]`);

                return { id: $(input).attr("value") ?? "", title: text(label) };
            });

    const pairs = select.length ? fromSelect() : fromInputs();

    return pairs.filter((option) => option.id && option.title);
}

export function parseSearch(html: string): PagedSearchResult {
    const $ = load(html);
    const results: Highlight[] = [];

    $("li.work.blurb").each((_, element) => {
        const blurb = $(element);
        const id = /^work_(\d+)$/.exec(blurb.attr("id") ?? "")?.[1];
        if (!id) return;

        const heading = blurb.find(".header h4.heading").first();
        const ownLink = text(heading.find(`a[href="/works/${id}"]`).first());
        const title = ownLink || text(heading.find("a").first());
        const authors = heading
            .find('a[rel="author"]')
            .toArray()
            .map((a) => text($(a)));

        const rating = ratingOf(blurb.find("ul.required-tags span.rating").attr("title"));
        const words = text(blurb.find("dd.words"));
        const chapters = text(blurb.find("dd.chapters"));
        const kudos = text(blurb.find("dd.kudos"));

        const badgeText = [rating?.letter, words ? compactCount(words) : undefined]
            .filter(Boolean)
            .join(" · ");
        const info = [
            words ? { key: "Words", value: words } : undefined,
            chapters ? { key: "Chapters", value: chapters } : undefined,
            kudos ? { key: "Kudos", value: kudos } : undefined,
        ].filter((pair): pair is { key: string; value: string } => pair !== undefined);

        results.push({
            id,
            title,
            subtitle: bylineOf(authors, text(heading)),
            // AO3 has no cover art.
            cover: "",
            contentRating: rating?.rating,
            badge: badgeText ? { text: badgeText } : undefined,
            info,
            webUrl: `${BASE_URL}/works/${id}`,
        });
    });

    return { results, isLastPage: $("ol.pagination li.next a").length === 0 };
}

/** Anonymous and orphaned works carry no author link, only the bare word. */
function bylineOf(authors: string[], heading: string): string | undefined {
    if (authors.length) return authors.join(", ");
    if (/\bAnonymous\b/.test(heading)) return "Anonymous";

    return undefined;
}

/** "26,850" → "26.9k": the badge is a few characters wide. */
function compactCount(value: string): string {
    const n = Number.parseInt(value.replace(/[^\d]/g, ""), 10);
    if (!Number.isFinite(n)) return value;

    const trim = (formatted: string) => formatted.replace(/\.0$/, "");
    if (n >= 1_000_000) return `${trim((n / 1_000_000).toFixed(1))}M`;
    if (n >= 1_000) return `${trim((n / 1_000).toFixed(n >= 100_000 ? 0 : 1))}k`;

    return String(n);
}

const TAG_GROUPS: [selector: string, title: string][] = [
    ["dd.fandom.tags", "Fandoms"],
    ["dd.relationship.tags", "Relationships"],
    ["dd.character.tags", "Characters"],
    ["dd.freeform.tags", "Additional Tags"],
    ["dd.warning.tags", "Archive Warnings"],
    ["dd.category.tags", "Categories"],
];

function tagsIn($: CheerioAPI, node: Cheerio<Element>): Tag[] {
    return node
        .find("a.tag")
        .toArray()
        .map((a) => ({
            id: $(a).attr("href") ?? text($(a)),
            title: text($(a)),
            isNonInteractive: true,
        }));
}

type Author = { name: string; href: string };
type TagGroup = { title: string; tags: Tag[] };
type Stat = { key: string; value: string };

export function parseWork(html: string, id: string): { content: Content; language: string } {
    const $ = load(html);
    const meta = $("dl.work.meta").first();
    const preface = $("#workskin > .preface").first();

    const rating = text(meta.find("dd.rating.tags a.tag").first());
    const stats = meta.find("dd.stats dl.stats").first();
    const [posted, total] = text(stats.find("dd.chapters")).split("/");
    const complete = total !== undefined && total.trim() !== "?" && posted?.trim() === total.trim();

    const authors = preface
        .find('h3.byline a[rel="author"]')
        .toArray()
        .map((a) => ({ name: text($(a)), href: $(a).attr("href") ?? "" }));

    const groups = TAG_GROUPS.map(([selector, title]) => ({
        title,
        tags: tagsIn($, meta.find(selector).first()),
    }));

    const statItems = stats
        .find("dt")
        .toArray()
        .map((dt) => ({ key: text($(dt)).replace(/:$/, ""), value: text($(dt).next("dd")) }))
        .filter((pair) => pair.key && pair.value);

    const summaryNode = lineBreaks($, preface.find(".summary blockquote.userstuff").first());
    // Fandoms first: on AO3 they are what a reader scans for before anything else.
    const tags = groups
        .filter((g) => g.title !== "Archive Warnings" && g.title !== "Categories")
        .flatMap((g) => g.tags);

    const content: Content = {
        title: text(preface.find("h2.title")) || text($("h2.title.heading").first()),
        cover: "",
        summary: summaryOf($, summaryNode) || undefined,
        status: complete ? PublicationStatus.COMPLETED : PublicationStatus.ONGOING,
        contentType: ContentType.NOVEL,
        contentRating: ratingOf(rating)?.rating,
        additionalTitles: authors.length
            ? [`by ${authors.map((a) => a.name).join(", ")}`]
            : undefined,
        tags,
        additionalInfo: workInfo(authors, groups, statItems),
        webUrl: `${BASE_URL}/works/${id}`,
    };

    return { content, language: languageOf(meta.find("dd.language").attr("lang")) };
}

function workInfo(authors: Author[], groups: TagGroup[], stats: Stat[]): AdditionalInfoSection[] {
    const sections: AdditionalInfoSection[] = [];

    if (authors.length) {
        const items = authors.map((author) => ({
            type: AdditionalInfoType.Staff as const,
            id: author.href || author.name,
            title: author.name,
        }));
        sections.push({
            type: AdditionalInfoType.Staff,
            id: "creators",
            title: "Creators",
            hasMore: false,
            items,
        });
    }

    for (const group of groups) {
        if (!group.tags.length) continue;

        sections.push({
            type: AdditionalInfoType.Tags,
            id: group.title.toLowerCase().replace(/\s+/g, "-"),
            title: group.title,
            items: group.tags.map((tag) => ({ ...tag, type: AdditionalInfoType.Tags })),
        });
    }

    if (stats.length) {
        const items = stats.map((pair) => ({
            type: AdditionalInfoType.Tags as const,
            id: `stat-${pair.key}`,
            title: `${pair.key}: ${pair.value}`,
            isNonInteractive: true,
        }));
        sections.push({ type: AdditionalInfoType.Tags, id: "stats", title: "Stats", items });
    }

    return sections;
}

/** Summaries often break lines with `<br>` inside one paragraph; keep a gap there. */
function lineBreaks($: CheerioAPI, node: Cheerio<Element>): Cheerio<Element> {
    const copy = node.clone();
    copy.find("br").replaceWith(" ");

    return copy;
}

/** AO3 language codes are its own (`ptBR`, `zh`); the kit knows the common ISO ones. */
function languageOf(code: string | undefined): string {
    if (!code) return "en_US";

    const known = chapterLanguage(code, "");
    if (known) return known;

    const regional = /^([a-z]{2})([A-Z]{2})$/.exec(code);

    return regional ? `${regional[1]}_${regional[2]}` : code;
}

export function parseNavigate(html: string, id: string): ListedChapter[] {
    const $ = load(html);

    const chapters = $("ol.chapter.index li")
        .toArray()
        .map((li) => {
            const link = $(li).find(`a[href^="/works/${id}/chapters/"]`).first();
            const href = link.attr("href") ?? "";
            // "(2017-05-29)" is a plain date; Date.parse reads it as UTC midnight.
            const day = text($(li).find(".datetime")).replace(/[()]/g, "");

            return {
                chapterId: href,
                title: text(link),
                date: parseDate(day),
                webUrl: href ? `${BASE_URL}${href}` : undefined,
            };
        });

    return chapters.filter((chapter) => chapter.chapterId);
}

export function parseChapter(
    html: string,
    options: { url: string; includeNotes: boolean },
): { title: string; body: string } {
    const $ = load(html);
    const chapter = $("#chapters > .chapter").first();
    const scope = chapter.length ? chapter : $("#chapters").first();
    const body = scope.find("div.userstuff").first();
    if (!body.length) throw new SourceError("The chapter text could not be found on the page.");

    const clean = (node: Cheerio<Element>) =>
        cleanChapterHtml($, node, {
            baseUrl: options.url,
            remove: ["h3.landmark"],
        });

    // AO3 prints the work's own notes on the first chapter page (and on a one-chapter work),
    // and each chapter's notes around its text; all of them are kept, in reading order.
    const notes = (selectors: string[]) =>
        selectors
            .map((selector) => $.root().find(selector).first())
            .filter((node) => node.length > 0)
            .map(clean)
            .filter(Boolean)
            .join("");

    const parts: string[] = [];

    if (options.includeNotes) {
        const before = notes([
            "#workskin > .preface .notes blockquote.userstuff",
            "#chapters > .chapter > .chapter.preface #notes blockquote.userstuff",
        ]);
        if (before) parts.push(`<aside><h4>Notes</h4>${before}</aside><hr>`);
    }

    parts.push(clean(body));

    if (options.includeNotes) {
        const after = notes([
            "#chapters > .chapter .end.notes blockquote.userstuff",
            "#work_endnotes blockquote.userstuff",
        ]);
        if (after) parts.push(`<hr><aside><h4>End Notes</h4>${after}</aside>`);
    }

    const workTitle = text($("#workskin > .preface h2.title").first());
    const chapterTitle = text(chapter.find("h3.title").first());

    return { title: chapterTitle || workTitle || "Chapter", body: parts.join("") };
}

/** The signed-in user from the header greeting, which AO3 renders only for a session. */
export function parseGreeting(html: string): User | null {
    const $ = load(html);
    const greeting = $("#greeting");
    if (!greeting.length) return null;

    const link = greeting.find('ul.user li.dropdown > a[href^="/users/"]').first();
    const slug = /^\/users\/([^/?#]+)/.exec(link.attr("href") ?? "")?.[1] ?? "";
    const handle = decodeURIComponent(slug);
    if (!handle) return null;

    const avatar = resolveUrl(BASE_URL, greeting.find("p.icon img").attr("src"));

    return { handle, displayName: handle, avatar };
}

export function csrfToken(html: string): string | undefined {
    return load(html)('meta[name="csrf-token"]').attr("content") || undefined;
}
