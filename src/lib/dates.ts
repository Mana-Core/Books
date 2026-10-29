/* SPDX-License-Identifier: GPL-3.0-or-later */

import type { Moment, unitOfTime } from "moment";

/** The formats sites print, tried strictly after ISO 8601 and RFC 2822. */
const FORMATS = [
    "MMM D, YYYY h:mm A",
    "MMM D, YYYY",
    "MMMM D, YYYY",
    "D MMM YYYY",
    "D MMMM YYYY",
    "YYYY-MM-DD HH:mm:ss",
    "YYYY-MM-DD",
];

const UNITS: Record<string, unitOfTime.DurationConstructor> = {
    sec: "second",
    min: "minute",
    hr: "hour",
};

const AGO = /(\d+|an?|one)\s*(second|sec|minute|min|hour|hr|day|week|month|year)s?\s*ago/;

/**
 * Parses the dates sites print: ISO, "Jan 2, 2024", "Oct 23, 2026 12:06 PM", "2 days ago",
 * "yesterday", or a Unix time. Returns `undefined` rather than an invalid date, which the
 * app cannot decode. Uses the host's `moment`, referenced only when called: the build step
 * that reads a source's intents has no moment.
 */
export function parseDate(value: string | number | undefined | null): Date | undefined {
    if (value === undefined || value === null || value === "") return undefined;

    if (typeof value === "number") {
        const ms = value < 1e12 ? value * 1_000 : value;
        return valid(moment(ms));
    }

    // "Jan 2nd, 2024" → "Jan 2, 2024"
    const text = value.trim().replace(/(\d)(st|nd|rd|th)\b/g, "$1");

    const ago = relative(text.toLowerCase());
    if (ago) return ago;

    return valid(moment(text, [moment.ISO_8601, moment.RFC_2822, ...FORMATS], "en", true));
}

function relative(text: string): Date | undefined {
    if (text === "today" || text === "just now") return new Date();
    if (text === "yesterday") return moment().subtract(1, "day").toDate();

    const match = AGO.exec(text);
    if (!match) return undefined;

    const [, count = "", word = ""] = match;
    const amount = /^\d+$/.test(count) ? Number(count) : 1;
    const unit = UNITS[word] ?? (word as unitOfTime.DurationConstructor);

    return moment().subtract(amount, unit).toDate();
}

function valid(date: Moment): Date | undefined {
    return date.isValid() ? date.toDate() : undefined;
}
