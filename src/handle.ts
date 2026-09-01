import { EventEmitter } from 'node:events';
import type { CrawlEvent, CrawlEventOf, CrawlEventType } from './events.js';

/** What the internal pipeline uses to talk to a handle. */
export interface HandleController {
  emit(event: CrawlEvent): void;
  readonly signal: AbortSignal;
}

type Settled<R> =
  | { state: 'pending' }
  | { state: 'resolved'; value: R }
  | { state: 'rejected'; error: unknown };

/**
 * The return value of generateCrawler()/runCrawler(). Usable three ways, which
 * can be combined freely:
 *   - `await handle` → the final result
 *   - `for await (const event of handle)` / `for await (const item of handle.items())`
 *   - `handle.on('progress', ...)`
 *
 * Attach listeners/iterators before awaiting — events are delivered live, not
 * replayed. If the run fails and you neither await nor iterate, the failure is
 * still surfaced as an `error` event (no unhandled rejection).
 */
export class CrawlHandle<R> implements PromiseLike<R>, AsyncIterable<CrawlEvent> {
  #settled: Settled<R> = { state: 'pending' };
  #settleCallbacks: Array<() => void> = [];
  #emitter = new EventEmitter();
  #abort = new AbortController();

  constructor(runner: (ctl: HandleController) => Promise<R>, external?: AbortSignal) {
    if (external) {
      if (external.aborted) this.#abort.abort(external.reason);
      else external.addEventListener('abort', () => this.#abort.abort(external.reason), { once: true });
    }
    const ctl: HandleController = {
      emit: (event) => {
        if (this.#settled.state !== 'pending') return;
        this.#emitter.emit('event', event);
        this.#emitter.emit(`type:${event.type}`, event);
      },
      signal: this.#abort.signal,
    };
    // Start on the next microtask so callers can attach listeners first.
    queueMicrotask(() => {
      runner(ctl).then(
        (value) => this.#settle({ state: 'resolved', value }),
        (error: unknown) => {
          ctl.emit({
            type: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
          });
          this.#settle({ state: 'rejected', error });
        },
      );
    });
  }

  #settle(next: Settled<R>): void {
    if (this.#settled.state !== 'pending') return;
    this.#settled = next;
    const callbacks = this.#settleCallbacks;
    this.#settleCallbacks = [];
    for (const cb of callbacks) cb();
  }

  #onSettle(cb: () => void): void {
    if (this.#settled.state !== 'pending') queueMicrotask(cb);
    else this.#settleCallbacks.push(cb);
  }

  then<T1 = R, T2 = never>(
    onfulfilled?: ((value: R) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return new Promise<R>((resolve, reject) => {
      this.#onSettle(() => {
        const s = this.#settled;
        if (s.state === 'resolved') resolve(s.value);
        else if (s.state === 'rejected') reject(s.error);
      });
    }).then(onfulfilled, onrejected);
  }

  on<T extends CrawlEventType>(type: T, listener: (event: CrawlEventOf<T>) => void): this {
    this.#emitter.on(`type:${type}`, listener);
    return this;
  }

  off<T extends CrawlEventType>(type: T, listener: (event: CrawlEventOf<T>) => void): this {
    this.#emitter.off(`type:${type}`, listener);
    return this;
  }

  /** Abort the crawl. The handle rejects with the abort reason. */
  abort(reason?: unknown): void {
    this.#abort.abort(reason ?? new Error('Crawl aborted'));
  }

  [Symbol.asyncIterator](): AsyncIterator<CrawlEvent> {
    const queue: CrawlEvent[] = [];
    let wake: (() => void) | undefined;
    const onEvent = (event: CrawlEvent) => {
      queue.push(event);
      wake?.();
    };
    this.#emitter.on('event', onEvent);
    this.#onSettle(() => wake?.());
    const cleanup = () => this.#emitter.off('event', onEvent);

    return {
      next: async (): Promise<IteratorResult<CrawlEvent>> => {
        for (;;) {
          const queued = queue.shift();
          if (queued) return { value: queued, done: false };
          const s = this.#settled;
          if (s.state === 'resolved') {
            cleanup();
            return { value: undefined, done: true };
          }
          if (s.state === 'rejected') {
            cleanup();
            throw s.error;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      },
      return: async (): Promise<IteratorResult<CrawlEvent>> => {
        cleanup();
        return { value: undefined, done: true };
      },
    };
  }

  /** Validated items only, optionally filtered to one schema name. */
  async *items<S = unknown>(schema?: string): AsyncIterableIterator<S> {
    for await (const event of this) {
      if (event.type === 'item' && (schema === undefined || event.schema === schema)) {
        yield event.item as S;
      }
    }
  }
}
