import type { LanguageModel } from 'ai';
import type { z } from 'zod';
import type { Artifact, Assertion } from './artifact.js';

/** Named zod schemas describing the record types to extract. */
export type Schemas = Record<string, z.ZodType>;

export interface Limits {
  /** Hard budget on navigations/fetches. Default 100. */
  maxPages?: number;
  /** Politeness delay before every navigation/fetch. Default 500ms; raised by robots.txt Crawl-delay. */
  delayMs?: number;
  /** Wall-clock limit for a single crawl run. Default 600_000 (10 min). */
  timeoutMs?: number;
  /** Stop accepting items after this many (across all schemas). */
  maxItems?: number;
}

export interface ProxyOptions {
  /** Proxy URL, e.g. "http://host:8080" (credentials may be embedded or passed separately). */
  server: string;
  username?: string;
  password?: string;
  /**
   * Accept the proxy's TLS-intercepting certificates (residential proxies like
   * Bright Data MITM HTTPS). Default false.
   */
  ignoreTlsErrors?: boolean;
}

export interface RetryOptions {
  /** Retries after the first try for transient failures (network drops, 429/5xx). Default 2; 0 disables. */
  attempts?: number;
  /** Base backoff, doubled per retry. Default 1000ms. */
  backoffMs?: number;
  /** Backoff cap. Default 30_000ms. */
  maxBackoffMs?: number;
  /**
   * Cloudflare challenge/block responses (403/503 with Cloudflare markers) get
   * their own longer schedule — default 4 attempts, 5s base doubling to a 300s
   * cap. Pass false to disable, or an object to tune. NOTE: these waits count
   * against limits.timeoutMs (600s default); raise it for heavily-challenged sites.
   */
  cloudflare?: boolean | { attempts?: number; backoffMs?: number; maxBackoffMs?: number };
}

export interface BrowserOptions {
  /** Launch this Chromium binary instead of playwright's bundled one (e.g. a system chromium in Docker). */
  executablePath?: string;
  /** Extra chromium launch args, e.g. ['--no-sandbox', '--disable-dev-shm-usage']. */
  args?: string[];
}

export interface CommonOptions {
  /** Values for the inputs the artifact declares (username, password, ...). */
  inputs?: Record<string, string>;
  /** Route all HTTP and browser traffic through a proxy. */
  proxy?: ProxyOptions;
  /** Extra headers sent with every plain fetch and browser request. */
  headers?: Record<string, string>;
  /** Transient-failure retry policy. Retries are ON by default (2 attempts); `{ attempts: 0 }` disables. */
  retry?: RetryOptions;
  /** Browser launch overrides (playwright engine). */
  browser?: BrowserOptions;
  /** Emit screenshot events (playwright engine only). */
  screenshots?: boolean;
  /** When set, screenshots are written here and events carry `path` instead of `buffer`. */
  screenshotDir?: string;
  /** Skip robots.txt checks. Default false. */
  ignoreRobots?: boolean;
  /** Override the default `better-crawl/<version> (+repo)` user-agent. */
  userAgent?: string;
  limits?: Limits;
  /** Where generated crawl modules are written before import. Default os.tmpdir()/better-crawl. */
  moduleDir?: string;
  /** External abort signal; merged with handle.abort(). */
  signal?: AbortSignal;
  /** Run the browser headed (debugging). Default true = headless. */
  headless?: boolean;
}

export interface GenerateOptions extends CommonOptions {
  url: string;
  /** Natural-language description of what to find. */
  instructions: string;
  schemas: Schemas;
  /** Any Vercel AI SDK LanguageModel, e.g. anthropic('claude-opus-5'). */
  model: LanguageModel;
  /** Optional cheaper model for repair passes. Defaults to `model`. */
  repairModel?: LanguageModel;
  /** Scout agent-loop step budget. Default 40. */
  maxScoutSteps?: number;
  /** Self-test repair attempts (after the first try) before giving up. Default 3. */
  maxRepairAttempts?: number;
  /** Internal/test hook: replace the AI SDK adapter. */
  llmClient?: import('./llm/client.js').LlmClient;
}

export interface RunOptions extends CommonOptions {
  /**
   * The caller's real zod schemas for strict validation. Optional on replay —
   * without them, items are checked against the manifest's JSON Schema copies.
   */
  schemas?: Schemas;
  /**
   * false (default): fail fast on drift. true: attempt selector-only repair, then
   * scout-lite regen. 'full': allow a complete re-scout (may switch engine).
   */
  heal?: boolean | 'full';
  /** Required when heal is enabled. */
  model?: LanguageModel;
  /** Heal attempts before giving up. Default 2. */
  healAttempts?: number;
  /** Internal/test hook: replace the AI SDK adapter. */
  llmClient?: import('./llm/client.js').LlmClient;
}

/** Outcome of one execution of an artifact (self-test or replay). */
export interface RunReport {
  ok: boolean;
  itemCounts: Record<string, number>;
  invalidItems: Array<{ schema: string; issues: z.core.$ZodIssue[]; raw: unknown }>;
  assertionFailures: Array<{ assertion: Assertion; actual: string }>;
  runtimeError?: {
    message: string;
    stack: string;
    /** Set when the failure was a named-selector miss — enables selector-only healing. */
    failedSelector?: string;
  };
  pagesVisited: number;
  durationMs: number;
  /** Last ~30 progress messages — repair context. */
  progressTrail: string[];
}

export interface GenerateResult {
  artifact: Artifact;
  /** Items collected during the passing self-test run, keyed by schema name. */
  items: Record<string, unknown[]>;
  report: RunReport;
}

export interface RunResult {
  /** The artifact that ultimately ran — possibly healed. Persist if `healed`. */
  artifact: Artifact;
  healed: boolean;
  items: Record<string, unknown[]>;
  report: RunReport;
}
