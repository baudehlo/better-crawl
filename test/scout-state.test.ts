import { describe, expect, it } from 'vitest';
import { ScoutState } from '../src/scout/tools.js';

describe('ScoutState.recordSnapshot', () => {
  it('replaces an existing snapshot for the same URL (moving it to the end)', () => {
    const state = new ScoutState();
    state.recordSnapshot('http://x/a', 'first render');
    state.recordSnapshot('http://x/b', 'other page');
    state.recordSnapshot('http://x/a', 'second render');
    expect(state.snapshots).toEqual([
      { url: 'http://x/b', condensed: 'other page' },
      { url: 'http://x/a', condensed: 'second render' },
    ]);
  });

  it('caps the snapshot ring at 5, dropping the oldest', () => {
    const state = new ScoutState();
    for (let i = 0; i < 7; i++) state.recordSnapshot(`http://x/${i}`, `page ${i}`);
    expect(state.snapshots).toHaveLength(5);
    expect(state.snapshots[0]?.url).toBe('http://x/2');
    expect(state.snapshots.at(-1)?.url).toBe('http://x/6');
  });
});
