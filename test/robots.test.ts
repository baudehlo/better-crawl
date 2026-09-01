import { describe, expect, it } from 'vitest';
import { evaluateRobots, parseRobots, RobotsCache } from '../src/runtime/robots.js';

const UA = 'better-crawl/0.1.0 (+https://github.com/baudehlo/better-crawl)';

describe('robots.txt', () => {
  it('applies the wildcard group', () => {
    const groups = parseRobots('User-agent: *\nDisallow: /private/\n');
    expect(evaluateRobots(groups, UA, '/private/x').allowed).toBe(false);
    expect(evaluateRobots(groups, UA, '/public').allowed).toBe(true);
  });

  it('an empty Disallow allows everything', () => {
    const groups = parseRobots('User-agent: *\nDisallow:\n');
    expect(evaluateRobots(groups, UA, '/anything').allowed).toBe(true);
  });

  it('prefers the longest matching specific agent group', () => {
    const groups = parseRobots(
      'User-agent: *\nDisallow: /\n\nUser-agent: better-crawl\nDisallow: /admin/\n',
    );
    expect(evaluateRobots(groups, UA, '/ok').allowed).toBe(true);
    expect(evaluateRobots(groups, UA, '/admin/panel').allowed).toBe(false);
  });

  it('longest rule wins; Allow beats Disallow on ties', () => {
    const groups = parseRobots(
      'User-agent: *\nDisallow: /shop/\nAllow: /shop/public/\n',
    );
    expect(evaluateRobots(groups, UA, '/shop/cart').allowed).toBe(false);
    expect(evaluateRobots(groups, UA, '/shop/public/list').allowed).toBe(true);
  });

  it('supports * wildcards and $ anchors', () => {
    const groups = parseRobots('User-agent: *\nDisallow: /*.pdf$\n');
    expect(evaluateRobots(groups, UA, '/docs/file.pdf').allowed).toBe(false);
    expect(evaluateRobots(groups, UA, '/docs/file.pdf.html').allowed).toBe(true);
  });

  it('parses crawl-delay', () => {
    const groups = parseRobots('User-agent: *\nCrawl-delay: 2\nDisallow: /x\n');
    expect(evaluateRobots(groups, UA, '/y').crawlDelayMs).toBe(2000);
  });

  it('cache treats fetch failures and non-2xx as allow-all', async () => {
    let calls = 0;
    const cache = new RobotsCache(async () => {
      calls++;
      return { status: 404, body: '' };
    }, UA);
    expect((await cache.check('http://example.test/a')).allowed).toBe(true);
    expect((await cache.check('http://example.test/b')).allowed).toBe(true);
    expect(calls).toBe(1); // per-origin cache
  });

  it('ignores comments, blank lines, colon-less lines, and rules before any group', () => {
    const groups = parseRobots(
      '# a comment\n\nDisallow: /orphan\nnonsense line\nUser-agent: *\nDisallow: /x # trailing\n',
    );
    expect(groups).toHaveLength(1);
    expect(evaluateRobots(groups, UA, '/orphan')).toEqual({ allowed: true });
    expect(evaluateRobots(groups, UA, '/x').allowed).toBe(false);
  });

  it('consecutive User-agent lines share one group', () => {
    const groups = parseRobots('User-agent: botA\nUser-agent: botB\nDisallow: /\n');
    expect(groups).toHaveLength(1);
    expect(evaluateRobots(groups, 'botB/1.0', '/anything').allowed).toBe(false);
    expect(evaluateRobots(groups, 'someone-else', '/anything').allowed).toBe(true);
  });

  it('drops invalid crawl-delay values', () => {
    const groups = parseRobots('User-agent: *\nCrawl-delay: soon\nCrawl-delay: -5\n');
    expect(evaluateRobots(groups, UA, '/').crawlDelayMs).toBeUndefined();
  });

  it('a group with no matching rules allows by default', () => {
    const groups = parseRobots('User-agent: *\nDisallow: /admin\n');
    expect(evaluateRobots(groups, UA, '/public').allowed).toBe(true);
  });

  it('only the first wildcard group applies when several exist', () => {
    const groups = parseRobots(
      'User-agent: *\nDisallow: /first\n\nUser-agent: *\nDisallow: /second\n',
    );
    expect(evaluateRobots(groups, UA, '/first').allowed).toBe(false);
    expect(evaluateRobots(groups, UA, '/second').allowed).toBe(true);
  });

  it('a wildcard group after a specific-agent match is ignored', () => {
    const groups = parseRobots(
      'User-agent: mybot\nDisallow: /bot-only\n\nUser-agent: *\nDisallow: /everyone\n',
    );
    expect(evaluateRobots(groups, 'mybot/2.0', '/bot-only').allowed).toBe(false);
    expect(evaluateRobots(groups, 'mybot/2.0', '/everyone').allowed).toBe(true);
  });

  it('a shorter matching rule loses to an earlier longer one', () => {
    const groups = parseRobots('User-agent: *\nDisallow: /shop/items\nAllow: /shop\n');
    expect(evaluateRobots(groups, UA, '/shop/items/1').allowed).toBe(false);
    expect(evaluateRobots(groups, UA, '/shop/other').allowed).toBe(true);
  });

  it('cache treats a throwing fetcher as allow-all', async () => {
    const cache = new RobotsCache(async () => {
      throw new Error('network down');
    }, UA);
    expect((await cache.check('http://example.test/a')).allowed).toBe(true);
  });

  it('cache enforces parsed rules on later checks of the same origin', async () => {
    const cache = new RobotsCache(
      async () => ({ status: 200, body: 'User-agent: *\nDisallow: /private/\n' }),
      UA,
    );
    expect((await cache.check('http://example.test/ok')).allowed).toBe(true);
    expect((await cache.check('http://example.test/private/x')).allowed).toBe(false);
  });
});
