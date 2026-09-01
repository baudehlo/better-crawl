/**
 * Sandbox runner — the child-process entry that executes artifact code.
 *
 * Spawned by executeArtifact with a clean environment and Node's permission
 * model (read-only fs limited to code + node_modules, no child processes, no
 * workers). Everything with authority stays in the parent: network + cookie
 * jar, robots/budget/politeness gates, zod validation, the report. This
 * process holds only pure-JS capabilities (cheerio parsing, the playwright
 * websocket client) plus RPC bridges to the parent.
 */
import { pathToFileURL } from 'node:url';
import type { SelectorDef } from '../artifact.js';
import { NoMatchError, UnknownSelectorError } from '../errors.js';
import type { CrawlEvent } from '../events.js';
import { condenseHtml, condensePage } from '../llm/condense.js';
import type { PageFetcher } from '../runtime/ctx-cheerio.js';
import { createCheerioCtx } from '../runtime/ctx-cheerio.js';
import {
  EarlyStop,
  resolveInput,
  type CtxBase,
  type EngineRuntime,
} from '../runtime/ctx-shared.js';
import { createValidator } from '../runtime/validate.js';
import type {
  ChildMessage,
  ParentMessage,
  RpcMethod,
  SandboxInit,
  SandboxNotify,
} from './protocol.js';

const send = (message: ChildMessage): void => {
  process.send?.(message);
};
/** For lifecycle messages: resolves once the message is flushed to the IPC pipe. */
const sendAndFlush = (message: ChildMessage): Promise<void> =>
  new Promise((resolve) => {
    if (!process.send) return resolve();
    process.send(message, () => resolve());
  });

/** Omit distributed over a union — keeps SandboxNotify's discriminated variants intact. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
const notify = (n: DistributiveOmit<SandboxNotify, 'type'>): void => {
  send({ type: 'notify', ...n } as SandboxNotify);
};

// ── RPC to the parent ─────────────────────────────────────────────────────────

let nextRpcId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function rpc<T>(method: RpcMethod, params: { url: string; init?: unknown }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextRpcId++;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    send({ type: 'rpc', id, method, params } as ChildMessage);
  });
}

// ── The child-side EngineRuntime ──────────────────────────────────────────────

function createRemoteRuntime(init: SandboxInit) {
  // Local validation uses the manifest's JSON Schema copies — it only drives
  // the artifact's sync ctx.emit() return value and the maxItems stop. The
  // parent re-validates every item with the caller's real zod schemas.
  const validator = createValidator(undefined, init.manifest.schemas);
  let totalItems = 0;

  const runtime: EngineRuntime = {
    pageEvents: init.pageEvents,
    lastPage: undefined,
    selDef(name: string): SelectorDef {
      const def = init.manifest.selectors[name];
      if (!def) throw new UnknownSelectorError(name);
      return def;
    },
    gate: (url) => rpc<void>('gate', { url }),
    recordVisit: (url) => notify({ kind: 'visit', url }),
    throwIfAborted: () => {
      // Aborts arrive as SIGKILL from the parent; nothing to check here.
    },
    abortableSleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    emitEvent: (event: CrawlEvent) => {
      switch (event.type) {
        case 'progress':
          notify({ kind: 'progress', message: event.message, ...(event.pct !== undefined ? { pct: event.pct } : {}) });
          return;
        case 'log':
          notify({ kind: 'log', level: event.level, message: event.message });
          return;
        case 'screenshot':
          if (event.buffer) notify({ kind: 'screenshot', label: event.label, base64: event.buffer.toString('base64') });
          return;
        case 'page':
          notify({ kind: 'page', url: event.url, html: event.html });
          return;
        default:
          // item/invalid-item are produced authoritatively by the parent.
          return;
      }
    },
    emitPage: (url, html) => notify({ kind: 'page', url, html }),
    createCtxBase(screenshot: (label: string) => Promise<void>): CtxBase {
      return {
        entryUrl: init.manifest.entryUrl,
        emit: (schemaName, item) => {
          // The parent gets every item, valid-looking or not, and judges with zod.
          notify({ kind: 'item', schema: schemaName, item });
          // No JSON Schema copy to check against → benefit of the doubt; the
          // sync return and the maxItems cap are control-flow, not authority.
          const ok =
            init.manifest.schemas[schemaName] === undefined ? true : validator.validate(schemaName, item).ok;
          if (ok) {
            totalItems += 1;
            if (init.limits.maxItems !== undefined && totalItems >= init.limits.maxItems) {
              throw new EarlyStop();
            }
          }
          return ok;
        },
        input: (name) => resolveInput(init.manifest.inputs, init.inputs, name),
        sel: (name) => runtime.selDef(name).css,
        progress: (message, pct) => notify({ kind: 'progress', message, ...(pct !== undefined ? { pct } : {}) }),
        log: (level, message) => notify({ kind: 'log', level, message }),
        screenshot,
        sleep: (ms) => runtime.abortableSleep(ms),
      };
    },
  };
  return runtime;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(init: SandboxInit): Promise<void> {
  const runtime = createRemoteRuntime(init);
  let ctx: unknown;
  let cleanup: (() => Promise<void>) | undefined;
  let livePage: import('playwright').Page | undefined;

  if (init.manifest.engine === 'cheerio') {
    const fetcher: PageFetcher = {
      request: (url, reqInit) => rpc('fetch', { url, ...(reqInit !== undefined ? { init: reqInit } : {}) }),
    };
    ctx = createCheerioCtx(runtime, fetcher);
  } else {
    const { createPlaywrightSession } = await import('../runtime/ctx-playwright.js');
    const session = await createPlaywrightSession(runtime, {
      userAgent: init.userAgent,
      headless: true, // irrelevant when connecting — the parent launched the server
      screenshots: init.screenshots, // no screenshotDir here: buffers stream to the parent
      ...(init.wsEndpoint !== undefined ? { connectWsEndpoint: init.wsEndpoint } : {}),
      ...(init.headers !== undefined ? { headers: init.headers } : {}),
      // Only ignoreTlsErrors matters for the browser context; the proxy itself
      // was applied when the parent launched the browser server.
      ...(init.ignoreTlsErrors ? { proxy: { server: 'applied-at-launch', ignoreTlsErrors: true } } : {}),
      retry: init.retry,
    });
    ctx = session.ctx;
    livePage = session.page;
    cleanup = session.close;
  }

  const mod = (await import(pathToFileURL(init.moduleFile).href)) as Record<string, unknown>;
  const fn = mod['default'];
  if (typeof fn !== 'function') {
    throw new Error('Artifact code must `export default` an async crawl(ctx) function');
  }

  try {
    await (fn as (c: unknown) => Promise<unknown>)(ctx);
    await sendAndFlush({ type: 'done' });
  } catch (err) {
    if (err instanceof EarlyStop) {
      await sendAndFlush({ type: 'done' });
      return;
    }
    const error = err instanceof Error ? err : new Error(String(err));
    const failurePage = await captureFailurePage(livePage, runtime).catch(() => undefined);
    await sendAndFlush({
      type: 'crash',
      error: {
        message: error.message,
        stack: error.stack ?? '',
        ...(error instanceof NoMatchError || error instanceof UnknownSelectorError
          ? { failedSelector: error.selectorName }
          : {}),
      },
      ...(failurePage !== undefined ? { failurePage } : {}),
    });
  } finally {
    await cleanup?.().catch(() => undefined);
  }
}

async function captureFailurePage(
  livePage: import('playwright').Page | undefined,
  runtime: EngineRuntime,
): Promise<string | undefined> {
  if (livePage) return condensePage(livePage);
  if (runtime.lastPage) return condenseHtml(runtime.lastPage.html, runtime.lastPage.url);
  return undefined;
}

process.on('message', (message: ParentMessage) => {
  if (message.type === 'rpc-result') {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.value);
    else entry.reject(new Error(message.error ?? 'sandbox RPC failed'));
    return;
  }
  if (message.type === 'init') {
    run(message)
      .catch((err: Error) => sendAndFlush({ type: 'crash', error: { message: err.message, stack: err.stack ?? '' } }))
      .finally(() => {
        process.exit(0);
      });
  }
});

send({ type: 'ready' });
