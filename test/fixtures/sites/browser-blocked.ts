import { html, startSite, type FixtureSite } from './server.js';

export const BLOCKED_SESSIONS = [
  { name: '3.5 Weeks', price: 5360 },
  { name: '2 Weeks Session A', price: 3650 },
  { name: '2 Weeks Session B', price: 3650 },
  { name: '1 Week Intro Camp', price: 1990 },
];

/**
 * A server-rendered site that a browser cannot load but a plain fetch can
 * (as camphurontario.com through a proxy the browser could not authenticate
 * to). Browser navigations (sec-fetch-mode: navigate) get, per path:
 * `/` and `/contact` a 401 Basic-auth challenge, `/blank` an empty 200 page,
 * `/drop` a dropped connection. Plain fetches get the real page everywhere.
 */
export function startBrowserBlockedSite(): Promise<FixtureSite> {
  return startSite((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const browser = req.headers['sec-fetch-mode'] === 'navigate';

    if (url.pathname === '/robots.txt') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('none');
      return;
    }

    if (browser) {
      if (url.pathname === '/blank') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body></body></html>');
      } else if (url.pathname === '/drop') {
        req.socket.destroy();
      } else {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="members"', 'content-type': 'text/html' });
        res.end(html('<h1>401 Unauthorized</h1>'));
      }
      return;
    }

    if (url.pathname === '/contact') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html('<main><p class="summer"><strong>Summer</strong> MacTier, ON P0C 1H0</p></main>'));
      return;
    }

    const rows = BLOCKED_SESSIONS.map(
      (s) =>
        `<tr class="session"><td class="name"><a href="/register">${s.name}</a></td>` +
        `<td class="price">$${s.price.toLocaleString('en-US')} +HST</td></tr>`,
    ).join('');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      html(
        `<main><h1>Dates and Rates</h1><table class="sessions"><tbody>${rows}</tbody></table>` +
          `<a href="/contact">Contact</a></main>`,
        'Dates and Rates',
      ),
    );
  });
}
