import { html, startSite, type FixtureSite } from './server.js';

export interface MutableSite extends FixtureSite {
  /** Switch to the redesigned markup (same data, new class names). */
  reskin(): void;
}

const PRODUCTS = Array.from({ length: 6 }, (_, i) => ({
  id: i + 1,
  name: `Widget ${i + 1}`,
  price: (i + 1) * 10 + 0.99,
  description: `The finest widget number ${i + 1}.`,
}));

/**
 * A store whose markup can be reskinned mid-test: the data is identical but
 * every class name changes — the classic selector-drift scenario healing
 * exists for.
 */
export function startMutableStore(): Promise<MutableSite> {
  let version: 1 | 2 = 1;

  const sitePromise = startSite((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');

    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow:\n');
      return;
    }

    if (url.pathname === '/') {
      const items = PRODUCTS.map((p) =>
        version === 1
          ? `<li class="product"><a href="/p/${p.id}">${p.name}</a>` +
            `<span class="price">$${p.price.toFixed(2)}</span></li>`
          : `<li class="card-item"><a href="/p/${p.id}">${p.name}</a>` +
            `<em class="cost">$${p.price.toFixed(2)}</em></li>`,
      ).join('\n');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html(`<main><h1>Mutable Store</h1><ul>${items}</ul></main>`));
      return;
    }

    const detail = url.pathname.match(/^\/p\/(\d+)$/);
    if (detail) {
      const product = PRODUCTS.find((p) => p.id === Number(detail[1]));
      if (product) {
        const body =
          version === 1
            ? `<h1 class="name">${product.name}</h1>` +
              `<span class="price">$${product.price.toFixed(2)}</span>` +
              `<p class="desc">${product.description}</p>`
            : `<h1 class="title">${product.name}</h1>` +
              `<em class="cost">$${product.price.toFixed(2)}</em>` +
              `<div class="description">${product.description}</div>`;
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(html(`<main>${body}</main>`));
        return;
      }
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  return sitePromise.then((site) => ({
    ...site,
    reskin: () => {
      version = 2;
    },
  }));
}

export const MUTABLE_STORE_PRODUCT_COUNT = PRODUCTS.length;
