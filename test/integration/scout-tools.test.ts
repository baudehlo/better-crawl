import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Browser, Page } from 'playwright';
import type { CrawlEvent } from '../../src/events.js';
import { Net } from '../../src/runtime/net.js';
import { RobotsCache } from '../../src/runtime/robots.js';
import { createValidator } from '../../src/runtime/validate.js';
import { createScoutTools, ScoutState, type ScoutToolOptions } from '../../src/scout/tools.js';
import { startPaginated, PAGINATED_TOTAL_ITEMS } from '../fixtures/sites/paginated.js';
import { startLoginSite } from '../fixtures/sites/login-site.js';
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

const productSchema = z.object({ name: z.string(), price: z.number() });
const UA = 'better-crawl-test';

interface ToolRig {
  state: ScoutState;
  events: CrawlEvent[];
  limits: { maxPages: number; delayMs: number };
  call: (name: string, input?: unknown) => Promise<string>;
}

describe.skipIf(!hasBrowser)('scout tools', () => {
  let browser: Browser;
  let page: Page;
  let store: FixtureSite;
  let login: FixtureSite;
  let paginated: FixtureSite;

  beforeAll(async () => {
    const pw = await import('playwright');
    browser = await pw.chromium.launch({ headless: true });
    page = await (await browser.newContext({ userAgent: UA })).newPage();
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

  function rig(overrides: Partial<ScoutToolOptions> = {}): ToolRig {
    const state = new ScoutState();
    const events: CrawlEvent[] = [];
    const limits = { maxPages: 20, delayMs: 0 };
    const opts: ScoutToolOptions = {
      page,
      validator: createValidator({ product: productSchema }, {}),
      inputs: {},
      emitEvent: (e) => events.push(e),
      signal: new AbortController().signal,
      limits,
      robots: new RobotsCache(async (url) => {
        const res = await fetch(url);
        return { status: res.status, body: await res.text() };
      }, UA),
      userAgent: UA,
      net: new Net({ userAgent: UA }),
      screenshots: false,
      ...overrides,
    };
    const tools = createScoutTools(state, opts);
    const call = async (name: string, input: unknown = {}): Promise<string> => {
      const tool = tools[name] as {
        execute: (i: unknown, o: unknown) => Promise<unknown>;
      };
      return String(await tool.execute(input, { toolCallId: 'test', messages: [] }));
    };
    return { state, events, limits, call };
  }

  it('navigate returns the condensed page and records the visit', async () => {
    const { state, call } = rig();
    const out = await call('navigate', { url: `${store.url}/` });
    expect(out).toContain('=== LINKS ===');
    expect(out).toContain('Widget 1');
    expect(state.urlsVisited).toEqual([`${store.url}/`]);
    expect(state.snapshots).toHaveLength(1);
    expect(state.pagesVisited).toBe(1);
  });

  it('navigate refuses robots-disallowed URLs without spending the budget', async () => {
    const { state, call } = rig();
    const out = await call('navigate', { url: `${store.url}/private/secret` });
    expect(out).toContain('robots.txt disallows');
    expect(state.pagesVisited).toBe(0);
  });

  it('navigate reports page-budget exhaustion as a tool error', async () => {
    const { call } = rig({ limits: { maxPages: 1, delayMs: 0 } });
    await call('navigate', { url: `${store.url}/` });
    const out = await call('navigate', { url: `${store.url}/p/1` });
    expect(out).toContain('page budget exhausted (1)');
  });

  it('bumps the politeness delay when robots asks for a larger crawl-delay', async () => {
    const { limits, call } = rig({
      robots: new RobotsCache(
        async () => ({ status: 200, body: 'User-agent: *\nCrawl-delay: 0.02\n' }),
        UA,
      ),
    });
    await call('navigate', { url: `${store.url}/` });
    expect(limits.delayMs).toBe(20);
  });

  it('navigate turns connection failures into ERROR tool results', async () => {
    const { call } = rig({ robots: undefined as never });
    const out = await call('navigate', { url: 'http://127.0.0.1:1/' });
    expect(out).toMatch(/^ERROR: /);
  });

  it('read_page re-reads the current page', async () => {
    const { call } = rig();
    await call('navigate', { url: `${store.url}/` });
    const out = await call('read_page');
    expect(out).toContain('Static Store');
  });

  it('click follows links (reporting the new URL) and detects same-page clicks', async () => {
    const { state, call } = rig();
    await call('navigate', { url: `${store.url}/` });

    const miss = await call('click', { selector: '.does-not-exist', description: 'nothing' });
    expect(miss).toContain('matched 0 elements');

    const samePage = await call('click', { selector: 'h1', description: 'inert heading' });
    expect(samePage).toContain(`still at ${store.url}/`);

    const nav = await call('click', { selector: 'a[href="/p/1"]', description: 'first product' });
    expect(nav).toContain(`now at ${store.url}/p/1`);
    expect(nav).toContain('Widget 1');
    expect(state.urlsVisited).toContain(`${store.url}/p/1`);
  });

  it('type_text fills from inputs by name without echoing the value', async () => {
    const { call } = rig({ inputs: { username: 'admin', password: 'hunter2' } });
    await call('navigate', { url: `${login.url}/login` });

    const hidden = await call('type_text', {
      selector: 'input[name="username"]',
      inputName: 'username',
    });
    expect(hidden).toBe('typed «input:username» into input[name="username"]');
    expect(hidden).not.toContain('admin');

    const plain = await call('type_text', {
      selector: 'input[name="username"]',
      text: 'visible-text',
    });
    expect(plain).toContain('typed "visible-text"');

    const missing = await call('type_text', {
      selector: 'input[name="username"]',
      inputName: 'token',
    });
    expect(missing).toContain('no value was provided for input "token"');
    expect(missing).toContain('username, password');

    const noMatch = await call('type_text', { selector: '.ghost', text: 'x' });
    expect(noMatch).toContain('matched 0 elements');
  });

  it('try_selector returns counts and samples, and reports bad selectors as errors', async () => {
    const { state, call } = rig();
    await call('navigate', { url: `${store.url}/` });

    const result = JSON.parse(await call('try_selector', { selector: 'li.product' })) as {
      count: number;
      samples: Array<{ text: string; href?: string }>;
    };
    expect(result.count).toBe(6);
    expect(result.samples).toHaveLength(3);
    expect(result.samples[0]?.text).toContain('Widget 1');
    expect(result.samples[0]?.href).toBe(`${store.url}/p/1`);
    expect(state.verifiedSelectors.get('li.product')?.count).toBe(6);

    const bad = await call('try_selector', { selector: '<<<not-css>>>' });
    expect(bad).toMatch(/^ERROR: /);
  });

  it('detect_listing finds the dominant pattern and admits when there is none', async () => {
    const { call } = rig();
    await call('navigate', { url: `${store.url}/` });
    const found = JSON.parse(await call('detect_listing')) as { selector: string; count: number };
    expect(found.selector).toBe('a[href*="/p/"]');
    expect(found.count).toBe(6);

    await call('navigate', { url: `${store.url}/p/1` });
    const none = await call('detect_listing');
    expect(none).toContain('no repeating listing pattern');
  });

  it('load_all exhausts a lazy list and verifies the selector', async () => {
    const { state, call } = rig();
    await call('navigate', { url: `${paginated.url}/` });
    const out = await call('load_all', { selector: 'li.item' });
    expect(out).toBe(`final count for li.item: ${PAGINATED_TOTAL_ITEMS}`);
    expect(state.verifiedSelectors.get('li.item')?.count).toBe(PAGINATED_TOTAL_ITEMS);
  }, 90_000);

  it('load_all reports selector failures as tool errors', async () => {
    const { call } = rig();
    await call('navigate', { url: `${store.url}/` });
    const out = await call('load_all', { selector: '<<<not-css>>>' });
    expect(out).toMatch(/^ERROR: /);
  });

  it('probe_no_js fetches raw HTML, records probe text, and respects robots', async () => {
    const { state, call } = rig();
    const out = await call('probe_no_js', { url: `${store.url}/` });
    expect(out).toContain('HTTP 200 (no-JS probe)');
    expect(out).toContain('Widget 1');
    expect(state.probeTexts).toHaveLength(1);
    expect(state.snapshots[0]?.url).toBe(`probe:${store.url}/`);

    const blocked = await call('probe_no_js', { url: `${store.url}/private/secret` });
    expect(blocked).toContain('robots.txt disallows');

    const dead = await call('probe_no_js', { url: 'http://127.0.0.1:1/' });
    expect(dead).toMatch(/^ERROR: /);
  });

  it('screenshot emits a buffer without a dir and writes files with one', async () => {
    await page.goto(`${store.url}/`);

    const silent = rig({ screenshots: false });
    expect(await silent.call('screenshot', { label: 'quiet' })).toBe('captured');
    expect(silent.events).toHaveLength(0);

    const buffered = rig({ screenshots: true });
    await buffered.call('screenshot', { label: 'in memory' });
    const bufferEvent = buffered.events.find((e) => e.type === 'screenshot');
    expect(bufferEvent).toBeDefined();
    expect(bufferEvent?.type === 'screenshot' && bufferEvent.buffer?.length).toBeGreaterThan(0);

    const dir = await mkdtemp(path.join(os.tmpdir(), 'bc-shots-'));
    try {
      const filed = rig({ screenshots: true, screenshotDir: dir });
      await filed.call('screenshot', { label: 'to disk!' });
      const files = await readdir(dir);
      expect(files).toEqual(['scout-000-to_disk_.png']);
      const fileEvent = filed.events.find((e) => e.type === 'screenshot');
      expect(fileEvent?.type === 'screenshot' && fileEvent.path).toContain(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('report_findings auto-verifies unseen selectors and rejects dead ones', async () => {
    const { state, call } = rig();
    await call('navigate', { url: `${store.url}/` });
    const out = await call('report_findings', {
      engine: 'playwright',
      engineReason: 'why not',
      selectors: {
        good: { css: 'li.product', description: 'rows', expect: 'many' },
        dead: { css: '.no-such-thing', description: 'ghost', expect: 'many' },
      },
      inputsNeeded: [],
      navigationPlan: ['look around'],
      expectedCounts: { product: 6 },
      sampleItems: {
        product: [
          { name: 'Widget 1', price: 10.99 },
          { name: 'Widget 2', price: 20.99 },
        ],
      },
    });
    expect(out).toMatch(/REJECTED: selector "dead".*matched 0 elements/);
    // both selectors were auto-verified even though try_selector was never called
    expect(state.verifiedSelectors.get('li.product')?.count).toBe(6);
    expect(state.verifiedSelectors.get('.no-such-thing')?.count).toBe(0);
    expect(state.findings).toBeUndefined();
  });

  it('report_findings records invalid CSS as 0-match evidence instead of crashing', async () => {
    const { state, call } = rig();
    await call('navigate', { url: `${store.url}/` });
    const out = await call('report_findings', {
      engine: 'playwright',
      engineReason: 'x',
      selectors: { broken: { css: '<<<not-css>>>', description: 'nope', expect: 'many' } },
      inputsNeeded: [],
      navigationPlan: [],
      expectedCounts: {},
      sampleItems: {
        product: [
          { name: 'Widget 1', price: 10.99 },
          { name: 'Widget 2', price: 20.99 },
        ],
      },
    });
    expect(out).toMatch(/REJECTED: selector "broken".*matched 0 elements/);
    expect(state.verifiedSelectors.get('<<<not-css>>>')).toEqual({ count: 0 });
  });

  it('type_text with neither inputName nor text fills an empty string', async () => {
    const { call } = rig();
    await call('navigate', { url: `${login.url}/login` });
    const out = await call('type_text', { selector: 'input[name="username"]' });
    expect(out).toContain('typed ""');
  });

  it('type_text reports invalid selectors as tool errors', async () => {
    const { call } = rig();
    await call('navigate', { url: `${store.url}/` });
    const out = await call('type_text', { selector: '<<<not-css>>>', text: 'x' });
    expect(out).toMatch(/^ERROR: /);
  });

  it('read_page and detect_listing report a broken page as tool errors', async () => {
    const orphan = await (await browser.newContext()).newPage();
    await orphan.goto(`${store.url}/`);
    const { call } = rig({ page: orphan });
    await orphan.close();
    expect(await call('read_page')).toMatch(/^ERROR: /);
    expect(await call('detect_listing')).toMatch(/^ERROR: /);
  });

  it('report_findings converts library-side crashes into tool errors', async () => {
    const { call } = rig({
      validator: {
        schemaNames: ['product'],
        validate: () => {
          throw new Error('validator exploded');
        },
      },
    });
    await call('navigate', { url: `${store.url}/` });
    const out = await call('report_findings', {
      engine: 'playwright',
      engineReason: 'x',
      selectors: { good: { css: 'li.product', description: 'rows', expect: 'many' } },
      inputsNeeded: [],
      navigationPlan: [],
      expectedCounts: {},
      sampleItems: { product: [{ name: 'a' }, { name: 'b' }] },
    });
    expect(out).toBe('ERROR: validator exploded');
  });

  it('tools abort by rethrowing the signal reason', async () => {
    const ctl = new AbortController();
    const { call } = rig({ signal: ctl.signal });
    const reason = new Error('scout cancelled');
    ctl.abort(reason);
    await expect(call('click', { selector: 'h1', description: 'anything' })).rejects.toBe(reason);
    await expect(call('navigate', { url: `${store.url}/` })).rejects.toBe(reason);
  });

  it('an abort mid-politeness-sleep rejects the pending navigate', async () => {
    const ctl = new AbortController();
    const { call } = rig({
      signal: ctl.signal,
      limits: { maxPages: 20, delayMs: 5_000 },
      robots: undefined as never,
    });
    const reason = new Error('impatient');
    const pending = call('navigate', { url: `${store.url}/` });
    setTimeout(() => ctl.abort(reason), 25);
    await expect(pending).rejects.toBe(reason);
  });
});
