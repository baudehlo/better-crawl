import * as cheerio from 'cheerio';
import type { Page } from 'playwright';

/**
 * Page condensation — the ONLY page representation the LLM ever sees.
 * Not the accessibility tree (huge, hard to parse) and not raw HTML.
 * Output spec (shared by the browser and cheerio implementations):
 *
 *   URL: <current url>
 *
 *   === LINKS ===
 *   <anchor text>: <absolute href>        (deduped; no javascript:/mailto:/#)
 *
 *   === TEXT ===
 *   <main-content text>                   (li[class] prefixed with "[CSS: <classes>] "
 *                                          so status classes like sold-out survive)
 */

export const LINKS_CAP = 15_000;
export const TEXT_CAP = 25_000;

const ROOT_SELECTOR = "main,[role='main'],#content,#main,article";

export function formatCondensed(url: string, links: string, text: string): string {
  return `URL: ${url}\n\n=== LINKS ===\n${links.slice(0, LINKS_CAP)}\n\n=== TEXT ===\n${text
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, TEXT_CAP)}`;
}

/**
 * Browser-side condensation. Annotation text nodes are prepended, read, then
 * removed again — the DOM must never be destructively modified (on React SPAs
 * removed elements are often the mount containers).
 */
export async function condensePage(page: Page): Promise<string> {
  const { url, links, text } = await page.evaluate(
    /* v8 ignore start -- runs inside Chromium, invisible to Node coverage; asserted via integration tests */
    ({ rootSelector }) => {
      const root =
        (document.querySelector(rootSelector) as HTMLElement | null) ?? document.body;

      const added: Text[] = [];
      document.querySelectorAll('li[class]').forEach((li) => {
        const cls = (li.getAttribute('class') ?? '').trim();
        if (cls) {
          const node = document.createTextNode(`[CSS: ${cls}] `);
          li.prepend(node);
          added.push(node);
        }
      });
      const textContent = root.innerText || '';
      added.forEach((node) => node.remove());

      const seen = new Set<string>();
      const lines: string[] = [];
      document.querySelectorAll('a[href]').forEach((a) => {
        const href = (a as HTMLAnchorElement).href;
        if (!href || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
        const label =
          (a.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 120) || '(no text)';
        const line = `${label}: ${href}`;
        if (!seen.has(line)) {
          seen.add(line);
          lines.push(line);
        }
      });

      return { url: location.href, links: lines.join('\n'), text: textContent };
    },
    /* v8 ignore stop */
    { rootSelector: ROOT_SELECTOR },
  );
  return formatCondensed(url, links, text);
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'ul', 'ol', 'tr', 'table', 'section', 'article',
  'header', 'footer', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'form', 'fieldset',
]);
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg']);

/** Cheerio-side condensation of raw HTML — used by probe_no_js and cheerio heals. */
export function condenseHtml(html: string, url: string): string {
  const $ = cheerio.load(html);
  $('li[class]').each((_, el) => {
    const cls = $(el).attr('class')?.trim();
    if (cls) $(el).prepend(`[CSS: ${cls}] `);
  });

  const seen = new Set<string>();
  const lines: string[] = [];
  $('a[href]').each((_, a) => {
    const hrefRaw = $(a).attr('href') ?? '';
    if (!hrefRaw || /^(javascript:|mailto:|#)/.test(hrefRaw)) return;
    let href: string;
    try {
      href = new URL(hrefRaw, url).href;
    } catch {
      return;
    }
    const label = $(a).text().trim().replace(/\s+/g, ' ').slice(0, 120) || '(no text)';
    const line = `${label}: ${href}`;
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  });

  const rootSel = $(ROOT_SELECTOR).first();
  const scope = rootSel.length > 0 ? rootSel : $('body');
  const text = blockAwareText($, scope.get(0));

  return formatCondensed(url, lines.join('\n'), text);
}

/** Minimal structural view of a parsed DOM node — avoids depending on domhandler types. */
interface DomNode {
  type: string;
  data?: string;
  name?: string;
  children?: DomNode[];
}

function blockAwareText(_$: cheerio.CheerioAPI, node: unknown): string {
  if (!node) return '';
  let out = '';
  const walk = (current: DomNode): void => {
    if (current.type === 'text') {
      out += current.data ?? '';
      return;
    }
    if (current.type !== 'tag') return;
    const tag = (current.name ?? '').toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (tag === 'br') {
      out += '\n';
      return;
    }
    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) out += '\n';
    if (tag === 'td' || tag === 'th') out += ' | ';
    for (const child of current.children ?? []) walk(child);
    if (isBlock) out += '\n';
  };
  walk(node as DomNode);
  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Replace secret input values with «secret:name» placeholders in any text bound
 * for the LLM. Values of ≤3 chars are skipped (too collision-prone to scrub).
 */
export function scrubSecrets(text: string, secrets: Record<string, string>): string {
  let scrubbed = text;
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length <= 3) continue;
    scrubbed = scrubbed.split(value).join(`«secret:${name}»`);
  }
  return scrubbed;
}
