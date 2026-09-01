import type { Artifact, SelectorDef } from '../artifact.js';
import type { CrawlEvent, Phase } from '../events.js';
import {
  MissingInputError,
  PageBudgetExceededError,
  RobotsDisallowedError,
  UnknownInputError,
  UnknownSelectorError,
} from '../errors.js';
import type { RunReport } from '../types.js';
import type { ItemValidator } from './validate.js';
import type { RobotsCache } from './robots.js';

/** The ctx surface shared by both engines — what generated code programs against. */
export interface CtxBase {
  /** The crawl's starting URL (from the manifest) — never hardcode URLs in code. */
  readonly entryUrl: string;
  /**
   * Validate `item` against the named schema and stream it out. Returns true
   * if the item was valid. Invalid items are recorded, never fatal.
   */
  emit(schemaName: string, item: unknown): boolean;
  input(name: string): string;
  sel(name: string): string;
  progress(message: string, pct?: number): void;
  log(level: 'debug' | 'info' | 'warn', message: string): void;
  screenshot(label: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/** Thrown internally when maxItems is reached; treated as clean completion. */
export class EarlyStop extends Error {
  constructor() {
    super('maxItems reached');
    this.name = 'EarlyStop';
  }
}

/**
 * What the engine ctx implementations need from their runtime. SharedRuntime
 * implements it in-process; the sandbox runner implements it with RPC bridges
 * to the parent, so the same ctx code runs on both sides of the boundary.
 */
export interface EngineRuntime {
  readonly pageEvents: boolean;
  lastPage: { url: string; html: string } | undefined;
  selDef(name: string): SelectorDef;
  gate(url: string): Promise<void>;
  recordVisit(finalUrl: string): void;
  throwIfAborted(): void;
  abortableSleep(ms: number): Promise<void>;
  emitEvent(event: CrawlEvent): void;
  emitPage(url: string, html: string): void;
  createCtxBase(screenshot: (label: string) => Promise<void>): CtxBase;
}

export interface SharedRuntimeOptions {
  artifact: Artifact;
  validator: ItemValidator;
  inputs: Record<string, string>;
  emitEvent: (event: CrawlEvent) => void;
  phase: Phase;
  signal: AbortSignal;
  limits: { maxPages: number; delayMs: number; maxItems?: number };
  robots?: RobotsCache;
  pageEvents?: boolean;
}

const PROGRESS_TRAIL_CAP = 30;
const INVALID_ITEM_CAP = 20;

/**
 * Engine-independent runtime state + the CtxBase implementation. The guards
 * (page budget, politeness delay, robots, abort) live here so generated code
 * cannot run away regardless of what the model wrote.
 */
export class SharedRuntime implements EngineRuntime {
  readonly itemCounts: Record<string, number> = {};
  readonly items: Record<string, unknown[]> = {};
  readonly invalidItems: RunReport['invalidItems'] = [];
  readonly urlsVisited: string[] = [];
  readonly progressTrail: string[] = [];
  pagesVisited = 0;
  totalItems = 0;
  /** Last raw page seen (cheerio engine) — condensed into repair digests on failure. */
  lastPage: { url: string; html: string } | undefined;

  constructor(private readonly opts: SharedRuntimeOptions) {
    for (const name of opts.validator.schemaNames) {
      this.itemCounts[name] = 0;
      this.items[name] = [];
    }
  }

  selDef(name: string): SelectorDef {
    const def = this.opts.artifact.manifest.selectors[name];
    if (!def) throw new UnknownSelectorError(name);
    return def;
  }

  /** Pre-navigation gate: abort, robots, page budget, politeness delay. */
  async gate(url: string): Promise<void> {
    this.throwIfAborted();
    if (this.opts.robots) {
      const verdict = await this.opts.robots.check(url);
      if (!verdict.allowed) throw new RobotsDisallowedError(url);
      if (
        verdict.crawlDelayMs !== undefined &&
        verdict.crawlDelayMs > this.opts.limits.delayMs
      ) {
        this.opts.limits.delayMs = verdict.crawlDelayMs;
      }
    }
    if (this.pagesVisited >= this.opts.limits.maxPages) {
      throw new PageBudgetExceededError(this.opts.limits.maxPages);
    }
    this.pagesVisited += 1;
    if (this.opts.limits.delayMs > 0) await this.abortableSleep(this.opts.limits.delayMs);
  }

  /** Record the URL a navigation actually landed on (observed, not asserted). */
  recordVisit(finalUrl: string): void {
    this.urlsVisited.push(finalUrl);
  }

  throwIfAborted(): void {
    if (this.opts.signal.aborted) {
      throw this.opts.signal.reason instanceof Error
        ? this.opts.signal.reason
        : new Error(String(this.opts.signal.reason));
    }
  }

  abortableSleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.opts.signal.aborted) {
        reject(this.opts.signal.reason);
        return;
      }
      const timer = setTimeout(() => {
        this.opts.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(this.opts.signal.reason);
      };
      this.opts.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  emitEvent(event: CrawlEvent): void {
    this.opts.emitEvent(event);
  }

  /** Validate an item and stream it out; also the parent-side handler for sandboxed emits. */
  emitItem(schemaName: string, item: unknown): boolean {
    this.throwIfAborted();
    const result = this.opts.validator.validate(schemaName, item);
    if (result.ok) {
      this.itemCounts[schemaName] = (this.itemCounts[schemaName] ?? 0) + 1;
      (this.items[schemaName] ??= []).push(result.value);
      this.totalItems += 1;
      this.emitEvent({ type: 'item', schema: schemaName, item: result.value });
      const cap = this.opts.limits.maxItems;
      if (cap !== undefined && this.totalItems >= cap) throw new EarlyStop();
      return true;
    }
    if (this.invalidItems.length < INVALID_ITEM_CAP) {
      this.invalidItems.push({ schema: schemaName, issues: result.issues, raw: item });
    }
    this.emitEvent({
      type: 'invalid-item',
      schema: schemaName,
      issues: result.issues,
      raw: item,
    });
    return false;
  }

  /** Record a progress message in the trail and emit it. */
  trackProgress(message: string, pct?: number): void {
    this.progressTrail.push(message);
    if (this.progressTrail.length > PROGRESS_TRAIL_CAP) this.progressTrail.shift();
    this.emitEvent({
      type: 'progress',
      phase: this.opts.phase,
      message,
      ...(pct !== undefined ? { pct } : {}),
    });
  }

  /** Whether the host asked for raw-page events — engines check this BEFORE paying for a snapshot. */
  get pageEvents(): boolean {
    return this.opts.pageEvents ?? false;
  }

  emitPage(url: string, html: string): void {
    this.emitEvent({ type: 'page', phase: this.opts.phase, url, html });
  }

  /** Build the engine-independent part of the ctx handed to generated code. */
  createCtxBase(screenshot: (label: string) => Promise<void>): CtxBase {
    const { inputs, artifact } = this.opts;
    return {
      entryUrl: artifact.manifest.entryUrl,
      emit: (schemaName, item) => this.emitItem(schemaName, item),
      input: (name) => resolveInput(artifact.manifest.inputs, inputs, name),
      sel: (name) => this.selDef(name).css,
      progress: (message, pct) => this.trackProgress(message, pct),
      log: (level, message) => this.emitEvent({ type: 'log', level, message }),
      screenshot,
      sleep: (ms) => this.abortableSleep(ms),
    };
  }
}

/** Shared input lookup — also used by the sandbox runner's runtime. */
export function resolveInput(
  declaredInputs: Artifact['manifest']['inputs'],
  inputs: Record<string, string>,
  name: string,
): string {
  const declared = declaredInputs.find((i) => i.name === name);
  if (!declared) throw new UnknownInputError(name);
  const value = inputs[name];
  if (value === undefined) {
    if (declared.required) throw new MissingInputError(name);
    return '';
  }
  return value;
}
