import { describe, expect, it } from 'vitest';
import { condenseHtml, formatCondensed, LINKS_CAP, scrubSecrets, TEXT_CAP } from '../src/llm/condense.js';

const SAMPLE = `<!doctype html><html><head><title>t</title>
<style>.x{color:red}</style><script>var hidden = 'nope';</script></head>
<body>
<nav><a href="/about">About</a></nav>
<main>
  <h1>Camp Sessions</h1>
  <ul>
    <li class="session sold-out"><a href="/s/1">Week One</a><span>$100</span></li>
    <li class="session available"><a href="/s/2">Week Two</a><span>$120</span></li>
  </ul>
  <table><tr><td>Ages</td><td>5-7</td></tr></table>
  <a href="javascript:void(0)">js link</a>
  <a href="mailto:a@b.c">mail</a>
  <a href="/s/1">Week One</a>
</main>
</body></html>`;

describe('condenseHtml', () => {
  const out = condenseHtml(SAMPLE, 'https://example.com/list');

  it('produces the URL / LINKS / TEXT sections', () => {
    expect(out).toMatch(/^URL: https:\/\/example\.com\/list\n\n=== LINKS ===\n/);
    expect(out).toContain('\n\n=== TEXT ===\n');
  });

  it('absolutizes and dedupes links, dropping javascript:/mailto:', () => {
    expect(out).toContain('Week One: https://example.com/s/1');
    expect(out).toContain('Week Two: https://example.com/s/2');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('mailto:');
    expect(out.match(/Week One: https:\/\/example\.com\/s\/1/g)).toHaveLength(1);
  });

  it('annotates li[class] so status classes survive text extraction', () => {
    expect(out).toContain('[CSS: session sold-out] Week One');
    expect(out).toContain('[CSS: session available] Week Two');
  });

  it('keeps block structure (headings on own lines, table cells piped)', () => {
    const text = out.split('=== TEXT ===')[1]!;
    expect(text).toContain('\nCamp Sessions\n');
    expect(text).toContain('| Ages');
    expect(text).toContain('| 5-7');
  });

  it('drops script/style content and out-of-main nav text', () => {
    const text = out.split('=== TEXT ===')[1]!;
    expect(text).not.toContain('hidden');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('About'); // nav is outside <main>
  });

  it('renders <br> as a line break and skips unparseable hrefs', () => {
    const result = condenseHtml(
      '<body><p>line one<br>line two</p><a href="http://[bad">broken</a></body>',
      'https://example.com/',
    );
    const text = result.split('=== TEXT ===')[1]!;
    expect(text).toContain('line one\nline two');
    expect(result).not.toContain('broken:');
  });

  it('falls back to <body> when no main-content root exists', () => {
    const result = condenseHtml(
      '<body><p>free-floating text</p></body>',
      'https://example.com/',
    );
    expect(result).toContain('free-floating text');
  });

  it('labels anchors without text as (no text)', () => {
    const result = condenseHtml(
      '<body><main><a href="/x"><img src="i.png"></a></main></body>',
      'https://example.com/',
    );
    expect(result).toContain('(no text): https://example.com/x');
  });
});

describe('formatCondensed caps', () => {
  it('caps links and text independently', () => {
    const out = formatCondensed('u', 'L'.repeat(LINKS_CAP + 500), 'T'.repeat(TEXT_CAP + 500));
    const links = out.split('=== LINKS ===\n')[1]!.split('\n\n=== TEXT ===')[0]!;
    const text = out.split('=== TEXT ===\n')[1]!;
    expect(links.length).toBe(LINKS_CAP);
    expect(text.length).toBe(TEXT_CAP);
  });
});

describe('scrubSecrets', () => {
  it('replaces secret values with named placeholders', () => {
    const scrubbed = scrubSecrets('password=hunter2 and again hunter2', {
      password: 'hunter2',
    });
    expect(scrubbed).toBe('password=«secret:password» and again «secret:password»');
  });

  it('skips values too short to scrub safely', () => {
    expect(scrubSecrets('pin is 123', { pin: '123' })).toBe('pin is 123');
  });
});
