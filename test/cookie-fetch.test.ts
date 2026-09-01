import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CookieFetcher } from '../src/runtime/cookie-fetch.js';
import { readBody, startSite, type FixtureSite } from './fixtures/sites/server.js';

describe('CookieFetcher', () => {
  let site: FixtureSite;
  const seen: Array<{ method: string; path: string; body: string; cookie?: string }> = [];

  beforeAll(async () => {
    site = await startSite((req, res) => {
      void handle(req, res);
    });
  });
  afterAll(async () => {
    await site?.close();
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const body = await readBody(req);
    seen.push({
      method: req.method ?? '',
      path: url.pathname,
      body,
      ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
    });

    switch (url.pathname) {
      case '/set':
        res.writeHead(302, { 'set-cookie': 'a=1; Path=/', location: '/final' });
        res.end();
        return;
      case '/post307':
        res.writeHead(307, { location: '/post-target' });
        res.end();
        return;
      case '/post-target':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`method=${req.method} body=${body}`);
        return;
      case '/loop':
        res.writeHead(302, { location: '/loop' });
        res.end();
        return;
      case '/bad-cookie':
        res.writeHead(200, { 'set-cookie': 'this is; not,,valid;;;===' });
        res.end('ok');
        return;
      default:
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`final at ${url.pathname}`);
    }
  }

  it('follows 302 redirects, capturing cookies and demoting POST to GET', async () => {
    const fetcher = new CookieFetcher('test-agent');
    const result = await fetcher.request(`${site.url}/set`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'x=1',
    });
    expect(result.status).toBe(200);
    expect(result.url).toBe(`${site.url}/final`);
    expect(result.body).toBe('final at /final');
    const finalHop = seen.find((r) => r.path === '/final');
    expect(finalHop?.method).toBe('GET');
    expect(finalHop?.body).toBe('');

    // the jar replays the cookie on the next request to the same origin
    const next = await fetcher.request(`${site.url}/whatever`);
    expect(next.status).toBe(200);
    const replay = seen.find((r) => r.path === '/whatever');
    expect(replay?.cookie).toContain('a=1');
  });

  it('preserves method and body across a 307 redirect', async () => {
    const fetcher = new CookieFetcher('test-agent', new AbortController().signal);
    const result = await fetcher.request(`${site.url}/post307`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'keep-me',
    });
    expect(result.body).toBe('method=POST body=keep-me');
  });

  it('throws TOO_MANY_REDIRECTS on a redirect loop', async () => {
    const fetcher = new CookieFetcher('test-agent');
    await expect(fetcher.request(`${site.url}/loop`)).rejects.toThrow(/Too many redirects/);
  });

  it('ignores invalid Set-Cookie headers instead of failing', async () => {
    const fetcher = new CookieFetcher('test-agent');
    const result = await fetcher.request(`${site.url}/bad-cookie`);
    expect(result.status).toBe(200);
    expect(result.body).toBe('ok');
  });
});
