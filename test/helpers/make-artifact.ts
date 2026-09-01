import {
  ARTIFACT_FORMAT_VERSION,
  Artifact,
  type ArtifactManifest,
} from '../../src/artifact.js';

/** Build a valid artifact with overridable pieces, for tests. */
export function makeArtifact(
  overrides: Partial<ArtifactManifest> = {},
  code = 'export default async function crawl(ctx) {}\n',
): Artifact {
  const manifest: ArtifactManifest = {
    formatVersion: ARTIFACT_FORMAT_VERSION,
    generator: { library: 'better-crawl', version: '0.0.0-test' },
    engine: 'cheerio',
    entryUrl: 'http://127.0.0.1:1/',
    instructions: 'test',
    inputs: [],
    selectors: {},
    schemas: {},
    assertions: [],
    stats: {
      generatedAt: new Date(0).toISOString(),
      model: 'fake',
      attempts: 1,
      scoutSteps: 0,
      testItemCounts: {},
      testPagesVisited: 0,
      testDurationMs: 0,
      tokens: { input: 0, output: 0 },
    },
    ...overrides,
  };
  return new Artifact(manifest, code);
}
