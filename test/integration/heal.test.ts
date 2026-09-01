import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import type { Artifact } from '../../src/artifact.js';
import { BetterCrawlError } from '../../src/errors.js';
import { runCrawler } from '../../src/run.js';
import { FakeLlm } from '../helpers/fake-llm.js';
import { makeArtifact } from '../helpers/make-artifact.js';
import {
  startMutableStore,
  MUTABLE_STORE_PRODUCT_COUNT,
  type MutableSite,
} from '../fixtures/sites/mutable-store.js';

const FAKE_MODEL = 'fake-model' as unknown as LanguageModel;

const productSchema = z.object({
  name: z.string().min(1),
  price: z.number(),
  description: z.string(),
  url: z.string(),
});
const schemas = { product: productSchema };

const CRAWL_CODE = `export default async function crawl(ctx) {
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

function v1Artifact(entryUrl: string): Artifact {
  return makeArtifact(
    {
      entryUrl,
      selectors: {
        productRow: { css: 'li.product', description: 'listing rows', expect: 'many', sampleText: 'Widget 1' },
        detailName: { css: 'h1.name', description: 'product name', expect: 'one' },
        detailPrice: { css: 'span.price', description: 'product price', expect: 'one' },
        detailDesc: { css: 'p.desc', description: 'product description', expect: 'one' },
      },
      assertions: [{ kind: 'minItems', schema: 'product', min: 4 }],
    },
    CRAWL_CODE,
  );
}

const V2_SELECTOR_PATCH = {
  selectors: {
    productRow: { css: 'li.card-item' },
    detailName: { css: 'h1.title' },
    detailPrice: { css: 'em.cost' },
    detailDesc: { css: 'div.description' },
  },
  reasoning: 'site was reskinned; data unchanged',
};

const FAST = { delayMs: 0 };

describe('runCrawler + heal', () => {
  let site: MutableSite;
  beforeEach(async () => {
    site = await startMutableStore();
  });
  afterEach(async () => {
    await site.close();
  });

  it('replays a saved artifact with zero LLM involvement', async () => {
    const result = await runCrawler(v1Artifact(`${site.url}/`), { schemas, limits: FAST });
    expect(result.healed).toBe(false);
    expect(result.report.ok).toBe(true);
    expect(result.items['product']).toHaveLength(MUTABLE_STORE_PRODUCT_COUNT);
  });

  it('resolves with report.ok=false on drift when heal is off', async () => {
    site.reskin();
    const result = await runCrawler(v1Artifact(`${site.url}/`), { schemas, limits: FAST });
    expect(result.healed).toBe(false);
    expect(result.report.ok).toBe(false);
    expect(result.report.itemCounts['product']).toBe(0);
  });

  it('requires a model when heal is enabled and the run fails', async () => {
    site.reskin();
    await expect(
      runCrawler(v1Artifact(`${site.url}/`), { schemas, heal: true, limits: FAST }),
    ).rejects.toThrow(BetterCrawlError);
  });

  it('heals selector drift with a selector-only patch (code untouched)', async () => {
    site.reskin();
    const fake = new FakeLlm({ objects: [V2_SELECTOR_PATCH] });
    const original = v1Artifact(`${site.url}/`);

    const handle = runCrawler(original, {
      schemas,
      heal: true,
      model: FAKE_MODEL,
      llmClient: fake,
      limits: FAST,
    });
    const updates: Artifact[] = [];
    handle.on('artifact-updated', (e) => updates.push(e.artifact));

    const result = await handle;
    expect(result.healed).toBe(true);
    expect(result.report.ok).toBe(true);
    expect(result.items['product']).toHaveLength(MUTABLE_STORE_PRODUCT_COUNT);
    expect(result.items['product']?.[0]).toMatchObject({ name: 'Widget 1', price: 10.99 });

    // selector-only: css patched, code identical, other metadata kept
    expect(result.artifact.code).toBe(original.code);
    expect(result.artifact.manifest.selectors['productRow']?.css).toBe('li.card-item');
    expect(result.artifact.manifest.selectors['productRow']?.description).toBe('listing rows');
    expect(updates).toHaveLength(1);

    // the repair prompt carried the selector table and the failure
    const repairMessages = fake.objectCalls[0]?.messages;
    const userTurn = String(repairMessages?.at(-1)?.content);
    expect(userTurn).toContain('li.product');
    expect(userTurn).toContain('Fresh page (condensed)');
    expect(userTurn).toContain('card-item'); // fresh page shows the new markup classes
  });

  it('escalates to scout-lite regeneration when the selector patch fails', async () => {
    site.reskin();
    const badPatch = {
      selectors: {
        productRow: { css: 'li.product' }, // unchanged → still broken
        detailName: { css: 'h1.name' },
        detailPrice: { css: 'span.price' },
        detailDesc: { css: 'p.desc' },
      },
      reasoning: 'looks fine to me',
    };
    const goodRegen = {
      engine: 'cheerio',
      selectors: {
        productRow: { css: 'li.card-item', description: 'listing rows', expect: 'many' },
        detailName: { css: 'h1.title', description: 'name', expect: 'one' },
        detailPrice: { css: 'em.cost', description: 'price', expect: 'one' },
        detailDesc: { css: 'div.description', description: 'description', expect: 'one' },
      },
      inputs: [],
      assertions: [{ kind: 'minItems', schema: 'product', min: 999 }], // must be IGNORED
      code: CRAWL_CODE,
      notes: 'rewritten for the redesign',
    };
    const fake = new FakeLlm({ objects: [badPatch, goodRegen] });

    const result = await runCrawler(v1Artifact(`${site.url}/`), {
      schemas,
      heal: true,
      model: FAKE_MODEL,
      llmClient: fake,
      limits: FAST,
    });

    expect(result.healed).toBe(true);
    expect(result.report.ok).toBe(true);
    expect(result.items['product']).toHaveLength(MUTABLE_STORE_PRODUCT_COUNT);
    // assertions never drift during healing — the old success bar stands
    expect(result.artifact.manifest.assertions).toEqual([
      { kind: 'minItems', schema: 'product', min: 4 },
    ]);
    expect(result.artifact.manifest.engine).toBe('cheerio');
  });

  it('throws HealFailedError with all reports when the budget runs out', async () => {
    site.reskin();
    const uselessPatch = {
      selectors: { productRow: { css: 'li.product' } },
      reasoning: 'no idea',
    };
    const uselessRegen = {
      engine: 'cheerio',
      selectors: {
        productRow: { css: 'li.nothing', description: 'rows', expect: 'many' },
        detailName: { css: 'h1.name', description: 'name', expect: 'one' },
        detailPrice: { css: 'span.price', description: 'price', expect: 'one' },
        detailDesc: { css: 'p.desc', description: 'description', expect: 'one' },
      },
      inputs: [],
      assertions: [],
      code: CRAWL_CODE,
      notes: 'still wrong',
    };
    const fake = new FakeLlm({ objects: [uselessPatch, uselessRegen] });

    const error = await runCrawler(v1Artifact(`${site.url}/`), {
      schemas,
      heal: true,
      model: FAKE_MODEL,
      llmClient: fake,
      healAttempts: 2,
      limits: FAST,
    }).then(
      () => Promise.reject(new Error('should have failed')),
      (e: unknown) => e,
    );
    expect((error as Error).message).toMatch(/Healing failed after 2 attempt/);
    expect((error as { reports: unknown[] }).reports.length).toBe(3); // original + patch try + regen try
  });
});
