import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LanguageModel, ToolSet } from 'ai';
import { GenerationFailedError } from '../../src/errors.js';
import type { CrawlEventOf } from '../../src/events.js';
import { generateCrawler } from '../../src/generate.js';
import { FakeLlm } from '../helpers/fake-llm.js';
import { startStaticStore, STATIC_STORE_PRODUCT_COUNT } from '../fixtures/sites/static-store.js';
import type { FixtureSite } from '../fixtures/sites/server.js';

const hasBrowser = await (async () => {
  try {
    const pw = await import('playwright');
    const browser = await pw.chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
})();

const FAKE_MODEL = 'fake-model' as unknown as LanguageModel;

const productSchema = z.object({
  name: z.string().min(1),
  price: z.number(),
  description: z.string(),
  url: z.string(),
});

/** Scripted scout: explore the static store and get findings ACCEPTED. */
async function driveStaticStoreScout(tools: ToolSet, storeUrl: string): Promise<void> {
  const call = async (name: string, input: unknown): Promise<string> => {
    const t = tools[name] as { execute: (i: unknown, o: unknown) => Promise<unknown> };
    return String(await t.execute(input, { toolCallId: 'test', messages: [] }));
  };
  await call('navigate', { url: `${storeUrl}/` });
  await call('try_selector', { selector: 'li.product' });
  await call('probe_no_js', { url: `${storeUrl}/` });
  const accepted = await call('report_findings', {
    engine: 'cheerio',
    engineReason: 'all data present in raw HTML',
    selectors: {
      productRow: { css: 'li.product', description: 'listing rows', expect: 'many' },
    },
    inputsNeeded: [],
    navigationPlan: ['open listing', 'follow each product link', 'read detail fields'],
    expectedCounts: { product: STATIC_STORE_PRODUCT_COUNT },
    sampleItems: {
      product: [
        { name: 'Widget 1', price: 10.99, description: 'The finest widget number 1.', url: `${storeUrl}/p/1` },
        { name: 'Widget 2', price: 20.99, description: 'The finest widget number 2.', url: `${storeUrl}/p/2` },
      ],
    },
  });
  if (!accepted.includes('ACCEPTED')) throw new Error(`scout script rejected: ${accepted}`);
}

const WORKING_CODE = `export default async function crawl(ctx) {
  ctx.progress('fetching listing');
  const listing = await ctx.fetch(ctx.entryUrl);
  const links = [];
  ctx.select(listing, 'productRow').each((i, el) => {
    links.push(ctx.absolute(listing.$(el).find('a').attr('href'), listing.url));
  });
  for (const link of links) {
    const detail = await ctx.fetch(link);
    ctx.emit('product', {
      name: ctx.select(detail, 'detailName').first().text().trim(),
      price: Number(ctx.select(detail, 'detailPrice').first().text().replace(/[^0-9.]/g, '')),
      description: ctx.select(detail, 'detailDesc').first().text().trim(),
      url: detail.url,
    });
  }
}
`;

function codegenOutput(code: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    engine: 'cheerio',
    selectors: {
      productRow: { css: 'li.product', description: 'listing rows', expect: 'many' },
      detailName: { css: 'h1.name', description: 'product name', expect: 'one' },
      detailPrice: { css: 'span.price', description: 'product price', expect: 'one' },
      detailDesc: { css: 'p.desc', description: 'product description', expect: 'one' },
    },
    inputs: [],
    assertions: [{ kind: 'minItems', schema: 'product', min: 6 }],
    code,
    notes: 'listing → detail pages',
    ...overrides,
  };
}

describe.skipIf(!hasBrowser)('generateCrawler pipeline (FakeLlm)', () => {
  let store: FixtureSite;
  beforeAll(async () => {
    store = await startStaticStore();
  });
  afterAll(async () => {
    await store?.close();
  });

  it('repairs a lint-broken first attempt and returns a self-tested artifact', async () => {
    const fake = new FakeLlm({
      driveAgent: (loop) => driveStaticStoreScout(loop.tools, store.url),
      objects: [
        // attempt 1: missing export default → static lint catches it, no live run
        codegenOutput('async function crawl(ctx) { /* forgot to export */ }\n'),
        // attempt 2: the working crawler
        codegenOutput(WORKING_CODE),
      ],
    });

    const events: CrawlEventOf<'progress'>[] = [];
    const handle = generateCrawler({
      url: `${store.url}/`,
      instructions: 'Extract every product with name, price and description',
      schemas: { product: productSchema },
      model: FAKE_MODEL,
      llmClient: fake,
      limits: { delayMs: 0 },
    });
    handle.on('progress', (e) => events.push(e));

    const { artifact, items, report } = await handle;

    expect(report.ok).toBe(true);
    expect(items['product']).toHaveLength(STATIC_STORE_PRODUCT_COUNT);
    expect(artifact.manifest.engine).toBe('cheerio');
    expect(artifact.manifest.stats.attempts).toBe(2);
    // minItems floored to 60% of the scout's expected count
    expect(artifact.manifest.assertions).toContainEqual({
      kind: 'minItems',
      schema: 'product',
      min: Math.floor(STATIC_STORE_PRODUCT_COUNT * 0.6),
    });
    expect(artifact.manifest.stats.testItemCounts['product']).toBe(STATIC_STORE_PRODUCT_COUNT);
    expect(artifact.manifest.selectors['productRow']?.sampleText).toContain('Widget 1');

    // the repair prompt carried the failure digest
    const repairTurn = fake.objectCalls[1]?.messages.at(-1);
    expect(String(repairTurn?.content)).toContain('SELF-TEST FAILED');
    expect(String(repairTurn?.content)).toContain('export default');

    // events narrate the arc: codegen → selftest fail → repair → pass
    const phases = events.map((e) => e.phase);
    expect(phases).toContain('scout');
    expect(phases).toContain('codegen');
    expect(phases).toContain('repair');
    expect(phases).toContain('selftest');

    // serialized artifact round-trips
    const { Artifact } = await import('../../src/artifact.js');
    expect(Artifact.parse(artifact.serialize()).manifest).toEqual(artifact.manifest);
  });

  it('repairs a runtime failure (bad selector) using the digest', async () => {
    const fake = new FakeLlm({
      driveAgent: (loop) => driveStaticStoreScout(loop.tools, store.url),
      objects: [
        // attempt 1: wrong detail selectors → items all invalid → assertions fail
        codegenOutput(WORKING_CODE, {
          selectors: {
            productRow: { css: 'li.product', description: 'rows', expect: 'many' },
            detailName: { css: 'h9.nope', description: 'name', expect: 'one' },
            detailPrice: { css: 'span.price', description: 'price', expect: 'one' },
            detailDesc: { css: 'p.desc', description: 'description', expect: 'one' },
          },
        }),
        codegenOutput(WORKING_CODE),
      ],
    });

    const handle = generateCrawler({
      url: `${store.url}/`,
      instructions: 'Extract every product',
      schemas: { product: productSchema },
      model: FAKE_MODEL,
      llmClient: fake,
      limits: { delayMs: 0 },
    });

    const { artifact, report } = await handle;
    expect(report.ok).toBe(true);
    expect(artifact.manifest.stats.attempts).toBe(2);

    const repairTurn = String(fake.objectCalls[1]?.messages.at(-1)?.content);
    expect(repairTurn).toContain('SELF-TEST FAILED');
    expect(repairTurn).toMatch(/invalid|Assertion FAILED/);
  });

  it('retries a malformed codegen response and merges scout inputs/assertions', async () => {
    const driveWithInputs = async (tools: ToolSet): Promise<void> => {
      const call = async (name: string, input: unknown): Promise<string> => {
        const t = tools[name] as { execute: (i: unknown, o: unknown) => Promise<unknown> };
        return String(await t.execute(input, { toolCallId: 'test', messages: [] }));
      };
      await call('navigate', { url: `${store.url}/` });
      await call('try_selector', { selector: 'li.product' });
      await call('probe_no_js', { url: `${store.url}/` });
      const accepted = await call('report_findings', {
        engine: 'cheerio',
        engineReason: 'raw HTML',
        selectors: {
          productRow: { css: 'li.product', description: 'rows', expect: 'many' },
        },
        inputsNeeded: [{ name: 'apiKey', description: 'the API key', secret: true }],
        navigationPlan: ['listing', 'details'],
        // "phantom" has no matching user schema → no assertion is invented for it
        expectedCounts: { product: STATIC_STORE_PRODUCT_COUNT, phantom: 3 },
        sampleItems: {
          product: [
            { name: 'Widget 1', price: 10.99, description: 'The finest widget number 1.', url: `${store.url}/p/1` },
            { name: 'Widget 2', price: 20.99, description: 'The finest widget number 2.', url: `${store.url}/p/2` },
          ],
        },
      });
      if (!accepted.includes('ACCEPTED')) throw new Error(`scout script rejected: ${accepted}`);
    };

    const fake = new FakeLlm({
      driveAgent: (loop) => driveWithInputs(loop.tools),
      objects: [
        // attempt 1: not a CodegenOutput at all → schema parse throws → retried
        { garbage: true },
        // attempt 2: valid, with non-minItems assertions and no product minItems
        codegenOutput(WORKING_CODE, {
          assertions: [
            { kind: 'fieldCoverage', schema: 'product', field: 'name', minRatio: 0.5 },
            { kind: 'minItems', schema: 'extra', min: 0 },
          ],
          inputs: [{ name: 'note', description: 'free-form note', secret: false, required: false }],
          selectors: {
            productRow: { css: 'li.product', description: 'listing rows', expect: 'many' },
            // the scout verified this same CSS under the name "productRow"
            rowsAlias: { css: 'li.product', description: 'renamed rows', expect: 'many' },
            detailName: { css: 'h1.name', description: 'product name', expect: 'one' },
            detailPrice: { css: 'span.price', description: 'product price', expect: 'one' },
            detailDesc: { css: 'p.desc', description: 'product description', expect: 'one' },
          },
        }),
      ],
    });

    const handle = generateCrawler({
      url: `${store.url}/`,
      instructions: 'Extract every product',
      schemas: { product: productSchema },
      // an object-shaped LanguageModel exercises the modelId-based description
      model: { modelId: 'object-model' } as unknown as LanguageModel,
      llmClient: fake,
      inputs: { apiKey: 'secret-key-123' },
      limits: { delayMs: 0 },
    });

    const { artifact, report } = await handle;
    expect(report.ok).toBe(true);
    expect(artifact.manifest.stats.attempts).toBe(2);
    expect(artifact.manifest.stats.model).toBe('object-model');

    // the malformed response was retried with an explanation, not fatal
    const retryTurn = String(fake.objectCalls[1]?.messages.at(-1)?.content);
    expect(retryTurn).toContain('Your previous response failed');

    // scout-discovered inputs the codegen omitted are merged in as required,
    // alongside the codegen's own declarations
    expect(artifact.manifest.inputs).toContainEqual({
      name: 'apiKey',
      description: 'the API key',
      secret: true,
      required: true,
    });
    expect(artifact.manifest.inputs).toContainEqual({
      name: 'note',
      description: 'free-form note',
      secret: false,
      required: false,
    });

    // a renamed selector with the scout's CSS inherits the scout's sample anchor
    expect(artifact.manifest.selectors['rowsAlias']?.sampleText).toContain('Widget 1');

    // non-minItems assertions pass through; a minItems for each expected schema is added
    expect(artifact.manifest.assertions).toContainEqual({
      kind: 'fieldCoverage',
      schema: 'product',
      field: 'name',
      minRatio: 0.5,
    });
    expect(artifact.manifest.assertions).toContainEqual({ kind: 'minItems', schema: 'extra', min: 0 });
    expect(artifact.manifest.assertions).toContainEqual({
      kind: 'minItems',
      schema: 'product',
      min: Math.floor(STATIC_STORE_PRODUCT_COUNT * 0.6),
    });
    expect(artifact.manifest.assertions.some((a) => a.kind === 'minItems' && a.schema === 'phantom')).toBe(
      false,
    );
  });

  it('propagates a codegen failure raw when it lands on the final attempt', async () => {
    const fake = new FakeLlm({
      driveAgent: (loop) => driveStaticStoreScout(loop.tools, store.url),
      objects: [], // generateObject immediately throws, and there are no retries left
    });
    const handle = generateCrawler({
      url: `${store.url}/`,
      instructions: 'Extract products',
      schemas: { product: productSchema },
      model: FAKE_MODEL,
      llmClient: fake,
      maxRepairAttempts: 0,
      limits: { delayMs: 0 },
    });
    await expect(handle).rejects.toThrow(/no scripted object remains/);
  });

  it('throws GenerationFailedError with the last artifact after exhausting attempts', async () => {
    const broken = codegenOutput('export default async function crawl(ctx) { throw new Error("always broken"); }\n');
    const fake = new FakeLlm({
      driveAgent: (loop) => driveStaticStoreScout(loop.tools, store.url),
      objects: [broken, broken],
    });

    const handle = generateCrawler({
      url: `${store.url}/`,
      instructions: 'Extract products',
      schemas: { product: productSchema },
      model: FAKE_MODEL,
      llmClient: fake,
      maxRepairAttempts: 1,
      limits: { delayMs: 0 },
    });

    const error = await handle.then(
      () => Promise.reject(new Error('should have failed')),
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GenerationFailedError);
    const failure = error as GenerationFailedError<import('../../src/artifact.js').Artifact, unknown>;
    expect(failure.lastArtifact?.code).toContain('always broken');
    expect(failure.reports).toHaveLength(2);
  });
});
