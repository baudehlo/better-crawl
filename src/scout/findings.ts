import { z } from 'zod';

export const reportedSelectorSchema = z.object({
  css: z.string().min(1),
  description: z.string(),
  expect: z.enum(['one', 'many', 'maybe']),
});

/**
 * The report_findings tool payload. Deliberately LOOSE where user data flows
 * through (sampleItems) — user schemas are never compiled into LLM tool
 * schemas (Anthropic times out compiling >~16 anyOf branches); strictness
 * lives in the library-side gates instead.
 */
export const reportFindingsSchema = z.object({
  engine: z.enum(['playwright', 'cheerio']),
  engineReason: z.string(),
  selectors: z.record(z.string(), reportedSelectorSchema),
  inputsNeeded: z.array(
    z.object({ name: z.string(), description: z.string(), secret: z.boolean() }),
  ),
  navigationPlan: z.array(z.string()),
  expectedCounts: z.record(z.string(), z.number()),
  sampleItems: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});

export type ReportFindingsPayload = z.infer<typeof reportFindingsSchema>;

export interface ScoutFindings extends ReportFindingsPayload {
  /** Selector name → sample text of the first live match (anchors healing). */
  selectorSamples: Record<string, string>;
  /** Condensed snapshots of the most informative pages, for the codegen prompt. */
  keyPages: Array<{ url: string; condensed: string }>;
  /** Every URL the scout actually visited (observed, not asserted). */
  urlsVisited: string[];
  /** Whether a probe_no_js call succeeded and contained target data. */
  probeVerifiedCheerio: boolean;
}
