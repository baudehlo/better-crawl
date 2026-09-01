import { html, startSite, type FixtureSite } from './server.js';

/**
 * The async-count trap: clicking "Load more" appends items only after a 300ms
 * delay, so a naive "count didn't change → done" check exits far too early.
 */
export function startPaginated(): Promise<FixtureSite> {
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
          `<main><ul id="list"></ul><button id="more">Load more</button></main>
<script>
  let n = 0;
  const TOTAL = 60;
  function add(k) {
    const ul = document.getElementById('list');
    for (let i = 0; i < k && n < TOTAL; i++) {
      n++;
      const li = document.createElement('li');
      li.className = 'item';
      li.textContent = 'Item ' + n;
      ul.appendChild(li);
    }
    if (n >= TOTAL) document.getElementById('more').style.display = 'none';
  }
  add(20);
  document.getElementById('more').addEventListener('click', () => {
    setTimeout(() => add(20), 300);
  });
</script>`,
        ),
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
}

export const PAGINATED_TOTAL_ITEMS = 60;
