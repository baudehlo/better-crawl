import type { ModelMessage } from 'ai';
import { z } from 'zod';
import {
  Artifact,
  ARTIFACT_FORMAT_VERSION,
  type ArtifactManifest,
  type Assertion,
  type JsonSchemaObject,
} from './artifact.js';
import { runCodegenCall, type CodegenOutput } from './codegen/codegen.js';
import { buildCodegenSystemPrompt, buildCodegenUserMessage } from './codegen/prompts.js';
import { GenerationFailedError } from './errors.js';
import { CrawlHandle, type HandleController } from './handle.js';
import { createLlmClient, type LlmUsage } from './llm/client.js';
import { DEFAULT_LIMITS } from './runtime/execute.js';
import type { ScoutFindings } from './scout/findings.js';
import { runScout } from './scout/scout.js';
import { buildFailureDigest } from './selftest/digest.js';
import { runSelfTest, type SelfTestResult } from './selftest/selftest.js';
import type { GenerateOptions, GenerateResult, RunReport } from './types.js';
import { DEFAULT_USER_AGENT, VERSION } from './version.js';

/**
 * The whole point of the library: explore once with an LLM, emit a reusable
 * artifact, and only return it after it has passed a live self-test.
 */
export function generateCrawler(opts: GenerateOptions): CrawlHandle<GenerateResult> {
  return new CrawlHandle<GenerateResult>(
    (ctl) => runGeneration(opts, ctl),
    opts.signal,
  );
}

/** Exported for internal reuse by heal: 'full' (a complete re-scout). */
export async function runGeneration(
  opts: GenerateOptions,
  ctl: HandleController,
): Promise<GenerateResult> {
  const llm = opts.llmClient ?? createLlmClient();
  const inputs = opts.inputs ?? {};
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const maxRepairAttempts = opts.maxRepairAttempts ?? 3;
  const totalAttempts = 1 + maxRepairAttempts;
  const limits = {
    maxPages: opts.limits?.maxPages ?? DEFAULT_LIMITS.maxPages,
    delayMs: opts.limits?.delayMs ?? DEFAULT_LIMITS.delayMs,
  };
  const totalUsage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  const addUsage = (usage: LlmUsage) => {
    totalUsage.inputTokens += usage.inputTokens;
    totalUsage.outputTokens += usage.outputTokens;
  };

  // ---- Phase 1: scout -------------------------------------------------------
  ctl.emit({ type: 'progress', phase: 'scout', message: `exploring ${opts.url}` });
  const scout = await runScout({
    llm,
    model: opts.model,
    url: opts.url,
    instructions: opts.instructions,
    schemas: opts.schemas,
    inputs,
    emitEvent: (e) => ctl.emit(e),
    signal: ctl.signal,
    maxSteps: opts.maxScoutSteps ?? 40,
    limits,
    ignoreRobots: opts.ignoreRobots ?? false,
    userAgent,
    screenshots: opts.screenshots ?? false,
    ...(opts.screenshotDir !== undefined ? { screenshotDir: opts.screenshotDir } : {}),
    headless: opts.headless ?? true,
  });
  addUsage(scout.usage);
  ctl.emit({
    type: 'progress',
    phase: 'scout',
    message: `scout done in ${scout.steps} steps — engine: ${scout.findings.engine}`,
  });

  // ---- Phase 2..N: codegen → self-test → repair ----------------------------
  const messages: ModelMessage[] = [
    { role: 'system', content: buildCodegenSystemPrompt(scout.findings.engine) },
    {
      role: 'user',
      content: buildCodegenUserMessage({
        instructions: opts.instructions,
        entryUrl: opts.url,
        schemas: opts.schemas,
        findings: scout.findings,
      }),
    },
  ];

  let lastArtifact: Artifact | undefined;
  const reports: RunReport[] = [];

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const phase = attempt === 1 ? 'codegen' : 'repair';
    ctl.emit({
      type: 'progress',
      phase,
      message: attempt === 1 ? 'writing crawler code' : `repairing (attempt ${attempt}/${totalAttempts})`,
    });

    let output: CodegenOutput;
    try {
      const call = await runCodegenCall({
        llm,
        model: attempt === 1 ? opts.model : (opts.repairModel ?? opts.model),
        messages,
        signal: ctl.signal,
      });
      output = call.output;
      addUsage(call.usage);
      ctl.emit({
        type: 'llm-usage',
        phase,
        inputTokens: call.usage.inputTokens,
        outputTokens: call.usage.outputTokens,
      });
    } catch (err) {
      // Truncated/refused output is repair-eligible like any other failure.
      if (attempt >= totalAttempts) throw err;
      messages.push({
        role: 'user',
        content:
          `Your previous response failed: ${(err as Error).message}\n` +
          `Return the complete JSON object again. Keep the code SHORT — lean on the ctx helpers.`,
      });
      continue;
    }

    const artifact = assembleArtifact({
      output,
      findings: scout.findings,
      opts,
      attempt,
      scoutSteps: scout.steps,
      usage: totalUsage,
    });
    lastArtifact = artifact;

    ctl.emit({ type: 'progress', phase: 'selftest', message: `self-testing against ${opts.url}` });
    const result: SelfTestResult = await runSelfTest(artifact, {
      schemas: opts.schemas,
      inputs,
      emitEvent: (e) => ctl.emit(e),
      limits: opts.limits ?? {},
      signal: ctl.signal,
      ignoreRobots: opts.ignoreRobots ?? false,
      userAgent,
      ...(opts.moduleDir !== undefined ? { moduleDir: opts.moduleDir } : {}),
      screenshots: opts.screenshots ?? false,
      ...(opts.screenshotDir !== undefined ? { screenshotDir: opts.screenshotDir } : {}),
      headless: opts.headless ?? true,
      phase: 'selftest',
    });
    if (result.report) reports.push(result.report);

    if (result.passed && result.report) {
      const final = withFinalStats(artifact, {
        attempt,
        scoutSteps: scout.steps,
        report: result.report,
        usage: totalUsage,
        model: describeModel(opts.model),
      });
      ctl.emit({
        type: 'progress',
        phase: 'selftest',
        message: `self-test passed: ${Object.entries(result.report.itemCounts)
          .map(([schema, count]) => `${schema}=${count}`)
          .join(', ')}`,
      });
      return { artifact: final, items: result.items ?? {}, report: result.report };
    }

    const digest = buildFailureDigest(result, {
      attempt,
      maxAttempts: totalAttempts,
      ...(result.failurePage !== undefined ? { freshPage: result.failurePage } : {}),
    });
    ctl.emit({
      type: 'log',
      level: 'warn',
      message: `self-test failed (attempt ${attempt}/${totalAttempts})`,
    });
    messages.push({ role: 'assistant', content: JSON.stringify(output) });
    messages.push({
      role: 'user',
      content: `${digest}\n\nFix the problem and return the complete corrected JSON object (full code, not a diff).`,
    });
  }

  throw new GenerationFailedError<Artifact, RunReport>(
    `Generation failed: the crawler did not pass its self-test after ${totalAttempts} attempt(s). ` +
      `The last artifact and all test reports are attached to this error.`,
    lastArtifact,
    reports,
  );
}

function describeModel(model: GenerateOptions['model']): string {
  if (typeof model === 'string') return model;
  const m = model as { modelId?: string };
  return m.modelId ?? 'unknown-model';
}

function assembleArtifact(args: {
  output: CodegenOutput;
  findings: ScoutFindings;
  opts: GenerateOptions;
  attempt: number;
  scoutSteps: number;
  usage: LlmUsage;
}): Artifact {
  const { output, findings, opts } = args;

  // The library overrides what it verified itself (observation over assertion).
  const engine = findings.engine;

  const selectors: ArtifactManifest['selectors'] = {};
  for (const [name, def] of Object.entries(output.selectors)) {
    let sampleText = findings.selectorSamples[name];
    if (sampleText === undefined) {
      // codegen may have reused the scout's CSS under a different name
      const scoutName = Object.entries(findings.selectors).find(
        ([, scoutDef]) => scoutDef.css === def.css,
      )?.[0];
      if (scoutName !== undefined) sampleText = findings.selectorSamples[scoutName];
    }
    selectors[name] = {
      css: def.css,
      description: def.description,
      expect: def.expect,
      ...(sampleText !== undefined ? { sampleText } : {}),
    };
  }

  const inputsByName = new Map(output.inputs.map((input) => [input.name, input]));
  for (const needed of findings.inputsNeeded) {
    if (!inputsByName.has(needed.name)) {
      inputsByName.set(needed.name, { ...needed, required: true });
    }
  }

  const assertions: Assertion[] = [];
  const seenMinItems = new Set<string>();
  for (const assertion of output.assertions) {
    if (assertion.kind === 'minItems') {
      seenMinItems.add(assertion.schema);
      const expected = findings.expectedCounts[assertion.schema];
      if (expected !== undefined && expected > 0) {
        assertions.push({
          ...assertion,
          min: Math.max(1, Math.floor(expected * 0.6)),
        });
        continue;
      }
    }
    assertions.push(assertion);
  }
  for (const [schema, expected] of Object.entries(findings.expectedCounts)) {
    if (!seenMinItems.has(schema) && expected > 0 && schema in opts.schemas) {
      assertions.push({
        kind: 'minItems',
        schema,
        min: Math.max(1, Math.floor(expected * 0.6)),
      });
    }
  }

  const schemas: Record<string, JsonSchemaObject> = {};
  for (const [name, schema] of Object.entries(opts.schemas)) {
    schemas[name] = z.toJSONSchema(schema) as JsonSchemaObject;
  }

  const manifest: ArtifactManifest = {
    formatVersion: ARTIFACT_FORMAT_VERSION,
    generator: { library: 'better-crawl', version: VERSION },
    engine,
    entryUrl: opts.url,
    instructions: opts.instructions,
    inputs: [...inputsByName.values()],
    selectors,
    schemas,
    assertions,
    stats: {
      generatedAt: new Date().toISOString(),
      model: describeModel(opts.model),
      attempts: args.attempt,
      scoutSteps: args.scoutSteps,
      testItemCounts: {},
      testPagesVisited: 0,
      testDurationMs: 0,
      tokens: { input: args.usage.inputTokens, output: args.usage.outputTokens },
    },
  };

  return new Artifact(manifest, output.code);
}

function withFinalStats(
  artifact: Artifact,
  args: {
    attempt: number;
    scoutSteps: number;
    report: RunReport;
    usage: LlmUsage;
    model: string;
  },
): Artifact {
  const manifest: ArtifactManifest = {
    ...artifact.manifest,
    stats: {
      generatedAt: new Date().toISOString(),
      model: args.model,
      attempts: args.attempt,
      scoutSteps: args.scoutSteps,
      testItemCounts: { ...args.report.itemCounts },
      testPagesVisited: args.report.pagesVisited,
      testDurationMs: args.report.durationMs,
      tokens: { input: args.usage.inputTokens, output: args.usage.outputTokens },
    },
  };
  return new Artifact(manifest, artifact.code);
}
