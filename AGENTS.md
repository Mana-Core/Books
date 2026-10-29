# AGENTS.md

Web-novel and ebook sources for Mana, built with `mana-dev` into `.mana` bundles. Every
source opens in Mana's book reader, which renders a chapter's `document` response as EPUB,
PDF, UTF-8 text or HTML.

## Layout

| Path | Holds |
| :--- | :---- |
| `src/lib/` | Shared kit. Never declare a `Target` class here — any `.ts` file containing `class Target` is built as a source. |
| `src/<Name>/` | One source: `main.ts` (ends with `export class Target extends <Name> {}`), `parsers.ts`, `model.ts`. `info.name` must equal `<Name>`. |
| `assets/<Name>.png` | Source icon. `info.thumbnail` is the bare filename. Only this folder is packaged. |
| `probes/<Name>.json` | Live-verification fixture: `query`, optional `contentId`/`chapterId`, `expect` (`html`/`epub`/`pdf`/`file`), `intents`, `requiresEnv`, `basicAuth`, `secureStore`. |
| `scripts/` | `verify.mjs` (live contract test), `check.mjs` (offline rules), `harness/runtime.mjs` (the app stand-in). |

## Runtime rules (bare JavaScriptCore, not Node or a browser)

- There is no `fetch`, `URL`, `URLSearchParams`, `TextEncoder`/`TextDecoder`, `DOMParser` or `crypto.subtle`. Use `HttpClient` through `src/lib/http.ts`, `src/lib/url.ts`, and cheerio through `src/lib/html.ts`.
- Create the HTTP client lazily in a `private get http()` getter. `onEnvironmentLoaded` is not awaited before the first call.
- An `HttpResponse` with status 4xx/5xx is returned, not thrown. Read bodies through `getText`/`getJson`/`requireOk`. A Cloudflare challenge already becomes a `CloudflareError` inside the runtime.
- POST bodies go through `Body.form` / `Body.json` from `@mana-app/types`, never a hand-stringified body.
- Dates are real `Date` objects. Use `new Date(0)` when unknown; never return an invalid date.
- Every `Content` sets `contentType: ContentType.NOVEL` — that is what opens the book reader.
- Chapter `index` is contiguous from 0 at the **oldest** chapter. `title` is printed verbatim.
- Method presence is the feature flag. The app offers only the features whose methods exist, so don't define a method you can't back with real data.
- Store content and chapter IDs as **paths without host** (`pathOf`), so switching mirrors never orphans library entries.

## Kit

Every source extends `BookSource` (`src/lib/source.ts`), or `HomeSource` when it has a
home page. The base supplies:
- the lazy `http` client, configured by overriding `clientOptions`;
- a long-timeout `downloads` client for book files;
- `getSortOptions` from `sorts`, and `sortOf(request)`.

There is deliberately no default `getChapters`. A source that returns chapters from
`getContent` leaves it out, which gives it the `chaptersInContent` intent; the app then
reads chapters from the content. Only a source that lists chapters separately defines
`getChapters`.

`HomeSource` adds the home-page methods from `rows()`, plus a `search` that answers "View
more" lists and passes everything else to `find(request)`. The base classes only define
methods every source can back, because method presence is the feature flag.
`src/Gutenberg/main.ts` is the reference shape.

| Module | Use |
| :----- | :-- |
| `source.ts` | `BookSource`, `HomeSource` |
| `http.ts` | `createClient({requests, intervalMs})`, `getText`, `getJson`, `requireOk`, `SourceError` (reader-facing message), `isBrowserCheck` (DDoS-Guard / "Checking your browser" → throw `CloudflareError`) |
| `url.ts` | `withQuery`, `encodeQuery`, `resolveUrl`, `pathOf`, `originOf`, `normalizeMirror` |
| `html.ts` | `load`, `text`, `attr`, `imageOf`, `summaryOf`, `cleanChapterHtml`, `chapterDocument`, `textToHtml` (plain-text API bodies → paragraphs), `escapeHtml` |
| `books.ts` | `htmlChapter(response, html)`, `fileChapter(client, url, opts, explainRefusal)`, `fileChapters(files, lang)`, `sequenceChapters(list, lang)`, `formatOf`, `formatBytes` |
| `search.ts` | `FilterReader` (a SELECT arrives as an `Option` object, not a string; `integer` reads a typed number), `singleSelect` (inline picker ≤20, sheet beyond), `multiSelect` (inline chips ≤12, sheet beyond), `sortOf`, `options` |
| `sections.ts` | `Home`: home rows whose "View more" is a search with `listId` — call `home.list(request)` first in `search()` |
| `mirrors.ts` | `MirrorSet`: built-in + custom mirrors, live status in settings, automatic failover. `probeUrl(origin)` probes another host (e.g. `api.`); a 429 counts as online |
| `settings.ts` | `Preferences` (typed `ObjectStore`, plus `toggle`/`picker` form builders), `readingSection` (the "Reading" section for chapter options such as author notes), `Secrets` (Keychain via `SecureStore`) |
| `dates.ts` / `language.ts` | `parseDate` (ISO, "Jan 2, 2024", "3 days ago"), `chapterLanguage` |

`src/Gutenberg/` is the reference source.

### Web-novel chapter

```ts
const response = requireOk(await this.http.get(url));
const $ = load(await response.text());
const body = cleanChapterHtml($, $("#chapter-content").first(), { baseUrl: url, remove: [".ads"], dropText: [/novel\w*\.com/i] });
return htmlChapter(response, chapterDocument(title, body));
```

Images are kept with absolute URLs. The app downloads them through the source and leaves out any that fail, so a broken image never stops a chapter from opening.

### Ebook chapter

The source returns `fileChapter(this.http, url)`. The app sniffs EPUB/PDF/text from the bytes; JS never reads the file. Chapters come from `fileChapters([{ id, format, label?, bytes?, date? }], language)`, which keeps readable formats, puts EPUB first and titles them like `EPUB · 2.1 MB`.

### Mirrors (sites with more than one domain)

```ts
private readonly mirrors = new MirrorSet({ builtIn: ["https://a.example", "https://b.example"], probePath: "/robots.txt" });
async getPreferenceMenu(): Promise<Form> { return { sections: [await this.mirrors.section(), /* source settings */] }; }
// every request:
const html = await this.mirrors.run((origin) => getText(this.http, `${origin}${path}`));
```

Use `config.cloudflareResolutionURL` only for single-domain sources. A getter for it is not supported.

### Authentication (needs the Mana change that wires basic + WebView auth)

- **Basic (email):**
  - Define `getAuthenticatedUser()`, `handleUserSignOut()`, `handleBasicAuth(identifier, password)`.
  - Define both `readonly BasicAuthenticationUIIdentifier = BasicAuthenticationUIIdentifier.EMAIL` (read by `mana-dev`'s intent emulator) and `readonly BasicAuthUIIdentifier = BasicAuthenticationUIIdentifier.EMAIL` (the TS type).
  - Keep only the session tokens, in `Secrets`; never store the password.
- **WebView:**
  - Define `getAuthenticatedUser()`, `handleUserSignOut()`, `getWebAuthRequestURL()` → `{ url }`, and `didReceiveSessionCookieFromWebAuthResponse(name)` → `{ state }`.
  - The app syncs the WebView cookies into the shared cookie storage that `HttpClient` requests already use.
- `getAuthenticatedUser` returns `{ handle, displayName?, avatar?, info?: string[] }` or `null`.

## Build and serve

```bash
npm install
npm run build        # dist/sources.json + dist/sources/*.mana + dist/assets
npm run dev          # mana-dev serve --watch on :8080
node scripts/new-source.mjs <Name> --url https://site.example
```

To try a build in Mana, add `http://<this-mac's-LAN-IP>:8080` as a repository, or host `dist/` anywhere and add that URL.

## Verify

```bash
npx tsc --noEmit                                   # the gate that matters — the bundler does not typecheck
npm run lint
npx mana-dev build src/<Name> --output .mana-temp/<Name>
node scripts/check.mjs --dist=.mana-temp/<Name>
node scripts/verify.mjs <Name> --dist=.mana-temp/<Name> [--verbose]
node scripts/verify.mjs --all
npm run build && npm run check                     # whole repository
```

On a network whose DNS blocks a source's domains, prefix with `node --import ./scripts/harness/public-dns.mjs` to resolve through 1.1.1.1.

`verify` hits the live site.
- SKIP (a Cloudflare challenge or missing credentials) means unverified, not passed. Say so rather than calling the source working.
- Credentials for sources that need them come from env vars named in the probe (`requiresEnv`, `basicAuth`, `secureStore`).

## Versioning and git

- A new source starts at `1.0.0`, and every released change bumps the patch digit.
- Comments explain *why*, never *what*.
- No `any`; `strict` and `noUncheckedIndexedAccess` are on.
- Don't commit unless asked.
