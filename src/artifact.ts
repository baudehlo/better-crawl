import { z } from 'zod';
import { ArtifactFormatError } from './errors.js';

export const ARTIFACT_FORMAT_VERSION = 1;

export interface ArtifactInput {
  /** e.g. "username" — referenced by generated code as ctx.input('username') */
  name: string;
  /** Human-readable purpose, written at generation time. */
  description: string;
  /** Secret values are scrubbed from all LLM-bound content and never serialized. */
  secret: boolean;
  required: boolean;
}

export interface SelectorDef {
  /** The only field mutated during selector-only healing. */
  css: string;
  /** What this selector points at, e.g. "the next-page button". */
  description: string;
  /** Cardinality hint used by self-test and healing. */
  expect: 'one' | 'many' | 'maybe';
  /** Trimmed text of the first match at generation time — anchors healing. */
  sampleText?: string;
}

export type Assertion =
  | { kind: 'minItems'; schema: string; min: number }
  | { kind: 'fieldCoverage'; schema: string; field: string; minRatio: number }
  | { kind: 'urlReached'; pattern: string }
  | { kind: 'maxDurationMs'; ms: number };

export interface GenerationStats {
  generatedAt: string;
  model: string;
  /** Self-test attempts consumed (1 = passed first try). */
  attempts: number;
  scoutSteps: number;
  /** Item counts observed on the passing self-test run, keyed by schema name. */
  testItemCounts: Record<string, number>;
  testPagesVisited: number;
  testDurationMs: number;
  tokens: { input: number; output: number };
}

/** A JSON Schema object as produced by zod's z.toJSONSchema. */
export type JsonSchemaObject = Record<string, unknown>;

export interface ArtifactManifest {
  formatVersion: typeof ARTIFACT_FORMAT_VERSION;
  generator: { library: 'better-crawl'; version: string };
  engine: 'playwright' | 'cheerio';
  entryUrl: string;
  /** The original natural-language task. */
  instructions: string;
  inputs: ArtifactInput[];
  /** name → definition; generated code refers to selectors only by name. */
  selectors: Record<string, SelectorDef>;
  /** JSON Schema copies of the user's zod schemas, keyed by schema name. */
  schemas: Record<string, JsonSchemaObject>;
  assertions: Assertion[];
  stats: GenerationStats;
}

const selectorDefSchema = z.object({
  css: z.string().min(1),
  description: z.string(),
  expect: z.enum(['one', 'many', 'maybe']),
  sampleText: z.string().optional(),
});

export const assertionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('minItems'), schema: z.string(), min: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal('fieldCoverage'),
    schema: z.string(),
    field: z.string(),
    minRatio: z.number().min(0).max(1),
  }),
  z.object({ kind: z.literal('urlReached'), pattern: z.string() }),
  z.object({ kind: z.literal('maxDurationMs'), ms: z.number().positive() }),
]);

const manifestSchema = z.object({
  formatVersion: z.number().int(),
  generator: z.object({ library: z.literal('better-crawl'), version: z.string() }),
  engine: z.enum(['playwright', 'cheerio']),
  entryUrl: z.string(),
  instructions: z.string(),
  inputs: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string(),
      secret: z.boolean(),
      required: z.boolean(),
    }),
  ),
  selectors: z.record(z.string(), selectorDefSchema),
  schemas: z.record(z.string(), z.record(z.string(), z.unknown())),
  assertions: z.array(assertionSchema),
  stats: z.object({
    generatedAt: z.string(),
    model: z.string(),
    attempts: z.number().int(),
    scoutSteps: z.number().int(),
    testItemCounts: z.record(z.string(), z.number()),
    testPagesVisited: z.number().int(),
    testDurationMs: z.number(),
    tokens: z.object({ input: z.number(), output: z.number() }),
  }),
});

export class Artifact {
  constructor(
    readonly manifest: ArtifactManifest,
    /** A plain ES module: `export default async function crawl(ctx) {...}` */
    readonly code: string,
  ) {}

  serialize(): string {
    return JSON.stringify({ manifest: this.manifest, code: this.code }, null, 2);
  }

  static parse(json: string): Artifact {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (err) {
      throw new ArtifactFormatError(
        `Artifact is not valid JSON: ${(err as Error).message}`,
      );
    }
    return artifactFromObject(raw);
  }
}

function artifactFromObject(raw: unknown): Artifact {
  if (typeof raw !== 'object' || raw === null) {
    throw new ArtifactFormatError('Artifact must be a JSON object');
  }
  const { manifest, code } = raw as { manifest?: unknown; code?: unknown };
  if (typeof code !== 'string' || code.length === 0) {
    throw new ArtifactFormatError('Artifact "code" must be a non-empty string');
  }
  const versioned = manifest as { formatVersion?: unknown } | undefined;
  if (versioned?.formatVersion !== ARTIFACT_FORMAT_VERSION) {
    throw new ArtifactFormatError(
      `Unsupported artifact formatVersion ${String(versioned?.formatVersion)} ` +
        `(this version of better-crawl supports ${ARTIFACT_FORMAT_VERSION})`,
    );
  }
  const parsed = manifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new ArtifactFormatError(
      `Artifact manifest is invalid: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return new Artifact(parsed.data as ArtifactManifest, code);
}

/** Load an artifact from a serialized JSON string or an already-parsed object. */
export function loadArtifact(
  source: string | { manifest: unknown; code: string },
): Artifact {
  return typeof source === 'string' ? Artifact.parse(source) : artifactFromObject(source);
}
