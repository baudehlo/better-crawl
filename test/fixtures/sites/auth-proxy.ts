import http from 'node:http';
import type { FixtureSite } from './server.js';

export interface AuthProxy extends FixtureSite {
  /** "<status> <url>" per request the proxy answered. */
  log: string[];
}

/**
 * A forwarding HTTP proxy that demands Basic proxy credentials (407 without
 * them), like the residential proxies crawls use. `url` carries no credentials.
 */
export function startAuthProxy(username: string, password: string): Promise<AuthProxy> {
  const log: string[] = [];
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const server = http.createServer((req, res) => {
    if (req.headers['proxy-authorization'] !== expected) {
      log.push(`407 ${req.url}`);
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="proxy"', 'content-type': 'text/plain' });
      res.end('proxy authentication required');
      return;
    }
    log.push(`200 ${req.url}`);
    const target = new URL(req.url ?? '');
    const { 'proxy-authorization': _auth, ...headers } = req.headers;
    const upstream = http.request(
      { host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) throw new Error('no address');
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        log,
        close: () =>
          new Promise<void>((done, fail) => {
            server.closeAllConnections();
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}
