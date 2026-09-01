import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { Page } from 'playwright';
import type { CrawlEvent } from '../events.js';
import { condenseHtml, condensePage, scrubSecrets } from '../llm/condense.js';
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
    const condensed = scrub(await condensePage(page));
    state.recordSnapshot(page.url(), condensed);
    return condensed;
  };

  const verifySelector = async (
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
          await page.goto(url, { waitUntil: 'domcontentloaded' });
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
          const res = await fetch(url, {
            headers: { 'user-agent': opts.userAgent },
            signal: opts.signal,
          });
          const condensed = scrub(condenseHtml(await res.text(), res.url || url));
          state.probeTexts.push(condensed);
          state.recordSnapshot(`probe:${url}`, condensed);
          return `HTTP ${res.status} (no-JS probe)\n${condensed}`;
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
