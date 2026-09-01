import { describe, expect, it } from 'vitest';
import { buildFailureDigest } from '../src/selftest/digest.js';
import { lintArtifact } from '../src/selftest/lint.js';
import { runSelfTest, type SelfTestResult } from '../src/selftest/selftest.js';
import type { RunReport } from '../src/types.js';
import { makeArtifact } from './helpers/make-artifact.js';

describe('lintArtifact', () => {
  const selectors = {
    itemRow: { css: 'li.item', description: 'rows', expect: 'many' as const },
  };

  it('passes clean code', () => {
    const artifact = makeArtifact(
      { selectors },
      `export default async function crawl(ctx) {
  await ctx.goto(ctx.entryUrl);
  const n = await ctx.count('itemRow');
  ctx.progress('found ' + n);
}
`,
    );
    expect(lintArtifact(artifact)).toEqual([]);
  });

  it('rejects missing export default', () => {
    const artifact = makeArtifact({ selectors }, 'async function crawl(ctx) {}\n');
    expect(lintArtifact(artifact)).toContainEqual(expect.stringContaining('export default'));
  });

  it('rejects import and require', () => {
    const artifact = makeArtifact(
      { selectors },
      `import fs from 'node:fs';
export default async function crawl(ctx) { const x = require('x'); }
`,
    );
    const errors = lintArtifact(artifact);
    expect(errors).toContainEqual(expect.stringContaining('import'));
    expect(errors).toContainEqual(expect.stringContaining('require'));
  });

  it('rejects unknown selector names in ctx helpers', () => {
    const artifact = makeArtifact(
      { selectors },
      `export default async function crawl(ctx) { await ctx.click('nextPage'); }\n`,
    );
    expect(lintArtifact(artifact)).toContainEqual(expect.stringContaining('"nextPage"'));
  });

  it('rejects raw CSS passed to named-selector helpers', () => {
    const artifact = makeArtifact(
      { selectors },
      `export default async function crawl(ctx) { const t = await ctx.text('li.item > a'); }\n`,
    );
    expect(lintArtifact(artifact)).toContainEqual(expect.stringContaining('raw CSS'));
  });

  it('rejects unknown selector names in ctx.select', () => {
    const artifact = makeArtifact(
      { selectors },
      `export default async function crawl(ctx) {
  const page = await ctx.fetch(ctx.entryUrl);
  ctx.select(page, 'mysteryRows').each(() => {});
}
`,
    );
    expect(lintArtifact(artifact)).toContainEqual(expect.stringContaining('"mysteryRows"'));
  });

  it('rejects direct DOM queries', () => {
    const artifact = makeArtifact(
      { selectors },
      `export default async function crawl(ctx) {
  await ctx.page.evaluate(() => document.querySelector('.x'));
}
`,
    );
    expect(lintArtifact(artifact)).toContainEqual(expect.stringContaining('DOM directly'));
  });
});

describe('buildFailureDigest', () => {
  const baseReport: RunReport = {
    ok: false,
    itemCounts: { product: 2, session: 0 },
    invalidItems: [
      {
        schema: 'product',
        issues: [
          { code: 'custom', path: ['price'], message: 'expected number, got string', input: '$4.99' },
        ] as never,
        raw: { name: 'x', price: '$4.99' },
      },
      {
        schema: 'product',
        issues: [
          { code: 'custom', path: ['price'], message: 'expected number, got string', input: '$5.99' },
        ] as never,
        raw: { name: 'y', price: '$5.99' },
      },
    ],
    assertionFailures: [
      { assertion: { kind: 'minItems', schema: 'session', min: 12 }, actual: '0 valid item(s)' },
    ],
    runtimeError: {
      message: 'Selector "sessionRow" (li.session) matched 0 elements on http://x/schedule',
      stack:
        'NoMatchError: ...\n    at crawl (file:///tmp/better-crawl/crawl-a1b2c3d4.mjs:14:9)\n    at run (...)',
      failedSelector: 'sessionRow',
    },
    pagesVisited: 5,
    durationMs: 1234,
    progressTrail: ['logged in', 'loaded 61 items'],
  };

  it('summarizes lint failures without a report', () => {
    const result: SelfTestResult = { passed: false, lintErrors: ['no export default'] };
    const digest = buildFailureDigest(result, { attempt: 1, maxAttempts: 3 });
    expect(digest).toContain('attempt 1/3');
    expect(digest).toContain('no export default');
    expect(digest).toContain('was not run');
  });

  it('includes error, module stack frame, counts, assertions, grouped issues, and trail', () => {
    const result: SelfTestResult = { passed: false, lintErrors: [], report: baseReport };
    const digest = buildFailureDigest(result, {
      attempt: 2,
      maxAttempts: 3,
      freshPage: 'URL: http://x/schedule\n=== LINKS ===\n...',
    });
    expect(digest).toContain('SELF-TEST FAILED (attempt 2/3)');
    expect(digest).toContain('matched 0 elements');
    expect(digest).toContain('crawl-a1b2c3d4.mjs:14:9');
    expect(digest).toContain('Failed selector name: "sessionRow"');
    expect(digest).toContain('product: 2 valid / 2 invalid');
    expect(digest).toContain('session: 0');
    expect(digest).toContain('"kind":"minItems"');
    expect(digest).toContain('×2');
    expect(digest).toContain('logged in → loaded 61 items → ✖');
    expect(digest).toContain('Fresh page (condensed)');
    // compact: well under the ~2k token guideline
    expect(digest.length).toBeLessThan(8000);
  });

  it('returns just the header when there is no report and no lint errors', () => {
    const digest = buildFailureDigest({ passed: false, lintErrors: [] }, { attempt: 1, maxAttempts: 2 });
    expect(digest).toBe('SELF-TEST FAILED (attempt 1/2)');
  });

  it('reports "(none)" for empty item counts and survives unstringifiable raw samples', () => {
    const circular: Record<string, unknown> = { schema: 'oops' };
    circular['self'] = circular;
    const report: RunReport = {
      ok: false,
      itemCounts: {},
      invalidItems: [
        {
          schema: 'product',
          issues: [{ code: 'custom', path: ['x'], message: 'bad', input: 1 }] as never,
          raw: circular,
        },
        {
          schema: 'product',
          issues: [
            { code: 'custom', path: ['x'], message: 'bad', input: 1 },
            { code: 'custom', path: ['y'], message: 'also bad', input: 2 },
          ] as never,
          raw: { y: 2 },
        },
      ],
      assertionFailures: [],
      pagesVisited: 0,
      durationMs: 10,
      progressTrail: [],
    };
    const digest = buildFailureDigest(
      { passed: false, lintErrors: [], report },
      { attempt: 1, maxAttempts: 1 },
    );
    expect(digest).toContain('Items: (none)');
    // the repeated issue ranks first, the singleton after it
    const xIndex = digest.indexOf('product.x — bad ×2');
    const yIndex = digest.indexOf('product.y — also bad ×1');
    expect(xIndex).toBeGreaterThan(-1);
    expect(yIndex).toBeGreaterThan(xIndex);
  });
});

describe('runSelfTest', () => {
  it('fails on lint errors without running the code', async () => {
    const artifact = makeArtifact({}, 'not even a module');
    const result = await runSelfTest(artifact, {});
    expect(result.passed).toBe(false);
    expect(result.lintErrors.length).toBeGreaterThan(0);
    expect(result.report).toBeUndefined();
  });

  it('runs the artifact live and reports success', async () => {
    const artifact = makeArtifact(
      {},
      `export default async function crawl(ctx) { ctx.progress('did nothing'); }\n`,
    );
    const result = await runSelfTest(artifact, { limits: { delayMs: 0 } });
    expect(result.lintErrors).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.report?.ok).toBe(true);
  });
});
