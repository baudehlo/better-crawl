import { toJsonSchema } from '../json-schema.js';
import type { Schemas } from '../types.js';
import type { ScoutFindings } from '../scout/findings.js';

const SHARED_CTX_API = `// Shared ctx API (both engines):
ctx.entryUrl                       // string — the crawl's starting URL. Never hardcode URLs.
ctx.emit(schemaName, item)         // validate + stream one extracted item; returns false if invalid (keep going)
ctx.input(name)                    // string value of a declared input (credentials etc.). Never hardcode credential values.
ctx.sel(name)                      // CSS of a named selector from the manifest
ctx.progress(message, pct?)        // report progress at each phase
ctx.log(level, message)            // 'debug' | 'info' | 'warn'
ctx.screenshot(label)              // capture a screenshot (no-op on cheerio)
ctx.sleep(ms)`;

const PLAYWRIGHT_CTX_API = `${SHARED_CTX_API}

// Playwright engine — all selector arguments are NAMES from the manifest, never raw CSS:
await ctx.goto(url)                          // navigate (politeness + robots + budget enforced)
await ctx.click(name)                        // click first match; throws if 0 matches
await ctx.fill(name, value)                  // fill first match (pair with ctx.input for credentials)
await ctx.waitFor(name, { timeoutMs? })      // wait until the selector appears; throws if it never does
await ctx.text(name)                         // string[] — trimmed innerText of every match
await ctx.attr(name, attribute)              // (string|null)[] per match
await ctx.links(name)                        // string[] — absolute deduped hrefs of matches
await ctx.count(name)                        // number of matches
await ctx.loadAll(name, { maxClicks? })      // exhaust "load more"/lazy lists; returns final count. ALWAYS use this instead of writing your own load-more loop.
ctx.page                                     // the raw Playwright Page — LAST RESORT only, for logic the helpers can't express

// Worked example:
export default async function crawl(ctx) {
  await ctx.goto(ctx.entryUrl);
  await ctx.waitFor('productRow');
  await ctx.loadAll('productRow');
  const urls = await ctx.links('productLink');
  ctx.progress('found ' + urls.length + ' products');
  for (const url of urls) {
    await ctx.goto(url);
    const [name] = await ctx.text('detailName');
    const [priceText] = await ctx.text('detailPrice');
    ctx.emit('product', {
      name,
      price: Number((priceText || '').replace(/[^0-9.]/g, '')) || null,
      url,
    });
  }
}`;

const CHEERIO_CTX_API = `${SHARED_CTX_API}

// Cheerio engine — plain HTTP + HTML parsing (no JavaScript execution):
const page = await ctx.fetch(url)            // GET through a cookie jar → { $, url, status }
                                             //   page.$ is the CheerioAPI; page.url is the FINAL url after redirects
const page = await ctx.submitForm(url, fields) // urlencoded POST through the cookie jar (form logins)
ctx.select(page, name)                       // query the page with a NAMED manifest selector → Cheerio selection
ctx.absolute(href, base)                     // resolve a relative href

// Worked example (with login):
export default async function crawl(ctx) {
  const loginUrl = new URL('/login', ctx.entryUrl).href;
  const loginPage = await ctx.fetch(loginUrl);
  const csrf = ctx.select(loginPage, 'csrfField').attr('value');
  await ctx.submitForm(loginUrl, {
    username: ctx.input('username'),
    password: ctx.input('password'),
    csrf,
  });
  const listing = await ctx.fetch(ctx.entryUrl);
  const links = [];
  ctx.select(listing, 'itemRow').each((i, el) => {
    const href = listing.$(el).find('a').attr('href');
    if (href) links.push(ctx.absolute(href, listing.url));
  });
  for (const link of links) {
    const detail = await ctx.fetch(link);
    ctx.emit('record', {
      name: ctx.select(detail, 'detailName').first().text().trim(),
      url: detail.url,
    });
  }
}`;

export function buildCodegenSystemPrompt(engine: 'playwright' | 'cheerio'): string {
  return `You write crawler programs for the better-crawl runtime. Given scout findings about a website, you produce a single JSON object containing a complete crawler module plus its manifest metadata (selectors, inputs, assertions).

## The runtime API your code runs against
${engine === 'playwright' ? PLAYWRIGHT_CTX_API : CHEERIO_CTX_API}

## Hard rules for the code
1. The code is ONE plain ES module: \`export default async function crawl(ctx) { ... }\`. No imports, no require — only ctx and standard JavaScript (URL, JSON, Math, RegExp are available).
2. NO raw CSS strings in the code. Every selector lives in the "selectors" manifest table you return, and code refers to it only by name (ctx.sel/click/text/select...). This is what makes the crawler self-healing — breaking this rule makes the artifact unrepairable.
3. NO credential or user-value literals in the code — use ctx.input(name) and declare each input in "inputs".
4. Emit items ONE AT A TIME with ctx.emit as soon as each is extracted (items stream to the caller). Emit ALL items found — never skip, merge, or deduplicate entries that look similar; distinct URLs mean distinct items.
5. Convert types correctly for the schema: numbers as numbers (strip currency symbols), null for genuinely absent optional values — never 0 or "" as a guess.
6. Call ctx.progress at each phase (e.g. "logged in", "reading detail 3/20").
7. Handle absence gracefully: check counts/lengths before indexing; a missing optional field is null, not a crash.
8. Keep the code short and boring. Prefer the ctx helpers over clever DOM logic. Use ctx.loadAll for any "load more" pattern (playwright).

## The manifest you return alongside the code
- "selectors": every selector the code references, with a one-line description and expect: "one" | "many" | "maybe". Reuse the scout's verified selector names/CSS wherever they fit.
- "inputs": every ctx.input the code uses ({ name, description, secret, required }).
- "assertions": what a successful run looks like — at minimum one { kind: "minItems", schema, min } per schema based on the scout's expected counts (use roughly 60% of the expected count as min, to tolerate site variance), plus { kind: "fieldCoverage", schema, field, minRatio } for fields that should almost always be present, and { kind: "urlReached", pattern } for pages the crawl must reach (regex).
- "notes": one short paragraph on the approach and anything fragile.

Your response is consumed by a machine: return exactly the requested JSON object.`;
}

export interface CodegenUserContext {
  instructions: string;
  entryUrl: string;
  schemas: Schemas;
  findings: ScoutFindings;
}

export function buildCodegenUserMessage(ctx: CodegenUserContext): string {
  const schemaText = Object.entries(ctx.schemas)
    .map(([name, schema]) => `### ${name}\n${JSON.stringify(toJsonSchema(schema))}`)
    .join('\n\n');

  const selectorLines = Object.entries(ctx.findings.selectors)
    .map(([name, def]) => {
      const sample = ctx.findings.selectorSamples[name];
      return `- ${name}: ${JSON.stringify(def.css)} (${def.expect}) — ${def.description}${
        sample ? ` — sample match: ${JSON.stringify(sample)}` : ''
      }`;
    })
    .join('\n');

  const keyPages = ctx.findings.keyPages
    .map((page) => `--- ${page.url} ---\n${page.condensed}`)
    .join('\n\n');

  return `## Task
${ctx.instructions}

## Entry URL
${ctx.entryUrl}

## Target schemas (JSON Schema)
${schemaText}

## Scout findings
Engine: ${ctx.findings.engine} — ${ctx.findings.engineReason}
Verified selectors:
${selectorLines || '(none)'}
Inputs needed: ${JSON.stringify(ctx.findings.inputsNeeded)}
Expected item counts: ${JSON.stringify(ctx.findings.expectedCounts)}
Navigation plan (from exploration):
${ctx.findings.navigationPlan.map((step, i) => `${i + 1}. ${step}`).join('\n')}
Sample items (extracted by the scout from real pages):
${JSON.stringify(ctx.findings.sampleItems, null, 2)}

## Condensed snapshots of key pages
${keyPages}

Write the crawler now.`;
}
