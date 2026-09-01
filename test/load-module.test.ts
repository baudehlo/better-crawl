import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArtifactFormatError } from '../src/errors.js';
import { loadCrawlModule } from '../src/runtime/load-module.js';

describe('loadCrawlModule', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'bc-load-module-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads valid code and returns the default export', async () => {
    const { fn, file } = await loadCrawlModule(
      'export default async function crawl(ctx) { return "ran"; }\n',
      dir,
    );
    expect(file).toContain(dir);
    await expect(fn({})).resolves.toBe('ran');
  });

  it('reuses the same content-hashed file for identical code', async () => {
    const code = 'export default async function crawl() { return 1; }\n';
    const first = await loadCrawlModule(code, dir);
    const second = await loadCrawlModule(code, dir);
    expect(second.file).toBe(first.file);
  });

  it('wraps syntax errors in ArtifactFormatError', async () => {
    await expect(loadCrawlModule('export default function {{{', dir)).rejects.toThrow(
      ArtifactFormatError,
    );
  });

  it('rejects modules without a default function export', async () => {
    await expect(loadCrawlModule('export const notDefault = 1;\n', dir)).rejects.toThrow(
      /export default/,
    );
  });
});
