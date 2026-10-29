/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    SearchExcludableMultiPicker,
    SearchExcludableMultiPickerSheet,
    SearchListSection,
    SearchMenuPicker,
    SearchMultiPicker,
    SearchMultiPickerSheet,
    SearchPickerSheet,
    SearchTagsSection,
    type Option,
    SearchSectionType,
    type SearchFieldBase,
    type SearchForm,
    type SearchListField,
    type SearchRequest,
    type SearchSection,
    type SortOption,
} from "@mana-app/types";

type Filters = Record<string, unknown>;

function filtersOf(request: SearchRequest): Filters {
    return (request.filters ?? {}) as Filters;
}

function idOf(value: unknown): string | undefined {
    if (typeof value === "string") return value || undefined;

    if (value && typeof value === "object" && "id" in value) {
        const id = (value as Option).id;
        return typeof id === "string" && id ? id : undefined;
    }

    return undefined;
}

function idsOf(list: unknown): string[] {
    if (!Array.isArray(list)) return [];

    return list.map(idOf).filter((id): id is string => id !== undefined);
}

/**
 * Reads filter values the way the host sends them: a SELECT arrives as an `Option`
 * object, not a string, so `filters[id] as string` silently reads nothing.
 */
export const FilterReader = {
    option(request: SearchRequest, id: string): string | undefined {
        return idOf(filtersOf(request)[id]);
    },
    options(request: SearchRequest, id: string): string[] {
        return idsOf(filtersOf(request)[id]);
    },

    excludable(request: SearchRequest, id: string): { included: string[]; excluded: string[] } {
        const value = filtersOf(request)[id] as
            | { included?: unknown[]; excluded?: unknown[] }
            | undefined;

        return { included: idsOf(value?.included), excluded: idsOf(value?.excluded) };
    },

    toggle(request: SearchRequest, id: string): boolean {
        return filtersOf(request)[id] === true;
    },

    text(request: SearchRequest, id: string): string | undefined {
        const value = filtersOf(request)[id];
        if (typeof value !== "string") return undefined;

        return value.trim() || undefined;
    },

    /** A whole number typed into a text field ("10,000" included); `undefined` if there is none. */
    integer(request: SearchRequest, id: string, max = Number.MAX_SAFE_INTEGER): number | undefined {
        const digits = (FilterReader.text(request, id) ?? "").replace(/[^\d]/g, "");
        const value = Number.parseInt(digits, 10);

        return Number.isFinite(value) && value > 0 && value <= max ? value : undefined;
    },

    number(request: SearchRequest, id: string): number | undefined {
        const value = filtersOf(request)[id];

        return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    },
};

/** The requested sort, or the declared default. */
export function sortOf(
    request: SearchRequest,
    options: SortOption[],
): { id: string; ascending: boolean } {
    const fallback = options.find((o) => o.isDefault) ?? options[0];
    const chosen = options.find((o) => o.id === request.sort?.id) ?? fallback;

    return {
        id: chosen?.id ?? "",
        ascending: request.sort?.ascending ?? chosen?.defaultAscending ?? false,
    };
}

const INLINE_LIMIT = 20;
const CHIP_LIMIT = 12;

/** The host's pickers carry their own "None", so a blank "Any" option would show twice. */
function chosen(list: Option[]): Option[] {
    return list.filter((option) => option.id !== "");
}

/**
 * A single choice: the inline menu picker in its row while the list is short, a searchable
 * sheet once it is long enough that a menu would scroll off screen.
 */
export function singleSelect(props: SearchFieldBase & { options: Option[] }): SearchListField {
    const field = { ...props, options: chosen(props.options) };

    if (field.options.length <= INLINE_LIMIT) return SearchMenuPicker(field);

    return SearchPickerSheet(field);
}

/**
 * A multiple choice as inline chips — its own section, since the host draws a tags field
 * as the whole section — or, for a long list, a searchable sheet row.
 */
export function multiSelect(
    props: SearchFieldBase & { options: Option[]; excludable?: boolean; footer?: string },
): SearchSection {
    const { excludable, footer, ...rest } = props;
    const field = { ...rest, options: chosen(rest.options) };

    if (field.options.length <= CHIP_LIMIT) {
        const chips = excludable ? SearchExcludableMultiPicker(field) : SearchMultiPicker(field);

        return SearchTagsSection({ header: field.title, footer, field: chips });
    }

    const sheet = excludable
        ? SearchExcludableMultiPickerSheet(field)
        : SearchMultiPickerSheet(field);

    return SearchListSection({ footer, children: [sheet] });
}

/**
 * A search form without the option fields that ended up with no options — a site list
 * that could not be fetched — and without sections those leave empty.
 */
export function searchForm(sections: SearchSection[]): SearchForm {
    const usable = (field: { options?: Option[] }) =>
        !Array.isArray(field.options) || field.options.length > 0;

    const kept = sections.flatMap((section): SearchSection[] => {
        if (section.type === SearchSectionType.TAGS) {
            return usable(section.field) ? [section] : [];
        }

        if (section.type !== SearchSectionType.LIST) return [section];

        const children = section.children.filter((child) => {
            const isGroup = "kind" in child && child.kind === "group";
            return isGroup || usable(child as { options?: Option[] });
        });

        return children.length ? [{ ...section, children }] : [];
    });

    return { sections: kept };
}

/** Options whose id is the title in lower case, for sites that filter by the label itself. */
export function labels(titles: string[]): Option[] {
    return titles.map((title) => ({ id: title.toLowerCase(), title }));
}

export function options(entries: Record<string, string> | [string, string][]): Option[] {
    const pairs = Array.isArray(entries) ? entries : Object.entries(entries);

    return pairs.map(([id, title]) => ({ id, title }));
}
