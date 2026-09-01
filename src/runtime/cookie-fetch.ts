import { CookieJar } from 'tough-cookie';
import { BetterCrawlError } from '../errors.js';
import { classifyResponse, type AttemptFailure, type Net } from './net.js';

export interface CookieFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface CookieFetchResult {
  /** Final URL after following redirects — observed, never asserted. */
  url: string;
  status: number;
  body: string;
  contentType: string | null;
}

const MAX_REDIRECTS = 10;

/**
 * fetch() with a cookie jar and MANUAL redirect following.
 *
 * Auto-redirecting fetch processes Set-Cookie inconsistently across the 302
 * chain of a typical form login; following each hop ourselves captures session
 * cookies reliably (and records the true final URL).
 *
 * Transient failures retry on the Net's schedule: network errors for any
 * method, and retryable statuses (429/5xx, Cloudflare challenges) for GETs
 * only — a POST that reached the server must not be replayed blindly.
 */
export class CookieFetcher {
  readonly jar = new CookieJar();

  constructor(
    private readonly net: Net,
    private readonly signal?: AbortSignal,
  ) {}

  async request(url: string, init?: CookieFetchInit): Promise<CookieFetchResult> {
    const method = init?.method ?? 'GET';
    const outcome = await this.net.retrying(() => this.attempt(url, init), {
      inspect: (v) => (method === 'GET' ? v.failure : null),
    });
    return outcome.result;
  }

  private async attempt(
    url: string,
    init?: CookieFetchInit,
  ): Promise<{ result: CookieFetchResult; failure: AttemptFailure | null }> {
    let current = url;
    let method = init?.method ?? 'GET';
    let body = init?.body;
    let extraHeaders = init?.headers ?? {};

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const cookie = await this.jar.getCookieString(current);
      const res = await this.net.fetch(current, {
        method,
        redirect: 'manual',
        ...(body !== undefined ? { body } : {}),
        ...(this.signal ? { signal: this.signal } : {}),
        headers: {
          ...(cookie ? { cookie } : {}),
          ...extraHeaders,
        },
      });

      for (const setCookie of res.headers.getSetCookie()) {
        // Invalid cookies from misbehaving servers are ignored, not fatal.
        await this.jar.setCookie(setCookie, current).catch(() => undefined);
      }

      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => undefined);
        current = new URL(location, current).href;
        if (res.status !== 307 && res.status !== 308) {
          method = 'GET';
          body = undefined;
          extraHeaders = {};
        }
        continue;
      }

      const text = await res.text();
      return {
        result: {
          url: current,
          status: res.status,
          body: text,
          contentType: res.headers.get('content-type'),
        },
        failure: classifyResponse(res.status, res.headers, text),
      };
    }
    throw new BetterCrawlError(
      `Too many redirects (>${MAX_REDIRECTS}) starting from ${url}`,
      'TOO_MANY_REDIRECTS',
    );
  }
}
