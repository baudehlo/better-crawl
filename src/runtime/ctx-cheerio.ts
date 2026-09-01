import * as cheerio from 'cheerio';
import type { CtxBase, SharedRuntime } from './ctx-shared.js';
import { CookieFetcher } from './cookie-fetch.js';

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
  shared: SharedRuntime,
  fetcher: CookieFetcher,
): CheerioCtx {
  const toPage = (result: { url: string; status: number; body: string }): FetchedPage => {
    shared.recordVisit(result.url);
    shared.lastPage = { url: result.url, html: result.body };
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
