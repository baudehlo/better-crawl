// Self-contained live demo: boots a tiny local store, has the AI generate a
// crawler for it, then replays the artifact with zero LLM involvement.
//
//   ANTHROPIC_API_KEY=sk-... node examples/quickstart.mjs
//   (optional: BC_MODEL=claude-sonnet-4-6 to use a cheaper model)
//
// Run `npm run build` first — this imports from dist/.
import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { anthropic } from '@ai-sdk/anthropic';
import { generateCrawler, runCrawler, loadArtifact } from '../dist/index.mjs';

// --- a tiny server-rendered store ------------------------------------------
const PRODUCTS = Array.from({ length: 5 }, (_, i) => ({
  id: i + 1,
  name: `Aeropress Model ${i + 1}`,
  price: (i + 1) * 15 + 0.5,
  description: `Brews a remarkably smooth cup, edition ${i + 1}.`,
}));
const page = (body) => `<!doctype html><html><head><title>demo</title></head><body>${body}</body></html>`;
const server = http.createServer((req, res) => {
  if (req.url === '/robots.txt') return res.end('User-agent: *\nDisallow:\n');
  res.setHeader('content-type', 'text/html');
  if (req.url === '/') {
    return res.end(page(`<main><h1>Demo Store</h1><ul>${PRODUCTS.map(
      (p) => `<li class="product"><a href="/p/${p.id}">${p.name}</a><span class="price">$${p.price.toFixed(2)}</span></li>`,
    ).join('')}</ul></main>`));
  }
  const m = req.url.match(/^\/p\/(\d+)$/);
  const p = m && PRODUCTS.find((x) => x.id === Number(m[1]));
  if (p) {
    return res.end(page(`<main><h1 class="name">${p.name}</h1><span class="price">$${p.price.toFixed(2)}</span><p class="desc">${p.description}</p></main>`));
  }
  res.statusCode = 404;
  res.end('not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
console.log(`demo store at ${url}\n`);

// --- generate ---------------------------------------------------------------
const schemas = {
  product: z.object({
    name: z.string(),
    price: z.number(),
    description: z.string(),
    url: z.string(),
  }),
};

const gen = generateCrawler({
  url,
  instructions: 'Extract every product with its name, price, and full description from the detail page.',
  schemas,
  model: anthropic(process.env.BC_MODEL ?? 'claude-opus-5'),
  limits: { delayMs: 100 },
});
gen.on('progress', (e) => console.error(`[${e.phase}] ${e.message}`));
gen.on('llm-usage', (e) => console.error(`[tokens] ${e.phase}: ${e.inputTokens} in / ${e.outputTokens} out`));

const { artifact, report } = await gen;
await writeFile('demo-crawler.json', artifact.serialize());
console.log(`\ngenerated demo-crawler.json — engine: ${artifact.manifest.engine}, self-test: ${JSON.stringify(report.itemCounts)}`);
console.log(`LLM cost: ${artifact.manifest.stats.tokens.input} in / ${artifact.manifest.stats.tokens.output} out tokens (attempts: ${artifact.manifest.stats.attempts})\n`);

// --- replay: zero tokens ----------------------------------------------------
const replay = runCrawler(loadArtifact(artifact.serialize()), { schemas, limits: { delayMs: 0 } });
for await (const item of replay.items('product')) console.log('replayed:', item);
const result = await replay;
console.log(`\nreplay ok=${result.report.ok} in ${result.report.durationMs}ms — and it cost 0 tokens`);
server.close();
