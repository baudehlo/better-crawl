import * as cheerio from 'cheerio';
import type { CtxBase, EngineRuntime } from './ctx-shared.js';
import type { CookieFetchInit, CookieFetchResult } from './cookie-fetch.js';

/** How the cheerio ctx gets pages — a CookieFetcher in-process, an RPC proxy in the sandbox. */
export interface PageFetcher {
  request(url: string, init?: CookieFetchInit): Promise<CookieFetchResult>;
}

export interface FetchedPage {
  $: cheerio.CheerioAPI;
  /** Final URL after redirects — observed, not asserted. */
  url: string;
  status: number;
}

export interface CheerioCtx extends CtxBase {
  /** GET through the cookie jar (robots/budget/delay enforced). */
  fetch(url: string): Promise<FetchedPage>;
  /** urlencoded POST through the cookie jar — form logins. */
  submitForm(url: string, fields: Record<string, string>): Promise<FetchedPage>;
  /** Query a page with a manifest selector name. */
  select(page: FetchedPage, selectorName: string): cheerio.Cheerio<never>;
  /** Resolve a possibly-relative href against a base URL. */
  absolute(href: string, base: string): string;
}

export function createCheerioCtx(
  shared: EngineRuntime,
  fetcher: PageFetcher,
): CheerioCtx {
  const toPage = (result: { url: string; status: number; body: string }): FetchedPage => {
    shared.recordVisit(result.url);
    shared.lastPage = { url: result.url, html: result.body };
    if (shared.pageEvents) shared.emitPage(result.url, result.body);
    return { $: cheerio.load(result.body), url: result.url, status: result.status };
  };

  const base = shared.createCtxBase(async () => {
    // Screenshots are a browser concept; no-op on the cheerio engine.
  });

  return {
    ...base,
    fetch: async (url) => {
      await shared.gate(url);
      return toPage(await fetcher.request(url));
    },
    submitForm: async (url, fields) => {
      await shared.gate(url);
      return toPage(
        await fetcher.request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(fields).toString(),
        }),
      );
    },
    select: (page, selectorName) =>
      page.$(shared.selDef(selectorName).css) as cheerio.Cheerio<never>,
    absolute: (href, baseUrl) => new URL(href, baseUrl).href,
  };
}
