/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    CloudflareError,
    TimeoutError,
    UIListSection,
    UIPicker,
    UITextField,
    type FormSection,
    type HttpClient,
} from "@mana-app/types";

import { createClient, isHostFailure } from "./http";
import { normalizeMirror } from "./url";

export type MirrorConfig = {
    /** Origins the source ships with, best first. */
    builtIn: string[];
    /** A cheap page to probe; defaults to `/`. */
    probePath?: string;
    /** For sites whose traffic goes elsewhere than the origin, e.g. an `api.` host. Overrides `probePath`. */
    probeUrl?: (origin: string) => string;
    /** Text the probed page must contain to count as the site rather than a parked domain. */
    marker?: string;
};

export type MirrorStatus = {
    mirror: string;
    online: boolean;
    latencyMs?: number;
    note?: string;
};

const AUTOMATIC = "auto";
const KEY_SELECTED = "mirror.selected";
const KEY_CUSTOM = "mirror.custom";
const KEY_CURRENT = "mirror.current";
const PROBE_TTL_MS = 60_000;

/**
 * The domains a source can reach its site through, which one is in use, and whether each
 * is up. Automatic mode remembers the last mirror that answered and moves on when it fails.
 */
export class MirrorSet {
    private probes: { at: number; results: MirrorStatus[] } | undefined;
    private probeClient: HttpClient | undefined;

    constructor(private readonly config: MirrorConfig) {}

    async all(): Promise<string[]> {
        const custom = await this.custom();

        return [...new Set([...this.config.builtIn, ...custom])];
    }

    /** The origin requests should go to right now. */
    async active(): Promise<string> {
        const mirrors = await this.all();

        // A mirror picked by hand wins…
        const selected = await ObjectStore.get(KEY_SELECTED);
        if (typeof selected === "string" && selected !== AUTOMATIC && mirrors.includes(selected)) {
            return selected;
        }

        // …then the one automatic mode last moved to, then the first built-in one.
        const current = await ObjectStore.get(KEY_CURRENT);
        if (typeof current === "string" && mirrors.includes(current)) return current;

        return mirrors[0] ?? "";
    }

    /**
     * Runs `task` against the active mirror. In automatic mode a host failure re-probes,
     * switches to the first other mirror that answers, and retries once.
     */
    async run<T>(task: (origin: string) => Promise<T>): Promise<T> {
        const origin = await this.active();

        try {
            return await task(origin);
        } catch (error) {
            if (!isHostFailure(error) || !(await this.isAutomatic())) throw error;

            const statuses = await this.probe(true);
            const next = statuses.find((s) => s.online && s.mirror !== origin);
            if (!next) throw error;

            await ObjectStore.set(KEY_CURRENT, next.mirror);

            return task(next.mirror);
        }
    }

    /** Probes every mirror in parallel; results are reused for a minute. */
    async probe(force = false): Promise<MirrorStatus[]> {
        if (!force && this.probes && Date.now() - this.probes.at < PROBE_TTL_MS) {
            return this.probes.results;
        }

        const mirrors = await this.all();
        const results = await Promise.all(mirrors.map((mirror) => this.check(mirror)));
        this.probes = { at: Date.now(), results };

        return results;
    }

    /**
     * The settings section. The host awaits the preference menu while it shows a loading
     * state, so probing here gives fresh status every time settings open — the form is not
     * rebuilt after a button press, which is why there is no "Check now" button.
     */
    async section(): Promise<FormSection> {
        const [statuses, selected, custom, active] = await Promise.all([
            this.probe(),
            ObjectStore.get(KEY_SELECTED),
            this.custom(),
            this.active(),
        ]);

        const automatic = typeof selected !== "string" || selected === AUTOMATIC;

        const online = statuses.filter((s) => s.online).length;
        const checked = clock(this.probes?.at ?? Date.now());
        const footer = [
            `Checked ${checked} · ${online} of ${statuses.length} online.`,
            automatic ? `Automatic is using ${bare(active)}.` : undefined,
            "Custom mirrors: one domain per line. Reopen settings to refresh status.",
        ];

        const mirrorOptions = statuses.map((s) => ({
            id: s.mirror,
            title: `${bare(s.mirror)} — ${describe(s)}`,
        }));

        return UIListSection({
            header: "Mirrors",
            footer: footer.filter(Boolean).join(" "),
            children: [
                UIPicker({
                    id: KEY_SELECTED,
                    title: "Active Mirror",
                    options: [{ id: AUTOMATIC, title: "Automatic" }, ...mirrorOptions],
                    value: automatic ? AUTOMATIC : (selected as string),
                    didChange: async (value) => {
                        await ObjectStore.set(KEY_SELECTED, value);
                        if (value !== AUTOMATIC) await ObjectStore.set(KEY_CURRENT, value);
                    },
                }),
                UITextField({
                    id: KEY_CUSTOM,
                    title: "Custom Mirrors",
                    placeholder: "example.org",
                    multiline: true,
                    value: custom.join("\n"),
                    // Saved on every keystroke, so partial lines are kept as typed and only
                    // complete domains ever reach the mirror list.
                    didChange: async (value) => {
                        await ObjectStore.set(KEY_CUSTOM, value);
                        this.probes = undefined;
                    },
                }),
            ],
        });
    }

    private async isAutomatic(): Promise<boolean> {
        const selected = await ObjectStore.get(KEY_SELECTED);

        return typeof selected !== "string" || selected === AUTOMATIC;
    }

    private async custom(): Promise<string[]> {
        const raw = await ObjectStore.get(KEY_CUSTOM);
        if (typeof raw !== "string") return [];

        return raw
            .split(/[\n,\s]+/)
            .map(normalizeMirror)
            .filter((m): m is string => m !== undefined);
    }

    private async check(mirror: string): Promise<MirrorStatus> {
        this.probeClient ??= createClient({
            requests: 8,
            intervalMs: 1_000,
            timeoutMs: 4_000,
            retries: 0,
        });

        const url = this.config.probeUrl?.(mirror) ?? `${mirror}${this.config.probePath ?? "/"}`;
        const started = Date.now();

        try {
            const response = await this.probeClient.get(url);
            const latencyMs = Date.now() - started;
            const { status } = response;

            if (status >= 500) return { mirror, online: false, note: `HTTP ${status}` };

            // A rate-limit page is the site answering; reading it for the marker would call it parked.
            if (status === 429) return { mirror, online: true, latencyMs, note: "rate limited" };

            if (status >= 400) return { mirror, online: false, latencyMs, note: `HTTP ${status}` };

            if (this.config.marker) {
                const page = await response.text();
                if (!page.includes(this.config.marker)) {
                    return { mirror, online: false, latencyMs, note: "not the site" };
                }
            }

            return { mirror, online: true, latencyMs };
        } catch (error) {
            const latencyMs = Date.now() - started;

            if (error instanceof CloudflareError) {
                return { mirror, online: true, latencyMs, note: "Cloudflare" };
            }

            const note = error instanceof TimeoutError ? "timeout" : "unreachable";

            return { mirror, online: false, note };
        }
    }
}

function describe(status: MirrorStatus): string {
    if (!status.online) {
        return status.note ? `○ Offline (${status.note})` : "○ Offline";
    }

    const parts = ["● Online"];
    if (status.latencyMs !== undefined) parts.push(`${status.latencyMs} ms`);
    if (status.note) parts.push(status.note);

    return parts.join(" · ");
}

function bare(origin: string): string {
    return origin.replace(/^https?:\/\//, "");
}

function clock(at: number): string {
    const date = new Date(at);
    const pad = (n: number) => String(n).padStart(2, "0");

    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
