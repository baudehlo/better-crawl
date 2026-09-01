import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MissingInputError } from '../../src/errors.js';
import type { CrawlEvent } from '../../src/events.js';
import { executeArtifact } from '../../src/runtime/execute.js';
import { makeArtifact } from '../helpers/make-artifact.js';
import { startLoginSite, LOGIN, LOGIN_SITE_RECORD_COUNT } from '../fixtures/sites/login-site.js';
import { startStaticStore, STATIC_STORE_PRODUCT_COUNT } from '../fixtures/sites/static-store.js';
import type { FixtureSite } from '../fixtures/sites/server.js';

const productSchema = z.object({
  name: z.string().min(1),
  price: z.number(),
  description: z.string(),
  url: z.string(),
  note: z.string().optional(),
});

const FAST = { delayMs: 0 };

describe('cheerio runtime', () => {
  let store: FixtureSite;
  let loginSite: FixtureSite;

  beforeAll(async () => {
    store = await startStaticStore();
    loginSite = await startLoginSite();
  });
  afterAll(async () => {
    await store.close();
    await loginSite.close();
  });

  it('crawls the static store end to end (listing → details → validated items)', async () => {
    const artifact = makeArtifact(
      {
        entryUrl: `${store.url}/`,
        selectors: {
          productRow: { css: 'li.product', description: 'listing rows', expect: 'many' },
          detailName: { css: 'h1.name', description: 'product name', expect: 'one' },
          detailPrice: { css: 'span.price', description: 'product price', expect: 'one' },
          detailDesc: { css: 'p.desc', description: 'product description', expect: 'one' },
        },
        assertions: [
          { kind: 'minItems', schema: 'product', min: STATIC_STORE_PRODUCT_COUNT },
          { kind: 'fieldCoverage', schema: 'product', field: 'price', minRatio: 1 },
          { kind: 'urlReached', pattern: '/p/1$' },
        ],
      },
      `export default async function crawl(ctx) {
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
`,
    );

    const events: CrawlEvent[] = [];
    const { report, items } = await executeArtifact(artifact, {
      schemas: { product: productSchema },
      limits: FAST,
      emitEvent: (e) => events.push(e),
    });

    expect(report.runtimeError).toBeUndefined();
    expect(report.assertionFailures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.itemCounts['product']).toBe(STATIC_STORE_PRODUCT_COUNT);
    expect(report.pagesVisited).toBe(1 + STATIC_STORE_PRODUCT_COUNT);
    expect(items['product']?.[0]).toMatchObject({ name: 'Widget 1', price: 10.99 });
    expect(events.filter((e) => e.type === 'item')).toHaveLength(STATIC_STORE_PRODUCT_COUNT);
    expect(report.progressTrail).toContain('fetching listing');
  });

  it('isolates invalid items and strips nulls on optional fields', async () => {
    const artifact = makeArtifact(
      { entryUrl: `${store.url}/` },
      `export default async function crawl(ctx) {
  await ctx.fetch(ctx.entryUrl);
  ctx.emit('product', { name: 'good', price: 1, description: 'd', url: 'u' });
  ctx.emit('product', { name: 'bad', price: 'not-a-number', description: 'd', url: 'u' });
  ctx.emit('product', { name: 'null-note', price: 2, description: 'd', url: 'u', note: null });
}
`,
    );

    const { report, items } = await executeArtifact(artifact, {
      schemas: { product: productSchema },
      limits: FAST,
    });

    expect(report.itemCounts['product']).toBe(2);
    expect(report.invalidItems).toHaveLength(1);
    expect(report.invalidItems[0]?.raw).toMatchObject({ name: 'bad' });
    // null on the optional field was stripped, not fatal
    expect(items['product']?.[1]).toMatchObject({ name: 'null-note', price: 2 });
    expect((items['product']?.[1] as Record<string, unknown>)['note']).toBeUndefined();
  });

  it('logs in via submitForm with ctx.input and reads gated data', async () => {
    const recordSchema = z.object({ name: z.string(), value: z.number() });
    const artifact = makeArtifact(
      {
        entryUrl: `${loginSite.url}/`,
        inputs: [
          { name: 'username', description: 'login user', secret: false, required: true },
          { name: 'password', description: 'login password', secret: true, required: true },
        ],
        selectors: {
          csrfField: { css: 'input[name=csrf]', description: 'CSRF token', expect: 'one' },
          recordRow: { css: 'li.record', description: 'data rows', expect: 'many' },
        },
        assertions: [{ kind: 'urlReached', pattern: '/account$' }],
      },
      `export default async function crawl(ctx) {
  const loginUrl = new URL('/login', ctx.entryUrl).href;
  const loginPage = await ctx.fetch(loginUrl);
  const csrf = ctx.select(loginPage, 'csrfField').attr('value');
  const landed = await ctx.submitForm(loginUrl, {
    username: ctx.input('username'),
    password: ctx.input('password'),
    csrf,
  });
  ctx.progress('landed on ' + landed.url);
  const data = await ctx.fetch(new URL('/data', ctx.entryUrl).href);
  ctx.select(data, 'recordRow').each((i, el) => {
    const row = data.$(el);
    ctx.emit('record', {
      name: row.find('.name').text(),
      value: Number(row.find('.value').text()),
    });
  });
}
`,
    );

    // Missing required input is a caller error, thrown before touching the site.
    await expect(
      executeArtifact(artifact, { schemas: { record: recordSchema }, limits: FAST }),
    ).rejects.toThrow(MissingInputError);

    const { report } = await executeArtifact(artifact, {
      schemas: { record: recordSchema },
      inputs: { username: LOGIN.username, password: LOGIN.password },
      limits: FAST,
    });
    expect(report.runtimeError).toBeUndefined();
    expect(report.itemCounts['record']).toBe(LOGIN_SITE_RECORD_COUNT);
    // the 302 chain was followed and observed
    expect(report.assertionFailures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('enforces robots.txt unless ignoreRobots is set', async () => {
    const artifact = makeArtifact(
      { entryUrl: `${store.url}/` },
      `export default async function crawl(ctx) {
  await ctx.fetch(new URL('/private/secret', ctx.entryUrl).href);
}
`,
    );

    const blocked = await executeArtifact(artifact, { limits: FAST });
    expect(blocked.report.ok).toBe(false);
    expect(blocked.report.runtimeError?.message).toMatch(/robots\.txt disallows/);

    const allowed = await executeArtifact(artifact, { limits: FAST, ignoreRobots: true });
    expect(allowed.report.runtimeError).toBeUndefined();
  });

  it('stops runaway code at the page budget', async () => {
    const artifact = makeArtifact(
      { entryUrl: `${store.url}/` },
      `export default async function crawl(ctx) {
  for (let i = 0; i < 50; i++) await ctx.fetch(ctx.entryUrl);
}
`,
    );
    const { report } = await executeArtifact(artifact, {
      limits: { delayMs: 0, maxPages: 3 },
    });
    expect(report.runtimeError?.message).toMatch(/Page budget exhausted/);
    expect(report.pagesVisited).toBe(3);
  });

  it('fails assertions without a runtime error when too few items are found', async () => {
    const artifact = makeArtifact(
      {
        entryUrl: `${store.url}/`,
        selectors: {
          productRow: { css: 'li.product', description: 'rows', expect: 'many' },
        },
        assertions: [{ kind: 'minItems', schema: 'product', min: 50 }],
      },
      `export default async function crawl(ctx) {
  const listing = await ctx.fetch(ctx.entryUrl);
  ctx.select(listing, 'productRow').each((i, el) => {
    ctx.emit('product', {
      name: listing.$(el).find('a').text(),
      price: 0,
      description: 'from listing',
      url: listing.url,
    });
  });
}
`,
    );
    const { report } = await executeArtifact(artifact, {
      schemas: { product: productSchema },
      limits: FAST,
    });
    expect(report.runtimeError).toBeUndefined();
    expect(report.ok).toBe(false);
    expect(report.assertionFailures).toHaveLength(1);
    expect(report.assertionFailures[0]?.actual).toContain('6 valid item(s)');
  });

  it('honors maxItems as an early clean stop', async () => {
    const artifact = makeArtifact(
      { entryUrl: `${store.url}/` },
      `export default async function crawl(ctx) {
  await ctx.fetch(ctx.entryUrl);
  for (let i = 0; i < 100; i++) {
    ctx.emit('product', { name: 'p' + i, price: i, description: 'd', url: 'u' });
  }
}
`,
    );
    const { report } = await executeArtifact(artifact, {
      schemas: { product: productSchema },
      limits: { delayMs: 0, maxItems: 5 },
    });
    expect(report.runtimeError).toBeUndefined();
    expect(report.itemCounts['product']).toBe(5);
  });

  it('falls back to manifest JSON Schemas when no zod schemas are passed', async () => {
    const artifact = makeArtifact(
      {
        entryUrl: `${store.url}/`,
        schemas: {
          product: z.toJSONSchema(productSchema) as Record<string, unknown>,
        },
      },
      `export default async function crawl(ctx) {
  await ctx.fetch(ctx.entryUrl);
  ctx.emit('product', { name: 'ok', price: 3, description: 'd', url: 'u' });
  ctx.emit('product', { name: 42, price: 'x', description: 'd', url: 'u' });
}
`,
    );
    const { report } = await executeArtifact(artifact, { limits: FAST });
    expect(report.itemCounts['product']).toBe(1);
    expect(report.invalidItems).toHaveLength(1);
  });
});
