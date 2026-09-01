import { describe, expect, it } from 'vitest';
import { CrawlHandle, type HandleController } from '../src/handle.js';
import type { CrawlEvent } from '../src/events.js';

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('CrawlHandle', () => {
  it('resolves like a promise with the runner result', async () => {
    const handle = new CrawlHandle(async () => 42);
    await expect(handle).resolves.toBe(42);
  });

  it('rejects like a promise when the runner throws', async () => {
    const handle = new CrawlHandle(async () => {
      throw new Error('boom');
    });
    await expect(handle).rejects.toThrow('boom');
  });

  it('delivers events to .on listeners registered synchronously', async () => {
    const seen: string[] = [];
    const handle = new CrawlHandle(async (ctl) => {
      ctl.emit({ type: 'progress', phase: 'run', message: 'one' });
      ctl.emit({ type: 'log', level: 'info', message: 'two' });
      return 'done';
    });
    handle.on('progress', (e) => seen.push(e.message));
    handle.on('log', (e) => seen.push(e.message));
    await handle;
    expect(seen).toEqual(['one', 'two']);
  });

  it('supports async iteration of all events, ending on resolve', async () => {
    const handle = new CrawlHandle(async (ctl) => {
      ctl.emit({ type: 'item', schema: 'a', item: 1 });
      await tick();
      ctl.emit({ type: 'item', schema: 'b', item: 2 });
      return null;
    });
    const types: string[] = [];
    for await (const event of handle) types.push(event.type);
    expect(types).toEqual(['item', 'item']);
  });

  it('async iteration throws when the runner rejects', async () => {
    const handle = new CrawlHandle(async (ctl) => {
      ctl.emit({ type: 'progress', phase: 'run', message: 'started' });
      throw new Error('mid-crawl failure');
    });
    const seen: CrawlEvent[] = [];
    await expect(async () => {
      for await (const event of handle) seen.push(event);
    }).rejects.toThrow('mid-crawl failure');
    // the progress event and the error event both arrive before the throw
    expect(seen.map((e) => e.type)).toEqual(['progress', 'error']);
  });

  it('items() yields item payloads, optionally filtered by schema', async () => {
    const make = () =>
      new CrawlHandle(async (ctl) => {
        ctl.emit({ type: 'item', schema: 'product', item: { id: 1 } });
        ctl.emit({ type: 'progress', phase: 'run', message: 'x' });
        ctl.emit({ type: 'item', schema: 'review', item: { id: 2 } });
        ctl.emit({ type: 'item', schema: 'product', item: { id: 3 } });
        return null;
      });

    const all: unknown[] = [];
    for await (const item of make().items()) all.push(item);
    expect(all).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const products: Array<{ id: number }> = [];
    for await (const item of make().items<{ id: number }>('product')) products.push(item);
    expect(products).toEqual([{ id: 1 }, { id: 3 }]);
  });

  it('can be awaited and iterated simultaneously', async () => {
    const handle = new CrawlHandle(async (ctl) => {
      ctl.emit({ type: 'item', schema: 's', item: 'x' });
      return 'result';
    });
    const items: unknown[] = [];
    const iterate = (async () => {
      for await (const item of handle.items()) items.push(item);
    })();
    const [result] = await Promise.all([handle, iterate]);
    expect(result).toBe('result');
    expect(items).toEqual(['x']);
  });

  it('abort() signals the runner and rejects with the reason', async () => {
    let observed: AbortSignal | undefined;
    const handle = new CrawlHandle(async (ctl: HandleController) => {
      observed = ctl.signal;
      await new Promise((_resolve, reject) => {
        ctl.signal.addEventListener('abort', () => reject(ctl.signal.reason), { once: true });
      });
      return 'never';
    });
    await tick();
    handle.abort(new Error('user cancelled'));
    await expect(handle).rejects.toThrow('user cancelled');
    expect(observed?.aborted).toBe(true);
  });

  it('honors a pre-aborted external signal', async () => {
    const external = new AbortController();
    external.abort(new Error('external stop'));
    const handle = new CrawlHandle(async (ctl) => {
      if (ctl.signal.aborted) throw ctl.signal.reason;
      return 'unreachable';
    }, external.signal);
    await expect(handle).rejects.toThrow('external stop');
  });

  it('surfaces runner failure as an error event (no unhandled rejection without await)', async () => {
    const errors: Error[] = [];
    const handle = new CrawlHandle(async () => {
      throw new Error('silent-ish');
    });
    handle.on('error', (e) => errors.push(e.error));
    await tick();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('silent-ish');
  });

  it('wraps non-Error rejection reasons into the error event', async () => {
    const errors: Error[] = [];
    const handle = new CrawlHandle(async () => {
      throw 'a string reason'; // eslint-disable-line no-throw-literal
    });
    handle.on('error', (e) => errors.push(e.error));
    await expect(handle).rejects.toBe('a string reason');
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0]!.message).toBe('a string reason');
  });

  it('propagates an external signal aborted after construction', async () => {
    const external = new AbortController();
    const handle = new CrawlHandle(async (ctl) => {
      await new Promise((_resolve, reject) => {
        ctl.signal.addEventListener('abort', () => reject(ctl.signal.reason), { once: true });
      });
      return 'never';
    }, external.signal);
    await tick();
    external.abort(new Error('external late stop'));
    await expect(handle).rejects.toThrow('external late stop');
  });

  it('off() detaches a listener', async () => {
    const seen: string[] = [];
    const listener = (e: { message: string }) => seen.push(e.message);
    let releaseSecond!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const handle = new CrawlHandle(async (ctl) => {
      ctl.emit({ type: 'progress', phase: 'run', message: 'first' });
      await gate;
      ctl.emit({ type: 'progress', phase: 'run', message: 'second' });
      return null;
    });
    handle.on('progress', listener);
    await tick();
    handle.off('progress', listener);
    releaseSecond();
    await handle;
    expect(seen).toEqual(['first']);
  });

  it('breaking out of iteration invokes the iterator return() cleanup', async () => {
    const handle = new CrawlHandle(async (ctl) => {
      ctl.emit({ type: 'item', schema: 'a', item: 1 });
      ctl.emit({ type: 'item', schema: 'a', item: 2 });
      return 'done';
    });
    const seen: CrawlEvent[] = [];
    for await (const event of handle) {
      seen.push(event);
      break;
    }
    expect(seen).toHaveLength(1);
    await expect(handle).resolves.toBe('done');
  });

  it('ignores events emitted after the handle settles', async () => {
    let leaked!: HandleController;
    const seen: string[] = [];
    const handle = new CrawlHandle(async (ctl) => {
      leaked = ctl;
      return 'done';
    });
    handle.on('progress', (e) => seen.push(e.message));
    await handle;
    leaked.emit({ type: 'progress', phase: 'run', message: 'too late' });
    expect(seen).toEqual([]);
  });

  it('abort after resolution is a no-op', async () => {
    const handle = new CrawlHandle(async () => 'ok');
    await expect(handle).resolves.toBe('ok');
    handle.abort(new Error('late'));
    await expect(handle).resolves.toBe('ok');
  });

  it('abort() without a reason uses a default Error', async () => {
    const handle = new CrawlHandle(async (ctl) => {
      await new Promise((_resolve, reject) => {
        ctl.signal.addEventListener('abort', () => reject(ctl.signal.reason), { once: true });
      });
      return 'never';
    });
    await tick();
    handle.abort();
    await expect(handle).rejects.toThrow('Crawl aborted');
  });
});
