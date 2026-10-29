/* SPDX-License-Identifier: GPL-3.0-or-later */

// The runtime has no `URL`/`URLSearchParams` typing (lib is ES2020 without DOM), so the few
// operations sources need are written out here.

export type QueryScalar = string | number | boolean;
export type QueryValue = QueryScalar | readonly QueryScalar[] | null | undefined;
export type Query = Record<string, QueryValue>;

/** Encodes a query, skipping empty values and repeating the key for arrays. */
export function encodeQuery(params: Query): string {
    const parts: string[] = [];

    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === "") continue;

        const values = Array.isArray(value) ? value : [value as QueryScalar];
        for (const item of values) {
            parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
        }
    }

    return parts.join("&");
}

export function withQuery(url: string, params?: Query): string {
    const query = params ? encodeQuery(params) : "";
    if (!query) return url;

    const separator = url.includes("?") ? "&" : "?";

    return `${url}${separator}${query}`;
}

const ORIGIN = /^(https?:\/\/[^/?#]+)/i;

export function originOf(url: string): string {
    return ORIGIN.exec(url)?.[1] ?? "";
}

export function hostOf(url: string): string {
    const origin = originOf(url);

    return origin.replace(/^https?:\/\//i, "").toLowerCase();
}

/**
 * The path, query and fragment of a URL without its origin. Library entries store this
 * rather than the full URL so that switching mirrors never orphans them.
 */
export function pathOf(url: string): string {
    const path = url.replace(ORIGIN, "");

    return path.startsWith("/") ? path : `/${path}`;
}

/** Resolves `href` against `base` the way a browser would for the cases sites use. */
export function resolveUrl(base: string, href: string | undefined): string | undefined {
    const value = href?.trim();
    if (!value || value.startsWith("javascript:") || value.startsWith("data:")) return undefined;

    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith("//")) return `https:${value}`;
    if (value.startsWith("/")) return `${originOf(base)}${value}`;

    // Relative to the page's directory.
    const directory = base.replace(/[?#].*$/, "").replace(/[^/]*$/, "");

    return `${directory}${value}`;
}

/**
 * Normalises a user-entered mirror to a bare origin: adds `https://`, drops any path and
 * trailing slash, and rejects anything that is not a host name.
 */
export function normalizeMirror(input: string): string | undefined {
    const trimmed = input.trim();
    if (!trimmed) return undefined;

    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const origin = originOf(withScheme).toLowerCase();

    return /^https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/.test(origin) ? origin : undefined;
}
