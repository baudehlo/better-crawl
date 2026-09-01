import type { LanguageModel } from 'ai';
import { z } from 'zod';
import type { CrawlEvent } from '../events.js';
import { GenerationFailedError, PlaywrightMissingError } from '../errors.js';
import type { LlmClient, LlmUsage } from '../llm/client.js';
import { RobotsCache } from '../runtime/robots.js';
import { createValidator } from '../runtime/validate.js';
import type { Schemas } from '../types.js';
import type { ScoutFindings } from './findings.js';
import { createScoutTools, ScoutState } from './tools.js';

export interface ScoutRunOptions {
  llm: LlmClient;
  model: LanguageModel;
  url: string;
  instructions: string;
  schemas: Schemas;
  inputs: Record<string, string>;
  emitEvent: (event: CrawlEvent) => void;
  signal: AbortSignal;
  maxSteps: number;
  limits: { maxPages: number; delayMs: number };
  ignoreRobots: boolean;
  userAgent: string;
  screenshots: boolean;
  screenshotDir?: string;
  headless: boolean;
}

export interface ScoutRunResult {
  findings: ScoutFindings;
  usage: LlmUsage;
  steps: number;
}

export function buildScoutSystemPrompt(opts: {
  instructions: string;
  schemas: Schemas;
  inputNames: string[];
}): string {
  const schemaText = Object.entries(opts.schemas)
    .map(([name, schema]) => `### ${name}\n${JSON.stringify(z.toJSONSchema(schema))}`)
    .join('\n\n');

  return `You are a web-crawling scout. Explore the target site, work out exactly how the requested data can be extracted, and submit your conclusions with the report_findings tool. A separate step will turn your findings into a permanent crawler program, so your job is reconnaissance, not bulk extraction.

## The task
${opts.instructions}

## Data schemas to extract (JSON Schema)
${schemaText}

## Available user inputs
${opts.inputNames.length > 0 ? opts.inputNames.join(', ') : '(none provided)'}

## How to work
1. navigate to the start URL and read the condensed page (LINKS and TEXT sections).
2. Identify where the data lives. detect_listing finds repeating listing-link patterns; load_all exhausts lazy "load more" lists; click/type_text handle interactions. If a login is needed, use type_text with inputName so credential values are filled without being shown to you.
3. Verify EVERY selector you plan to report with try_selector on the page where it applies. Selectors must be stable CSS (prefer classes/attributes over positional nth-child).
4. Call probe_no_js on one or two key pages (the listing page and one detail page). If the target data appears in the no-JS output, report engine "cheerio" (much cheaper); otherwise report engine "playwright".
5. Extract at least 2 sample items per schema from real page content, with correct JSON types (numbers as numbers).
6. Call report_findings. If it returns REJECTED: fix exactly what it says and call it again. You MUST end with an ACCEPTED report_findings — never finish without it.

## Rules
- Never submit forms other than a login/search form needed to reach the data.
- Never navigate outside the target site.
- Keep exploration tight: a handful of pages is usually enough; do not read every detail page.
- In selectors, report what a PROGRAM will use later: listing rows, item links, name/price/field elements on detail pages, pagination controls, login form fields if needed.`;
}

export async function runScout(opts: ScoutRunOptions): Promise<ScoutRunResult> {
  let pw: typeof import('playwright');
  try {
    pw = await import('playwright');
  } catch {
    throw new PlaywrightMissingError();
  }

  const browser = await pw.chromium.launch({ headless: opts.headless });
  try {
    const context = await browser.newContext({ userAgent: opts.userAgent });
    const page = await context.newPage();

    const robots = opts.ignoreRobots
      ? undefined
      : new RobotsCache(async (url) => {
          const res = await fetch(url, {
            headers: { 'user-agent': opts.userAgent },
            signal: opts.signal,
          });
          return { status: res.status, body: await res.text() };
        }, opts.userAgent);

    const state = new ScoutState();
    const tools = createScoutTools(state, {
      page,
      validator: createValidator(opts.schemas, {}),
      inputs: opts.inputs,
      emitEvent: opts.emitEvent,
      signal: opts.signal,
      limits: { ...opts.limits },
      ...(robots ? { robots } : {}),
      userAgent: opts.userAgent,
      screenshots: opts.screenshots,
      ...(opts.screenshotDir !== undefined ? { screenshotDir: opts.screenshotDir } : {}),
    });

    const system = buildScoutSystemPrompt({
      instructions: opts.instructions,
      schemas: opts.schemas,
      inputNames: Object.keys(opts.inputs),
    });

    const { usage, steps } = await opts.llm.runAgentLoop({
      model: opts.model,
      system,
      prompt: `The start URL is: ${opts.url}\n\nBegin by calling navigate on it.`,
      tools,
      maxSteps: opts.maxSteps,
      signal: opts.signal,
      onStepFinish: (step) => {
        const toolNames = step.toolCalls.map((call) => call.toolName);
        if (toolNames.length > 0) {
          opts.emitEvent({
            type: 'progress',
            phase: 'scout',
            message: `scout: ${toolNames.join(', ')}`,
          });
        }
        if (step.text) {
          opts.emitEvent({
            type: 'log',
            level: 'debug',
            message: `scout reasoning: ${step.text.slice(0, 300)}`,
          });
        }
      },
    });

    opts.emitEvent({
      type: 'llm-usage',
      phase: 'scout',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });

    if (!state.findings) {
      throw new GenerationFailedError(
        `The scout finished ${steps} step(s) without an accepted report_findings — ` +
          `the site may be too complex for the step budget (${opts.maxSteps}), or access failed. ` +
          `Check progress events for details.`,
        undefined,
        [],
      );
    }
    return { findings: state.findings, usage, steps };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
