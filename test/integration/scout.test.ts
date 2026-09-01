import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LanguageModel, ToolSet } from 'ai';
import type { CrawlEvent } from '../../src/events.js';
import { runScout } from '../../src/scout/scout.js';
import { FakeLlm } from '../helpers/fake-llm.js';
import { startJsStore } from '../fixtures/sites/js-store.js';
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

const FAKE_MODEL = 'fake-model' as unknown as LanguageModel;
const productSchema = z.object({ name: z.string(), price: z.number() });

function makeCaller(tools: ToolSet) {
  return async (name: string, input: unknown): Promise<string> => {
    const t = tools[name] as { execute: (i: unknown, o: unknown) => Promise<unknown> };
    const result = await t.execute(input, { toolCallId: 'test', messages: [] });
    return String(result);
  };
}

describe.skipIf(!hasBrowser)('scout (FakeLlm-driven)', () => {
  let store: FixtureSite;
  let jsStore: FixtureSite;
  beforeAll(async () => {
    store = await startStaticStore();
    jsStore = await startJsStore();
  });
  afterAll(async () => {
    await store?.close();
    await jsStore?.close();
  });

  it('accepts a cheerio report on the static store after probe + verification, rejecting bad ones first', async () => {
    const transcript: string[] = [];
    const fake = new FakeLlm({
      driveAgent: async (loop) => {
        const call = makeCaller(loop.tools);

        const nav = await call('navigate', { url: `${store.url}/` });
        expect(nav).toContain('=== LINKS ===');
        expect(nav).toContain('Widget 1');

        const detected = JSON.parse(await call('detect_listing', {})) as {
          selector: string;
          count: number;
        };
        expect(detected.selector).toBe('a[href*="/p/"]');
        expect(detected.count).toBe(6);

        await call('try_selector', { selector: 'li.product' });
        await call('probe_no_js', { url: `${store.url}/` });

        // Wrong types in the sample → gate rejects, model "self-corrects".
        const rejected = await call('report_findings', {
          engine: 'cheerio',
          engineReason: 'data in raw HTML',
          selectors: {
            productRow: { css: 'li.product', description: 'rows', expect: 'many' },
          },
          inputsNeeded: [],
          navigationPlan: ['open listing'],
          expectedCounts: { product: 6 },
          sampleItems: {
            product: [
              { name: 'Widget 1', price: '$10.99' },
              { name: 'Widget 2', price: '$20.99' },
            ],
          },
        });
        transcript.push(rejected);
        expect(rejected).toContain('REJECTED');

        const accepted = await call('report_findings', {
          engine: 'cheerio',
          engineReason: 'data in raw HTML',
          selectors: {
            productRow: { css: 'li.product', description: 'rows', expect: 'many' },
          },
          inputsNeeded: [],
          navigationPlan: ['open listing', 'read rows'],
          expectedCounts: { product: 6 },
          sampleItems: {
            product: [
              { name: 'Widget 1', price: 10.99 },
              { name: 'Widget 2', price: 20.99 },
            ],
          },
        });
        transcript.push(accepted);
        expect(accepted).toContain('ACCEPTED');
      },
    });

    const events: CrawlEvent[] = [];
    const result = await runScout({
      llm: fake,
      model: FAKE_MODEL,
      url: `${store.url}/`,
      instructions: 'Find all products with prices',
      schemas: { product: productSchema },
      inputs: {},
      emitEvent: (e) => events.push(e),
      signal: new AbortController().signal,
      maxSteps: 40,
      limits: { maxPages: 20, delayMs: 0 },
      ignoreRobots: false,
      userAgent: 'better-crawl-test',
      screenshots: false,
      headless: true,
    });

    expect(result.findings.engine).toBe('cheerio');
    expect(result.findings.probeVerifiedCheerio).toBe(true);
    expect(result.findings.selectorSamples['productRow']).toContain('Widget 1');
    expect(result.findings.keyPages.length).toBeGreaterThan(0);
    expect(result.findings.urlsVisited[0]).toContain(store.url);
    expect(events.some((e) => e.type === 'llm-usage')).toBe(true);
  });

  it('refuses a cheerio claim on a JS-rendered site (probe gate)', async () => {
    const fake = new FakeLlm({
      driveAgent: async (loop) => {
        const call = makeCaller(loop.tools);
        await call('navigate', { url: `${jsStore.url}/` });
        await call('try_selector', { selector: 'li.product' });
        await call('probe_no_js', { url: `${jsStore.url}/` });

        const rejected = await call('report_findings', {
          engine: 'cheerio',
          engineReason: 'looks simple',
          selectors: {
            productRow: { css: 'li.product', description: 'rows', expect: 'many' },
          },
          inputsNeeded: [],
          navigationPlan: ['open listing'],
          expectedCounts: { product: 4 },
          sampleItems: {
            product: [
              { name: 'Gadget 1', price: 5 },
              { name: 'Gadget 2', price: 10 },
            ],
          },
        });
        expect(rejected).toMatch(/playwright/);

        const accepted = await call('report_findings', {
          engine: 'playwright',
          engineReason: 'data rendered by JS',
          selectors: {
            productRow: { css: 'li.product', description: 'rows', expect: 'many' },
          },
          inputsNeeded: [],
          navigationPlan: ['open listing'],
          expectedCounts: { product: 4 },
          sampleItems: {
            product: [
              { name: 'Gadget 1', price: 5 },
              { name: 'Gadget 2', price: 10 },
            ],
          },
        });
        expect(accepted).toContain('ACCEPTED');
      },
    });

    const result = await runScout({
      llm: fake,
      model: FAKE_MODEL,
      url: `${jsStore.url}/`,
      instructions: 'Find all products',
      schemas: { product: productSchema },
      inputs: {},
      emitEvent: () => undefined,
      signal: new AbortController().signal,
      maxSteps: 40,
      limits: { maxPages: 20, delayMs: 0 },
      ignoreRobots: false,
      userAgent: 'better-crawl-test',
      screenshots: false,
      headless: true,
    });
    expect(result.findings.engine).toBe('playwright');
  });

  it('throws GenerationFailedError when the loop ends without accepted findings', async () => {
    const fake = new FakeLlm({
      driveAgent: async (loop) => {
        const call = makeCaller(loop.tools);
        await call('navigate', { url: `${store.url}/` });
        // ... and then the "model" gives up without reporting.
      },
    });
    await expect(
      runScout({
        llm: fake,
        model: FAKE_MODEL,
        url: `${store.url}/`,
        instructions: 'Find products',
        schemas: { product: productSchema },
        inputs: {},
        emitEvent: () => undefined,
        signal: new AbortController().signal,
        maxSteps: 5,
        limits: { maxPages: 20, delayMs: 0 },
        ignoreRobots: false,
        userAgent: 'better-crawl-test',
        screenshots: false,
        headless: true,
      }),
    ).rejects.toThrow(/without an accepted report_findings/);
  });

  it('narrates tool calls and reasoning through onStepFinish', async () => {
    const fake = new FakeLlm({
      driveAgent: async (loop) => {
        const call = makeCaller(loop.tools);
        await call('navigate', { url: `${store.url}/` });
        await loop.onStepFinish?.({
          toolCalls: [{ toolName: 'navigate' }, { toolName: 'try_selector' }],
          text: 'the listing looks promising',
        } as never);
        await loop.onStepFinish?.({ toolCalls: [], text: '' } as never);
        // gives up without reporting — the throw is expected below
      },
    });
    const events: CrawlEvent[] = [];
    await expect(
      runScout({
        llm: fake,
        model: FAKE_MODEL,
        url: `${store.url}/`,
        instructions: 'Find products',
        schemas: { product: productSchema },
        inputs: {},
        emitEvent: (e) => events.push(e),
        signal: new AbortController().signal,
        maxSteps: 5,
        limits: { maxPages: 20, delayMs: 0 },
        ignoreRobots: true,
        userAgent: 'better-crawl-test',
        screenshots: false,
        headless: true,
      }),
    ).rejects.toThrow(/without an accepted report_findings/);

    expect(events).toContainEqual({
      type: 'progress',
      phase: 'scout',
      message: 'scout: navigate, try_selector',
    });
    expect(
      events.some(
        (e) => e.type === 'log' && e.message.includes('scout reasoning: the listing looks promising'),
      ),
    ).toBe(true);
  });
});
