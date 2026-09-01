import { html, startSite, type FixtureSite } from './server.js';

/**
 * Client-rendered store: the raw HTML is an empty shell; products only exist
 * after the inline script runs. A no-JS probe must find nothing here.
 */
export function startJsStore(): Promise<FixtureSite> {
  return startSite((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');

    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow:\n');
      return;
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        html(
          `<main><h1>JS Store</h1><ul id="app"></ul></main>
<script>
  const products = [1, 2, 3, 4].map((i) => ({ id: i, name: 'Gadget ' + i, price: i * 5 }));
  document.getElementById('app').innerHTML = products
    .map((p) => '<li class="product"><span class="name">' + p.name +
      '</span><span class="price">$' + p.price + '.00</span></li>')
    .join('');
</script>`,
        ),
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
}

export const JS_STORE_PRODUCT_COUNT = 4;
