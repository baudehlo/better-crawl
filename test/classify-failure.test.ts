import { describe, expect, it } from 'vitest';
import { classifyFailure } from '../src/heal/heal.js';
import type { RunReport } from '../src/types.js';

function report(overrides: Partial<RunReport>): RunReport {
  return {
    ok: false,
    itemCounts: {},
    invalidItems: [],
    assertionFailures: [],
    pagesVisited: 1,
    durationMs: 10,
    progressTrail: [],
    ...overrides,
  };
}

describe('classifyFailure', () => {
  it('a failed named selector is selector-class', () => {
    expect(
      classifyFailure(
        report({
          runtimeError: { message: 'no match', stack: '', failedSelector: 'row' },
        }),
      ),
    ).toBe('selector');
  });

  it('a clean run that found zero items is selector-class (classic reskin)', () => {
    expect(
      classifyFailure(
        report({
          itemCounts: { product: 0 },
          assertionFailures: [
            { assertion: { kind: 'minItems', schema: 'product', min: 4 }, actual: '0 valid item(s)' },
          ],
        }),
      ),
    ).toBe('selector');
  });

  it('a clean run that found SOME items is structural', () => {
    expect(
      classifyFailure(
        report({
          itemCounts: { product: 2 },
          assertionFailures: [
            { assertion: { kind: 'minItems', schema: 'product', min: 4 }, actual: '2 valid item(s)' },
          ],
        }),
      ),
    ).toBe('structural');
  });

  it('a runtime error without a failed selector is structural', () => {
    expect(
      classifyFailure(report({ runtimeError: { message: 'fetch failed', stack: '' } })),
    ).toBe('structural');
  });
});
