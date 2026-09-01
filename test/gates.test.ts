import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { checkFindings, type GateEvidence } from '../src/scout/gates.js';
import type { ReportFindingsPayload } from '../src/scout/findings.js';
import { createValidator } from '../src/runtime/validate.js';

const productSchema = z.object({ name: z.string(), price: z.number() });

function payload(overrides: Partial<ReportFindingsPayload> = {}): ReportFindingsPayload {
  return {
    engine: 'playwright',
    engineReason: 'JS-rendered',
    selectors: {
      itemRow: { css: 'li.product', description: 'rows', expect: 'many' },
    },
    inputsNeeded: [],
    navigationPlan: ['open listing', 'read rows'],
    expectedCounts: { product: 6 },
    sampleItems: {
      product: [
        { name: 'Widget 1', price: 10.99 },
        { name: 'Widget 2', price: 20.99 },
      ],
    },
    ...overrides,
  };
}

function evidence(overrides: Partial<GateEvidence> = {}): GateEvidence {
  return {
    verifiedSelectors: new Map([['li.product', { count: 6, sampleText: 'Widget 1' }]]),
    probeTexts: [],
    validator: createValidator({ product: productSchema }, {}),
    ...overrides,
  };
}

describe('checkFindings gates', () => {
  it('accepts a verified playwright report', () => {
    expect(checkFindings(payload(), evidence())).toBeNull();
  });

  it('rejects selectors that were never verified', () => {
    const result = checkFindings(payload(), evidence({ verifiedSelectors: new Map() }));
    expect(result).toMatch(/REJECTED: selector "itemRow".*never verified/);
    expect(result).toContain('try_selector');
  });

  it('rejects selectors that verified to 0 matches', () => {
    const result = checkFindings(
      payload(),
      evidence({ verifiedSelectors: new Map([['li.product', { count: 0 }]]) }),
    );
    expect(result).toMatch(/matched 0 elements/);
  });

  it('rejects sampleItems for schemas that do not exist', () => {
    const result = checkFindings(
      payload({
        sampleItems: {
          product: [
            { name: 'a', price: 1 },
            { name: 'b', price: 2 },
          ],
          bogus: [{ x: 1 }],
        },
      }),
      evidence(),
    );
    expect(result).toMatch(/unknown schema "bogus"/);
  });

  it('rejects fewer than 2 samples per schema', () => {
    const result = checkFindings(
      payload({ sampleItems: { product: [{ name: 'only', price: 1 }] } }),
      evidence(),
    );
    expect(result).toMatch(/at least 2 sample items/);
  });

  it('rejects invalid samples with the failing path and a type hint', () => {
    const result = checkFindings(
      payload({
        sampleItems: {
          product: [
            { name: 'ok', price: 1 },
            { name: 'bad', price: '$4.99' },
          ],
        },
      }),
      evidence(),
    );
    expect(result).toMatch(/REJECTED: sample item for schema "product"/);
    expect(result).toContain('price');
    expect(result).toContain('numbers as numbers');
  });

  it('rejects cheerio without any no-JS probe', () => {
    const result = checkFindings(payload({ engine: 'cheerio' }), evidence());
    expect(result).toMatch(/requires a successful probe_no_js/);
  });

  it('rejects cheerio when the probe does not contain the sample data', () => {
    const result = checkFindings(
      payload({ engine: 'cheerio' }),
      evidence({ probeTexts: ['URL: x\n=== TEXT ===\nnothing relevant here'] }),
    );
    expect(result).toMatch(/report engine "playwright" instead/i);
  });

  it('accepts cheerio when a probe contains sample values (observation over assertion)', () => {
    const result = checkFindings(
      payload({ engine: 'cheerio' }),
      evidence({ probeTexts: ['=== TEXT ===\nWidget 1 $10.99\nWidget 2 $20.99'] }),
    );
    expect(result).toBeNull();
  });

  it('rejects when a schema has no sampleItems entry at all', () => {
    const result = checkFindings(payload({ sampleItems: {} }), evidence());
    expect(result).toMatch(/needs at least 2 sample items.*got 0/);
  });

  it('rejects cheerio when samples have no meaty string values to check against probes', () => {
    const numericSchema = z.object({ id: z.number(), price: z.number() });
    const result = checkFindings(
      payload({
        engine: 'cheerio',
        sampleItems: {
          product: [
            { id: 1, price: 10.99 },
            { id: 2, price: 20.99 },
          ],
        },
      }),
      evidence({
        probeTexts: ['=== TEXT ===\nplenty of page text'],
        validator: createValidator({ product: numericSchema }, {}),
      }),
    );
    expect(result).toMatch(/none of your sample values appear/);
  });
});
