import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CookieFetcher } from '../src/runtime/cookie-fetch.js';
import { Net } from '../src/runtime/net.js';
import { readBody, startSite, type FixtureSite } from './fixtures/sites/server.js';

const testNet = () => new Net({ userAgent: 'test-agent' });

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
      case '/flaky':
        if (seen.filter((r) => r.path === '/flaky').length < 3) {
          res.writeHead(503);
          res.end('overloaded');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('recovered');
        return;
      case '/always503':
        res.writeHead(503);
        res.end('nope');
        return;
      case '/cf':
        if (seen.filter((r) => r.path === '/cf').length < 2) {
          res.writeHead(403, { server: 'cloudflare' });
          res.end('<title>Just a moment...</title>');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('challenge cleared');
        return;
      default:
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`final at ${url.pathname}`);
    }
  }

  it('follows 302 redirects, capturing cookies and demoting POST to GET', async () => {
    const fetcher = new CookieFetcher(testNet());
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
    const fetcher = new CookieFetcher(testNet(), new AbortController().signal);
    const result = await fetcher.request(`${site.url}/post307`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'keep-me',
    });
    expect(result.body).toBe('method=POST body=keep-me');
  });

  it('throws TOO_MANY_REDIRECTS on a redirect loop', async () => {
    const fetcher = new CookieFetcher(testNet());
    await expect(fetcher.request(`${site.url}/loop`)).rejects.toThrow(/Too many redirects/);
  });

  it('ignores invalid Set-Cookie headers instead of failing', async () => {
    const fetcher = new CookieFetcher(testNet());
    const result = await fetcher.request(`${site.url}/bad-cookie`);
    expect(result.status).toBe(200);
    expect(result.body).toBe('ok');
  });

  it('retries transient 5xx GETs on the Net schedule', async () => {
    const net = new Net({ userAgent: 'test-agent', retry: { backoffMs: 1 } });
    const result = await new CookieFetcher(net).request(`${site.url}/flaky`);
    expect(result.status).toBe(200);
    expect(result.body).toBe('recovered');
    expect(seen.filter((r) => r.path === '/flaky')).toHaveLength(3);
  });

  it('does not retry non-GET requests on status', async () => {
    const net = new Net({ userAgent: 'test-agent', retry: { backoffMs: 1 } });
    const result = await new CookieFetcher(net).request(`${site.url}/always503`, {
      method: 'POST',
      body: 'x=1',
    });
    expect(result.status).toBe(503);
    expect(seen.filter((r) => r.path === '/always503')).toHaveLength(1);
  });

  it('retries Cloudflare-marked 403s on the dedicated schedule', async () => {
    // attempts: 0 disables ordinary retries — only the Cloudflare budget can carry this.
    const net = new Net({
      userAgent: 'test-agent',
      retry: { attempts: 0, cloudflare: { backoffMs: 1 } },
    });
    const result = await new CookieFetcher(net).request(`${site.url}/cf`);
    expect(result.status).toBe(200);
    expect(result.body).toBe('challenge cleared');
    expect(seen.filter((r) => r.path === '/cf')).toHaveLength(2);
  });
});
