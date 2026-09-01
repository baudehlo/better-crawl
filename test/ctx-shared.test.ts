import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CrawlEvent } from '../src/events.js';
import {
  MissingInputError,
  PageBudgetExceededError,
  RobotsDisallowedError,
  UnknownInputError,
  UnknownSelectorError,
} from '../src/errors.js';
import { EarlyStop, SharedRuntime } from '../src/runtime/ctx-shared.js';
import { RobotsCache } from '../src/runtime/robots.js';
import { createValidator } from '../src/runtime/validate.js';
import { makeArtifact } from './helpers/make-artifact.js';

const itemSchema = z.object({ name: z.string() });

function makeRuntime(overrides: {
  limits?: { maxPages: number; delayMs: number; maxItems?: number };
  signal?: AbortSignal;
  robotsBody?: string;
  inputs?: Record<string, string>;
  events?: CrawlEvent[];
} = {}): { runtime: SharedRuntime; events: CrawlEvent[] } {
  const events = overrides.events ?? [];
  const artifact = makeArtifact({
    inputs: [
      { name: 'user', description: 'login', secret: false, required: true },
      { name: 'note', description: 'optional note', secret: false, required: false },
    ],
    selectors: { row: { css: 'li.row', description: 'rows', expect: 'many' } },
  });
  const runtime = new SharedRuntime({
    artifact,
    validator: createValidator({ item: itemSchema }, {}),
    inputs: overrides.inputs ?? { user: 'alice' },
    emitEvent: (e) => events.push(e),
    phase: 'run',
    signal: overrides.signal ?? new AbortController().signal,
    limits: overrides.limits ?? { maxPages: 10, delayMs: 0 },
    ...(overrides.robotsBody !== undefined
      ? {
          robots: new RobotsCache(
            async () => ({ status: 200, body: overrides.robotsBody! }),
            'test-agent',
          ),
        }
      : {}),
  });
  return { runtime, events };
}

describe('SharedRuntime.gate', () => {
  it('counts pages and throws when the budget is exhausted', async () => {
    const { runtime } = makeRuntime({ limits: { maxPages: 2, delayMs: 0 } });
    await runtime.gate('http://x/1');
    await runtime.gate('http://x/2');
    await expect(runtime.gate('http://x/3')).rejects.toThrow(PageBudgetExceededError);
    expect(runtime.pagesVisited).toBe(2);
  });

  it('throws RobotsDisallowedError for disallowed paths', async () => {
    const { runtime } = makeRuntime({ robotsBody: 'User-agent: *\nDisallow: /private/\n' });
    await runtime.gate('http://x/public');
    await expect(runtime.gate('http://x/private/data')).rejects.toThrow(RobotsDisallowedError);
  });

  it('bumps the politeness delay up to a larger robots crawl-delay', async () => {
    const { runtime } = makeRuntime({
      limits: { maxPages: 5, delayMs: 0 },
      robotsBody: 'User-agent: *\nCrawl-delay: 0.02\n',
    });
    const start = Date.now();
    await runtime.gate('http://x/a');
    // second gate sleeps with the bumped 20ms delay
    await runtime.gate('http://x/b');
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it('rejects immediately when the signal aborted', async () => {
    const ctl = new AbortController();
    const reason = new Error('stop it');
    ctl.abort(reason);
    const { runtime } = makeRuntime({ signal: ctl.signal });
    await expect(runtime.gate('http://x/')).rejects.toBe(reason);
  });
});

describe('SharedRuntime abort plumbing', () => {
  it('throwIfAborted wraps non-Error reasons', () => {
    const ctl = new AbortController();
    ctl.abort('plain string reason');
    const { runtime } = makeRuntime({ signal: ctl.signal });
    expect(() => runtime.throwIfAborted()).toThrow('plain string reason');
  });

  it('abortableSleep rejects when aborted mid-sleep', async () => {
    const ctl = new AbortController();
    const { runtime } = makeRuntime({ signal: ctl.signal });
    const sleep = runtime.abortableSleep(5_000);
    const reason = new Error('cancelled');
    setTimeout(() => ctl.abort(reason), 10);
    await expect(sleep).rejects.toBe(reason);
  });

  it('abortableSleep rejects immediately on a pre-aborted signal', async () => {
    const ctl = new AbortController();
    const reason = new Error('already dead');
    ctl.abort(reason);
    const { runtime } = makeRuntime({ signal: ctl.signal });
    await expect(runtime.abortableSleep(1)).rejects.toBe(reason);
  });
});

describe('createCtxBase', () => {
  const screenshot = async (): Promise<void> => undefined;

  it('emit validates, streams, and stops at maxItems with EarlyStop', () => {
    const { runtime, events } = makeRuntime({
      limits: { maxPages: 10, delayMs: 0, maxItems: 2 },
    });
    const ctx = runtime.createCtxBase(screenshot);
    expect(ctx.emit('item', { name: 'a' })).toBe(true);
    expect(() => ctx.emit('item', { name: 'b' })).toThrow(EarlyStop);
    expect(runtime.totalItems).toBe(2);
    expect(events.filter((e) => e.type === 'item')).toHaveLength(2);
  });

  it('emit records invalid items (capped at 20) and returns false', () => {
    const { runtime, events } = makeRuntime();
    const ctx = runtime.createCtxBase(screenshot);
    for (let i = 0; i < 25; i++) {
      expect(ctx.emit('item', { name: 42 })).toBe(false);
    }
    expect(runtime.invalidItems).toHaveLength(20);
    expect(events.filter((e) => e.type === 'invalid-item')).toHaveLength(25);
  });

  it('input returns values, empty string for optional-missing, and throws otherwise', () => {
    const { runtime } = makeRuntime();
    const ctx = runtime.createCtxBase(screenshot);
    expect(ctx.input('user')).toBe('alice');
    expect(ctx.input('note')).toBe('');
    expect(() => ctx.input('nope')).toThrow(UnknownInputError);
  });

  it('input throws MissingInputError for a required input without a value', () => {
    const { runtime } = makeRuntime({ inputs: {} });
    const ctx = runtime.createCtxBase(screenshot);
    expect(() => ctx.input('user')).toThrow(MissingInputError);
  });

  it('sel resolves manifest selectors by name', () => {
    const { runtime } = makeRuntime();
    const ctx = runtime.createCtxBase(screenshot);
    expect(ctx.sel('row')).toBe('li.row');
    expect(() => ctx.sel('ghost')).toThrow(UnknownSelectorError);
  });

  it('progress keeps a capped trail and forwards pct', () => {
    const { runtime, events } = makeRuntime();
    const ctx = runtime.createCtxBase(screenshot);
    for (let i = 0; i < 35; i++) ctx.progress(`step ${i}`, i);
    expect(runtime.progressTrail).toHaveLength(30);
    expect(runtime.progressTrail[0]).toBe('step 5');
    const progressEvents = events.filter((e) => e.type === 'progress');
    expect(progressEvents[0]).toMatchObject({ message: 'step 0', pct: 0 });
  });

  it('log, sleep, screenshot, and entryUrl are wired through', async () => {
    const { runtime, events } = makeRuntime();
    let shot = false;
    const ctx = runtime.createCtxBase(async () => {
      shot = true;
    });
    ctx.log('warn', 'be careful');
    await ctx.sleep(1);
    await ctx.screenshot('label');
    expect(ctx.entryUrl).toBe('http://127.0.0.1:1/');
    expect(shot).toBe(true);
    expect(events).toContainEqual({ type: 'log', level: 'warn', message: 'be careful' });
  });
});
