// SPDX-License-Identifier: GPL-3.0-or-later
//
// Scaffolds a web-novel source: node scripts/new-source.mjs <Name> --url https://site.example [--id site]

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--"));
const flag = (key) => {
    const index = args.indexOf(`--${key}`);
    return index >= 0 ? args[index + 1] : undefined;
};
const url = flag("url")?.replace(/\/+$/, "");

if (!name || !/^[A-Z][A-Za-z0-9]+$/.test(name) || !url) {
    console.error(
        "Usage: node scripts/new-source.mjs <PascalName> --url https://site.example [--id site]",
    );
    process.exit(2);
}
const folder = join(ROOT, "src", name);
if (existsSync(folder)) {
    console.error(`src/${name} already exists.`);
    process.exit(1);
}

const main = `/* SPDX-License-Identifier: GPL-3.0-or-later */

import {
  CatalogRating,
  ContentType,
  type ChapterData,
  type Content,
  type Form,
  type PagedSearchResult,
  type SearchRequest,
} from "@mana-app/types";

import { htmlChapter } from "../lib/books";
import { requireOk } from "../lib/http";
import { chapterDocument, cleanChapterHtml, load, text } from "../lib/html";
import { MirrorSet } from "../lib/mirrors";
import type { HomeRow } from "../lib/sections";
import { HomeSource } from "../lib/source";

class ${name} extends HomeSource {
  readonly info = {
    id: "mc.${flag("id") ?? name.toLowerCase()}",
    name: "${name}",
    version: "1.0.0",
    website: "${url}",
    rating: CatalogRating.MIXED,
    supportedLanguages: ["en_US"],
    thumbnail: "${name}.png",
  };
  protected readonly sorts = [{ id: "popular", title: "Popular", isDefault: true }];

  private readonly mirrors = new MirrorSet({ builtIn: ["${url}"], probePath: "/robots.txt" });

  protected rows(): HomeRow[] {
    return [{ id: "popular", title: "Popular", load: (page) => this.find({ page }) }];
  }

  protected async find(request: SearchRequest): Promise<PagedSearchResult> {
    throw new Error(\`TODO: search \${request.query ?? ""}\`);
  }

  async getPreferenceMenu(): Promise<Form> {
    return { sections: [await this.mirrors.section()] };
  }

  async getContent(contentId: string): Promise<Content> {
    const html = await this.mirrors.run(async (origin) => (await requireOk(await this.http.get(\`\${origin}\${contentId}\`)).text()));
    const $ = load(html);
    return { title: text($("h1").first()), cover: "", contentType: ContentType.NOVEL, chapters: [] };
  }

  async getChapterData(_contentId: string, chapterId: string): Promise<ChapterData> {
    return this.mirrors.run(async (origin) => {
      const url = \`\${origin}\${chapterId}\`;
      const response = requireOk(await this.http.get(url));
      const $ = load(await response.text());
      const body = cleanChapterHtml($, $("#content").first(), { baseUrl: url });
      return htmlChapter(response, chapterDocument(text($("h1").first()), body));
    });
  }
}

export class Target extends ${name} {}
`;

mkdirSync(folder, { recursive: true });
writeFileSync(join(folder, "main.ts"), main);
writeFileSync(
    join(ROOT, "probes", `${name}.json`),
    `${JSON.stringify({ query: "", expect: "html", intents: ["search", "providesChapters", "preferences", "pageResolver"] }, null, 2)}\n`,
);
console.log(`Created src/${name}/main.ts and probes/${name}.json. Add assets/${name}.png.`);
