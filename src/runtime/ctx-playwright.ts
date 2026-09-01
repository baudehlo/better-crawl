import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Page, Response as PwResponse } from 'playwright';
import { NoMatchError, PlaywrightMissingError } from '../errors.js';
import type { BrowserOptions, ProxyOptions } from '../types.js';
import type { CtxBase, EngineRuntime } from './ctx-shared.js';
import {
  buildContextOptions,
  buildLaunchOptions,
  classifyResponse,
  resolveRetry,
  withRetry,
  type ResolvedRetry,
} from './net.js';
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
  /** Connect to an already-launched browser server instead of launching one (sandbox runner). */
  connectWsEndpoint?: string;
  proxy?: ProxyOptions;
  headers?: Record<string, string>;
  browser?: BrowserOptions;
  /** Resolved retry schedule for goto navigations. Default: resolveRetry(undefined). */
  retry?: ResolvedRetry;
}

export interface PlaywrightSession {
  ctx: PlaywrightCtx;
  page: Page;
  close: () => Promise<void>;
}

export async function createPlaywrightSession(
  shared: EngineRuntime,
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
    } catch (err) {
      // Only a genuinely absent package means "install playwright" — anything
      // else (a permission denial in the sandbox, a broken install) must
      // surface as itself or it's undebuggable.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
        throw new PlaywrightMissingError();
      }
      throw err;
    }
    browser = opts.connectWsEndpoint
      ? await pw.chromium.connect(opts.connectWsEndpoint)
      : await pw.chromium.launch(buildLaunchOptions(opts.headless, opts.browser, opts.proxy));
    const context = await browser.newContext(
      buildContextOptions(opts.userAgent, opts.headers, opts.proxy),
    );
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
  const retry = opts.retry ?? resolveRetry(undefined);

  // Raw-page events cost a DOM serialization each — best-effort, and only
  // when the host asked. Snapshot is post-navigation (pre-interaction).
  const emitPageSnapshot = async (): Promise<void> => {
    if (!shared.pageEvents) return;
    try {
      shared.emitPage(page.url(), await page.content());
    } catch {
      // a mid-navigation snapshot must never fail the crawl
    }
  };

  const ctx: PlaywrightCtx = {
    ...base,
    page,
    goto: async (url) => {
      await shared.gate(url);
      await gotoWithRetry(page, url, retry, shared);
      shared.recordVisit(page.url());
      await emitPageSnapshot();
    },
    click: async (name) => {
      const css = await requireMatch(name);
      const urlBefore = page.url();
      await page.locator(css).first().click();
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      if (page.url() !== urlBefore) {
        shared.recordVisit(page.url());
        await emitPageSnapshot();
      }
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

/** Chromium-level navigation failures worth a retry (dropped connections, gateway timeouts). */
const GOTO_TRANSIENT_RE =
  /net::ERR_(CONNECTION|TIMED_OUT|NETWORK|INTERNET_DISCONNECTED|SOCKET|EMPTY_RESPONSE|NAME_NOT_RESOLVED)|Timeout \d+ms exceeded/;

async function gotoWithRetry(
  page: Page,
  url: string,
  retry: ResolvedRetry,
  shared: EngineRuntime,
): Promise<void> {
  await withRetry<PwResponse | null>(() => page.goto(url, { waitUntil: 'domcontentloaded' }), {
    retry,
    sleepFn: (ms) => shared.abortableSleep(ms),
    classifyError: (err) =>
      err instanceof Error && GOTO_TRANSIENT_RE.test(err.message)
        ? { kind: 'transient', detail: err.message }
        : null,
    inspect: async (response) => {
      if (!response) return null; // same-document navigation — nothing to judge
      const status = response.status();
      if (status < 400) return null;
      const headers = await response.allHeaders().catch(() => ({}) as Record<string, string>);
      // The rendered body is only needed for the Cloudflare check on 403/503.
      const body =
        status === 403 || status === 503 ? await page.content().catch(() => '') : '';
      return classifyResponse(status, { get: (name) => headers[name.toLowerCase()] ?? null }, body);
    },
    onRetry: (info) => {
      shared.emitEvent({
        type: 'log',
        level: 'warn',
        message: `goto ${url}: retrying after ${info.failure.detail} — waiting ${info.delayMs}ms (attempt ${info.attempt}/${info.maxAttempts})`,
      });
    },
  });
}
