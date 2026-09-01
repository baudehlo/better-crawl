import type { Artifact } from '../artifact.js';
import type { CrawlEvent, Phase } from '../events.js';
import {
  MissingInputError,
  NoMatchError,
  RunTimeoutError,
  UnknownSelectorError,
} from '../errors.js';
import type { Limits, RunReport, Schemas } from '../types.js';
import { DEFAULT_USER_AGENT } from '../version.js';
import { CookieFetcher } from './cookie-fetch.js';
import { createCheerioCtx } from './ctx-cheerio.js';
import { EarlyStop, SharedRuntime } from './ctx-shared.js';
import { loadCrawlModule } from './load-module.js';
import { RobotsCache } from './robots.js';
import { createValidator } from './validate.js';

export interface ExecuteOptions {
  schemas?: Schemas;
  inputs?: Record<string, string>;
  emitEvent?: (event: CrawlEvent) => void;
  phase?: Phase;
  limits?: Limits;
  signal?: AbortSignal;
  ignoreRobots?: boolean;
  userAgent?: string;
  moduleDir?: string;
  screenshots?: boolean;
  screenshotDir?: string;
  headless?: boolean;
}

export interface ExecuteOutcome {
  report: RunReport;
  /** Validated items collected during the run, keyed by schema name. */
  items: Record<string, unknown[]>;
  /** Condensed rendering of the page where a failure happened (repair context). */
  failurePage?: string;
}

export const DEFAULT_LIMITS = {
  maxPages: 100,
  delayMs: 500,
  timeoutMs: 600_000,
} as const;

/**
 * Run an artifact to completion and report what happened. Never throws for
 * "the crawl went wrong" (that lands in report.runtimeError) — only for caller
 * errors: malformed artifact code, missing required inputs, missing playwright.
 */
export async function executeArtifact(
  artifact: Artifact,
  opts: ExecuteOptions = {},
): Promise<ExecuteOutcome> {
  const { manifest } = artifact;
  const inputs = opts.inputs ?? {};

  // Missing required inputs are a caller error — fail before touching the site.
  for (const input of manifest.inputs) {
    if (input.required && inputs[input.name] === undefined) {
      throw new MissingInputError(input.name);
    }
  }

  const emitEvent = opts.emitEvent ?? (() => undefined);
  const phase = opts.phase ?? 'run';
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const limits = {
    maxPages: opts.limits?.maxPages ?? DEFAULT_LIMITS.maxPages,
    delayMs: opts.limits?.delayMs ?? DEFAULT_LIMITS.delayMs,
    ...(opts.limits?.maxItems !== undefined ? { maxItems: opts.limits.maxItems } : {}),
  };
  const timeoutMs = opts.limits?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs;

  const { fn } = await loadCrawlModule(artifact.code, opts.moduleDir);
  const validator = createValidator(opts.schemas, manifest.schemas);

  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => {
    timeoutCtl.abort(new RunTimeoutError(timeoutMs));
  }, timeoutMs);
  timer.unref?.();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutCtl.signal])
    : timeoutCtl.signal;

  const robots = opts.ignoreRobots
    ? undefined
    : new RobotsCache(async (url) => {
        const res = await fetch(url, { headers: { 'user-agent': userAgent }, signal });
        return { status: res.status, body: await res.text() };
      }, userAgent);

  const shared = new SharedRuntime({
    artifact,
    validator,
    inputs,
    emitEvent,
    phase,
    signal,
    limits,
    ...(robots ? { robots } : {}),
  });

  const startedAt = Date.now();
  let runtimeError: RunReport['runtimeError'];
  let failurePage: string | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  let livePage: import('playwright').Page | undefined;

  try {
    let ctx: unknown;
    if (manifest.engine === 'cheerio') {
      ctx = createCheerioCtx(shared, new CookieFetcher(userAgent, signal));
    } else {
      const { createPlaywrightSession } = await import('./ctx-playwright.js');
      const session = await createPlaywrightSession(shared, {
        userAgent,
        headless: opts.headless ?? true,
        screenshots: opts.screenshots ?? false,
        ...(opts.screenshotDir !== undefined ? { screenshotDir: opts.screenshotDir } : {}),
      });
      ctx = session.ctx;
      livePage = session.page;
      cleanup = session.close;
    }
    await fn(ctx);
  } catch (err) {
    if (!(err instanceof EarlyStop)) {
      const error = err instanceof Error ? err : new Error(String(err));
      runtimeError = {
        message: error.message,
        stack: error.stack ?? '',
        ...(error instanceof NoMatchError || error instanceof UnknownSelectorError
          ? { failedSelector: error.selectorName }
          : {}),
      };
      failurePage = await captureFailurePage(livePage, shared).catch(() => undefined);
    }
  } finally {
    clearTimeout(timer);
    await cleanup?.().catch(() => undefined);
  }

  const durationMs = Date.now() - startedAt;
  const assertionFailures = checkAssertions(artifact, shared, durationMs);

  const report: RunReport = {
    ok: !runtimeError && assertionFailures.length === 0,
    itemCounts: { ...shared.itemCounts },
    invalidItems: shared.invalidItems,
    assertionFailures,
    ...(runtimeError ? { runtimeError } : {}),
    pagesVisited: shared.pagesVisited,
    durationMs,
    progressTrail: [...shared.progressTrail],
  };
  return { report, items: shared.items, ...(failurePage ? { failurePage } : {}) };
}

async function captureFailurePage(
  livePage: import('playwright').Page | undefined,
  shared: SharedRuntime,
): Promise<string | undefined> {
  if (livePage) {
    const { condensePage } = await import('../llm/condense.js');
    return condensePage(livePage);
  }
  if (shared.lastPage) {
    const { condenseHtml } = await import('../llm/condense.js');
    return condenseHtml(shared.lastPage.html, shared.lastPage.url);
  }
  return undefined;
}

function checkAssertions(
  artifact: Artifact,
  shared: SharedRuntime,
  durationMs: number,
): RunReport['assertionFailures'] {
  const failures: RunReport['assertionFailures'] = [];
  for (const assertion of artifact.manifest.assertions) {
    switch (assertion.kind) {
      case 'minItems': {
        const count = shared.itemCounts[assertion.schema] ?? 0;
        if (count < assertion.min) {
          failures.push({ assertion, actual: `${count} valid item(s)` });
        }
        break;
      }
      case 'fieldCoverage': {
        const items = shared.items[assertion.schema] ?? [];
        if (items.length === 0) break; // minItems is the emptiness check
        const covered = items.filter((item) => {
          const value = (item as Record<string, unknown>)[assertion.field];
          return value !== undefined && value !== null && value !== '';
        }).length;
        const ratio = covered / items.length;
        if (ratio < assertion.minRatio) {
          failures.push({
            assertion,
            actual: `${covered}/${items.length} items have ${assertion.field} (${ratio.toFixed(2)})`,
          });
        }
        break;
      }
      case 'urlReached': {
        const re = new RegExp(assertion.pattern);
        if (!shared.urlsVisited.some((url) => re.test(url))) {
          failures.push({
            assertion,
            actual: `visited: ${shared.urlsVisited.slice(-5).join(', ') || '(no pages)'}`,
          });
        }
        break;
      }
      case 'maxDurationMs': {
        if (durationMs > assertion.ms) {
          failures.push({ assertion, actual: `${durationMs}ms` });
        }
        break;
      }
    }
  }
  return failures;
}
