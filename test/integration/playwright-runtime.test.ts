import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { executeArtifact } from '../../src/runtime/execute.js';
import { makeArtifact } from '../helpers/make-artifact.js';
import { startJsStore, JS_STORE_PRODUCT_COUNT } from '../fixtures/sites/js-store.js';
import { startPaginated, PAGINATED_TOTAL_ITEMS } from '../fixtures/sites/paginated.js';
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

const FAST = { delayMs: 0 };

describe.skipIf(!hasBrowser)('playwright runtime', () => {
  let jsStore: FixtureSite;
  let paginated: FixtureSite;

  beforeAll(async () => {
    jsStore = await startJsStore();
    paginated = await startPaginated();
  });
  afterAll(async () => {
    await jsStore?.close();
    await paginated?.close();
  });

  it('crawls the client-rendered store (goto/waitFor/text helpers)', async () => {
    const productSchema = z.object({ name: z.string().min(1), price: z.number() });
    const artifact = makeArtifact(
      {
        engine: 'playwright',
        entryUrl: `${jsStore.url}/`,
        selectors: {
          productRow: { css: 'li.product', description: 'product rows', expect: 'many' },
          productName: { css: 'li.product .name', description: 'names', expect: 'many' },
          productPrice: { css: 'li.product .price', description: 'prices', expect: 'many' },
        },
        assertions: [{ kind: 'minItems', schema: 'product', min: JS_STORE_PRODUCT_COUNT }],
      },
      `export default async function crawl(ctx) {
  await ctx.goto(ctx.entryUrl);
  await ctx.waitFor('productRow');
  const names = await ctx.text('productName');
  const prices = await ctx.text('productPrice');
  for (let i = 0; i < names.length; i++) {
    ctx.emit('product', { name: names[i], price: Number(prices[i].replace(/[^0-9.]/g, '')) });
  }
  ctx.progress('extracted ' + names.length + ' products');
}
`,
    );

    const { report, items } = await executeArtifact(artifact, {
      schemas: { product: productSchema },
      limits: FAST,
    });
    expect(report.runtimeError).toBeUndefined();
    expect(report.ok).toBe(true);
    expect(report.itemCounts['product']).toBe(JS_STORE_PRODUCT_COUNT);
    expect(items['product']?.[0]).toEqual({ name: 'Gadget 1', price: 5 });
  });

  it('emits a rendered page event after goto when pageEvents is on', async () => {
    const artifact = makeArtifact(
      {
        engine: 'playwright',
        entryUrl: `${jsStore.url}/`,
        selectors: {
          productRow: { css: 'li.product', description: 'product rows', expect: 'many' },
        },
      },
      `export default async function crawl(ctx) {
  await ctx.goto(ctx.entryUrl);
}
`,
    );

    const events: Array<{ type: string; url?: string; html?: string; phase?: string }> = [];
    const { report } = await executeArtifact(artifact, {
      limits: FAST,
      pageEvents: true,
      emitEvent: (e) => events.push(e),
    });
    expect(report.runtimeError).toBeUndefined();
    const pages = events.filter((e) => e.type === 'page');
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ phase: 'run', url: `${jsStore.url}/` });
    // the snapshot is the live DOM, so it includes what client-side JS rendered
    expect(pages[0]?.html).toContain('class="product"');
  });

  it('loadAll survives the async-count trap and exhausts the listing', async () => {
    const artifact = makeArtifact(
      {
        engine: 'playwright',
        entryUrl: `${paginated.url}/`,
        selectors: {
          item: { css: 'li.item', description: 'list items', expect: 'many' },
        },
        assertions: [{ kind: 'minItems', schema: 'entry', min: PAGINATED_TOTAL_ITEMS }],
      },
      `export default async function crawl(ctx) {
  await ctx.goto(ctx.entryUrl);
  const n = await ctx.loadAll('item', { pollIntervalMs: 100 });
  ctx.progress('loadAll settled at ' + n);
  const labels = await ctx.text('item');
  for (const label of labels) ctx.emit('entry', { label });
}
`,
    );

    const { report } = await executeArtifact(artifact, {
      schemas: { entry: z.object({ label: z.string() }) },
      limits: FAST,
    });
    expect(report.runtimeError).toBeUndefined();
    expect(report.ok).toBe(true);
    expect(report.itemCounts['entry']).toBe(PAGINATED_TOTAL_ITEMS);
  }, 90_000);

  it('reports failedSelector when a named selector never appears', async () => {
    const artifact = makeArtifact(
      {
        engine: 'playwright',
        entryUrl: `${jsStore.url}/`,
        selectors: {
          ghost: { css: '.does-not-exist', description: 'nothing', expect: 'one' },
        },
      },
      `export default async function crawl(ctx) {
  await ctx.goto(ctx.entryUrl);
  await ctx.waitFor('ghost', { timeoutMs: 500 });
}
`,
    );

    const { report } = await executeArtifact(artifact, { limits: FAST });
    expect(report.ok).toBe(false);
    expect(report.runtimeError?.failedSelector).toBe('ghost');
    expect(report.runtimeError?.message).toMatch(/matched 0 elements/);
  });
});
