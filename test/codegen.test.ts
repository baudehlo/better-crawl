import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runCodegenCall } from '../src/codegen/codegen.js';
import { buildCodegenSystemPrompt, buildCodegenUserMessage } from '../src/codegen/prompts.js';
import type { ScoutFindings } from '../src/scout/findings.js';
import { FakeLlm } from './helpers/fake-llm.js';

const MODEL = 'fake-model' as never;

const VALID_OUTPUT = {
  engine: 'cheerio',
  selectors: { row: { css: 'li.row', description: 'rows', expect: 'many' } },
  inputs: [],
  assertions: [],
  code: 'export default async function crawl(ctx) {}\n',
  notes: 'trivial',
};

describe('runCodegenCall', () => {
  it('parses the structured output (works without a signal)', async () => {
    const fake = new FakeLlm({ objects: [VALID_OUTPUT] });
    const { output, usage } = await runCodegenCall({
      llm: fake,
      model: MODEL,
      messages: [{ role: 'user', content: 'write it' }],
    });
    expect(output.code).toContain('export default');
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(fake.objectCalls[0]?.maxOutputTokens).toBe(64_000);
  });

  it('passes an abort signal through when given', async () => {
    const fake = new FakeLlm({ objects: [VALID_OUTPUT] });
    const signal = new AbortController().signal;
    await runCodegenCall({ llm: fake, model: MODEL, messages: [], signal });
    expect(fake.objectCalls[0]?.signal).toBe(signal);
  });
});

describe('codegen prompts', () => {
  it('system prompt embeds the engine-specific ctx API', () => {
    const playwright = buildCodegenSystemPrompt('playwright');
    expect(playwright).toContain('ctx.goto');
    expect(playwright).toContain('ctx.loadAll');
    expect(playwright).not.toContain('ctx.submitForm');

    const cheerio = buildCodegenSystemPrompt('cheerio');
    expect(cheerio).toContain('ctx.fetch');
    expect(cheerio).toContain('ctx.submitForm');
    expect(cheerio).not.toContain('ctx.goto');
  });

  it('system prompt forbids hardcoding the year and pins undated dates to the running year', () => {
    for (const engine of ['playwright', 'cheerio'] as const) {
      const prompt = buildCodegenSystemPrompt(engine);
      expect(prompt).toContain('NEVER hardcode a year');
      expect(prompt).toContain('new Date().getFullYear()');
      expect(prompt).toContain('the year the crawl is running');
    }
  });

  it('user message renders findings with and without selectors/samples', () => {
    const base: ScoutFindings = {
      engine: 'cheerio',
      engineReason: 'raw HTML',
      selectors: {
        row: { css: 'li.row', description: 'rows', expect: 'many' },
        bare: { css: '.bare', description: 'no sample', expect: 'one' },
      },
      inputsNeeded: [],
      navigationPlan: ['open listing'],
      expectedCounts: { product: 6 },
      sampleItems: { product: [{ name: 'x' }] },
      selectorSamples: { row: 'Widget 1' },
      keyPages: [{ url: 'http://x/', condensed: 'URL: http://x/\npage text' }],
      urlsVisited: ['http://x/'],
      probeVerifiedCheerio: true,
    };
    const message = buildCodegenUserMessage({
      instructions: 'get products',
      entryUrl: 'http://x/',
      schemas: { product: z.object({ name: z.string() }) },
      findings: base,
    });
    expect(message).toContain('sample match: "Widget 1"');
    expect(message).toContain('- bare: ".bare" (one) — no sample');
    expect(message).toContain('--- http://x/ ---');

    const empty = buildCodegenUserMessage({
      instructions: 'get products',
      entryUrl: 'http://x/',
      schemas: { product: z.object({ name: z.string() }) },
      findings: { ...base, selectors: {} },
    });
    expect(empty).toContain('(none)');
  });
});
