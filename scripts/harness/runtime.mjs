// SPDX-License-Identifier: GPL-3.0-or-later
//
// Stands in for the Mana app: installs the HTTP bridge, the stores and the host's HTTP
// runtime, then evaluates a built `.mana` bundle in this realm. One source per process —
// a bundle assigns `globalThis.Target`.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const HOST_RUNTIME = require.resolve("@mana-app/types/dist/runtime/http-host.generated.js");
const EXPORT_RESPONSE = Symbol.for("mana.http.response.v1");

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const BODY_TYPES = [
    "application/json",
    "application/x-www-form-urlencoded",
    "text/plain",
    "application/octet-stream",
];
const USER_AGENT =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** In-memory stand-in for the host's ObjectStore/SecureStore (values kept as JSON). */
class MemoryStore {
    constructor(seed = {}) {
        this.values = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
    }
    async get(key) {
        const raw = this.values.get(key);
        return raw === undefined ? null : JSON.parse(raw);
    }
    async set(key, value) {
        this.values.set(key, JSON.stringify(value));
    }
    async remove(key) {
        this.values.delete(key);
    }
    async string(key) {
        const v = await this.get(key);
        return typeof v === "string" ? v : null;
    }
    async boolean(key) {
        const v = await this.get(key);
        return typeof v === "boolean" ? v : null;
    }
    async number(key) {
        const v = await this.get(key);
        return typeof v === "number" ? v : null;
    }
    async stringArray(key) {
        const v = await this.get(key);
        return Array.isArray(v) ? v : null;
    }
}

/** A per-host cookie jar, standing in for the app's shared `HTTPCookieStorage`. */
class CookieJar {
    constructor() {
        this.hosts = new Map();
    }
    header(url) {
        const jar = this.hosts.get(new URL(url).host);
        return jar && jar.size ? [...jar].map(([k, v]) => `${k}=${v}`).join("; ") : undefined;
    }
    store(url, response) {
        const host = new URL(url).host;
        const jar = this.hosts.get(host) ?? new Map();
        for (const line of response.headers.getSetCookie?.() ?? []) {
            const [pair] = line.split(";");
            const index = pair.indexOf("=");
            if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
        }
        this.hosts.set(host, jar);
    }
}

/** Headers for a redirect hop: the jar's cookies for the new URL, never the first host's. */
function withCookie(headers, cookie) {
    const { cookie: _dropped, ...rest } = headers;
    return cookie ? { ...rest, cookie } : rest;
}

function createBridge({ log }) {
    const bodies = new Map();
    const inflight = new Map();
    const cookies = new CookieJar();
    let sequence = 0;

    const keep = (bytes) => {
        const id = `body-${++sequence}`;
        bodies.set(id, Buffer.from(bytes));
        return id;
    };

    return {
        bodies,
        binary: true,
        now: () => Date.now(),
        async send(message) {
            switch (message.operation) {
                case 0: {
                    const controller = new AbortController();
                    inflight.set(message.requestID, controller);
                    const timer = setTimeout(() => controller.abort(), message.timeoutMs ?? 30_000);
                    const headers = Object.fromEntries(
                        Object.entries(message.headers ?? {}).map(([k, v]) => [
                            k.toLowerCase(),
                            String(v),
                        ]),
                    );
                    headers["user-agent"] ??= USER_AGENT;
                    if (message.bodyKind !== undefined && message.bodyKind !== null) {
                        headers["content-type"] ??= BODY_TYPES[message.bodyKind];
                    }
                    const cookie = cookies.header(message.url);
                    if (cookie && !headers.cookie) headers.cookie = cookie;
                    const started = Date.now();
                    const method = METHODS[message.method] ?? "GET";
                    const body =
                        method === "GET" || method === "HEAD"
                            ? undefined
                            : message.bytes
                              ? Buffer.from(message.bytes)
                              : message.body;
                    try {
                        // Redirects are followed by hand so cookies set on a 30x land in the jar, as they
                        // do in the app's URLSession.
                        let url = message.url;
                        let response;
                        for (let hop = 0; ; hop += 1) {
                            const init =
                                hop === 0
                                    ? { method, headers, body }
                                    : {
                                          method: "GET",
                                          headers: withCookie(headers, cookies.header(url)),
                                      };
                            response = await fetch(url, {
                                ...init,
                                redirect: "manual",
                                signal: controller.signal,
                            });
                            cookies.store(url, response);
                            const location = response.headers.get("location");
                            const redirected =
                                response.status >= 300 && response.status < 400 && location;
                            if (!redirected || hop >= 10) break;
                            url = new URL(location, url).toString();
                        }
                        Object.defineProperty(response, "url", { value: url });
                        const bytes = new Uint8Array(await response.arrayBuffer());
                        log?.(
                            `${METHODS[message.method]} ${response.status} ${message.url} (${Date.now() - started} ms, ${bytes.length} B)`,
                        );
                        return {
                            bodyID: keep(bytes),
                            sessionID: "harness",
                            status: response.status,
                            url: response.url || message.url,
                            headers: Object.fromEntries(response.headers),
                        };
                    } catch (error) {
                        log?.(`${METHODS[message.method]} ERR ${message.url}: ${error.message}`);
                        throw new Error(
                            controller.signal.aborted ? "The request timed out." : error.message,
                        );
                    } finally {
                        clearTimeout(timer);
                        inflight.delete(message.requestID);
                    }
                }
                case 1: {
                    const bytes = bodies.get(message.bodyID);
                    if (!bytes) throw new Error("Unknown body");
                    if (message.reader === 0) return { value: bytes.toString("utf8") };
                    if (message.reader === 1) return { value: bytes.toString("base64") };
                    return { bytes: new Uint8Array(bytes) };
                }
                case 2:
                    bodies.delete(message.bodyID);
                    return {};
                case 3:
                    inflight.get(message.requestID)?.abort();
                    return {};
                case 4: {
                    const bytes = message.bytes ?? Buffer.from(message.value ?? "", "base64");
                    return { bodyID: keep(bytes), sessionID: "harness" };
                }
                case 5:
                case 6:
                case 7:
                case 8:
                    return {};
                default:
                    throw new Error(
                        `The harness does not implement bridge operation ${message.operation}.`,
                    );
            }
        },
    };
}

/**
 * Loads a bundle and returns `{ source, call, bridge, stores }`. `call(method, ...args)`
 * runs the method inside an HTTP operation the way `bridge.js` does in the app.
 */
export function loadSource(bundlePath, { objectStore = {}, secureStore = {}, log } = {}) {
    const bridge = createBridge({ log });
    const stores = { object: new MemoryStore(objectStore), secure: new MemoryStore(secureStore) };
    globalThis.__manaHTTPBridge = bridge;
    globalThis.ObjectStore = stores.object;
    globalThis.SecureStore = stores.secure;
    // The app loads moment before every source; sources use that global.
    globalThis.moment = require("moment");

    vm.runInThisContext(readFileSync(HOST_RUNTIME, "utf8"), { filename: "http-host.generated.js" });
    vm.runInThisContext(readFileSync(bundlePath, "utf8"), { filename: bundlePath });
    if (typeof globalThis.Target !== "function") {
        throw new Error("The bundle did not define Target.");
    }

    const source = new globalThis.Target();
    globalThis.IDENTIFIER = source.info?.id;

    const call = async (method, ...args) => {
        const run = async () => {
            const result = await source[method](...args);
            if (method !== "getChapterData" || !result?.document) return result;
            if (typeof result.document[EXPORT_RESPONSE] !== "function") {
                throw new TypeError("ChapterData.document must be an HttpResponse");
            }
            const exported = await result.document[EXPORT_RESPONSE]();
            return {
                ...result,
                document: { ...exported, bytes: bridge.bodies.get(exported.bodyID) },
            };
        };
        return globalThis.ManaHTTP.runHttpOperation(run);
    };

    return { source, call, bridge, stores };
}
