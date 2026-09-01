import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toJsonSchema } from '../src/json-schema.js';
import { buildCodegenUserMessage } from '../src/codegen/prompts.js';
import { buildScoutSystemPrompt } from '../src/scout/scout.js';

/**
 * Real-world schemas routinely carry .transform()/.catch()/.refine() layers.
 * z.toJSONSchema throws on those by default; ours must degrade gracefully —
 * the JSON Schema is only descriptive, real validation uses zod directly.
 */
const transformingSchema = z.object({
  name: z.string(),
  price: z.number().nullable().catch(null),
  categories: z.array(z.string()).transform((arr) => arr.filter((c) => c.length > 0)),
});

describe('toJsonSchema', () => {
  it('renders plain schemas as-is', () => {
    const rendered = toJsonSchema(z.object({ name: z.string() }));
    expect(rendered).toMatchObject({ type: 'object', properties: { name: { type: 'string' } } });
  });

  it('renders the input side of transforms instead of throwing', () => {
    const rendered = toJsonSchema(transformingSchema) as {
      properties: Record<string, { type?: string; items?: { type?: string } }>;
    };
    expect(rendered.properties.categories).toMatchObject({ type: 'array', items: { type: 'string' } });
  });

  it('degrades truly unrepresentable types to an unconstrained schema', () => {
    expect(() => toJsonSchema(z.object({ when: z.date() }))).not.toThrow();
  });
});

describe('prompt builders with transforming schemas', () => {
  it('buildScoutSystemPrompt does not throw', () => {
    const prompt = buildScoutSystemPrompt({
      instructions: 'find products',
      schemas: { product: transformingSchema },
      inputNames: [],
    });
    expect(prompt).toContain('"categories"');
  });

  it('buildCodegenUserMessage does not throw', () => {
    const message = buildCodegenUserMessage({
      instructions: 'find products',
      entryUrl: 'https://example.com',
      schemas: { product: transformingSchema },
      findings: {
        engine: 'cheerio',
        engineReason: 'data present without JS',
        selectors: {},
        selectorSamples: {},
        inputsNeeded: [],
        navigationPlan: [],
        expectedCounts: {},
        sampleItems: {},
        keyPages: [],
        urlsVisited: [],
        probeVerifiedCheerio: true,
      },
    });
    expect(message).toContain('"categories"');
  });
});
