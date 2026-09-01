import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildContextOptions,
  buildLaunchOptions,
  classifyResponse,
  DEFAULT_CF_RETRY,
  DEFAULT_RETRY,
  isNetworkError,
  Net,
  resolveRetry,
  withRetry,
} from '../src/runtime/net.js';
import { startSite, type FixtureSite } from './fixtures/sites/server.js';

const headersOf = (record: Record<string, string>) => ({
  get: (name: string) => record[name.toLowerCase()] ?? null,
});

describe('resolveRetry', () => {
  it('applies defaults, cloudflare enabled', () => {
    const r = resolveRetry(undefined);
    expect(r).toEqual({
      attempts: DEFAULT_RETRY.attempts,
      backoffMs: DEFAULT_RETRY.backoffMs,
      maxBackoffMs: DEFAULT_RETRY.maxBackoffMs,
      cfEnabled: true,
      cfAttempts: DEFAULT_CF_RETRY.attempts,
      cfBackoffMs: DEFAULT_CF_RETRY.backoffMs,
      cfMaxBackoffMs: DEFAULT_CF_RETRY.maxBackoffMs,
    });
  });

  it('cloudflare: false disables the long schedule; an object tunes it', () => {
    expect(resolveRetry({ cloudflare: false }).cfEnabled).toBe(false);
    const tuned = resolveRetry({ attempts: 5, cloudflare: { attempts: 1, backoffMs: 9 } });
    expect(tuned.attempts).toBe(5);
    expect(tuned.cfEnabled).toBe(true);
    expect(tuned.cfAttempts).toBe(1);
    expect(tuned.cfBackoffMs).toBe(9);
  });
});

describe('classifyResponse', () => {
  it('flags 429/5xx as transient', () => {
    expect(classifyResponse(429, headersOf({}), '')?.kind).toBe('transient');
    expect(classifyResponse(502, headersOf({}), '')?.kind).toBe('transient');
    expect(classifyResponse(504, headersOf({}), '')?.kind).toBe('transient');
  });

  it('accepts 200 and plain 403/500', () => {
    expect(classifyResponse(200, headersOf({}), '')).toBeNull();
    expect(classifyResponse(403, headersOf({}), 'forbidden by acl')).toBeNull();
    expect(classifyResponse(500, headersOf({}), '')).toBeNull();
  });

  it('detects Cloudflare challenges by header or body on 403/503', () => {
    expect(classifyResponse(403, headersOf({ 'cf-ray': 'abc123' }), '')?.kind).toBe('cloudflare');
    expect(classifyResponse(403, headersOf({ server: 'cloudflare' }), '')?.kind).toBe('cloudflare');
    expect(
      classifyResponse(503, headersOf({}), '<title>Just a moment...</title>')?.kind,
    ).toBe('cloudflare');
    // a Cloudflare-marked 503 is a challenge, not a generic transient 503
    expect(classifyResponse(503, headersOf({ 'cf-mitigated': 'challenge' }), '')?.kind).toBe(
      'cloudflare',
    );
  });
});

describe('isNetworkError', () => {
  it('matches dropped-connection errors, including nested causes', () => {
    expect(isNetworkError(new Error('socket hang up'))).toBe(true);
    expect(isNetworkError(Object.assign(new Error('boom'), { code: 'ECONNRESET' }))).toBe(true);
    const fetchFailed = new TypeError('fetch failed');
    (fetchFailed as { cause?: unknown }).cause = Object.assign(new Error('x'), {
      code: 'ECONNREFUSED',
    });
    expect(isNetworkError(fetchFailed)).toBe(true);
  });

  it('rejects aborts and ordinary errors', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(isNetworkError(abort)).toBe(false);
    expect(isNetworkError(new Error('validation failed'))).toBe(false);
    expect(isNetworkError('nope')).toBe(false);
  });
});

describe('withRetry', () => {
  const fastRetry = (overrides = {}) =>
    resolveRetry({ backoffMs: 10, cloudflare: { backoffMs: 20 }, ...overrides });

  it('retries transient inspect failures with exponential backoff, then succeeds', async () => {
    const delays: number[] = [];
    let calls = 0;
    const value = await withRetry(async () => ++calls, {
      retry: fastRetry(),
      sleepFn: async (ms) => void delays.push(ms),
      inspect: (v) => (v < 3 ? { kind: 'transient', detail: 'HTTP 503' } : null),
    });
    expect(value).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  it('returns the last value unchanged when the budget is exhausted', async () => {
    let calls = 0;
    const value = await withRetry(async () => ++calls, {
      retry: fastRetry(),
      sleepFn: async () => undefined,
      inspect: () => ({ kind: 'transient', detail: 'HTTP 502' }),
    });
    expect(value).toBe(3); // 1 try + 2 retries, caller sees the real final outcome
  });

  it('retries thrown network errors and rethrows after the budget', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error('req failed'), { code: 'ETIMEDOUT' });
        },
        { retry: fastRetry(), sleepFn: async () => undefined },
      ),
    ).rejects.toThrow('req failed');
    expect(calls).toBe(3);
  });

  it('rethrows non-retryable errors immediately', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('artifact is malformed');
        },
        { retry: fastRetry(), sleepFn: async () => undefined },
      ),
    ).rejects.toThrow('malformed');
    expect(calls).toBe(1);
  });

  it('gives Cloudflare failures their own budget and schedule', async () => {
    const delays: number[] = [];
    let calls = 0;
    const value = await withRetry(async () => ++calls, {
      retry: fastRetry({ attempts: 0, cloudflare: { attempts: 2, backoffMs: 20 } }),
      sleepFn: async (ms) => void delays.push(ms),
      inspect: (v) => (v < 3 ? { kind: 'cloudflare', detail: 'HTTP 403 (Cloudflare)' } : null),
    });
    expect(value).toBe(3); // attempts: 0 would forbid transient retries; cf budget carried it
    expect(delays).toEqual([20, 40]);
  });

  it('honors the backoff cap', async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry(async () => ++calls, {
      retry: fastRetry({ attempts: 4, backoffMs: 10, maxBackoffMs: 25 }),
      sleepFn: async (ms) => void delays.push(ms),
      inspect: (v) => (v < 5 ? { kind: 'transient', detail: 'HTTP 503' } : null),
    });
    expect(delays).toEqual([10, 20, 25, 25]);
  });

  it('does not retry Cloudflare failures when disabled', async () => {
    let calls = 0;
    const value = await withRetry(async () => ++calls, {
      retry: resolveRetry({ cloudflare: false }),
      sleepFn: async () => undefined,
      inspect: () => ({ kind: 'cloudflare', detail: 'HTTP 403' }),
    });
    expect(value).toBe(1);
  });

  it('reports each retry via onRetry', async () => {
    const seen: string[] = [];
    let calls = 0;
    await withRetry(async () => ++calls, {
      retry: fastRetry(),
      sleepFn: async () => undefined,
      inspect: (v) => (v < 2 ? { kind: 'transient', detail: 'HTTP 429' } : null),
      onRetry: (info) =>
        seen.push(`${info.failure.detail} in ${info.delayMs}ms (${info.attempt}/${info.maxAttempts})`),
    });
    expect(seen).toEqual(['HTTP 429 in 10ms (1/2)']);
  });
});

describe('browser option builders', () => {
  it('buildLaunchOptions forwards executablePath, args, and proxy credentials', () => {
    expect(buildLaunchOptions(true)).toEqual({ headless: true });
    expect(
      buildLaunchOptions(
        false,
        { executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] },
        { server: 'http://proxy:8080', username: 'u', password: 'p' },
      ),
    ).toEqual({
      headless: false,
      executablePath: '/usr/bin/chromium',
      args: ['--no-sandbox'],
      proxy: { server: 'http://proxy:8080', username: 'u', password: 'p' },
    });
  });

  it('buildContextOptions forwards headers and TLS relaxation', () => {
    expect(buildContextOptions('ua')).toEqual({ userAgent: 'ua' });
    expect(
      buildContextOptions('ua', { 'x-team': 'crawl' }, { server: 's', ignoreTlsErrors: true }),
    ).toEqual({
      userAgent: 'ua',
      extraHTTPHeaders: { 'x-team': 'crawl' },
      ignoreHTTPSErrors: true,
    });
  });
});

describe('Net.fetch', () => {
  let site: FixtureSite;
  const requests: Array<Record<string, string | string[] | undefined>> = [];

  beforeAll(async () => {
    site = await startSite((req: http.IncomingMessage, res: http.ServerResponse) => {
      requests.push({ ...req.headers });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  afterAll(async () => {
    await site?.close();
  });

  it('sends the user-agent plus configured default headers, per-call headers winning', async () => {
    const net = new Net({ userAgent: 'net-test/1.0', headers: { 'x-team': 'crawl', 'x-a': '1' } });
    const res = await net.fetch(`${site.url}/`, { headers: { 'x-a': '2' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    const last = requests.at(-1)!;
    expect(last['user-agent']).toBe('net-test/1.0');
    expect(last['x-team']).toBe('crawl');
    expect(last['x-a']).toBe('2');
  });
});
