import { tool, type ToolSet } from 'ai';
import * as cheerio from 'cheerio';
import { z } from 'zod';
import type { Page, Response as PwResponse } from 'playwright';
import type { CrawlEvent } from '../events.js';
import { blockAwareText, condenseHtml, condensePage, scrubSecrets } from '../llm/condense.js';
import type { Net } from '../runtime/net.js';
import type { RobotsCache } from '../runtime/robots.js';
import type { ItemValidator } from '../runtime/validate.js';
import { loadAll } from '../runtime/paginate.js';
import { checkFindings, type SelectorEvidence } from './gates.js';
import {
  reportFindingsSchema,
  reportedSelectorSchema,
  type ScoutFindings,
} from './findings.js';

const SNAPSHOT_CAP = 5;
const KEY_PAGE_COUNT = 3;

export interface ScoutToolOptions {
  page: Page;
  validator: ItemValidator;
  /** Generate-time input values; ALL of them are scrubbed from LLM-bound text. */
  inputs: Record<string, string>;
  emitEvent: (event: CrawlEvent) => void;
  signal: AbortSignal;
  limits: { maxPages: number; delayMs: number };
  robots?: RobotsCache;
  userAgent: string;
  /** Proxy/header-aware fetch for the no-JS probe. */
  net: Net;
  screenshots: boolean;
  screenshotDir?: string;
}

export class ScoutState {
  readonly urlsVisited: string[] = [];
  readonly verifiedSelectors = new Map<string, SelectorEvidence>();
  readonly probeTexts: string[] = [];
  readonly snapshots: Array<{ url: string; condensed: string }> = [];
  pagesVisited = 0;
  findings: ScoutFindings | undefined;
  /**
   * Set once the browser failed to load a page that a plain fetch (no
   * JavaScript) could: the site is then cheerio-only, and the scout reads and
   * checks selectors on the raw HTML of the last page fetched.
   */
  cheerioOnly: { reason: string; url: string; html: string } | undefined;

  recordSnapshot(url: string, condensed: string): void {
    const existing = this.snapshots.findIndex((s) => s.url === url);
    if (existing !== -1) this.snapshots.splice(existing, 1);
    this.snapshots.push({ url, condensed });
    if (this.snapshots.length > SNAPSHOT_CAP) this.snapshots.shift();
  }
}

/** Errors become tool-result strings so the agent loop keeps going. */
function asToolError(err: unknown): string {
  return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
}

/** Whether raw HTML shows any text without JavaScript (script and noscript content does not count). */
function hasBodyText(html: string): boolean {
  const $ = cheerio.load(html);
  $('script, style, noscript, template').remove();
  return $('body').text().trim().length > 0;
}

/** try_selector on raw HTML, with the same result shape as the browser version. */
function selectInHtml(
  html: string,
  pageUrl: string,
  css: string,
): { count: number; samples: Array<{ text: string; href?: string }> } {
  const $ = cheerio.load(html);
  const matches = $(css);
  const samples = matches
    .slice(0, 3)
    .toArray()
    .map((el) => {
      const node = $(el);
      const text = blockAwareText($, el).replace(/\s+/g, ' ').replace(/^\| /, '').slice(0, 120);
      const closest = node.closest('a');
      const raw = (closest.length > 0 ? closest : node.find('a').first()).attr('href');
      let href: string | undefined;
      try {
        href = raw ? new URL(raw, pageUrl).href : undefined;
      } catch {
        href = undefined;
      }
      return { text, ...(href ? { href } : {}) };
    });
  return { count: matches.length, samples };
}

export function createScoutTools(
  state: ScoutState,
  opts: ScoutToolOptions,
): ToolSet {
  const { page } = opts;

  const scrub = (text: string) => scrubSecrets(text, opts.inputs);

  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      opts.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(opts.signal.reason);
        },
        { once: true },
      );
    });

  const throwIfAborted = () => {
    if (opts.signal.aborted) throw opts.signal.reason;
  };

  const gate = async (url: string): Promise<string | null> => {
    throwIfAborted();
    if (opts.robots) {
      const verdict = await opts.robots.check(url);
      if (!verdict.allowed) {
        return `ERROR: robots.txt disallows ${url} — do not fetch it; find the data elsewhere.`;
      }
      if (verdict.crawlDelayMs !== undefined && verdict.crawlDelayMs > opts.limits.delayMs) {
        opts.limits.delayMs = verdict.crawlDelayMs;
      }
    }
    if (state.pagesVisited >= opts.limits.maxPages) {
      return `ERROR: page budget exhausted (${opts.limits.maxPages}); report your findings now with what you have.`;
    }
    state.pagesVisited += 1;
    if (opts.limits.delayMs > 0) await sleep(opts.limits.delayMs);
    return null;
  };

  let screenshotIndex = 0;
  const captureScreenshot = async (label: string): Promise<void> => {
    if (!opts.screenshots) return;
    try {
      const buffer = await page.screenshot();
      if (opts.screenshotDir) {
        const { mkdir, writeFile } = await import('node:fs/promises');
        const path = await import('node:path');
        await mkdir(opts.screenshotDir, { recursive: true });
        const file = path.join(
          opts.screenshotDir,
          `scout-${String(screenshotIndex++).padStart(3, '0')}-${label.replace(/[^\w.-]+/g, '_')}.png`,
        );
        await writeFile(file, buffer);
        opts.emitEvent({ type: 'screenshot', label, path: file });
      } else {
        opts.emitEvent({ type: 'screenshot', label, buffer });
      }
    } catch {
      /* best-effort */
    }
  };

  const readCurrentPage = async (): Promise<string> => {
    if (state.cheerioOnly) {
      return scrub(condenseHtml(state.cheerioOnly.html, state.cheerioOnly.url));
    }
    const condensed = scrub(await condensePage(page));
    state.recordSnapshot(page.url(), condensed);
    return condensed;
  };

  /** Plain fetch (no JavaScript) of a page; the probe text is evidence for engine "cheerio". */
  const fetchRaw = async (url: string) => {
    const res = await opts.net.fetch(url, { signal: opts.signal });
    const html = await res.text();
    const finalUrl = res.url || url;
    const condensed = scrub(condenseHtml(html, finalUrl));
    return { status: res.status, ok: res.ok, html, url: finalUrl, condensed };
  };

  /** Makes a raw page the current page of a cheerio-only scout. */
  const useRawPage = (raw: { url: string; html: string; condensed: string }, reason: string) => {
    state.cheerioOnly = { reason, url: raw.url, html: raw.html };
    state.probeTexts.push(raw.condensed);
    state.recordSnapshot(raw.url, raw.condensed);
  };

  /** Why the browser did not really load the page, or null when it did. */
  const browserLoadProblem = async (response: PwResponse | null): Promise<string | null> => {
    if (response && response.status() >= 400) return `HTTP ${response.status()}`;
    const isBlank = () =>
      page
        .evaluate(
          /* v8 ignore start -- runs inside Chromium, invisible to Node coverage */
          () => !document.body || (document.body.innerText.trim() === '' && document.links.length === 0),
          /* v8 ignore stop */
        )
        .catch(() => false);
    if (!(await isBlank())) return null;
    // A script-rendered page can still be empty at domcontentloaded.
    await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => undefined);
    return (await isBlank()) ? 'a blank page' : null;
  };

  /**
   * The browser failed to load url. If a plain fetch gets the page, switch the
   * scout to cheerio-only and return the raw page with a notice saying so;
   * otherwise null.
   */
  const noJsFallback = async (url: string, problem: string): Promise<string | null> => {
    const raw = await fetchRaw(url).catch(() => null);
    throwIfAborted();
    if (!raw?.ok || !hasBodyText(raw.html)) return null;
    useRawPage(raw, problem);
    state.urlsVisited.push(raw.url);
    return (
      `NOTE: the browser could not load this page (${problem}), but a plain HTTP fetch ` +
      `without JavaScript did (HTTP ${raw.status}). This site is cheerio-only for the rest ` +
      `of the exploration:\n` +
      `- navigate and probe_no_js return the raw HTML, and that page becomes the current page.\n` +
      `- try_selector and report_findings check selectors against this raw HTML, as the ` +
      `cheerio engine will.\n` +
      `- click, type_text, load_all and detect_listing need the browser and are unavailable; ` +
      `follow links with navigate.\n` +
      `- Report engine "cheerio".\n\n${raw.condensed}`
    );
  };

  /** Tools that need a live browser page refuse to run on a cheerio-only site. */
  const browserOnly = (name: string): string | null =>
    state.cheerioOnly
      ? `ERROR: ${name} needs the browser, which cannot load this site ` +
        `(${state.cheerioOnly.reason}). The site is cheerio-only: navigate to link URLs and ` +
        `use try_selector on the raw HTML.`
      : null;

  const selectInBrowser = async (
    css: string,
  ): Promise<{ count: number; samples: Array<{ text: string; href?: string }> }> => {
    const locator = page.locator(css);
    const count = await locator.count();
    const samples: Array<{ text: string; href?: string }> = [];
    for (let i = 0; i < Math.min(count, 3); i++) {
      const el = locator.nth(i);
      const text = (await el.innerText().catch(() => '')).trim().replace(/\s+/g, ' ').slice(0, 120);
      const href = await el
        .evaluate(
          /* v8 ignore start -- runs inside Chromium, invisible to Node coverage */
          (node) => {
            const anchor = node.closest('a') ?? node.querySelector('a');
            return anchor instanceof HTMLAnchorElement ? anchor.href : null;
          },
          /* v8 ignore stop */
        )
        .catch(() => null);
      samples.push({ text, ...(href ? { href } : {}) });
    }
    return { count, samples };
  };

  const verifySelector = async (
    css: string,
  ): Promise<{ count: number; samples: Array<{ text: string; href?: string }> }> => {
    const { count, samples } = state.cheerioOnly
      ? selectInHtml(state.cheerioOnly.html, state.cheerioOnly.url, css)
      : await selectInBrowser(css);
    const evidence: SelectorEvidence = {
      count,
      ...(samples[0]?.text ? { sampleText: samples[0].text } : {}),
    };
    state.verifiedSelectors.set(css, evidence);
    return { count, samples };
  };

  return {
    navigate: tool({
      description:
        'Navigate the browser to a URL and return the condensed page (LINKS + TEXT sections).',
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => {
        try {
          const blocked = await gate(url);
          if (blocked) return blocked;
          if (state.cheerioOnly) {
            const raw = await fetchRaw(url);
            useRawPage(raw, state.cheerioOnly.reason);
            state.urlsVisited.push(raw.url);
            return `HTTP ${raw.status} (raw HTML, no JavaScript)\n${raw.condensed}`;
          }
          let response: PwResponse | null;
          try {
            response = await page.goto(url, { waitUntil: 'domcontentloaded' });
          } catch (err) {
            throwIfAborted();
            const gotoError = err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
            const fallback = await noJsFallback(url, gotoError);
            if (fallback) return fallback;
            throw err;
          }
          const problem = await browserLoadProblem(response);
          if (problem) {
            const fallback = await noJsFallback(url, problem);
            if (fallback) return fallback;
          }
          state.urlsVisited.push(page.url());
          await captureScreenshot('navigate');
          return await readCurrentPage();
        } catch (err) {
          throwIfAborted();
          return asToolError(err);
        }
      },
    }),

    read_page: tool({
      description: 'Re-read the current page as condensed LINKS + TEXT (e.g. after clicking).',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          return await readCurrentPage();
        } catch (err) {
          throwIfAborted();
          return asToolError(err);
        }
      },
    }),

    click: tool({
      description:
        'Click the first element matching a CSS selector. Returns the new URL and, if the page changed, its condensed content.',
      inputSchema: z.object({
        selector: z.string(),
        description: z.string().describe('what you expect this click to do'),
      }),
      execute: async ({ selector }) => {
        try {
          throwIfAborted();
          const refused = browserOnly('click');
          if (refused) return refused;
          const locator = page.locator(selector);
          if ((await locator.count()) === 0) {
            return `ERROR: selector matched 0 elements: ${selector}`;
          }
          const urlBefore = page.url();
          await locator.first().click();
          await page.waitForLoadState('domcontentloaded').catch(() => undefined);
          await sleep(200);
          if (page.url() !== urlBefore) {
            state.urlsVisited.push(page.url());
            await captureScreenshot('click');
            return `clicked; now at ${page.url()}\n\n${await readCurrentPage()}`;
          }
          return `clicked; still at ${page.url()} (DOM may have changed — use read_page to see)`;
        } catch (err) {
          throwIfAborted();
          return asToolError(err);
        }
      },
    }),

    type_text: tool({
      description:
        'Type into the first element matching a CSS selector. For credentials/user-supplied ' +
        'values pass inputName (the value is filled without being shown to you); for other ' +
        'text pass text.',
      inputSchema: z.object({
        selector: z.string(),
        inputName: z.string().optional(),
        text: z.string().optional(),
      }),
      execute: async ({ selector, inputName, text }) => {
        try {
          throwIfAborted();
          const refused = browserOnly('type_text');
          if (refused) return refused;
          let value: string;
          if (inputName !== undefined) {
            const supplied = opts.inputs[inputName];
            if (supplied === undefined) {
              return `ERROR: no value was provided for input "${inputName}". Available inputs: ${
                Object.keys(opts.inputs).join(', ') || '(none)'
              }`;
            }
            value = supplied;
          } else {
            value = text ?? '';
          }
          const locator = page.locator(selector);
          if ((await locator.count()) === 0) {
            return `ERROR: selector matched 0 elements: ${selector}`;
          }
          await locator.first().fill(value);
          return inputName !== undefined
            ? `typed «input:${inputName}» into ${selector}`
            : `typed ${JSON.stringify(value)} into ${selector}`;
        } catch (err) {
          throwIfAborted();
          return asToolError(err);
        }
      },
    }),

    try_selector: tool({
      description:
        'Test a CSS selector on the current page: returns the match count and up to 3 sample ' +
        'texts/hrefs. ALWAYS verify selectors here before reporting them.',
      inputSchema: z.object({ selector: z.string() }),
      execute: async ({ selector }) => {
        try {
          throwIfAborted();
          const { count, samples } = await verifySelector(selector);
          return scrub(JSON.stringify({ count, samples }));
        } catch (err) {
          throwIfAborted();
          return asToolError(err);
        }
      },
    }),

    detect_listing: tool({
      description:
        'Automatically detect the dominant repeating listing-link pattern on the current page ' +
        '(frequency analysis of same-origin link paths). Returns a candidate CSS selector and count.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          throwIfAborted();
          const refused = browserOnly('detect_listing');
          if (refused) return refused;
          const result = await page.evaluate(
            /* v8 ignore start -- runs inside Chromium, invisible to Node coverage; asserted via integration tests */
            () => {
            const groups = new Map<string, Set<string>>();
            const exclude =
              /^\/(tag|category|search|login|signin|signup|register|account|cart|checkout|privacy|terms|about|contact|help|faq|blog\/page)(\/|$)/i;
            document.querySelectorAll('a[href]').forEach((a) => {
              const href = (a as HTMLAnchorElement).href;
              let u: URL;
              try {
                u = new URL(href);
              } catch {
                return;
              }
              if (u.origin !== location.origin) return;
              if (exclude.test(u.pathname)) return;
              const segs = u.pathname.split('/').filter(Boolean);
              if (segs.length === 0) return;
              const keys: string[] = [];
              for (const n of [1, 2, 3]) {
                if (segs.length > n) keys.push('/' + segs.slice(0, n).join('/') + '/');
              }
              const last = segs[segs.length - 1];
              if (last !== undefined && /^\d+$/.test(last) && segs.length > 1) {
                keys.push('/' + segs.slice(0, -1).join('/') + '/');
              }
              for (const key of keys) {
                const set = groups.get(key) ?? new Set<string>();
                set.add(href);
                groups.set(key, set);
              }
            });
            let bestKey: string | undefined;
            let bestSize = 0;
            for (const [key, set] of groups) {
              if (set.size >= 4 && set.size > bestSize) {
                bestKey = key;
                bestSize = set.size;
              }
            }
            if (bestKey === undefined) return null;
            const selector = `a[href*="${bestKey}"]`;
            return {
              selector,
              count: document.querySelectorAll(selector).length,
              distinctUrls: bestSize,
            };
            /* v8 ignore stop */
          });
          if (!result) return 'no repeating listing pattern found on this page';
          await verifySelector(result.selector);
          return JSON.stringify(result);
        } catch (err) {
          throwIfAborted();
          return asToolError(err);
        }
      },
    }),

    load_all: tool({
      description:
        'Exhaust an accumulating listing on the current page: clicks "load more"-style buttons ' +
        'and scrolls until the count of elements matching the selector stops growing. Returns the final count.',
      inputSchema: z.object({ selector: z.string() }),
      execute: async ({ selector }) => {
        try {
          const refused = browserOnly('load_all');
          if (refused) return refused;
          const finalCount = await loadAll(page, selector, {}, throwIfAborted, sleep);
          await verifySelector(selector);
          return `final count for ${selector}: ${finalCount}`;
        } catch (err) {
          throwIfAborted();
          return asToolError(err);
        }
      },
    }),

    probe_no_js: tool({
      description:
        'Fetch a URL WITHOUT JavaScript (raw HTML) and return its condensed content. Use this ' +
        'to decide the engine: if the target data appears here, the site works with the cheap ' +
        'cheerio engine; if not, playwright is required.',
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => {
        try {
          const blocked = await gate(url);
          if (blocked) return blocked;
          const raw = await fetchRaw(url);
          if (state.cheerioOnly) {
            useRawPage(raw, state.cheerioOnly.reason);
          } else {
            state.probeTexts.push(raw.condensed);
            state.recordSnapshot(`probe:${url}`, raw.condensed);
          }
          return `HTTP ${raw.status} (no-JS probe)\n${raw.condensed}`;
        } catch (err) {
          throwIfAborted();
          return asToolError(err);
        }
      },
    }),

    screenshot: tool({
      description: 'Capture a screenshot for the human operator (you will not see it).',
      inputSchema: z.object({ label: z.string() }),
      execute: async ({ label }) => {
        await captureScreenshot(label);
        return 'captured';
      },
    }),

    report_findings: tool({
      description:
        'Submit your final findings. This is the ONLY way to finish. If the result starts with ' +
        'REJECTED, fix the issue it describes and call this again.',
      inputSchema: reportFindingsSchema,
      execute: async (payload) => {
        try {
          throwIfAborted();
          // Auto-verify any reported selector the model didn't try_selector itself.
          for (const def of Object.values(payload.selectors)) {
            if (!state.verifiedSelectors.has(def.css)) {
              await verifySelector(def.css).catch(() =>
                state.verifiedSelectors.set(def.css, { count: 0 }),
              );
            }
          }
          const rejection = checkFindings(payload, {
            verifiedSelectors: state.verifiedSelectors,
            probeTexts: state.probeTexts,
            validator: opts.validator,
            ...(state.cheerioOnly ? { browserProblem: state.cheerioOnly.reason } : {}),
          });
          if (rejection) return rejection;

          const selectorSamples: Record<string, string> = {};
          for (const [name, def] of Object.entries(payload.selectors)) {
            const sample = state.verifiedSelectors.get(def.css)?.sampleText;
            if (sample) selectorSamples[name] = sample;
          }
          state.findings = {
            ...payload,
            selectorSamples,
            keyPages: state.snapshots.slice(-KEY_PAGE_COUNT),
            urlsVisited: [...state.urlsVisited],
            probeVerifiedCheerio: payload.engine === 'cheerio',
          };
          return 'ACCEPTED — exploration complete. Stop calling tools now.';
        } catch (err) {
          throwIfAborted();
          return asToolError(err);
        }
      },
    }),
  };
}

export { reportedSelectorSchema };
