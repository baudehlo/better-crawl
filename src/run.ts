import type { Artifact } from './artifact.js';
import { BetterCrawlError } from './errors.js';
import { runGeneration } from './generate.js';
import { CrawlHandle, type HandleController } from './handle.js';
import { healArtifact } from './heal/heal.js';
import { createLlmClient } from './llm/client.js';
import { executeArtifact, type ExecuteOptions } from './runtime/execute.js';
import type { RunOptions, RunResult } from './types.js';
import { DEFAULT_USER_AGENT } from './version.js';

/**
 * Replay a saved artifact. Zero LLM cost on the happy path; with heal enabled,
 * drift triggers a repair (selector patch → regen → optionally full re-scout)
 * and the updated artifact is surfaced via the `artifact-updated` event and the
 * resolved RunResult.
 *
 * A failed run without heal resolves normally with `report.ok === false` —
 * inspect the report rather than relying on a rejection.
 */
export function runCrawler(artifact: Artifact, opts: RunOptions = {}): CrawlHandle<RunResult> {
  return new CrawlHandle<RunResult>((ctl) => runReplay(artifact, opts, ctl), opts.signal);
}

async function runReplay(
  artifact: Artifact,
  opts: RunOptions,
  ctl: HandleController,
): Promise<RunResult> {
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const execOpts: ExecuteOptions = {
    ...(opts.schemas !== undefined ? { schemas: opts.schemas } : {}),
    inputs: opts.inputs ?? {},
    emitEvent: (e) => ctl.emit(e),
    limits: opts.limits ?? {},
    signal: ctl.signal,
    ignoreRobots: opts.ignoreRobots ?? false,
    userAgent,
    ...(opts.moduleDir !== undefined ? { moduleDir: opts.moduleDir } : {}),
    screenshots: opts.screenshots ?? false,
    ...(opts.screenshotDir !== undefined ? { screenshotDir: opts.screenshotDir } : {}),
    ...(opts.pageEvents !== undefined ? { pageEvents: opts.pageEvents } : {}),
    headless: opts.headless ?? true,
    ...(opts.proxy !== undefined ? { proxy: opts.proxy } : {}),
    ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
    ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
    ...(opts.browser !== undefined ? { browser: opts.browser } : {}),
    phase: 'run',
  };

  ctl.emit({
    type: 'progress',
    phase: 'run',
    message: `running ${artifact.manifest.engine} crawler against ${artifact.manifest.entryUrl}`,
  });
  const outcome = await executeArtifact(artifact, execOpts);

  if (outcome.report.ok || !opts.heal) {
    return { artifact, healed: false, items: outcome.items, report: outcome.report };
  }

  if (!opts.model) {
    throw new BetterCrawlError(
      'This run failed and heal is enabled, but no model was provided — pass a LanguageModel via opts.model',
      'HEAL_NEEDS_MODEL',
    );
  }
  const llm = opts.llmClient ?? createLlmClient();

  // heal: 'full' — a complete re-scout, allowed to switch engine. Needs the
  // caller's real zod schemas (the scout validates sample extractions with them).
  if (opts.heal === 'full') {
    if (!opts.schemas) {
      throw new BetterCrawlError(
        "heal: 'full' re-runs the scout, which needs your zod schemas — pass opts.schemas",
        'HEAL_FULL_NEEDS_SCHEMAS',
      );
    }
    ctl.emit({ type: 'progress', phase: 'heal', message: 'full re-scout of the site' });
    const regenerated = await runGeneration(
      {
        url: artifact.manifest.entryUrl,
        instructions: artifact.manifest.instructions,
        schemas: opts.schemas,
        model: opts.model,
        llmClient: llm,
        inputs: opts.inputs ?? {},
        ...(opts.limits !== undefined ? { limits: opts.limits } : {}),
        ignoreRobots: opts.ignoreRobots ?? false,
        userAgent,
        ...(opts.moduleDir !== undefined ? { moduleDir: opts.moduleDir } : {}),
        screenshots: opts.screenshots ?? false,
        ...(opts.screenshotDir !== undefined ? { screenshotDir: opts.screenshotDir } : {}),
        ...(opts.pageEvents !== undefined ? { pageEvents: opts.pageEvents } : {}),
        headless: opts.headless ?? true,
        ...(opts.proxy !== undefined ? { proxy: opts.proxy } : {}),
        ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
        ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
        ...(opts.browser !== undefined ? { browser: opts.browser } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      },
      ctl,
    );
    ctl.emit({ type: 'artifact-updated', artifact: regenerated.artifact });
    return {
      artifact: regenerated.artifact,
      healed: true,
      items: regenerated.items,
      report: regenerated.report,
    };
  }

  const healed = await healArtifact({
    artifact,
    llm,
    model: opts.model,
    failedOutcome: outcome,
    emitEvent: (e) => ctl.emit(e),
    signal: ctl.signal,
    healAttempts: opts.healAttempts ?? 2,
    execOpts: { ...execOpts, phase: 'heal' },
    userAgent,
  });
  ctl.emit({ type: 'artifact-updated', artifact: healed.artifact });
  return {
    artifact: healed.artifact,
    healed: true,
    items: healed.outcome.items,
    report: healed.outcome.report,
  };
}
