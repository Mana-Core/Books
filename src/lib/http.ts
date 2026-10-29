/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
    AbortError,
    HttpClient,
    NetworkError,
    RateLimit,
    type HttpResponse,
    type RequestOptions,
} from "@mana-app/types";

export type ClientOptions = {
    /** Requests allowed per `intervalMs`. */
    requests?: number;
    intervalMs?: number;
    timeoutMs?: number;
    retries?: number;
    headers?: Record<string, string>;
};

/**
 * A client with spacing, a timeout and one retry for transient failures. The runtime
 * already turns a Cloudflare challenge into a `CloudflareError`, so nothing here sniffs
 * for one.
 */
export function createClient(options: ClientOptions = {}): HttpClient {
    const client = new HttpClient()
        .setTimeoutMs(options.timeoutMs ?? 20_000)
        .setRetry(options.retries ?? 1)
        .setRateLimiter(
            RateLimit.spaced({
                requests: options.requests ?? 3,
                intervalMs: options.intervalMs ?? 1_000,
            }),
        );

    if (options.headers) client.addHeaders(options.headers);

    return client;
}

/** An error whose message is meant to be read by the person using the app. */
export class SourceError extends Error {
    constructor(
        message: string,
        readonly status?: number,
    ) {
        super(message);
        this.name = "SourceError";
    }
}

export function requireOk(response: HttpResponse, what = "Request"): HttpResponse {
    if (!response.ok) {
        throw new SourceError(`${what} failed (HTTP ${response.status}).`, response.status);
    }

    return response;
}

export async function getText(
    client: HttpClient,
    url: string,
    options?: RequestOptions,
): Promise<string> {
    return requireOk(await client.get(url, options)).text();
}

export async function getJson<T>(
    client: HttpClient,
    url: string,
    options?: RequestOptions,
): Promise<T> {
    return requireOk(await client.get(url, options)).json<T>();
}

/**
 * A JavaScript browser check the runtime does not already report as Cloudflare: DDoS-Guard
 * and the "Checking your browser …" interstitial. A browser passes either on its own, so a
 * source throws `CloudflareError` for them and the app clears them in a WebView.
 */
export function isBrowserCheck(status: number, html: string): boolean {
    if (status !== 403 && status !== 503) return false;

    const head = html.slice(0, 8192);

    return /ddos-guard\/js-challenge|<title>\s*DDoS-Guard|checking your browser/i.test(head);
}

/**
 * Whether a failure says the host itself is unreachable or broken, as opposed to the
 * request being wrong. Only these move a source to another mirror.
 */
export function isHostFailure(error: unknown): boolean {
    if (error instanceof AbortError) return false;
    if (error instanceof NetworkError) return true;

    return error instanceof SourceError && error.status !== undefined && error.status >= 500;
}
