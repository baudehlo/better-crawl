import { ProxyAgent, fetch as undiciFetch } from 'undici';
import type { CrawlEvent } from '../events.js';
import type { BrowserOptions, ProxyOptions, RetryOptions } from '../types.js';

export const DEFAULT_RETRY = { attempts: 2, backoffMs: 1_000, maxBackoffMs: 30_000 } as const;
export const DEFAULT_CF_RETRY = { attempts: 4, backoffMs: 5_000, maxBackoffMs: 300_000 } as const;

/** RetryOptions with every knob resolved to a concrete number. */
export interface ResolvedRetry {
  attempts: number;
  backoffMs: number;
  maxBackoffMs: number;
  cfEnabled: boolean;
  cfAttempts: number;
  cfBackoffMs: number;
  cfMaxBackoffMs: number;
}

export function resolveRetry(retry?: RetryOptions): ResolvedRetry {
  const cf = retry?.cloudflare;
  const cfObj = typeof cf === 'object' ? cf : {};
  return {
    attempts: retry?.attempts ?? DEFAULT_RETRY.attempts,
    backoffMs: retry?.backoffMs ?? DEFAULT_RETRY.backoffMs,
    maxBackoffMs: retry?.maxBackoffMs ?? DEFAULT_RETRY.maxBackoffMs,
    cfEnabled: cf !== false,
    cfAttempts: cfObj.attempts ?? DEFAULT_CF_RETRY.attempts,
    cfBackoffMs: cfObj.backoffMs ?? DEFAULT_CF_RETRY.backoffMs,
    cfMaxBackoffMs: cfObj.maxBackoffMs ?? DEFAULT_CF_RETRY.maxBackoffMs,
  };
}

/**
 * Why a request attempt failed, for retry purposes. 'cloudflare' gets its own
 * longer backoff schedule (challenge pages clear on the order of minutes, not
 * seconds); 'transient' is everything worth an ordinary quick retry.
 */
export interface AttemptFailure {
  kind: 'transient' | 'cloudflare';
  detail: string;
}

const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Network-level failures worth retrying. Abort/timeout controllers are handled
 * separately by withRetry; this matches the error text and errno codes that
 * fetch()/undici surface for dropped connections.
 */
const NETWORK_ERROR_RE =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EPROTO|EAI_AGAIN|ENOTFOUND|socket hang up|socket disconnected|fetch failed|network|terminated|TLS connection/i;

export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  const cause = err.cause;
  const text = [
    err.message,
    (err as NodeJS.ErrnoException).code ?? '',
    cause instanceof Error ? cause.message : '',
    cause instanceof Error ? ((cause as NodeJS.ErrnoException).code ?? '') : '',
  ].join(' ');
  return NETWORK_ERROR_RE.test(text);
}

const CF_BODY_RE = /cloudflare|cf-chl|just a moment|attention required/i;

/**
 * Classify an HTTP response for retry purposes. `body` is only consulted for
 * the Cloudflare check, so callers may pass '' when the status can't be a
 * challenge (anything other than 403/503).
 */
export function classifyResponse(
  status: number,
  headers: { get(name: string): string | null },
  body: string,
): AttemptFailure | null {
  if (status === 403 || status === 503) {
    const cfHeaders =
      headers.get('cf-ray') !== null ||
      headers.get('cf-mitigated') !== null ||
      /cloudflare/i.test(headers.get('server') ?? '');
    if (cfHeaders || CF_BODY_RE.test(body.slice(0, 8_000))) {
      return { kind: 'cloudflare', detail: `HTTP ${status} (Cloudflare challenge/block)` };
    }
  }
  if (TRANSIENT_STATUSES.has(status)) {
    return { kind: 'transient', detail: `HTTP ${status}` };
  }
  return null;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface WithRetryOptions<T> {
  retry: ResolvedRetry;
  signal?: AbortSignal | undefined;
  /** Inspect a resolved value; a failure triggers a retry, null accepts it. */
  inspect?: (value: T) => AttemptFailure | null | Promise<AttemptFailure | null>;
  /** Classify a thrown error; null rethrows immediately. Default: network errors are transient. */
  classifyError?: (err: unknown) => AttemptFailure | null;
  onRetry?: (info: {
    failure: AttemptFailure;
    delayMs: number;
    attempt: number;
    maxAttempts: number;
  }) => void;
  /** Backoff sleeper — injectable for engines with their own abort plumbing and for tests. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Retry driver with two independent budgets: ordinary transient failures
 * (network drops, 429/5xx) on a quick exponential schedule, and Cloudflare
 * challenges on a long one (5s doubling to 5min by default — challenge pages
 * rarely clear faster). When a budget is exhausted the last outcome surfaces
 * unchanged: the value is returned (caller sees the real status) or the error
 * is rethrown.
 */
export async function withRetry<T>(run: () => Promise<T>, opts: WithRetryOptions<T>): Promise<T> {
  const { retry } = opts;
  const sleepFn = opts.sleepFn ?? ((ms: number) => abortableSleep(ms, opts.signal));
  const classifyError =
    opts.classifyError ??
    ((err: unknown) =>
      isNetworkError(err) ? { kind: 'transient' as const, detail: (err as Error).message } : null);
  let used = 0;
  let cfUsed = 0;

  for (;;) {
    let value: T | undefined;
    let error: unknown;
    let threw = false;
    let failure: AttemptFailure | null = null;

    try {
      value = await run();
      failure = opts.inspect ? await opts.inspect(value) : null;
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      threw = true;
      error = err;
      failure = classifyError(err);
    }

    const giveUp = (): T => {
      if (threw) throw error;
      return value as T;
    };

    if (!failure) return giveUp();
    if (failure.kind === 'cloudflare' && !retry.cfEnabled) return giveUp();

    const cf = failure.kind === 'cloudflare';
    const usedCount = cf ? cfUsed : used;
    const maxAttempts = cf ? retry.cfAttempts : retry.attempts;
    if (usedCount >= maxAttempts) return giveUp();

    const base = cf ? retry.cfBackoffMs : retry.backoffMs;
    const cap = cf ? retry.cfMaxBackoffMs : retry.maxBackoffMs;
    const delayMs = Math.min(base * 2 ** usedCount, cap);
    if (cf) cfUsed += 1;
    else used += 1;

    opts.onRetry?.({ failure, delayMs, attempt: usedCount + 1, maxAttempts });
    await sleepFn(delayMs);
  }
}

export interface NetInit {
  userAgent: string;
  proxy?: ProxyOptions | undefined;
  headers?: Record<string, string> | undefined;
  retry?: RetryOptions | undefined;
  signal?: AbortSignal | undefined;
  emitEvent?: ((event: CrawlEvent) => void) | undefined;
}

export interface NetFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: RequestRedirect;
  signal?: AbortSignal | undefined;
}

/**
 * One place that knows how plain (non-browser) HTTP leaves this library:
 * default headers, the proxy dispatcher, and the resolved retry schedules.
 * Retrying itself stays with callers (via withRetry) because what counts as
 * a retryable outcome differs per call site.
 */
export class Net {
  readonly userAgent: string;
  readonly retry: ResolvedRetry;
  private readonly headers: Record<string, string>;
  private readonly dispatcher: ProxyAgent | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly emitEvent: ((event: CrawlEvent) => void) | undefined;

  constructor(init: NetInit) {
    this.userAgent = init.userAgent;
    this.retry = resolveRetry(init.retry);
    this.headers = { 'user-agent': init.userAgent, ...(init.headers ?? {}) };
    this.dispatcher = init.proxy ? buildProxyAgent(init.proxy) : undefined;
    this.signal = init.signal;
    this.emitEvent = init.emitEvent;
  }

  /**
   * A single fetch with default headers and the proxy applied. No retries —
   * wrap with withRetry (see retrying()) where retrying is wanted. Proxied
   * requests go through undici's own fetch so the dispatcher and the fetch
   * implementation always come from the same library.
   */
  async fetch(url: string, init?: NetFetchInit): Promise<Response> {
    const headers = { ...this.headers, ...(init?.headers ?? {}) };
    const signal = init?.signal ?? this.signal;
    const common = {
      method: init?.method ?? 'GET',
      headers,
      ...(init?.body !== undefined ? { body: init.body } : {}),
      ...(init?.redirect !== undefined ? { redirect: init.redirect } : {}),
      ...(signal ? { signal } : {}),
    };
    if (this.dispatcher) {
      return (await undiciFetch(url, {
        ...common,
        dispatcher: this.dispatcher,
      })) as unknown as Response;
    }
    return await fetch(url, common);
  }

  /** withRetry pre-wired with this Net's schedule, signal, and a log event per retry. */
  retrying<T>(
    run: () => Promise<T>,
    opts?: Omit<WithRetryOptions<T>, 'retry' | 'signal' | 'onRetry'>,
  ): Promise<T> {
    return withRetry(run, {
      retry: this.retry,
      signal: this.signal,
      onRetry: (info) => {
        this.emitEvent?.({
          type: 'log',
          level: 'warn',
          message: `retrying after ${info.failure.detail} — waiting ${info.delayMs}ms (attempt ${info.attempt}/${info.maxAttempts})`,
        });
      },
      ...(opts ?? {}),
    });
  }
}

function buildProxyAgent(proxy: ProxyOptions): ProxyAgent {
  const tls = proxy.ignoreTlsErrors ? { rejectUnauthorized: false } : undefined;
  return new ProxyAgent({
    uri: proxy.server,
    ...(proxy.username !== undefined
      ? {
          token: `Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}`,
        }
      : {}),
    ...(tls ? { requestTls: tls, proxyTls: tls } : {}),
  });
}

/** chromium.launch() options for the shared browser knobs — pure, for tests. */
export function buildLaunchOptions(
  headless: boolean,
  browser?: BrowserOptions,
  proxy?: ProxyOptions,
): {
  headless: boolean;
  executablePath?: string;
  args?: string[];
  proxy?: { server: string; username?: string; password?: string };
} {
  return {
    headless,
    ...(browser?.executablePath !== undefined ? { executablePath: browser.executablePath } : {}),
    ...(browser?.args !== undefined ? { args: browser.args } : {}),
    ...(proxy
      ? {
          proxy: {
            server: proxy.server,
            ...(proxy.username !== undefined ? { username: proxy.username } : {}),
            ...(proxy.password !== undefined ? { password: proxy.password } : {}),
          },
        }
      : {}),
  };
}

/** browser.newContext() options for the shared knobs — pure, for tests. */
export function buildContextOptions(
  userAgent: string,
  headers?: Record<string, string>,
  proxy?: ProxyOptions,
): { userAgent: string; extraHTTPHeaders?: Record<string, string>; ignoreHTTPSErrors?: boolean } {
  return {
    userAgent,
    ...(headers !== undefined ? { extraHTTPHeaders: headers } : {}),
    ...(proxy?.ignoreTlsErrors ? { ignoreHTTPSErrors: true } : {}),
  };
}
