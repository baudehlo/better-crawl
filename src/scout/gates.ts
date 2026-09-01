import type { ItemValidator } from '../runtime/validate.js';
import type { ReportFindingsPayload } from './findings.js';

export interface SelectorEvidence {
  count: number;
  sampleText?: string;
}

export interface GateEvidence {
  /** css → live verification result (from try_selector calls + auto-verification). */
  verifiedSelectors: Map<string, SelectorEvidence>;
  /** Condensed text of every successful probe_no_js call. */
  probeTexts: string[];
  validator: ItemValidator;
}

/**
 * Library-side validation of a report_findings payload. Returns a
 * "REJECTED: <reason> <what to do instead>" string for the model to
 * self-correct on, or null when the report is acceptable.
 *
 * Trust observation over assertion: engine "cheerio" is only accepted when OUR
 * tool-call log shows a no-JS probe whose content contained the sample data.
 */
export function checkFindings(
  payload: ReportFindingsPayload,
  evidence: GateEvidence,
): string | null {
  for (const [name, def] of Object.entries(payload.selectors)) {
    const verification = evidence.verifiedSelectors.get(def.css);
    if (!verification) {
      return (
        `REJECTED: selector "${name}" (${def.css}) was never verified. ` +
        `Use try_selector on the page where it applies, then re-report.`
      );
    }
    if (verification.count === 0) {
      return (
        `REJECTED: selector "${name}" (${def.css}) matched 0 elements when verified. ` +
        `Use try_selector to find a working selector, then re-report.`
      );
    }
  }

  for (const schemaName of Object.keys(payload.sampleItems)) {
    if (!evidence.validator.schemaNames.includes(schemaName)) {
      return (
        `REJECTED: sampleItems references unknown schema "${schemaName}". ` +
        `Valid schema names: ${evidence.validator.schemaNames.join(', ')}.`
      );
    }
  }

  for (const schemaName of evidence.validator.schemaNames) {
    const samples = payload.sampleItems[schemaName] ?? [];
    if (samples.length < 2) {
      return (
        `REJECTED: schema "${schemaName}" needs at least 2 sample items extracted ` +
        `from actual page content (got ${samples.length}). Read the pages and re-report.`
      );
    }
    for (const sample of samples) {
      const result = evidence.validator.validate(schemaName, sample);
      if (!result.ok) {
        const first = result.issues[0];
        return (
          `REJECTED: sample item for schema "${schemaName}" is invalid — ` +
          `${first?.path.join('.') ?? '?'}: ${first?.message ?? 'unknown issue'} ` +
          `(sample: ${JSON.stringify(sample).slice(0, 200)}). ` +
          `Extract the sample again with correct types (numbers as numbers, not strings).`
        );
      }
    }
  }

  if (payload.engine === 'cheerio') {
    if (evidence.probeTexts.length === 0) {
      return (
        `REJECTED: engine "cheerio" requires a successful probe_no_js call proving the ` +
        `target data exists in raw HTML. Call probe_no_js on a key page first, or report ` +
        `engine "playwright".`
      );
    }
    if (!probeContainsSampleData(payload, evidence.probeTexts)) {
      return (
        `REJECTED: engine "cheerio" was reported but none of your sample values appear ` +
        `in the no-JS probe output — the data is likely rendered by JavaScript. ` +
        `Report engine "playwright" instead.`
      );
    }
  }

  return null;
}

/** At least one meaty string value from the samples must appear in a probe. */
function probeContainsSampleData(
  payload: ReportFindingsPayload,
  probeTexts: string[],
): boolean {
  const values: string[] = [];
  for (const samples of Object.values(payload.sampleItems)) {
    for (const sample of samples) {
      for (const value of Object.values(sample)) {
        if (typeof value === 'string' && value.trim().length > 3) {
          values.push(value.trim());
        }
      }
    }
  }
  if (values.length === 0) return false;
  return values.some((value) => probeTexts.some((text) => text.includes(value)));
}
