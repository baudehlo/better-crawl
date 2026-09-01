import { fork } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Artifact } from '../artifact.js';
import type { CrawlEvent } from '../events.js';
import type { PageFetcher } from '../runtime/ctx-cheerio.js';
import { EarlyStop, type SharedRuntime } from '../runtime/ctx-shared.js';
import { buildLaunchOptions, type ResolvedRetry } from '../runtime/net.js';
import type { RunReport } from '../types.js';
import type { BrowserOptions, ProxyOptions } from '../types.js';
import type { ChildMessage, SandboxInit } from './protocol.js';

export interface SandboxRunOptions {
  moduleFile: string;
  inputs: Record<string, string>;
  limits: { maxPages: number; delayMs: number; maxItems?: number };
  pageEvents: boolean;
  screenshots: boolean;
  screenshotDir?: string | undefined;
  headless: boolean;
  userAgent: string;
  headers?: Record<string, string> | undefined;
  proxy?: ProxyOptions | undefined;
  browser?: BrowserOptions | undefined;
  retry: ResolvedRetry;
  signal: AbortSignal;
}

export interface SandboxDeps {
  shared: SharedRuntime;
  /** Parent-side network for the cheerio engine (cookie jar, proxy, retries). */
  fetcher: PageFetcher;
  emitEvent: (event: CrawlEvent) => void;
}

export interface SandboxOutcomeResult {
  runtimeError?: RunReport['runtimeError'];
  failurePage?: string;
}

/**
 * Execute an artifact in a locked-down child process. The child gets a clean
 * environment (no secrets) and Node's permission model: read-only fs limited
 * to the artifact module + this package + node_modules, no child processes,
 * no workers, no native addons. All authority — network, gates, validation —
 * stays in this process and is reached over IPC.
 */
export async function runSandboxed(
  artifact: Artifact,
  opts: SandboxRunOptions,
  deps: SandboxDeps,
): Promise<SandboxOutcomeResult> {
  const runner = resolveRunnerPath();
  let browserServer: { wsEndpoint(): string; close(): Promise<void> } | undefined;

  if (artifact.manifest.engine === 'playwright') {
    const pw = await import('playwright');
    browserServer = await pw.chromium.launchServer(
      buildLaunchOptions(opts.headless, opts.browser, opts.proxy),
    );
  }

  const child = fork(runner, [], {
    execArgv: permissionFlags(path.dirname(opts.moduleFile)),
    env: {},
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const stderrTail: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail.push(chunk.toString());
    if (stderrTail.length > 20) stderrTail.shift();
  });

  let screenshotIndex = 0;
  let settled = false;

  try {
    return await new Promise<SandboxOutcomeResult>((resolve) => {
      const settle = (result: SandboxOutcomeResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const onAbort = (): void => {
        child.kill('SIGKILL');
        const reason = opts.signal.reason;
        settle({
          runtimeError: {
            message: reason instanceof Error ? reason.message : String(reason ?? 'aborted'),
            stack: reason instanceof Error ? (reason.stack ?? '') : '',
          },
        });
      };
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => settle({ runtimeError: { message: `sandbox runner failed to start: ${err.message}`, stack: err.stack ?? '' } }));
      child.on('exit', (code, sig) => {
        settle({
          runtimeError: {
            message:
              `sandbox runner exited unexpectedly (code=${code} signal=${sig}). ` +
              `${stderrTail.join('').slice(-1_000) || '(no stderr)'} — pass noSandbox: true to bypass sandboxing if your environment cannot spawn it`,
            stack: '',
          },
        });
      });

      child.on('message', (message: ChildMessage) => {
        void handleMessage(message).catch(() => undefined);
      });

      const handleMessage = async (message: ChildMessage): Promise<void> => {
        switch (message.type) {
          case 'ready': {
            const init: SandboxInit = {
              type: 'init',
              code: artifact.code,
              moduleFile: opts.moduleFile,
              manifest: artifact.manifest,
              inputs: opts.inputs,
              limits: opts.limits,
              pageEvents: opts.pageEvents,
              screenshots: opts.screenshots,
              userAgent: opts.userAgent,
              ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
              ...(opts.proxy?.ignoreTlsErrors ? { ignoreTlsErrors: true } : {}),
              retry: opts.retry,
              ...(browserServer ? { wsEndpoint: browserServer.wsEndpoint() } : {}),
            };
            child.send(init);
            return;
          }
          case 'rpc': {
            try {
              if (message.method === 'gate') {
                await deps.shared.gate(message.params.url);
                child.send({ type: 'rpc-result', id: message.id, ok: true });
              } else {
                const value = await deps.fetcher.request(message.params.url, message.params.init);
                child.send({ type: 'rpc-result', id: message.id, ok: true, value });
              }
            } catch (err) {
              child.send({
                type: 'rpc-result',
                id: message.id,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            return;
          }
          case 'notify': {
            switch (message.kind) {
              case 'item':
                try {
                  deps.shared.emitItem(message.schema, message.item);
                } catch (err) {
                  // EarlyStop: the child tracks its own cap and stops itself.
                  if (!(err instanceof EarlyStop)) throw err;
                }
                return;
              case 'visit':
                deps.shared.recordVisit(message.url);
                return;
              case 'progress':
                deps.shared.trackProgress(message.message, message.pct);
                return;
              case 'log':
                deps.emitEvent({ type: 'log', level: message.level, message: message.message });
                return;
              case 'page':
                deps.shared.emitPage(message.url, message.html);
                return;
              case 'screenshot': {
                const buffer = Buffer.from(message.base64, 'base64');
                if (opts.screenshotDir) {
                  await mkdir(opts.screenshotDir, { recursive: true });
                  const file = path.join(
                    opts.screenshotDir,
                    `${String(screenshotIndex++).padStart(3, '0')}-${message.label.replace(/[^\w.-]+/g, '_')}.png`,
                  );
                  await writeFile(file, buffer);
                  deps.emitEvent({ type: 'screenshot', label: message.label, path: file });
                } else {
                  deps.emitEvent({ type: 'screenshot', label: message.label, buffer });
                }
                return;
              }
            }
            return;
          }
          case 'done':
            settle({});
            return;
          case 'crash':
            settle({
              runtimeError: message.error,
              ...(message.failurePage !== undefined ? { failurePage: message.failurePage } : {}),
            });
            return;
        }
      };
    });
  } finally {
    if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
    await browserServer?.close().catch(() => undefined);
  }
}

/** Walk up from this file to the package root (works from both src/ and dist/). */
function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('better-crawl package root not found');
}

function resolveRunnerPath(): string {
  const root = packageRoot();
  const candidates = [
    path.join(root, 'dist', 'sandbox', 'sandbox-runner.mjs'),
    path.join(root, 'dist', 'sandbox-runner.mjs'),
  ];
  const runner = candidates.find((c) => existsSync(c));
  if (!runner) {
    throw new Error(
      `sandbox runner not found (looked in ${candidates.join(', ')}) — build better-crawl (npm run build), or pass noSandbox: true`,
    );
  }
  return runner;
}

/**
 * Node permission-model flags: read-only fs limited to what the runner needs
 * (this package, its resolvable deps' node_modules roots, and the artifact
 * module dir). child_process / workers / addons stay blocked by default.
 */
function permissionFlags(moduleDir: string): string[] {
  const major = Number(process.versions.node.split('.')[0]);
  const flag = major >= 23 ? '--permission' : '--experimental-permission';

  // The permission model matches canonical paths — resolve symlinks (macOS
  // tmpdir lives under /var → /private/var) or the allowlist silently misses.
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const roots = new Set<string>([real(packageRoot()), real(moduleDir)]);
  const require = createRequire(import.meta.url);
  for (const dep of ['cheerio', 'undici', 'playwright']) {
    try {
      const resolved = real(require.resolve(dep));
      const marker = `${path.sep}node_modules${path.sep}`;
      const idx = resolved.lastIndexOf(marker);
      if (idx !== -1) roots.add(resolved.slice(0, idx + marker.length - 1));
    } catch {
      // optional dep (playwright) — fine
    }
  }
  // A bare path is an exact-file grant, so directory trees need the wildcard —
  // and each grant needs its own flag (comma lists are not reliably parsed).
  return [flag, ...[...roots].map((root) => `--allow-fs-read=${root}${path.sep}*`)];
}
