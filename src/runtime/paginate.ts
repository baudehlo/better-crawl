import type { Page } from 'playwright';

export interface LoadAllOptions {
  maxClicks?: number;
  pollIntervalMs?: number;
}

/**
 * Text that marks an accumulate-in-place loader. Deliberately excludes "next" —
 * next-page style pagination replaces the list (and often navigates), which
 * generated code must handle as an explicit loop instead.
 */
const LOAD_MORE_RE = /\b(load more|show more|view more|see more|more results)\b/i;

const DEFAULT_MAX_CLICKS = 300;
const DEFAULT_POLL_INTERVAL_MS = 500;
/** Polls per round while waiting for the count to grow. */
const POLLS_PER_ROUND = 6;
/**
 * Consecutive no-growth rounds required before we believe the list is
 * exhausted. Async counters routinely look stable too early — a single quiet
 * poll proves nothing.
 */
const STABLE_ROUNDS_REQUIRED = 3;

/**
 * Exhaust an accumulating listing: click load-more style buttons when present,
 * fall back to scrolling to the bottom, and only stop after the item count has
 * refused to grow for several consecutive rounds. Returns the final count.
 */
export async function loadAll(
  page: Page,
  itemCss: string,
  opts: LoadAllOptions,
  throwIfAborted: () => void,
  sleep: (ms: number) => Promise<void>,
): Promise<number> {
  const maxClicks = opts.maxClicks ?? DEFAULT_MAX_CLICKS;
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const countItems = () => page.locator(itemCss).count();

  let lastCount = await countItems();
  let stableRounds = 0;
  let clicks = 0;

  while (stableRounds < STABLE_ROUNDS_REQUIRED && clicks < maxClicks) {
    throwIfAborted();

    const urlBefore = page.url();
    const button = page
      .locator('button, a, [role="button"]')
      .filter({ hasText: LOAD_MORE_RE })
      .first();
    const hasButton = (await button.count()) > 0 && (await button.isVisible().catch(() => false));

    if (hasButton) {
      await button.click().catch(() => undefined);
      clicks += 1;
      if (page.url() !== urlBefore) {
        // The "loader" actually navigated — undo and stop; this list doesn't accumulate.
        await page.goBack().catch(() => undefined);
        break;
      }
    } else {
      await page
        .evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        .catch(() => undefined);
    }

    let maxSeen = lastCount;
    for (let poll = 0; poll < POLLS_PER_ROUND; poll++) {
      await sleep(pollMs);
      maxSeen = Math.max(maxSeen, await countItems());
      if (maxSeen > lastCount) break;
    }

    if (maxSeen > lastCount) {
      lastCount = maxSeen;
      stableRounds = 0;
    } else {
      stableRounds += 1;
    }
  }

  return countItems();
}
