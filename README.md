# better-crawl

**AI writes your crawler once. After that, it runs for free.**

Point better-crawl at a URL with a natural-language description and your [zod](https://zod.dev) schemas. An LLM explores the site, writes a standalone crawler program (cheerio for static sites, Playwright when JavaScript is required — it decides), **self-tests it against the live site**, and hands you back a JSON *artifact*. Replaying the artifact costs zero LLM tokens. When the site eventually changes and the crawler breaks, `heal` sends the failure back to the model, patches the crawler, re-tests, and returns the updated artifact.

Unlike LLM-per-crawl tools, you pay for intelligence only twice: once at generation, and once per site redesign.

```
generate:  URL + instructions + zod schemas ──▶ scout ──▶ codegen ──▶ self-test ⟲ repair ──▶ artifact.json
run:       artifact.json ──▶ validated, streamed items          (no LLM, no tokens)
heal:      broken artifact + failure report ──▶ patched artifact (small LLM call)
```

## Install

```bash
npm install better-crawl zod ai @ai-sdk/anthropic
# playwright is optional — only needed for JS-rendered sites and for generation
npm install playwright && npx playwright install chromium
```

Requires Node ≥ 20.19. Bring any [Vercel AI SDK](https://ai-sdk.dev) model; the examples use Claude.

## Generate a crawler

```ts
import { generateCrawler } from 'better-crawl';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { writeFile } from 'node:fs/promises';

const gen = generateCrawler({
  url: 'https://example.com/products',
  instructions: 'Find every product with its name, price, and description',
  schemas: {
    product: z.object({
      name: z.string(),
      price: z.number().nullable(),
      description: z.string(),
      url: z.string(),
    }),
  },
  model: anthropic('claude-opus-5'),
});

gen.on('progress', (e) => console.error(`[${e.phase}] ${e.message}`));

const { artifact, items, report } = await gen; // resolves only after the self-test passes
await writeFile('crawler.json', artifact.serialize());
console.log(`self-test extracted ${items.product.length} products`, report.itemCounts);
```

## Replay it — no LLM involved

```ts
import { runCrawler, loadArtifact } from 'better-crawl';
import { readFile } from 'node:fs/promises';

const artifact = loadArtifact(await readFile('crawler.json', 'utf8'));
const run = runCrawler(artifact, { schemas: { product: productSchema } });

for await (const item of run.items('product')) {
  console.log(item); // items stream as they're extracted and validated
}
const result = await run;
if (!result.report.ok) console.error(result.report);
```

Passing `schemas` on replay gives you strict zod validation; without them, items are checked against the JSON Schema copies embedded in the artifact.

## Heal it when the site changes

```ts
const run = runCrawler(artifact, {
  schemas: { product: productSchema },
  heal: true,                      // or 'full' for a complete re-scout (may switch engine)
  model: anthropic('claude-opus-5'),
});
run.on('artifact-updated', async (e) => {
  await writeFile('crawler.json', e.artifact.serialize()); // persist the repair
});
const result = await run; // result.healed tells you whether a repair happened
```

Healing is tiered: a **selector-only patch** first (the usual case after a reskin — a few hundred tokens, the code is untouched), then a full code regeneration from the old artifact plus the failure report, and — only if you ask with `heal: 'full'` — a complete re-scout.

## CLI

```bash
# schemas.mjs:  export const product = z.object({ ... })
export ANTHROPIC_API_KEY=...

npx better-crawl generate https://example.com/products \
  -i "Find every product with name, price, description" \
  --schema ./schemas.mjs --out crawler.json

npx better-crawl run crawler.json --out items.ndjson        # zero-token replay
npx better-crawl run crawler.json --heal --schema ./schemas.mjs   # repair on drift
```

Items stream to stdout (or `--out`) as NDJSON; progress goes to stderr; the exit code is non-zero when the run's assertions fail. Credentials: `--input username=alice --input-env password=SHOP_PASSWORD`.

## What an artifact is — and a warning

An artifact is a single JSON file: a **manifest** (engine, entry URL, named inputs, a *named selector table*, JSON Schema copies of your schemas, success assertions, generation stats) plus the **generated code** — a plain ES module `export default async function crawl(ctx) {...}`.

Two properties matter:

- **All CSS lives in the manifest, never in the code.** Code references selectors by name (`ctx.sel('nextPage')`). That's what makes cheap selector-only healing possible.
- **⚠️ Artifacts are code.** Running an artifact executes its embedded JavaScript with the same privileges as your process. better-crawl generates and self-tests them, but it does not sandbox them. Treat an artifact like a dependency you vendored: review it before running it in sensitive environments, and don't run artifacts from sources you don't trust.

## Credentials

Artifacts declare named inputs (`username`, `password`, ...). Values are supplied at generate/run time and injected via `ctx.input(name)` — they are **never** embedded in the artifact, and secret values are scrubbed from everything sent to the LLM.

## Being a good citizen

By default better-crawl fetches `robots.txt` per origin and refuses disallowed URLs, honors `Crawl-delay`, waits 500ms between requests, caps runs at 100 pages and 10 minutes, and identifies itself as `better-crawl/<version> (+https://github.com/baudehlo/better-crawl)`. All of it is configurable (`limits`, `userAgent`, `ignoreRobots`) — what you do with the knobs is on you. Also: generation performs up to `1 + maxRepairAttempts` real crawls of the target site while self-testing. Develop against a staging copy or local fixture when you can.

## Events

Handles returned by `generateCrawler`/`runCrawler` are promises **and** async-iterables **and** event emitters:

| Event | Payload |
|---|---|
| `progress` | `{ phase: 'scout'\|'codegen'\|'selftest'\|'repair'\|'run'\|'heal', message, pct? }` |
| `item` | `{ schema, item }` — validated, streamed as found |
| `invalid-item` | `{ schema, issues, raw }` — recorded, never fatal |
| `screenshot` | `{ label, buffer? , path? }` — enable with `screenshots: true` (+ `screenshotDir`) |
| `llm-usage` | `{ phase, inputTokens, outputTokens }` |
| `artifact-updated` | `{ artifact }` — a heal produced a repair; persist it |
| `log` / `error` | diagnostics |

## How generation works

1. **Scout** — an agent loop drives a real browser: condensed page reads (links + text, never raw HTML or the accessibility tree), selector verification, automatic listing-pattern detection, pagination exhaustion, and a **no-JS probe** that decides cheerio vs playwright. Its exit tool is gated: reports with unverified selectors, invalid sample items, or an unproven cheerio claim are rejected with instructions, and the model corrects itself in-run.
2. **Codegen** — one structured-output call produces the code + manifest. The library overrides what it verified itself: the engine choice, selector samples, and assertion floors.
3. **Self-test** — static lint, then a full live run: every item validated per-schema, assertions checked (`minItems`, field coverage, URLs reached). Failures are compacted into a digest and sent back for repair (default 3 attempts). **You only ever receive an artifact that has passed.**

## License

MIT © Matt Sergeant
