// Generate a crawler for a real site, then replay it.
//
//   ANTHROPIC_API_KEY=sk-... node examples/real-site.mjs <url> "<what to find>"
//
// Edit `schemas` below to match what you're extracting. Artifacts are written
// to ./artifacts/<hostname>.json; if one already exists it is replayed (with
// healing) instead of regenerating.
//
// Tip (KikiPlan): pick a real source URL from the local database, e.g.
//   psql kikiplan -tAc "select url from crawl_sources where enabled limit 10"
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { anthropic } from '@ai-sdk/anthropic';
import { generateCrawler, runCrawler, loadArtifact } from '../dist/index.mjs';

const [url, instructions] = process.argv.slice(2);
if (!url || !instructions) {
  console.error('usage: node examples/real-site.mjs <url> "<what to find>"');
  process.exit(2);
}

// EDIT ME — the shape(s) of the data you want back:
const schemas = {
  session: z.object({
    name: z.string(),
    url: z.string(),
    cost: z.number().nullable(),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    ageMin: z.number().nullable(),
    ageMax: z.number().nullable(),
  }),
};

const model = anthropic(process.env.BC_MODEL ?? 'claude-opus-5');
await mkdir('artifacts', { recursive: true });
const artifactFile = `artifacts/${new URL(url).hostname}.json`;

const existing = await readFile(artifactFile, 'utf8').catch(() => undefined);

if (!existing) {
  const gen = generateCrawler({ url, instructions, schemas, model, screenshots: true, screenshotDir: 'artifacts/screenshots' });
  gen.on('progress', (e) => console.error(`[${e.phase}] ${e.message}`));
  gen.on('llm-usage', (e) => console.error(`[tokens] ${e.phase}: ${e.inputTokens}/${e.outputTokens}`));
  const { artifact, items } = await gen;
  await writeFile(artifactFile, artifact.serialize());
  console.log(`\nwrote ${artifactFile}; self-test items:`, Object.fromEntries(Object.entries(items).map(([k, v]) => [k, v.length])));
} else {
  const run = runCrawler(loadArtifact(existing), { schemas, heal: true, model });
  run.on('progress', (e) => console.error(`[${e.phase}] ${e.message}`));
  run.on('artifact-updated', async (e) => {
    await writeFile(artifactFile, e.artifact.serialize());
    console.error(`[heal] ${artifactFile} updated`);
  });
  for await (const item of run.items()) console.log(JSON.stringify(item));
  const result = await run;
  console.error(`\nok=${result.report.ok} healed=${result.healed} items=${JSON.stringify(result.report.itemCounts)}`);
}
