import { html, startSite, type FixtureSite } from './server.js';

const PRODUCTS = Array.from({ length: 6 }, (_, i) => ({
  id: i + 1,
  name: `Widget ${i + 1}`,
  price: (i + 1) * 10 + 0.99,
  description: `The finest widget number ${i + 1}.`,
}));

/**
 * Server-rendered store: all data present in raw HTML (cheerio-friendly).
 * robots.txt disallows /private/.
 */
export function startStaticStore(): Promise<FixtureSite> {
  return startSite((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');

    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /private/\n');
      return;
    }

    if (url.pathname === '/') {
      const items = PRODUCTS.map(
        (p) =>
          `<li class="product"><a href="/p/${p.id}">${p.name}</a>` +
          `<span class="price">$${p.price.toFixed(2)}</span></li>`,
      ).join('\n');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        html(
          `<main><h1>Static Store</h1><ul class="listing">${items}</ul>` +
            `<a href="/private/secret">secret</a></main>`,
        ),
      );
      return;
    }

    const detail = url.pathname.match(/^\/p\/(\d+)$/);
    if (detail) {
      const product = PRODUCTS.find((p) => p.id === Number(detail[1]));
      if (product) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          html(
            `<main><h1 class="name">${product.name}</h1>` +
              `<span class="price">$${product.price.toFixed(2)}</span>` +
              `<p class="desc">${product.description}</p></main>`,
          ),
        );
        return;
      }
    }

    if (url.pathname === '/private/secret') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html('<main>robots should have kept you out</main>'));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
}

export const STATIC_STORE_PRODUCT_COUNT = PRODUCTS.length;
