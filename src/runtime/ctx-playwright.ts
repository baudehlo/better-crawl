import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { NoMatchError, PlaywrightMissingError } from '../errors.js';
import type { CtxBase, SharedRuntime } from './ctx-shared.js';
import { loadAll, type LoadAllOptions } from './paginate.js';

export interface PlaywrightCtx extends CtxBase {
  /**
   * Escape hatch for logic the helpers can't express. Everything routine should
   * go through the named-selector helpers so healing stays possible.
   */
  page: Page;
  goto(url: string): Promise<void>;
  click(selectorName: string): Promise<void>;
  fill(selectorName: string, value: string): Promise<void>;
  waitFor(selectorName: string, opts?: { timeoutMs?: number }): Promise<void>;
  /** Trimmed innerText of every match. */
  text(selectorName: string): Promise<string[]>;
  attr(selectorName: string, attribute: string): Promise<(string | null)[]>;
  /** Absolute, deduped hrefs of every match. */
  links(selectorName: string): Promise<string[]>;
  count(selectorName: string): Promise<number>;
  /** Exhaust an accumulating listing (load-more/scroll); returns final count. */
  loadAll(selectorName: string, opts?: LoadAllOptions): Promise<number>;
}

export interface PlaywrightSessionOptions {
  userAgent: string;
  headless: boolean;
  screenshots: boolean;
  screenshotDir?: string;
  /** Reuse an existing page (the scout does this); the session then won't own/close the browser. */
  existingPage?: Page;
}

export interface PlaywrightSession {
  ctx: PlaywrightCtx;
  page: Page;
  close: () => Promise<void>;
}

export async function createPlaywrightSession(
  shared: SharedRuntime,
  opts: PlaywrightSessionOptions,
): Promise<PlaywrightSession> {
  let page: Page;
  let browser: Browser | undefined;

  if (opts.existingPage) {
    page = opts.existingPage;
  } else {
    let pw: typeof import('playwright');
    try {
      pw = await import('playwright');
    } catch {
      throw new PlaywrightMissingError();
    }
    browser = await pw.chromium.launch({ headless: opts.headless });
    const context = await browser.newContext({ userAgent: opts.userAgent });
    page = await context.newPage();
  }

  let screenshotIndex = 0;
  const screenshot = async (label: string): Promise<void> => {
    if (!opts.screenshots) return;
    try {
      const buffer = await page.screenshot();
      if (opts.screenshotDir) {
        await mkdir(opts.screenshotDir, { recursive: true });
        const file = path.join(
          opts.screenshotDir,
          `${String(screenshotIndex++).padStart(3, '0')}-${label.replace(/[^\w.-]+/g, '_')}.png`,
        );
        await writeFile(file, buffer);
        shared.emitEvent({ type: 'screenshot', label, path: file });
      } else {
        shared.emitEvent({ type: 'screenshot', label, buffer });
      }
    } catch {
      // Screenshots are best-effort; never fail a crawl over one.
    }
  };

  const resolve = (name: string) => shared.selDef(name).css;

  const requireMatch = async (name: string): Promise<string> => {
    const css = resolve(name);
    if ((await page.locator(css).count()) === 0) {
      throw new NoMatchError(name, css, page.url());
    }
    return css;
  };

  const base = shared.createCtxBase(screenshot);

  const ctx: PlaywrightCtx = {
    ...base,
    page,
    goto: async (url) => {
      await shared.gate(url);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      shared.recordVisit(page.url());
    },
    click: async (name) => {
      const css = await requireMatch(name);
      const urlBefore = page.url();
      await page.locator(css).first().click();
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      if (page.url() !== urlBefore) shared.recordVisit(page.url());
    },
    fill: async (name, value) => {
      const css = await requireMatch(name);
      await page.locator(css).first().fill(value);
    },
    waitFor: async (name, waitOpts) => {
      const css = resolve(name);
      try {
        await page.waitForSelector(css, {
          timeout: waitOpts?.timeoutMs ?? 10_000,
          state: 'attached',
        });
      } catch {
        throw new NoMatchError(name, css, page.url());
      }
    },
    text: async (name) => {
      const texts = await page.locator(resolve(name)).allInnerTexts();
      return texts.map((t) => t.trim());
    },
    attr: async (name, attribute) => {
      return page.locator(resolve(name)).evaluateAll(
        /* v8 ignore start -- runs inside Chromium, invisible to Node coverage */
        (els, attrName) => els.map((el) => el.getAttribute(attrName)),
        /* v8 ignore stop */
        attribute,
      );
    },
    links: async (name) => {
      const hrefs = await page.locator(resolve(name)).evaluateAll(
        /* v8 ignore start -- runs inside Chromium, invisible to Node coverage */
        (els) =>
          els.map((el) => {
            const anchor = el.closest('a') ?? el.querySelector('a') ?? el;
            return anchor instanceof HTMLAnchorElement ? anchor.href : el.getAttribute('href');
          }),
        /* v8 ignore stop */
      );
      const absolute = hrefs
        .filter((h): h is string => typeof h === 'string' && h.length > 0)
        .map((h) => new URL(h, page.url()).href);
      return [...new Set(absolute)];
    },
    count: (name) => page.locator(resolve(name)).count(),
    loadAll: (name, loadOpts = {}) =>
      loadAll(
        page,
        resolve(name),
        loadOpts,
        () => shared.throwIfAborted(),
        (ms) => shared.abortableSleep(ms),
      ),
  };

  return {
    ctx,
    page,
    close: async () => {
      if (browser) await browser.close();
    },
  };
}
