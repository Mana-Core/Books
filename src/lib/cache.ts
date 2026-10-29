/* SPDX-License-Identifier: GPL-3.0-or-later */

const DAY_MS = 24 * 60 * 60_000;

/** How long a failed load is remembered, so a blocked site is not asked on every form open. */
const RETRY_MS = 5 * 60_000;

type Entry<T> = { at: number; value: T };

/**
 * Data a site publishes for its own filters — genres, tags, languages, sorts — fetched
 * from the site rather than baked into the source, so a new genre shows up without a
 * release. Kept in memory and in `ObjectStore` for `ttlMs`: the search form opens without
 * waiting on the site, and when the site cannot be reached the last list it served is used.
 *
 * An empty list is never stored: it is a challenge page or a changed site, not data.
 */
export class SiteData<T> {
    private memory: Entry<T> | undefined;
    private failedAt = 0;

    constructor(
        private readonly key: string,
        private readonly load: () => Promise<T>,
        private readonly ttlMs = DAY_MS,
    ) {}

    async get(): Promise<T> {
        if (this.memory && this.isFresh(this.memory)) return this.memory.value;

        const stored = (await ObjectStore.get(this.storeKey)) as Entry<T> | null;
        if (stored && this.isFresh(stored)) {
            this.memory = stored;
            return stored.value;
        }

        try {
            if (Date.now() - this.failedAt < RETRY_MS) {
                throw new Error(`${this.key} failed recently`);
            }

            const value = await this.load();
            if (isEmpty(value)) throw new Error(`${this.key} came back empty`);

            await this.set(value);

            return value;
        } catch (error) {
            this.failedAt = Date.now();

            // A stale list beats none.
            if (stored) return stored.value;

            throw error;
        }
    }

    /** The value, or `fallback` when the site has never answered. */
    async getOr(fallback: T): Promise<T> {
        return this.get().catch(() => fallback);
    }

    /** Seeds the cache from data the source already fetched for something else. */
    async set(value: T): Promise<void> {
        if (isEmpty(value)) return;

        this.memory = { at: Date.now(), value };
        this.failedAt = 0;

        await ObjectStore.set(this.storeKey, this.memory);
    }

    private get storeKey(): string {
        return `site.${this.key}`;
    }

    private isFresh(entry: Entry<T>): boolean {
        return Date.now() - entry.at < this.ttlMs;
    }
}

/**
 * A value kept in memory for `ttlMs`, for data too large to persist (a site's whole
 * catalogue). Concurrent callers share one load, so home rows that resolve in parallel
 * download it once.
 */
export class Memo<T> {
    private entry: { at: number; value: Promise<T> } | undefined;

    constructor(
        private readonly load: () => Promise<T>,
        private readonly ttlMs: number,
    ) {}

    get(): Promise<T> {
        if (this.entry && Date.now() - this.entry.at < this.ttlMs) return this.entry.value;

        const value = this.load();
        this.entry = { at: Date.now(), value };

        // A failed load is not kept; the next caller tries again.
        value.catch(() => {
            if (this.entry?.value === value) this.entry = undefined;
        });

        return value;
    }
}

function isEmpty(value: unknown): boolean {
    if (Array.isArray(value)) return value.length === 0;

    if (value && typeof value === "object") {
        return Object.values(value).every((v) => Array.isArray(v) && v.length === 0);
    }

    return value === undefined || value === null;
}
