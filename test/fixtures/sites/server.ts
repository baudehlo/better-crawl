import http from 'node:http';

export interface FixtureSite {
  url: string;
  close(): Promise<void>;
}

export function startSite(handler: http.RequestListener): Promise<FixtureSite> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) throw new Error('no address');
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((done, fail) =>
            server.close((err) => (err ? fail(err) : done())),
          ),
      });
    });
  });
}

export function html(body: string, title = 'fixture'): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString()));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
