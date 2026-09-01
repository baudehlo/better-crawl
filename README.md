# better-crawl

[![CI](https://github.com/baudehlo/better-crawl/actions/workflows/ci.yml/badge.svg)](https://github.com/baudehlo/better-crawl/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20.19-brightgreen.svg)](package.json)

AI writes your crawler once. After that, it runs for free.

Point better-crawl at a URL with a plain-language description of what you want and your [zod](https://zod.dev) schemas. An LLM explores the site, writes a standalone crawler program (cheerio when the data is in the raw HTML, Playwright when JavaScript is required; it works out which), tests that crawler against the live site, and hands you back a JSON artifact. Replaying the artifact costs zero LLM tokens. When the site eventually changes and the crawler breaks, `heal` sends the failure report back to the model, patches the crawler, re-tests, and returns the updated artifact.

Tools that put an LLM in the loop for every page pay for intelligence on every crawl. This one pays twice: at generation, and again when the site gets redesigned.

```
generate:  URL + instructions + zod schemas ──▶ scout ──▶ codegen ──▶ self-test ⟲ repair ──▶ artifact.json
run:       artifact.json ──▶ validated, streamed items          (no LLM, no tokens)
heal:      broken artifact + failure report ──▶ patched artifact (small LLM call)
```

## Install

```bash
npm install better-crawl zod ai @ai-sdk/anthropic
# playwright is optional; needed for JS-rendered sites and for generation
npm install playwright && npx playwright install chromium
```

Requires Node 20.19 or later. Any [Vercel AI SDK](https://ai-sdk.dev) model works; the examples use Claude.

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

## Replay it, no LLM involved

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

Passing `schemas` on replay gives you strict zod validation. If you leave them out, items are checked against the JSON Schema copies embedded in the artifact instead.

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

Healing tries the cheap fix first: a selector-only patch, which handles the usual reskin for a few hundred tokens without touching the code. If that doesn't pass, it regenerates the code from the old artifact plus the failure report. A complete re-scout only happens if you ask for it with `heal: 'full'`.

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

Items stream to stdout (or `--out`) as NDJSON, progress goes to stderr, and the exit code is non-zero when the run's assertions fail. For credentials: `--input username=alice --input-env password=SHOP_PASSWORD`.

## Artifacts

An artifact is a single JSON file: a manifest (engine, entry URL, named inputs, a named selector table, JSON Schema copies of your schemas, success assertions, generation stats) plus the generated code, which is a plain ES module of the form `export default async function crawl(ctx) {...}`.

All CSS lives in the manifest, never in the code. Code refers to selectors by name (`ctx.sel('nextPage')`), which is what makes the cheap selector-only heal possible in the first place.

Artifacts are code — running one executes its embedded JavaScript. By default that happens inside a sandbox (see below), so a hostile or buggy artifact can't read your filesystem, spawn processes, or see your environment. Still treat an artifact like a dependency you vendored: review it before running it somewhere sensitive.

## Sandboxing

Artifact code runs **sandboxed by default**, in every phase that executes it (self-test, replay, heal). The scout and your own code are unaffected — only the LLM-written crawler program is confined.

The sandbox is a child process, not a JS-level jail (`vm` is not a security boundary and vm2 is dead): the runner is spawned with a **clean environment** — no API keys, no database URLs, nothing from `process.env` — under **Node's permission model**, which limits it to read-only access to the artifact's code and `node_modules`, and blocks child processes, workers, and native addons. Everything with authority stays in the parent and is reached over IPC:

- **Network** — the cookie jar, proxy, and retry/Cloudflare logic run parent-side; the cheerio engine's child never opens a socket, it asks the parent to fetch.
- **Gates** — robots.txt, the page budget, and the politeness delay are enforced in the parent, per navigation.
- **Validation** — your zod schemas never enter the child; every emitted item crosses the boundary raw and is judged by the parent.
- **Timeouts** — `limits.timeoutMs` becomes a hard kill instead of a cooperative signal, so a busy-looping artifact can't run forever.

On the playwright engine the parent launches the browser server and the child connects to it over a websocket, so the child additionally holds a browser connection (and artifact-declared `inputs` like login credentials, which it needs to type into forms) — weaker than the cheerio case, but still no fs, no exec, no ambient secrets.

Opting out: pass `noSandbox: true` (or `--no-sandbox` on the CLI) to run artifact code in-process. Do this only if your environment can't spawn the runner (the error will say so), and only for artifacts you trust like your own code. Spawn overhead is ~50ms per run.

Node version note: the permission model ships behind `--experimental-permission` on Node 20/22 (you may see an experimental warning on stderr) and as stable `--permission` on Node 23+. The clean-environment and process-isolation properties apply on every supported version.

## Credentials

Artifacts declare named inputs (`username`, `password`, and so on). Values are supplied at generate/run time and injected via `ctx.input(name)`. They are never embedded in the artifact, and secret values are scrubbed from everything sent to the LLM.

## Being a good citizen

By default better-crawl fetches `robots.txt` per origin and refuses disallowed URLs, honors `Crawl-delay`, waits 500ms between requests, caps runs at 100 pages and 10 minutes, and identifies itself as `better-crawl/<version> (+https://github.com/baudehlo/better-crawl)`. All of this is configurable through `limits`, `userAgent`, and `ignoreRobots`; what you do with the knobs is on you.

Note that generation performs up to `1 + maxRepairAttempts` real crawls of the target site while self-testing. Develop against a staging copy or a local fixture when you can.

## Network options

Both `generateCrawler` and `runCrawler` accept the same networking knobs, applied to every fetch and browser request the library makes (scout, self-test, replay, and heal alike):

```ts
{
  // Route all traffic through a proxy. ignoreTlsErrors accepts the certificates of
  // TLS-intercepting proxies (e.g. Bright Data's residential network).
  proxy: { server: 'http://host:8080', username: 'u', password: 'p', ignoreTlsErrors: true },

  // Extra headers on every request (merged over the user-agent; browser requests
  // send them as extraHTTPHeaders).
  headers: { 'x-team': 'data-eng' },

  // Transient-failure retries — ON by default. Network drops retry for any method;
  // 429/502/503/504 retry for GETs only. Exponential backoff: 1s doubling to 30s,
  // 2 retries. `retry: { attempts: 0 }` disables.
  retry: { attempts: 2, backoffMs: 1_000, maxBackoffMs: 30_000 },

  // Launch a specific Chromium (e.g. a system browser in Docker) with extra args.
  browser: { executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] },
}
```

Cloudflare challenges get their own retry schedule: a 403/503 carrying Cloudflare markers (`cf-ray`/`cf-mitigated` headers, a challenge page body) waits 5s doubling to a 300s cap, 4 attempts, independent of the ordinary retry budget. Tune or disable it with `retry.cloudflare` (`false`, or `{ attempts, backoffMs, maxBackoffMs }`). These waits count against `limits.timeoutMs` (10 minutes by default) — raise it for sites that challenge aggressively.

## Events

Handles returned by `generateCrawler`/`runCrawler` are promises, async-iterables, and event emitters all at once:

| Event | Payload |
|---|---|
| `progress` | `{ phase: 'scout'\|'codegen'\|'selftest'\|'repair'\|'run'\|'heal', message, pct? }` |
| `item` | `{ schema, item }` — validated, streamed as found |
| `invalid-item` | `{ schema, issues, raw }` — recorded, never fatal |
| `screenshot` | `{ label, buffer? , path? }` — enable with `screenshots: true` (+ `screenshotDir`) |
| `page` | `{ phase, url, html }` — raw page after each navigation; enable with `pageEvents: true`. Free on cheerio; costs a DOM serialization per page on playwright (snapshotted post-navigation, pre-interaction). Fires during self-test/replay/heal, not the scout. Lets the host run its own passes (meta tags, link scans) without re-fetching |
| `llm-usage` | `{ phase, inputTokens, outputTokens }` |
| `artifact-updated` | `{ artifact }` — a heal produced a repair; persist it |
| `log` / `error` | diagnostics |

## How generation works

1. **Scout.** An agent loop drives a real browser: condensed page reads (links + text, never raw HTML or the accessibility tree), selector verification, automatic listing-pattern detection, pagination exhaustion, and a no-JS probe that decides cheerio vs playwright. Its exit tool is gated. Reports with unverified selectors, invalid sample items, or an unproven cheerio claim get rejected with instructions, and the model corrects itself in-run.
2. **Codegen.** One structured-output call produces the code and manifest. The library overrides anything it verified itself: the engine choice, selector samples, and assertion floors.
3. **Self-test.** Static lint first, so obviously broken code never touches the site, then a full live run with every item validated per-schema and assertions checked (`minItems`, field coverage, URLs reached). Failures are compacted into a digest and sent back for repair, three attempts by default. You only ever receive an artifact that has passed.

## License

MIT © Matt Sergeant
