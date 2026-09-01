import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { loadAll } from '../src/runtime/paginate.js';

interface FakePageScript {
  /** Item counts returned by successive count() calls on the item selector. */
  counts: number[];
  button?: {
    present: boolean;
    visible?: boolean;
    onClick?: () => void;
    clickThrows?: boolean;
  };
  evaluateThrows?: boolean;
}

/** Minimal Page double for the loadAll control flow. */
function fakePage(script: FakePageScript): {
  page: Page;
  log: string[];
} {
  const log: string[] = [];
  let countIndex = 0;
  let url = 'http://fixture/list';

  const nextCount = () => {
    const count = script.counts[Math.min(countIndex, script.counts.length - 1)]!;
    countIndex++;
    return count;
  };

  const button = {
    count: async () => (script.button?.present ? 1 : 0),
    isVisible: async () => script.button?.visible ?? true,
    click: async () => {
      log.push('click');
      if (script.button?.clickThrows) throw new Error('detached');
      script.button?.onClick?.();
    },
  };

  const page = {
    url: () => url,
    setUrl: (next: string) => {
      url = next;
    },
    locator: (css: string) => {
      if (css.includes('button')) {
        return { filter: () => ({ first: () => button }) };
      }
      return { count: async () => nextCount() };
    },
    goBack: async () => {
      log.push('goBack');
      url = 'http://fixture/list';
    },
    evaluate: async (fn: () => unknown) => {
      log.push('scroll');
      if (script.evaluateThrows) throw new Error('ctx destroyed');
      // run the scroll callback for real; `window` is missing in Node and
      // loadAll's .catch is expected to absorb the resulting throw
      fn();
    },
  };
  return { page: page as unknown as Page, log };
}

const noAbort = () => undefined;
const instantSleep = async () => undefined;

describe('loadAll', () => {
  it('clicks a visible load-more button until the count stops growing', async () => {
    // initial 5; grows to 10 after first click, then stays flat
    const { page, log } = fakePage({
      counts: [5, 10, 10, 10, 10, 10],
      button: { present: true },
    });
    const result = await loadAll(page, 'li.item', { pollIntervalMs: 1 }, noAbort, instantSleep);
    expect(result).toBe(10);
    expect(log.filter((l) => l === 'click').length).toBeGreaterThanOrEqual(3);
  });

  it('falls back to scrolling when no button exists', async () => {
    const { page, log } = fakePage({ counts: [5, 5] });
    const result = await loadAll(page, 'li.item', { pollIntervalMs: 1 }, noAbort, instantSleep);
    expect(result).toBe(5);
    expect(log).toContain('scroll');
    expect(log).not.toContain('click');
  });

  it('treats a hidden button as absent and scrolls instead', async () => {
    const { page, log } = fakePage({
      counts: [3, 3],
      button: { present: true, visible: false },
    });
    await loadAll(page, 'li.item', { pollIntervalMs: 1 }, noAbort, instantSleep);
    expect(log).toContain('scroll');
    expect(log).not.toContain('click');
  });

  it('undoes and stops when the "loader" actually navigates', async () => {
    const { page, log } = fakePage({
      counts: [5, 5],
      button: {
        present: true,
        onClick: () => (page as unknown as { setUrl: (u: string) => void }).setUrl('http://fixture/page2'),
      },
    });
    const result = await loadAll(page, 'li.item', { pollIntervalMs: 1 }, noAbort, instantSleep);
    expect(log).toEqual(['click', 'goBack']);
    expect(result).toBe(5);
  });

  it('stops at maxClicks even while the list keeps growing', async () => {
    // grows forever: 1, 2, 3, ... so stability is never reached
    const counts = Array.from({ length: 200 }, (_, i) => i + 1);
    const { page, log } = fakePage({ counts, button: { present: true } });
    await loadAll(page, 'li.item', { maxClicks: 4, pollIntervalMs: 1 }, noAbort, instantSleep);
    expect(log.filter((l) => l === 'click')).toHaveLength(4);
  });

  it('survives click and scroll failures', async () => {
    const clicky = fakePage({
      counts: [2, 2],
      button: { present: true, clickThrows: true },
    });
    await expect(
      loadAll(clicky.page, 'li.item', { pollIntervalMs: 1 }, noAbort, instantSleep),
    ).resolves.toBe(2);

    const scrolly = fakePage({ counts: [2, 2], evaluateThrows: true });
    await expect(
      loadAll(scrolly.page, 'li.item', { pollIntervalMs: 1 }, noAbort, instantSleep),
    ).resolves.toBe(2);
  });

  it('propagates aborts through throwIfAborted', async () => {
    const { page } = fakePage({ counts: [1, 1] });
    const reason = new Error('cancelled');
    await expect(
      loadAll(
        page,
        'li.item',
        { pollIntervalMs: 1 },
        () => {
          throw reason;
        },
        instantSleep,
      ),
    ).rejects.toBe(reason);
  });
});
