import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CrawlEvent } from '../../src/events.js';
import { executeArtifact } from '../../src/runtime/execute.js';
import { startStaticStore } from '../fixtures/sites/static-store.js';
import type { FixtureSite } from '../fixtures/sites/server.js';
import { makeArtifact } from '../helpers/make-artifact.js';

const hasBrowser = await (async () => {
  try {
    const pw = await import('playwright');
    const browser = await pw.chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
})();

const FAST = { delayMs: 0 };
const probeSchema = z.object({ value: z.string() });

/** Run a hostile/probing artifact and return what it managed to observe. */
async function probe(code: string) {
  const artifact = makeArtifact({ entryUrl: 'https://example.invalid/' }, code);
  return executeArtifact(artifact, { schemas: { probe: probeSchema }, limits: FAST });
}

describe('sandboxed execution (default)', () => {
  it('gives artifact code a clean environment — no parent secrets', async () => {
    process.env['BC_TEST_SECRET'] = 'super-secret-value';
    try {
      const { report, items } = await probe(`export default async function crawl(ctx) {
  ctx.emit('probe', { value: String(globalThis.process?.env?.BC_TEST_SECRET ?? 'ENV-EMPTY') });
}
`);
      expect(report.runtimeError).toBeUndefined();
      expect(items['probe']?.[0]).toEqual({ value: 'ENV-EMPTY' });
    } finally {
      delete process.env['BC_TEST_SECRET'];
    }
  });

  it('blocks filesystem reads outside the allowlist', async () => {
    const { report } = await probe(`export default async function crawl(ctx) {
  const fs = await import('node:fs');
  ctx.emit('probe', { value: fs.readFileSync('/etc/hosts', 'utf8').slice(0, 10) });
}
`);
    expect(report.runtimeError?.message).toMatch(/restricted|ERR_ACCESS_DENIED|denied/i);
  });

  it('blocks spawning child processes', async () => {
    const { report } = await probe(`export default async function crawl(ctx) {
  const cp = await import('node:child_process');
  ctx.emit('probe', { value: cp.execSync('id').toString() });
}
`);
    expect(report.runtimeError?.message).toMatch(/restricted|ERR_ACCESS_DENIED|denied/i);
  });

  it('noSandbox: true opts back into in-process execution', async () => {
    process.env['BC_TEST_SECRET'] = 'visible-in-process';
    try {
      const artifact = makeArtifact(
        { entryUrl: 'https://example.invalid/' },
        `export default async function crawl(ctx) {
  ctx.emit('probe', { value: String(process.env.BC_TEST_SECRET) });
}
`,
      );
      const { report, items } = await executeArtifact(artifact, {
        schemas: { probe: probeSchema },
        limits: FAST,
        noSandbox: true,
      });
      expect(report.runtimeError).toBeUndefined();
      expect(items['probe']?.[0]).toEqual({ value: 'visible-in-process' });
    } finally {
      delete process.env['BC_TEST_SECRET'];
    }
  });
});

describe.skipIf(!hasBrowser)('sandboxed playwright screenshots', () => {
  let store: FixtureSite;
  let dir: string;

  beforeAll(async () => {
    store = await startStaticStore();
    dir = await mkdtemp(path.join(os.tmpdir(), 'bc-sbx-shots-'));
  });
  afterAll(async () => {
    await store?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('streams screenshot buffers to the parent, which writes the files', async () => {
    const artifact = makeArtifact(
      { engine: 'playwright', entryUrl: `${store.url}/` },
      `export default async function crawl(ctx) {
  await ctx.goto(ctx.entryUrl);
  await ctx.screenshot('front page');
}
`,
    );
    const events: CrawlEvent[] = [];
    const { report } = await executeArtifact(artifact, {
      limits: FAST,
      screenshots: true,
      screenshotDir: dir,
      emitEvent: (e) => events.push(e),
    });
    expect(report.runtimeError).toBeUndefined();
    const shot = events.find((e) => e.type === 'screenshot');
    expect(shot).toMatchObject({ label: 'front page' });
    expect((shot as { path?: string }).path).toContain(dir);
    const files = await readdir(dir);
    expect(files.some((f) => f.endsWith('.png'))).toBe(true);
  });
});
