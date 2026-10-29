/* SPDX-License-Identifier: GPL-3.0-or-later */

import { SectionStyle, type SortOption } from "@mana-app/types";

import type { FileFormat } from "../lib/books";
import { options } from "../lib/search";

export const BASE_URL = "https://archive.org";
export const PAGE_SIZE = 30;

/**
 * Every listing is narrowed to texts that carry an EPUB or PDF. `format` is tokenised, so
 * `format:PDF` also matches "Text PDF"; lending items are dropped by their flag, because
 * their EPUB and PDF files are private and answer 401.
 */
export const BASE_QUERY =
    "mediatype:texts AND (format:EPUB OR format:PDF) AND -access-restricted-item:true";

export const SEARCH_FIELDS = ["identifier", "title", "creator", "downloads", "year"];

/** Relevance sends no `sort[]`, which is how archive.org ranks text matches. */
export const RELEVANCE = "relevance";

/**
 * archive.org's search page draws its sort bar from the collection-browser script bundle;
 * no endpoint serves the list, so it stays here. The ids are the advancedsearch fields.
 */
export const SORTS: SortOption[] = [
    { id: RELEVANCE, title: "Relevance" },
    {
        id: "downloads",
        title: "Most Downloaded",
        isDefault: true,
        isOrderable: true,
        defaultAscending: false,
    },
    { id: "addeddate", title: "Date Added", isOrderable: true, defaultAscending: false },
    { id: "titleSorter", title: "Title", isOrderable: true, defaultAscending: true },
    { id: "date", title: "Publication Date", isOrderable: true, defaultAscending: false },
];

export const FILTER = {
    language: "language",
    collection: "collection",
    format: "format",
    creator: "creator",
    subject: "subject",
    yearFrom: "yearFrom",
    yearTo: "yearTo",
} as const;

/** The source's own narrowing of the base query, which already asks for either. */
export const FORMATS = options([
    ["", "EPUB or PDF"],
    ["EPUB", "EPUB only"],
    ["PDF", "PDF only"],
]);

/**
 * The archive's language facet folds the codes uploaders typed into English names, but
 * advancedsearch matches the raw field, where the MARC and ISO 639-1 codes outnumber the
 * names. These are the codes of the languages common enough for that to matter; any other
 * facet entry is matched by its name alone.
 */
export const LANGUAGE_CODES: Record<string, string[]> = {
    English: ["eng", "en"],
    German: ["ger", "deu", "de"],
    French: ["fre", "fra", "fr"],
    Spanish: ["spa", "es"],
    Italian: ["ita", "it"],
    Portuguese: ["por", "pt"],
    Dutch: ["dut", "nld", "nl"],
    Russian: ["rus", "ru"],
    Polish: ["pol", "pl"],
    Latin: ["lat", "la"],
    Arabic: ["ara", "ar"],
    Hindi: ["hin", "hi"],
    Japanese: ["jpn", "ja"],
    Chinese: ["chi", "zho", "zh"],
    Indonesian: ["ind", "id"],
};

/** Facets come largest first; past this many entries they are too small to be worth a picker row. */
export const FACET_SIZE = 100;

type FacetBucket = { key: string; doc_count: number };

/** The page-production search service, which archive.org's own search page reads its facets from. */
export type FacetResponse = {
    response?: {
        body?: {
            aggregations?: Record<string, { buckets?: FacetBucket[] | number[] }>;
            collection_titles?: Record<string, string>;
        };
    };
};

export const HOME_ROWS: {
    id: string;
    title: string;
    sort: string;
    collection?: string;
    style?: SectionStyle;
}[] = [
    {
        id: "popular",
        title: "Most Downloaded",
        sort: "downloads",
        style: SectionStyle.DetailedSingleRowPaged,
    },
    {
        id: "trending",
        title: "Popular This Week",
        sort: "week",
        style: SectionStyle.SimpleDoubleRow,
    },
    { id: "recent", title: "Recently Added", sort: "addeddate" },
    {
        id: "standardebooks",
        title: "Standard Ebooks",
        sort: "downloads",
        collection: "standardebooks",
    },
    {
        id: "sciencefiction",
        title: "Science Fiction and Fantasy",
        sort: "downloads",
        collection: "sciencefiction",
    },
    {
        id: "pulp",
        title: "The Pulp Magazine Archive",
        sort: "downloads",
        collection: "pulpmagazinearchive",
    },
    {
        id: "loc",
        title: "The Library of Congress",
        sort: "downloads",
        collection: "library_of_congress",
    },
];

/**
 * The archive's file formats the reader can open. "Additional Text PDF", "Grayscale PDF"
 * and "B/W PDF" are derived copies of a PDF already listed, so they are left out.
 */
export const FILE_FORMATS: Record<string, FileFormat> = {
    EPUB: "epub",
    "Text PDF": "pdf",
    PDF: "pdf",
    "Image Container PDF": "pdf",
    Text: "txt",
    DjVuTXT: "txt",
};

/** OCR text duplicates the scanned book; it is only worth offering when nothing else is. */
export const OCR_TEXT_FORMAT = "DjVuTXT";

type SearchDoc = {
    identifier: string;
    title?: string | string[];
    creator?: string | string[];
    downloads?: number;
    year?: string | number;
};

export type SearchResponse = {
    response?: { numFound: number; start: number; docs: SearchDoc[] };
    error?: string;
};

export type ItemFile = {
    name: string;
    format?: string;
    size?: string;
    mtime?: string;
    private?: string | boolean;
};

export type MetadataValue = string | string[] | undefined;

type ItemMetadata = {
    title?: MetadataValue;
    creator?: MetadataValue;
    description?: MetadataValue;
    subject?: MetadataValue;
    language?: MetadataValue;
    date?: MetadataValue;
    publisher?: MetadataValue;
    publicdate?: MetadataValue;
};

export type ItemResponse = { metadata?: ItemMetadata; files?: ItemFile[]; is_dark?: boolean };
