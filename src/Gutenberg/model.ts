/* SPDX-License-Identifier: GPL-3.0-or-later */

export const BASE_URL = "https://www.gutenberg.org";
export const PAGE_SIZE = 25;

/**
 * The search whose sort menu is read. Each page offers its own sorts — the bare browse
 * page adds Random and a shelf page adds Author, neither of which a filtered search
 * honours — so the menu is taken from a filtered search like the ones this source makes.
 */
export const SORT_MENU_QUERY = "l.en";

export const FILTER = {
    language: "language",
    category: "category",
    shelf: "shelf",
    subjectClass: "subjectClass",
    author: "author",
    subject: "subject",
    title: "title",
} as const;

/** Home rows are an editorial pick from the site's several hundred bookshelves. */
export const HOME_SHELVES: [id: string, title: string][] = [
    ["68", "Science Fiction"],
    ["36", "Fantasy"],
    ["30", "Detective Fiction"],
    ["82", "Adventure"],
    ["42", "Horror"],
    ["20", "Children's Literature"],
];
