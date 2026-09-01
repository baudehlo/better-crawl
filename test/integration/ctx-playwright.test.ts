import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Browser, Page } from 'playwright';
import type { CrawlEvent } from '../../src/events.js';
import { NoMatchError } from '../../src/errors.js';
import { SharedRuntime } from '../../src/runtime/ctx-shared.js';
import { createPlaywrightSession } from '../../src/runtime/ctx-playwright.js';
import { executeArtifact } from '../../src/runtime/execute.js';
import { createValidator } from '../../src/runtime/validate.js';
import { makeArtifact } from '../helpers/make-artifact.js';
import { startLoginSite } from '../fixtures/sites/login-site.js';
import { startPaginated, PAGINATED_TOTAL_ITEMS } from '../fixtures/sites/paginated.js';
import { startStaticStore } from '../fixtures/sites/static-store.js';
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

const SELECTORS = {
  row: { css: 'li.product', description: 'listing rows', expect: 'many' as const },
  link: { css: 'li.product a', description: 'product links', expect: 'many' as const },
  price: { css: 'li.product .price', description: 'prices', expect: 'many' as const },
  detailName: { css: 'h1.name', description: 'detail name', expect: 'one' as const },
  username: { css: 'input[name="username"]', description: 'login user', expect: 'one' as const },
  item: { css: 'li.item', description: 'lazy list items', expect: 'many' as const },
  ghost: { css: '.does-not-exist', description: 'nothing', expect: 'maybe' as const },
};

describe.skipIf(!hasBrowser)('createPlaywrightSession helpers', () => {
  let browser: Browser;
  let page: Page;
  let store: FixtureSite;
  let login: FixtureSite;
  let paginated: FixtureSite;
  let events: CrawlEvent[];

  beforeAll(async () => {
    const pw = await import('playwright');
    browser = await pw.chromium.launch({ headless: true });
    page = await (await browser.newContext()).newPage();
    store = await startStaticStore();
    login = await startLoginSite();
    paginated = await startPaginated();
  });
  afterAll(async () => {
    await browser?.close();
    await store?.close();
    await login?.close();
    await paginated?.close();
  });

  function makeShared(entryUrl: string): SharedRuntime {
    events = [];
    return new SharedRuntime({
      artifact: makeArtifact({ engine: 'playwright', entryUrl, selectors: SELECTORS }),
      validator: createValidator({ product: z.object({ name: z.string() }) }, {}),
      inputs: {},
      emitEvent: (e) => events.push(e),
      phase: 'run',
      signal: new AbortController().signal,
      limits: { maxPages: 50, delayMs: 0 },
    });
  }

  async function makeSession(entryUrl: string, extra: { screenshots?: boolean; screenshotDir?: string } = {}) {
    const shared = makeShared(entryUrl);
    const session = await createPlaywrightSession(shared, {
      userAgent: 'better-crawl-test',
      headless: true,
      screenshots: extra.screenshots ?? false,
      ...(extra.screenshotDir !== undefined ? { screenshotDir: extra.screenshotDir } : {}),
      existingPage: page,
    });
    return { shared, session };
  }

  it('reuses an existing page and leaves the browser open on close', async () => {
    const { shared, session } = await makeSession(`${store.url}/`);
    await session.ctx.goto(`${store.url}/`);
    expect(shared.urlsVisited).toEqual([`${store.url}/`]);
    expect(session.page).toBe(page);
    await session.close();
    expect(page.isClosed()).toBe(false);
  });

  it('count/text/attr/links resolve named selectors', async () => {
    const { session } = await makeSession(`${store.url}/`);
    const { ctx } = session;
    await ctx.goto(`${store.url}/`);

    expect(await ctx.count('row')).toBe(6);

    const prices = await ctx.text('price');
    expect(prices).toHaveLength(6);
    expect(prices[0]).toBe('$10.99');

    const classes = await ctx.attr('row', 'class');
    expect(classes).toEqual(Array.from({ length: 6 }, () => 'product'));
    expect(await ctx.attr('row', 'data-nope')).toEqual(Array.from({ length: 6 }, () => null));

    // links from the <a> elements themselves and from containers that wrap one
    const direct = await ctx.links('link');
    expect(direct).toContain(`${store.url}/p/1`);
    expect(direct).toHaveLength(6);
    expect(await ctx.links('row')).toEqual(direct);
  });

  it('click navigates and waitFor blocks until the selector exists', async () => {
    const { shared, session } = await makeSession(`${store.url}/`);
    const { ctx } = session;
    await ctx.goto(`${store.url}/`);
    await ctx.click('link');
    expect(page.url()).toBe(`${store.url}/p/1`);
    expect(shared.urlsVisited).toContain(`${store.url}/p/1`);
    await ctx.waitFor('detailName');
    expect(await ctx.text('detailName')).toEqual(['Widget 1']);
  });

  it('click and waitFor throw NoMatchError for missing selectors', async () => {
    const { session } = await makeSession(`${store.url}/`);
    const { ctx } = session;
    await ctx.goto(`${store.url}/`);
    await expect(ctx.click('ghost')).rejects.toThrow(NoMatchError);
    await expect(ctx.waitFor('ghost', { timeoutMs: 200 })).rejects.toThrow(NoMatchError);
  });

  it('fill types into the first match', async () => {
    const { session } = await makeSession(`${login.url}/login`);
    const { ctx } = session;
    await ctx.goto(`${login.url}/login`);
    await ctx.fill('username', 'admin');
    expect(await page.inputValue('input[name="username"]')).toBe('admin');
    await expect(ctx.fill('ghost', 'x')).rejects.toThrow(NoMatchError);
  });

  it('loadAll exhausts the lazy list through the ctx helper', async () => {
    const { session } = await makeSession(`${paginated.url}/`);
    const { ctx } = session;
    await ctx.goto(`${paginated.url}/`);
    const count = await ctx.loadAll('item', { pollIntervalMs: 60 });
    expect(count).toBe(PAGINATED_TOTAL_ITEMS);
  }, 60_000);

  it('screenshot emits a buffer, or writes a file when a dir is set', async () => {
    await page.goto(`${store.url}/`);

    const buffered = await makeSession(`${store.url}/`, { screenshots: true });
    await buffered.session.ctx.screenshot('memory shot');
    const bufferEvent = events.find((e) => e.type === 'screenshot');
    expect(bufferEvent?.type === 'screenshot' && bufferEvent.buffer?.length).toBeGreaterThan(0);

    const dir = await mkdtemp(path.join(os.tmpdir(), 'bc-pw-shots-'));
    try {
      const filed = await makeSession(`${store.url}/`, { screenshots: true, screenshotDir: dir });
      await filed.session.ctx.screenshot('disk shot');
      expect(await readdir(dir)).toEqual(['000-disk_shot.png']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const disabled = await makeSession(`${store.url}/`, { screenshots: false });
    await disabled.session.ctx.screenshot('ignored');
    expect(events.filter((e) => e.type === 'screenshot')).toHaveLength(0);
  });
});

describe.skipIf(!hasBrowser)('playwright failure reporting', () => {
  let store: FixtureSite;
  beforeAll(async () => {
    store = await startStaticStore();
  });
  afterAll(async () => {
    await store?.close();
  });

  it('captures the failed selector and a condensed failure page from the live browser', async () => {
    const artifact = makeArtifact(
      {
        engine: 'playwright',
        entryUrl: `${store.url}/`,
        selectors: SELECTORS,
      },
      `export default async function crawl(ctx) {
  await ctx.goto(ctx.entryUrl);
  await ctx.waitFor('ghost', { timeoutMs: 200 });
}
`,
    );
    const outcome = await executeArtifact(artifact, { limits: { delayMs: 0 } });
    expect(outcome.report.ok).toBe(false);
    expect(outcome.report.runtimeError?.failedSelector).toBe('ghost');
    expect(outcome.failurePage).toContain('=== TEXT ===');
    expect(outcome.failurePage).toContain('Static Store');
  });
});
