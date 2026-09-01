import type { SelfTestResult } from './selftest.js';

export interface DigestContext {
  attempt: number;
  maxAttempts: number;
  /** Condensed rendering of the page where the failure happened, if available. */
  freshPage?: string;
}

const MAX_RAW_SAMPLE_CHARS = 300;
const MAX_FRESH_PAGE_CHARS = 4_000;
const TOP_ISSUE_COUNT = 3;

/**
 * Summarize a failing self-test into a compact (~2k token) repair prompt
 * section. Deliberately terse: the repair model needs the shape of the failure,
 * not a transcript.
 */
export function buildFailureDigest(result: SelfTestResult, ctx: DigestContext): string {
  const lines: string[] = [
    `SELF-TEST FAILED (attempt ${ctx.attempt}/${ctx.maxAttempts})`,
  ];

  if (result.lintErrors.length > 0) {
    lines.push('Static lint errors (fix these — the code was not run):');
    for (const error of result.lintErrors) lines.push(`- ${error}`);
    return lines.join('\n');
  }

  const report = result.report;
  if (!report) return lines.join('\n');

  if (report.runtimeError) {
    const { message, stack, failedSelector } = report.runtimeError;
    lines.push(`Runtime error: ${message}`);
    const moduleFrame = stack
      .split('\n')
      .find((frame) => frame.includes('crawl-') && frame.includes('.mjs'));
    if (moduleFrame) lines.push(`  ${moduleFrame.trim()}`);
    if (failedSelector) {
      lines.push(
        `  Failed selector name: "${failedSelector}" — if the page structure moved, fix the selector CSS, not the logic.`,
      );
    }
  }

  const counts = Object.entries(report.itemCounts)
    .map(([schema, count]) => {
      const invalid = report.invalidItems.filter((i) => i.schema === schema).length;
      return invalid > 0 ? `${schema}: ${count} valid / ${invalid} invalid` : `${schema}: ${count}`;
    })
    .join('.  ');
  lines.push(`Items: ${counts || '(none)'}`);

  for (const failure of report.assertionFailures) {
    lines.push(`Assertion FAILED: ${JSON.stringify(failure.assertion)} — actual: ${failure.actual}`);
  }

  if (report.invalidItems.length > 0) {
    const grouped = new Map<string, { count: number; raw: unknown }>();
    for (const invalid of report.invalidItems) {
      for (const issue of invalid.issues) {
        const key = `${invalid.schema}.${issue.path.join('.')} — ${issue.message}`;
        const entry = grouped.get(key);
        if (entry) entry.count += 1;
        else grouped.set(key, { count: 1, raw: invalid.raw });
      }
    }
    const top = [...grouped.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, TOP_ISSUE_COUNT);
    lines.push('Top validation issues:');
    for (const [key, { count, raw }] of top) {
      let sample = '';
      try {
        sample = JSON.stringify(raw).slice(0, MAX_RAW_SAMPLE_CHARS);
      } catch {
        sample = String(raw).slice(0, MAX_RAW_SAMPLE_CHARS);
      }
      lines.push(`- ${key} ×${count} (raw sample: ${sample})`);
    }
  }

  if (report.progressTrail.length > 0) {
    lines.push(`Progress trail: ${report.progressTrail.join(' → ')} → ✖`);
  }
  lines.push(`Pages visited: ${report.pagesVisited}, duration: ${report.durationMs}ms`);

  if (ctx.freshPage) {
    lines.push(
      'Fresh page (condensed) where it failed:',
      ctx.freshPage.slice(0, MAX_FRESH_PAGE_CHARS),
    );
  }

  return lines.join('\n');
}
