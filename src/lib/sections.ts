/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    SectionStyle,
    type PageSection,
    type PagedSearchResult,
    type ResolvedPageSection,
    type SearchRequest,
} from "@mana-app/types";

import { SourceError } from "./http";

const HERO_ITEMS = 10;

export type HomeRow = {
    id: string;
    title: string;
    subtitle?: string;
    style?: SectionStyle;
    /** One page of the row. The home row shows page 1; "View more" pages through the rest. */
    load(page: number): Promise<PagedSearchResult>;
};

/**
 * Home rows that double as lists: each row's "View more" is a search request carrying
 * its `listId`, so the row and its full list come from the same loader and cannot drift.
 */
export class Home {
    constructor(private readonly rows: () => HomeRow[] | Promise<HomeRow[]>) {}

    async sections(): Promise<PageSection[]> {
        const rows = await this.rows();

        return rows.map((row) => ({
            id: row.id,
            title: row.title,
            subtitle: row.subtitle,
            style: row.style ?? SectionStyle.SimpleSingleRow,
            viewMoreLink: { request: { page: 1, listId: row.id } },
        }));
    }

    async resolve(id: string): Promise<ResolvedPageSection> {
        const row = await this.row(id);
        const result = await row.load(1);

        // A hero pages one banner per item, so a full result page makes an endless pager;
        // "View more" still lists everything.
        const isHero =
            row.style === SectionStyle.SimpleHero || row.style === SectionStyle.SimpleHeroPaged;

        return { items: isHero ? result.results.slice(0, HERO_ITEMS) : result.results };
    }

    /** Answers a search request when it is a "View more" list; `undefined` otherwise. */
    async list(request: SearchRequest): Promise<PagedSearchResult | undefined> {
        if (!request.listId) return undefined;

        const row = await this.row(request.listId);

        return row.load(request.page || 1);
    }

    private async row(id: string): Promise<HomeRow> {
        const rows = await this.rows();

        const row = rows.find((r) => r.id === id);
        if (!row) throw new SourceError(`Unknown section "${id}".`);

        return row;
    }
}
