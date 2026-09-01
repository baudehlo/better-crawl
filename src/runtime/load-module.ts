import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ArtifactFormatError } from '../errors.js';

export type CrawlFn = (ctx: unknown) => Promise<unknown>;

/**
 * Write the artifact's code to a content-hashed temp file, without importing
 * it. The sandbox path uses this: the parent writes, the child (which cannot
 * write anywhere) imports.
 */
export async function writeCrawlModule(code: string, moduleDir?: string): Promise<string> {
  let dir = moduleDir ?? path.join(os.tmpdir(), 'better-crawl');
  await mkdir(dir, { recursive: true });
  // Canonical path: the sandboxed child may not traverse symlinks outside its
  // fs allowlist (macOS tmpdir lives behind the /var → /private/var symlink).
  dir = realpathSync(dir);
  const hash = createHash('sha256').update(code).digest('hex').slice(0, 16);
  const file = path.join(dir, `crawl-${hash}.mjs`);
  await writeFile(file, code, 'utf8');
  return file;
}

/**
 * Write the artifact's code to a content-hashed temp file and import it.
 *
 * A real file (vs new AsyncFunction) gives stack traces whose file:line map 1:1
 * to the artifact's code string — the repair loop depends on that signal — and
 * lets users attach a debugger. Content-hashed names sidestep the ESM module
 * cache: changed code gets a fresh URL, identical code reuses the cached module
 * (harmless — the export is a pure function).
 */
export async function loadCrawlModule(
  code: string,
  moduleDir?: string,
): Promise<{ fn: CrawlFn; file: string }> {
  const file = await writeCrawlModule(code, moduleDir);

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (err) {
    throw new ArtifactFormatError(
      `Artifact code failed to load as an ES module: ${(err as Error).message}`,
    );
  }
  const fn = mod['default'];
  if (typeof fn !== 'function') {
    throw new ArtifactFormatError(
      'Artifact code must `export default` an async crawl(ctx) function',
    );
  }
  return { fn: fn as CrawlFn, file };
}
