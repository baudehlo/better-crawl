import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LanguageModel, ToolSet } from 'ai';
import type { Artifact } from '../../src/artifact.js';
import { BetterCrawlError, HealFailedError } from '../../src/errors.js';
import type { CrawlEvent } from '../../src/events.js';
import { runCrawler } from '../../src/run.js';
import { FakeLlm } from '../helpers/fake-llm.js';
import { makeArtifact } from '../helpers/make-artifact.js';
import {
  startMutableStore,
  MUTABLE_STORE_PRODUCT_COUNT,
  type MutableSite,
} from '../fixtures/sites/mutable-store.js';

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
const FAST = { delayMs: 0 };

const productSchema = z.object({
  name: z.string().min(1),
  price: z.number(),
  description: z.string(),
  url: z.string(),
});
const schemas = { product: productSchema };

const V1_CODE = `export default async function crawl(ctx) {
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

function v1Artifact(entryUrl: string): Artifact {
  return makeArtifact(
    {
      entryUrl,
      instructions: 'Extract every product',
      selectors: {
        productRow: { css: 'li.product', description: 'listing rows', expect: 'many' },
        detailName: { css: 'h1.name', description: 'name', expect: 'one' },
        detailPrice: { css: 'span.price', description: 'price', expect: 'one' },
        detailDesc: { css: 'p.desc', description: 'description', expect: 'one' },
      },
      assertions: [{ kind: 'minItems', schema: 'product', min: 4 }],
    },
    V1_CODE,
  );
}

/** Scripted scout for the reskinned (v2) markup. */
async function driveReskinScout(tools: ToolSet, siteUrl: string): Promise<void> {
  const call = async (name: string, input: unknown): Promise<string> => {
    const t = tools[name] as { execute: (i: unknown, o: unknown) => Promise<unknown> };
    return String(await t.execute(input, { toolCallId: 'test', messages: [] }));
  };
  await call('navigate', { url: `${siteUrl}/` });
  await call('try_selector', { selector: 'li.card-item' });
  await call('navigate', { url: `${siteUrl}/p/1` });
  await call('try_selector', { selector: 'h1.title' });
  await call('try_selector', { selector: 'em.cost' });
  await call('try_selector', { selector: 'div.description' });
  await call('probe_no_js', { url: `${siteUrl}/p/1` });
  const accepted = await call('report_findings', {
    engine: 'cheerio',
    engineReason: 'raw HTML has everything',
    selectors: {
      productRow: { css: 'li.card-item', description: 'listing rows', expect: 'many' },
      detailName: { css: 'h1.title', description: 'name', expect: 'one' },
      detailPrice: { css: 'em.cost', description: 'price', expect: 'one' },
      detailDesc: { css: 'div.description', description: 'description', expect: 'one' },
    },
    inputsNeeded: [],
    navigationPlan: ['open listing', 'read each detail page'],
    expectedCounts: { product: MUTABLE_STORE_PRODUCT_COUNT },
    sampleItems: {
      product: [
        {
          name: 'Widget 1',
          price: 10.99,
          description: 'The finest widget number 1.',
          url: `${siteUrl}/p/1`,
        },
        {
          name: 'Widget 2',
          price: 20.99,
          description: 'The finest widget number 2.',
          url: `${siteUrl}/p/2`,
        },
      ],
    },
  });
  if (!accepted.includes('ACCEPTED')) throw new Error(`scout script rejected: ${accepted}`);
}

const V2_CODEGEN_OUTPUT = {
  engine: 'cheerio',
  selectors: {
    productRow: { css: 'li.card-item', description: 'listing rows', expect: 'many' },
    detailName: { css: 'h1.title', description: 'name', expect: 'one' },
    detailPrice: { css: 'em.cost', description: 'price', expect: 'one' },
    detailDesc: { css: 'div.description', description: 'description', expect: 'one' },
  },
  inputs: [],
  assertions: [{ kind: 'minItems', schema: 'product', min: MUTABLE_STORE_PRODUCT_COUNT }],
  code: V1_CODE,
  notes: 'same shape, new class names',
};

describe("runCrawler heal: 'full'", () => {
  let site: MutableSite;
  beforeEach(async () => {
    site = await startMutableStore();
  });
  afterEach(async () => {
    await site?.close();
  });

  it('demands schemas before re-scouting', async () => {
    site.reskin();
    // no llmClient here: the real client is constructed (harmlessly) before
    // the missing-schemas check rejects the heal
    const handle = runCrawler(v1Artifact(site.url), {
      heal: 'full',
      model: FAKE_MODEL,
      limits: FAST,
    });
    const error = await handle.then(
      () => Promise.reject(new Error('should have failed')),
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BetterCrawlError);
    expect((error as BetterCrawlError).code).toBe('HEAL_FULL_NEEDS_SCHEMAS');
  });

  it.skipIf(!hasBrowser)(
    're-scouts the reskinned site and returns a fully regenerated artifact',
    async () => {
      site.reskin();
      const fake = new FakeLlm({
        driveAgent: (loop) => driveReskinScout(loop.tools, site.url),
        objects: [V2_CODEGEN_OUTPUT],
      });

      const events: CrawlEvent[] = [];
      const handle = runCrawler(v1Artifact(site.url), {
        heal: 'full',
        model: FAKE_MODEL,
        llmClient: fake,
        schemas,
        limits: FAST,
      });
      handle.on('progress', (e) => events.push(e));
      handle.on('artifact-updated', (e) => events.push(e));

      const result = await handle;
      expect(result.healed).toBe(true);
      expect(result.report.ok).toBe(true);
      expect(result.items['product']).toHaveLength(MUTABLE_STORE_PRODUCT_COUNT);
      expect(result.artifact.manifest.selectors['productRow']?.css).toBe('li.card-item');

      const updated = events.find((e) => e.type === 'artifact-updated');
      expect(updated?.type === 'artifact-updated' && updated.artifact).toBe(result.artifact);
      expect(
        events.some((e) => e.type === 'progress' && e.phase === 'heal' && /re-scout/.test(e.message)),
      ).toBe(true);
    },
  );
});

describe('healArtifact structural repair (no failure page captured)', () => {
  it('falls back to a fresh no-JS fetch of the entry page and keeps surviving sampleText anchors', async () => {
    const site = await startMutableStore();
    try {
      // fails before ANY fetch → no failure page in the outcome; the healer
      // must fetch the (live) entry page itself for repair context
      const artifact = makeArtifact(
        {
          entryUrl: `${site.url}/`,
          selectors: {
            productRow: {
              css: 'li.product',
              description: 'listing rows',
              expect: 'many',
              sampleText: 'Widget 1',
            },
          },
        },
        'export default async function crawl(ctx) { throw new Error("broken before first fetch"); }\n',
      );
      const fixedCode = `export default async function crawl(ctx) {
  const listing = await ctx.fetch(ctx.entryUrl);
  ctx.select(listing, 'productRow').each((i, el) => {
    ctx.emit('product', { name: listing.$(el).find('a').text().trim() });
  });
}
`;
      const fake = new FakeLlm({
        objects: [
          {
            engine: 'cheerio',
            // same name + same css as before → the old sampleText anchor survives
            selectors: { productRow: { css: 'li.product', description: 'listing rows', expect: 'many' } },
            inputs: [],
            assertions: [],
            code: fixedCode,
            notes: 'rewrote the broken logic',
          },
        ],
      });

      const result = await runCrawler(artifact, {
        heal: true,
        model: FAKE_MODEL,
        llmClient: fake,
        schemas: { product: z.object({ name: z.string() }) },
        limits: FAST,
      });
      expect(result.healed).toBe(true);
      expect(result.report.ok).toBe(true);
      expect(result.items['product']).toHaveLength(MUTABLE_STORE_PRODUCT_COUNT);
      expect(result.artifact.manifest.selectors['productRow']?.sampleText).toBe('Widget 1');

      // the regen prompt embedded the freshly fetched page, not "(unavailable)"
      const regenPrompt = String(fake.objectCalls[0]?.messages[1]?.content);
      expect(regenPrompt).toContain('Widget 1');
      expect(regenPrompt).not.toContain('(unavailable)');
    } finally {
      await site.close();
    }
  });
});

describe('healArtifact with a captured failure page', () => {
  it('reuses the failure page from the failed run instead of refetching', async () => {
    const site = await startMutableStore();
    try {
      // fetches the listing (so a failure page IS captured), then explodes
      const artifact = makeArtifact(
        {
          entryUrl: `${site.url}/`,
          selectors: {
            productRow: { css: 'li.product', description: 'rows', expect: 'many' },
          },
        },
        `export default async function crawl(ctx) {
  await ctx.fetch(ctx.entryUrl);
  throw new Error('exploded after the listing');
}
`,
      );
      const fake = new FakeLlm({
        objects: [
          {
            engine: 'cheerio',
            selectors: { productRow: { css: 'li.product', description: 'rows', expect: 'many' } },
            inputs: [],
            assertions: [],
            code: `export default async function crawl(ctx) {
  const listing = await ctx.fetch(ctx.entryUrl);
  ctx.select(listing, 'productRow').each((i, el) => {
    ctx.emit('product', { name: listing.$(el).find('a').text().trim() });
  });
}
`,
            notes: 'removed the explosion',
          },
        ],
      });
      const result = await runCrawler(artifact, {
        heal: true,
        model: FAKE_MODEL,
        llmClient: fake,
        schemas: { product: z.object({ name: z.string() }) },
        limits: FAST,
      });
      expect(result.healed).toBe(true);
      expect(result.report.ok).toBe(true);
      const regenPrompt = String(fake.objectCalls[0]?.messages[1]?.content);
      expect(regenPrompt).toContain('exploded after the listing');
      expect(regenPrompt).toContain('Widget 1');
    } finally {
      await site.close();
    }
  });
});

describe('healArtifact without any fresh page signal', () => {
  it('retries lint failures, then exhausts the budget against a dead site', async () => {
    const deadUrl = 'http://127.0.0.1:1/';
    const artifact = makeArtifact(
      {
        entryUrl: deadUrl,
        selectors: {},
        schemas: { product: z.toJSONSchema(productSchema) as Record<string, unknown> },
      },
      'export default async function crawl(ctx) { await ctx.fetch(ctx.entryUrl); }\n',
    );
    const fake = new FakeLlm({
      objects: [
        // first regen: fails static lint (no export default) → cheap retry
        {
          engine: 'cheerio',
          selectors: {},
          inputs: [],
          assertions: [],
          code: 'async function crawl(ctx) { /* not exported */ }\n',
          notes: 'oops',
        },
        // second regen: lints clean but the site is still unreachable
        {
          engine: 'cheerio',
          selectors: {},
          inputs: [],
          assertions: [],
          code: 'export default async function crawl(ctx) { await ctx.fetch(ctx.entryUrl); }\n',
          notes: 'still doomed',
        },
      ],
    });

    const handle = runCrawler(artifact, {
      heal: true,
      model: FAKE_MODEL,
      llmClient: fake,
      limits: FAST,
    });
    const error = await handle.then(
      () => Promise.reject(new Error('should have failed')),
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HealFailedError);
    expect((error as HealFailedError<unknown>).reports).toHaveLength(2);

    // the lint failure was fed back to the model, with no fresh page available
    const turns = (fake.objectCalls[1]?.messages ?? []).map((m) => String(m.content));
    expect(turns.some((t) => t.includes('Static lint failed'))).toBe(true);
    expect(String(fake.objectCalls[0]?.messages[1]?.content)).toContain('(unavailable)');
  });
});
