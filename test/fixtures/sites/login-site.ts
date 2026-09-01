import { html, readBody, startSite, type FixtureSite } from './server.js';

export const LOGIN = { username: 'admin', password: 'hunter2', csrf: 'csrf-123' };
const SESSION_COOKIE = 'session=s3cret';

const RECORDS = [
  { name: 'Alpha', value: 10 },
  { name: 'Beta', value: 20 },
  { name: 'Gamma', value: 30 },
];

function hasSession(cookieHeader: string | undefined): boolean {
  return (cookieHeader ?? '').split(/;\s*/).includes(SESSION_COOKIE);
}

/**
 * Form-login site: POST /login sets a session cookie via a 302 chain; /data
 * requires the cookie. Exercises the cookie jar, submitForm, and ctx.input.
 */
export function startLoginSite(): Promise<FixtureSite> {
  return startSite((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fixture');

      if (url.pathname === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('User-agent: *\nDisallow:\n');
        return;
      }

      if (url.pathname === '/login' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          html(
            `<main><form method="post" action="/login">` +
              `<input type="hidden" name="csrf" value="${LOGIN.csrf}">` +
              `<input name="username"><input name="password" type="password">` +
              `<button>Sign in</button></form></main>`,
          ),
        );
        return;
      }

      if (url.pathname === '/login' && req.method === 'POST') {
        const params = new URLSearchParams(await readBody(req));
        const ok =
          params.get('username') === LOGIN.username &&
          params.get('password') === LOGIN.password &&
          params.get('csrf') === LOGIN.csrf;
        if (ok) {
          res.writeHead(302, {
            'set-cookie': `${SESSION_COOKIE}; Path=/; HttpOnly`,
            location: '/account',
          });
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(html('<main class="error">Bad credentials</main>'));
        }
        return;
      }

      if (url.pathname === '/account' || url.pathname === '/data') {
        if (!hasSession(req.headers.cookie)) {
          res.writeHead(302, { location: '/login' });
          res.end();
          return;
        }
      }

      if (url.pathname === '/account') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(html('<main><h1>Account</h1><a href="/data">your data</a></main>'));
        return;
      }

      if (url.pathname === '/data') {
        const rows = RECORDS.map(
          (r) =>
            `<li class="record"><span class="name">${r.name}</span>` +
            `<span class="value">${r.value}</span></li>`,
        ).join('');
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(html(`<main><ul>${rows}</ul></main>`));
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    })();
  });
}

export const LOGIN_SITE_RECORD_COUNT = RECORDS.length;
