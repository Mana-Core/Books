/* SPDX-License-Identifier: GPL-3.0-or-later */

import type { HttpClient, Option } from "@mana-app/types";

import { Memo, SiteData } from "../lib/cache";
import { getJson } from "../lib/http";
import {
    BASE_URL,
    CATALOGUE_TTL_MS,
    MIN_GENRE_BOOKS,
    MIN_TAG_BOOKS,
    MTL_TAG,
    type Metadata,
    type ShelfEntry,
} from "./model";

export type Filters = {
    query?: string;
    type?: string;
    translation?: string;
    include: string[];
    exclude: string[];
    hideMature: boolean;
};

type Shelf = {
    books: ShelfEntry[];
    byName: Map<string, ShelfEntry>;
};

type Ranked = {
    entry: ShelfEntry;
    score: number;
};

const NO_MATCH = Number.POSITIVE_INFINITY;

function byTitle(a: ShelfEntry, b: ShelfEntry): number {
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
}

/** Orders for equally ranked series; the shelf itself is in popularity order, which ties keep. */
const ORDERS: Record<string, (a: ShelfEntry, b: ShelfEntry) => number> = {
    updated: (a, b) => (b.updated ?? 0) - (a.updated ?? 0),
    most: (a, b) => b.count - a.count,
    fewest: (a, b) => a.count - b.count,
    az: byTitle,
    za: (a, b) => byTitle(b, a),
};

/**
 * The site keeps its whole catalogue in the browser and filters, ranks and sorts it there;
 * this does the same with one copy of the shelf (about 2 MB compressed) and the metadata
 * (about 1.3 MB), the latter only fetched once a search or the filter lists need it.
 */
export class Catalogue {
    private readonly shelf = new Memo(() => this.loadShelf(), CATALOGUE_TTL_MS);
    private readonly metadata = new Memo(() => this.loadMetadata(), CATALOGUE_TTL_MS);

    private readonly genreList = new SiteData("cyrisia.genres", () => {
        return this.labelOptions("genres", MIN_GENRE_BOOKS);
    });

    private readonly tagList = new SiteData("cyrisia.tags", () => {
        return this.labelOptions("tags", MIN_TAG_BOOKS);
    });

    constructor(private readonly http: () => HttpClient) {}

    /** The genre chips for the search form; empty when the site has never answered. */
    genres(): Promise<Option[]> {
        return this.genreList.getOr([]);
    }

    /** The tag chips for the search form; empty when the site has never answered. */
    tags(): Promise<Option[]> {
        return this.tagList.getOr([]);
    }

    /** The series a list endpoint names, in its order; names the shelf lacks are dropped. */
    async named(names: string[]): Promise<ShelfEntry[]> {
        const { byName } = await this.shelf.get();

        return names.flatMap((name) => byName.get(name) ?? []);
    }

    async find(filters: Filters, sort: string): Promise<ShelfEntry[]> {
        const { books } = await this.shelf.get();

        const needsLabels =
            Boolean(filters.query || filters.translation) ||
            filters.include.length > 0 ||
            filters.exclude.length > 0;
        const metadata = needsLabels ? await this.metadata.get() : {};

        const ranked: Ranked[] = [];
        for (const entry of books) {
            const meta = metadata[entry.name];
            if (!matches(entry, meta, filters, needsLabels)) continue;

            const score = filters.query ? rank(entry.name, meta?.aliases, filters.query) : 0;
            if (score === NO_MATCH) continue;

            ranked.push({ entry, score });
        }

        const order = ORDERS[sort] ?? (() => 0);
        ranked.sort((x, y) => x.score - y.score || order(x.entry, y.entry));

        return ranked.map((item) => item.entry);
    }

    private async loadShelf(): Promise<Shelf> {
        const all = await getJson<ShelfEntry[]>(this.http(), `${BASE_URL}/api/bookshelf`);

        // Comics share the catalogue but open in an image reader this source does not serve.
        const books = all.filter((entry) => entry.kind === "ln" || entry.kind === "webnovel");
        const byName = new Map(books.map((entry) => [entry.name, entry]));

        return { books, byName };
    }

    private loadMetadata(): Promise<Record<string, Metadata>> {
        return getJson<Record<string, Metadata>>(this.http(), `${BASE_URL}/api/metadata-all`);
    }

    /**
     * The genre or tag chips the site builds from the metadata (`buildGenreList`). Only books
     * on the shelf count, and labels on fewer than `minimum` books are left out: the metadata
     * is hand-edited, and its long tail is stray spellings ("Slice of Lif") and one-offs.
     * Labels come in either case ("Sci-fi", "Sci-Fi"); the title is the spelling most use.
     */
    private async labelOptions(field: "genres" | "tags", minimum: number): Promise<Option[]> {
        const [{ byName }, metadata] = await Promise.all([this.shelf.get(), this.metadata.get()]);

        // Label id → how often each spelling of it is used.
        const spellingsById = new Map<string, Map<string, number>>();

        for (const [name, meta] of Object.entries(metadata)) {
            if (!byName.has(name)) continue;

            const seenOnThisBook = new Set<string>();
            for (const raw of meta[field] ?? []) {
                const title = raw.trim();
                const id = title.toLowerCase();
                if (!id || id === MTL_TAG || seenOnThisBook.has(id)) continue;
                seenOnThisBook.add(id);

                const spellings = spellingsById.get(id) ?? new Map<string, number>();
                spellings.set(title, (spellings.get(title) ?? 0) + 1);
                spellingsById.set(id, spellings);
            }
        }

        const options: Option[] = [];
        for (const [id, spellings] of spellingsById) {
            const counts = [...spellings].sort((a, b) => b[1] - a[1]);
            const books = counts.reduce((sum, [, count]) => sum + count, 0);
            if (books < minimum) continue;

            const mostUsed = counts[0]?.[0] ?? id;
            options.push({ id, title: mostUsed });
        }

        return options.sort((a, b) => {
            return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
        });
    }
}

function matches(
    entry: ShelfEntry,
    meta: Metadata | undefined,
    filters: Filters,
    checkLabels: boolean,
): boolean {
    if (filters.type && entry.kind !== filters.type) return false;
    if (filters.hideMature && (entry.mature || meta?.mature)) return false;
    if (!checkLabels) return true;

    const labels = new Set<string>();
    for (const label of [...(meta?.genres ?? []), ...(meta?.tags ?? [])]) {
        labels.add(label.toLowerCase());
    }

    if (filters.translation === "mtl" && !labels.has(MTL_TAG)) return false;
    if (filters.translation === "human" && labels.has(MTL_TAG)) return false;

    const hasAllIncluded = filters.include.every((label) => labels.has(label));
    const hasAnyExcluded = filters.exclude.some((label) => labels.has(label));

    return hasAllIncluded && !hasAnyExcluded;
}

/** Lower case with everything but letters and digits removed: "Re:ZERO" and "rezero" alike. */
function fold(value: string): string {
    return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * The site's own ranking, simplified: exact name, exact alias, name prefix, alias prefix,
 * then substring — as typed, then with spelling folded away. Lower is better.
 */
function rank(name: string, aliases: Metadata["aliases"], query: string): number {
    const q = query.toLowerCase();
    const title = name.toLowerCase();

    // Most entries list their aliases; some carry a single string.
    const others = [aliases ?? []]
        .flat()
        .filter((alias): alias is string => typeof alias === "string")
        .map((alias) => alias.toLowerCase());

    if (title === q) return 0;
    if (others.includes(q)) return 1;
    if (title.startsWith(q)) return 2;
    if (others.some((alias) => alias.startsWith(q))) return 3;
    if (title.includes(q) || others.some((alias) => alias.includes(q))) return 4;

    const foldedQuery = fold(q);
    if (foldedQuery.length < 2) return NO_MATCH;

    const folded = [title, ...others].map(fold);
    if (folded.includes(foldedQuery)) return 1;
    if (folded.some((value) => value.startsWith(foldedQuery))) return 2;
    if (folded.some((value) => value.includes(foldedQuery))) return 4;

    return NO_MATCH;
}
