import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { executeArtifact } from '../../src/runtime/execute.js';
import { runSelfTest } from '../../src/selftest/selftest.js';
import { makeArtifact } from '../helpers/make-artifact.js';
import { startStaticStore } from '../fixtures/sites/static-store.js';
import type { FixtureSite } from '../fixtures/sites/server.js';

const FAST = { delayMs: 0 };
const productSchema = z.object({ name: z.string(), note: z.string().optional() });

describe('executeArtifact assertions & limits', () => {
  let store: FixtureSite;
  beforeAll(async () => {
    store = await startStaticStore();
  });
  afterAll(async () => {
    await store?.close();
  });

  const FETCH_CODE = `export default async function crawl(ctx) {
  await ctx.screenshot('no-op on cheerio');
  const page = await ctx.fetch(ctx.entryUrl);
  ctx.select(page, 'row').each((i, el) => {
    ctx.emit('product', { name: page.$(el).find('a').text().trim() });
  });
}
`;

  it('urlReached passes when a visited URL matches and fails otherwise', async () => {
    const reached = makeArtifact(
      {
        entryUrl: `${store.url}/`,
        selectors: { row: { css: 'li.product', description: 'rows', expect: 'many' } },
        assertions: [{ kind: 'urlReached', pattern: '/$' }],
      },
      FETCH_CODE,
    );
    const ok = await executeArtifact(reached, { schemas: { product: productSchema }, limits: FAST });
    expect(ok.report.ok).toBe(true);

    const unreached = makeArtifact(
      {
        entryUrl: `${store.url}/`,
        selectors: { row: { css: 'li.product', description: 'rows', expect: 'many' } },
        assertions: [{ kind: 'urlReached', pattern: '/checkout/complete' }],
      },
      FETCH_CODE,
    );
    const bad = await executeArtifact(unreached, { schemas: { product: productSchema }, limits: FAST });
    expect(bad.report.ok).toBe(false);
    expect(bad.report.assertionFailures[0]?.actual).toContain('visited:');
  });

  it('urlReached reports "(no pages)" when nothing was visited', async () => {
    const artifact = makeArtifact(
      { assertions: [{ kind: 'urlReached', pattern: 'anywhere' }] },
      'export default async function crawl(ctx) {}\n',
    );
    const { report } = await executeArtifact(artifact, { limits: FAST });
    expect(report.assertionFailures[0]?.actual).toBe('visited: (no pages)');
  });

  it('fieldCoverage fails below the ratio and is skipped with zero items', async () => {
    const sparse = makeArtifact(
      {
        entryUrl: `${store.url}/`,
        selectors: { row: { css: 'li.product', description: 'rows', expect: 'many' } },
        assertions: [
          { kind: 'fieldCoverage', schema: 'product', field: 'note', minRatio: 0.9 },
          { kind: 'fieldCoverage', schema: 'ghostSchema', field: 'x', minRatio: 0.9 },
        ],
      },
      FETCH_CODE,
    );
    const { report } = await executeArtifact(sparse, {
      schemas: { product: productSchema },
      limits: FAST,
    });
    expect(report.ok).toBe(false);
    // only the populated schema produces a coverage failure
    expect(report.assertionFailures).toHaveLength(1);
    expect(report.assertionFailures[0]?.actual).toContain('0/6 items have note');
  });

  it('maxDurationMs fails when the crawl takes too long', async () => {
    const artifact = makeArtifact(
      { assertions: [{ kind: 'maxDurationMs', ms: 1 }] },
      'export default async function crawl(ctx) { await ctx.sleep(30); }\n',
    );
    const { report } = await executeArtifact(artifact, { limits: FAST });
    expect(report.ok).toBe(false);
    expect(report.assertionFailures[0]?.actual).toMatch(/^\d+ms$/);
  });

  it('records the selector name when generated code asks for an unknown selector', async () => {
    const artifact = makeArtifact(
      {},
      'export default async function crawl(ctx) { ctx.sel("mystery"); }\n',
    );
    const { report } = await executeArtifact(artifact, { limits: FAST });
    expect(report.ok).toBe(false);
    expect(report.runtimeError?.failedSelector).toBe('mystery');
  });

  it('wraps non-Error throws from generated code into the report', async () => {
    const artifact = makeArtifact({}, "export default async function crawl() { throw 'string bomb'; }\n");
    const { report } = await executeArtifact(artifact, { limits: FAST });
    expect(report.ok).toBe(false);
    expect(report.runtimeError?.message).toBe('string bomb');
  });

  it('aborts a stuck crawl at the wall-clock timeout', async () => {
    const artifact = makeArtifact({}, 'export default async function crawl(ctx) { await ctx.sleep(60000); }\n');
    const { report } = await executeArtifact(artifact, {
      limits: { delayMs: 0, timeoutMs: 50 },
    });
    expect(report.ok).toBe(false);
    expect(report.runtimeError?.message).toContain('wall-clock timeout of 50ms');
  });

  it('runSelfTest surfaces the captured failure page on a cheerio runtime error', async () => {
    const artifact = makeArtifact(
      {
        entryUrl: `${store.url}/`,
        selectors: { row: { css: 'li.product', description: 'rows', expect: 'many' } },
      },
      `export default async function crawl(ctx) {
  await ctx.fetch(ctx.entryUrl);
  throw new Error('deliberate failure after the first page');
}
`,
    );
    const result = await runSelfTest(artifact, { limits: FAST });
    expect(result.passed).toBe(false);
    expect(result.report?.runtimeError?.message).toContain('deliberate failure');
    expect(result.failurePage).toContain('Static Store');
  });
});
