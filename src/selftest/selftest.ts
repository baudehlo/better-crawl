import type { Artifact } from '../artifact.js';
import { executeArtifact, type ExecuteOptions } from '../runtime/execute.js';
import type { RunReport } from '../types.js';
import { lintArtifact } from './lint.js';

export interface SelfTestResult {
  passed: boolean;
  lintErrors: string[];
  /** Absent when lint failed (no live run was attempted). */
  report?: RunReport;
  items?: Record<string, unknown[]>;
  /** Condensed page from the failure moment, when one was captured. */
  failurePage?: string;
}

/**
 * The generate→test gate: static lint first (cheap failures never touch the
 * site), then a full live execution checked against schemas and assertions.
 */
export async function runSelfTest(
  artifact: Artifact,
  opts: ExecuteOptions,
): Promise<SelfTestResult> {
  const lintErrors = lintArtifact(artifact);
  if (lintErrors.length > 0) {
    return { passed: false, lintErrors };
  }
  const { report, items, failurePage } = await executeArtifact(artifact, {
    ...opts,
    phase: opts.phase ?? 'selftest',
  });
  return {
    passed: report.ok,
    lintErrors: [],
    report,
    items,
    ...(failurePage !== undefined ? { failurePage } : {}),
  };
}
