import type { LanguageModel, ModelMessage } from 'ai';
import { z } from 'zod';
import { Artifact, type ArtifactManifest } from '../artifact.js';
import { runCodegenCall, type CodegenOutput } from '../codegen/codegen.js';
import { buildCodegenSystemPrompt } from '../codegen/prompts.js';
import { HealFailedError } from '../errors.js';
import type { CrawlEvent } from '../events.js';
import type { LlmClient } from '../llm/client.js';
import { condenseHtml } from '../llm/condense.js';
import { executeArtifact, type ExecuteOptions, type ExecuteOutcome } from '../runtime/execute.js';
import { buildFailureDigest } from '../selftest/digest.js';
import { lintArtifact } from '../selftest/lint.js';
import type { RunReport } from '../types.js';

export type FailureClass = 'selector' | 'structural';

/**
 * Selector-class failures get the cheap repair: a named selector missed, or a
 * clean run found zero items (classic reskin). Everything else is structural.
 */
export function classifyFailure(report: RunReport): FailureClass {
  if (report.runtimeError?.failedSelector !== undefined) return 'selector';
  if (!report.runtimeError && report.assertionFailures.length > 0) {
    const zeroItems = Object.values(report.itemCounts).every((count) => count === 0);
    if (zeroItems) return 'selector';
  }
  return 'structural';
}

const selectorPatchSchema = z.object({
  selectors: z.record(z.string(), z.object({ css: z.string().min(1) })),
  reasoning: z.string(),
});

export interface HealOptions {
  artifact: Artifact;
  llm: LlmClient;
  model: LanguageModel;
  failedOutcome: ExecuteOutcome;
  emitEvent: (event: CrawlEvent) => void;
  signal: AbortSignal;
  healAttempts: number;
  execOpts: ExecuteOptions;
  userAgent: string;
}

export interface HealResult {
  artifact: Artifact;
  outcome: ExecuteOutcome;
}

/**
 * Repair a drifted artifact: selector-only patch first (few hundred tokens,
 * code untouched), then scout-lite full regeneration from the old artifact +
 * failure context. Throws HealFailedError when the budget runs out.
 */
export async function healArtifact(opts: HealOptions): Promise<HealResult> {
  const reports: RunReport[] = [opts.failedOutcome.report];
  let budget = opts.healAttempts;
  const freshPage = await resolveFreshPage(opts);

  if (budget > 0 && classifyFailure(opts.failedOutcome.report) === 'selector') {
    budget -= 1;
    opts.emitEvent({
      type: 'progress',
      phase: 'heal',
      message: 'selector drift suspected — attempting selector-only repair',
    });
    const patched = await selectorRepair(opts, freshPage);
    const outcome = await executeArtifact(patched, { ...opts.execOpts, phase: 'heal' });
    reports.push(outcome.report);
    if (outcome.report.ok) {
      opts.emitEvent({ type: 'progress', phase: 'heal', message: 'selector-only repair passed' });
      return { artifact: patched, outcome };
    }
    opts.emitEvent({
      type: 'log',
      level: 'warn',
      message: 'selector-only repair did not pass — escalating to full regeneration',
    });
  }

  // Scout-lite regeneration: rebuild the codegen conversation from the old
  // artifact + failure context; the engine and assertions never drift here.
  const messages: ModelMessage[] = [
    { role: 'system', content: buildCodegenSystemPrompt(opts.artifact.manifest.engine) },
    { role: 'user', content: buildRegenUserMessage(opts.artifact, reports.at(-1)!, freshPage) },
  ];

  while (budget > 0) {
    budget -= 1;
    opts.emitEvent({ type: 'progress', phase: 'heal', message: 'regenerating crawler code' });
    const { output, usage } = await runCodegenCall({
      llm: opts.llm,
      model: opts.model,
      messages,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    opts.emitEvent({
      type: 'llm-usage',
      phase: 'heal',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });

    const candidate = assembleHealedArtifact(opts.artifact, output);
    const lintErrors = lintArtifact(candidate);
    if (lintErrors.length > 0) {
      messages.push({ role: 'assistant', content: JSON.stringify(output) });
      messages.push({
        role: 'user',
        content: `Static lint failed:\n${lintErrors.map((e) => `- ${e}`).join('\n')}\nReturn the corrected full JSON object.`,
      });
      continue;
    }

    const outcome = await executeArtifact(candidate, { ...opts.execOpts, phase: 'heal' });
    reports.push(outcome.report);
    if (outcome.report.ok) {
      opts.emitEvent({ type: 'progress', phase: 'heal', message: 'regenerated crawler passed' });
      return { artifact: candidate, outcome };
    }

    messages.push({ role: 'assistant', content: JSON.stringify(output) });
    messages.push({
      role: 'user',
      content: `${buildFailureDigest(
        { passed: false, lintErrors: [], report: outcome.report },
        {
          attempt: opts.healAttempts - budget,
          maxAttempts: opts.healAttempts,
          ...(outcome.failurePage !== undefined ? { freshPage: outcome.failurePage } : {}),
        },
      )}\n\nFix the problem and return the complete corrected JSON object.`,
    });
  }

  throw new HealFailedError<RunReport>(
    `Healing failed after ${opts.healAttempts} attempt(s); the site may have changed too much. ` +
      `Consider heal: 'full' (complete re-scout) or regenerating the crawler.`,
    reports,
  );
}

async function resolveFreshPage(opts: HealOptions): Promise<string | undefined> {
  if (opts.failedOutcome.failurePage !== undefined) return opts.failedOutcome.failurePage;
  // Best-effort: a no-JS fetch of the entry page. For playwright-engine sites
  // this may miss rendered content, but structural signal beats nothing.
  try {
    const res = await fetch(opts.artifact.manifest.entryUrl, {
      headers: { 'user-agent': opts.userAgent },
      signal: opts.signal,
    });
    return condenseHtml(await res.text(), res.url || opts.artifact.manifest.entryUrl);
  } catch {
    return undefined;
  }
}

async function selectorRepair(opts: HealOptions, freshPage: string | undefined): Promise<Artifact> {
  const { manifest } = opts.artifact;
  const table = Object.entries(manifest.selectors)
    .map(
      ([name, def]) =>
        `- ${name}: ${JSON.stringify(def.css)} (${def.expect}) — ${def.description}` +
        (def.sampleText ? ` — matched this at generation time: ${JSON.stringify(def.sampleText)}` : ''),
    )
    .join('\n');

  const digest = buildFailureDigest(
    { passed: false, lintErrors: [], report: opts.failedOutcome.report },
    { attempt: 1, maxAttempts: 1 },
  );

  const messages: ModelMessage[] = [
    {
      role: 'system',
      content:
        'You repair broken CSS selectors for an existing web crawler. The crawler logic is ' +
        'unchanged and correct; the site markup drifted. Using the failure report and the ' +
        'fresh page content, return the corrected CSS for EVERY selector name (keep the ones ' +
        'that still look right unchanged). Prefer stable class/attribute selectors.',
    },
    {
      role: 'user',
      content: `## Current selectors\n${table}\n\n## Failure\n${digest}\n\n## Fresh page (condensed)\n${
        freshPage ?? '(no fresh page available)'
      }\n\nReturn the corrected selectors.`,
    },
  ];

  const { object, usage } = await opts.llm.generateObject({
    model: opts.model,
    messages,
    schema: selectorPatchSchema,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  opts.emitEvent({
    type: 'llm-usage',
    phase: 'heal',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });

  const selectors: ArtifactManifest['selectors'] = {};
  for (const [name, def] of Object.entries(manifest.selectors)) {
    const patch = object.selectors[name];
    selectors[name] = patch ? { ...def, css: patch.css } : def;
  }
  return new Artifact({ ...manifest, selectors }, opts.artifact.code);
}

function buildRegenUserMessage(
  artifact: Artifact,
  lastReport: RunReport,
  freshPage: string | undefined,
): string {
  const { manifest } = artifact;
  const digest = buildFailureDigest(
    { passed: false, lintErrors: [], report: lastReport },
    { attempt: 1, maxAttempts: 1 },
  );
  return `An existing crawler for this site broke after the site changed. Rewrite it.

## Original task
${manifest.instructions}

## Entry URL
${manifest.entryUrl}

## Target schemas (JSON Schema)
${Object.entries(manifest.schemas)
  .map(([name, schema]) => `### ${name}\n${JSON.stringify(schema)}`)
  .join('\n\n')}

## The old manifest selectors
${JSON.stringify(manifest.selectors, null, 2)}

## The old code (worked before the site changed)
\`\`\`js
${artifact.code}
\`\`\`

## Why it now fails
${digest}

## Fresh page (condensed)
${freshPage ?? '(unavailable)'}

Keep the same engine (${manifest.engine}) and the same general approach unless the failure says otherwise. Write the corrected crawler now.`;
}

function assembleHealedArtifact(old: Artifact, output: CodegenOutput): Artifact {
  const selectors: ArtifactManifest['selectors'] = {};
  for (const [name, def] of Object.entries(output.selectors)) {
    const previous = old.manifest.selectors[name];
    selectors[name] = {
      css: def.css,
      description: def.description,
      expect: def.expect,
      // keep the old anchor when the selector survived under the same name
      ...(previous?.sampleText !== undefined && previous.css === def.css
        ? { sampleText: previous.sampleText }
        : {}),
    };
  }
  const manifest: ArtifactManifest = {
    ...old.manifest,
    // engine and assertions deliberately do NOT drift during scout-lite healing
    selectors,
    inputs: output.inputs,
    stats: { ...old.manifest.stats, generatedAt: new Date().toISOString() },
  };
  return new Artifact(manifest, output.code);
}
