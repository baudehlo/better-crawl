#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { LanguageModel } from 'ai';
import type { z } from 'zod';
import { Artifact, loadArtifact } from './artifact.js';
import { generateCrawler } from './generate.js';
import type { CrawlHandle } from './handle.js';
import { runCrawler } from './run.js';
import type { Limits, RunResult, Schemas } from './types.js';
import { VERSION } from './version.js';

const USAGE = `better-crawl v${VERSION} — AI generates a crawler once; replays are near-free.

USAGE
  better-crawl generate <url> -i "<what to find>" --schema <file[#name]> --out crawler.json
  better-crawl run <crawler.json> [--heal | --heal-full] [--out items.ndjson]
  better-crawl heal <crawler.json> [--schema <file>]

COMMON OPTIONS
  --model <provider:id>     LLM to use (default anthropic:claude-opus-5; needs the
                            matching @ai-sdk/<provider> package installed and its API key env var)
  --schema <file[#name]>    JS/MJS module exporting zod schemas. Every zod export becomes a
                            named schema; "#name" limits it to one export. Repeatable.
  --input <name=value>      Value for a crawler input (repeatable)
  --input-env <name=VAR>    Read an input value from an environment variable (repeatable)
  --max-pages <n>           Page budget (default 100)
  --delay <ms>              Politeness delay between requests (default 500)
  --timeout <ms>            Wall-clock limit for a run (default 600000)
  --ignore-robots           Skip robots.txt checks
  --no-sandbox              Run artifact code in-process instead of the sandboxed child
  --headed                  Run the browser with a visible window
  --screenshots <dir>       Save screenshots to a directory
  --quiet                   Suppress progress output on stderr

generate OPTIONS
  -i, --instructions <txt>  What the crawler should find (required)
  --out <file>              Where to write the artifact (default crawler.json)
  --repair-attempts <n>     Self-test repair budget (default 3)
  --scout-steps <n>         Scout agent step budget (default 40)

run/heal OPTIONS
  --heal                    Repair the artifact if the site drifted (needs --model)
  --heal-full               Full re-scout repair (needs --model and --schema)
  --out <file>              Write items as NDJSON here (default: stdout)
  --save-healed <file>      Where to write a healed artifact (default: overwrite the input file)
`;

interface CliFlags {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
}

function parse(argv: string[]): CliFlags {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      instructions: { type: 'string', short: 'i' },
      schema: { type: 'string', multiple: true },
      out: { type: 'string' },
      model: { type: 'string' },
      input: { type: 'string', multiple: true },
      'input-env': { type: 'string', multiple: true },
      'max-pages': { type: 'string' },
      delay: { type: 'string' },
      timeout: { type: 'string' },
      'ignore-robots': { type: 'boolean' },
      'no-sandbox': { type: 'boolean' },
      headed: { type: 'boolean' },
      screenshots: { type: 'string' },
      quiet: { type: 'boolean' },
      'repair-attempts': { type: 'string' },
      'scout-steps': { type: 'string' },
      heal: { type: 'boolean' },
      'heal-full': { type: 'boolean' },
      'save-healed': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
}

async function resolveModel(spec: string | undefined): Promise<LanguageModel> {
  const [provider, ...rest] = (spec ?? 'anthropic:claude-opus-5').split(':');
  const modelId = rest.join(':');
  if (!provider || !modelId) {
    throw new Error(`--model must look like "provider:model-id" (got "${spec}")`);
  }
  const pkg = `@ai-sdk/${provider}`;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pkg)) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Model provider "${provider}" needs the ${pkg} package. Install it with: npm install ${pkg}`,
    );
  }
  const factory = mod[provider] ?? mod['default'];
  if (typeof factory !== 'function') {
    throw new Error(`${pkg} does not export a "${provider}" model factory`);
  }
  return (factory as (id: string) => LanguageModel)(modelId);
}

function isZodSchema(value: unknown): value is z.ZodType {
  return (
    typeof value === 'object' &&
    value !== null &&
    'safeParse' in value &&
    typeof (value as { safeParse: unknown }).safeParse === 'function'
  );
}

async function loadSchemas(specs: string[] | undefined): Promise<Schemas | undefined> {
  if (!specs || specs.length === 0) return undefined;
  const schemas: Schemas = {};
  for (const spec of specs) {
    const [file, fragment] = spec.split('#');
    if (!file) throw new Error(`Bad --schema value: ${spec}`);
    const mod = (await import(pathToFileURL(path.resolve(file)).href)) as Record<string, unknown>;
    const entries = fragment
      ? [[fragment, mod[fragment]] as const]
      : Object.entries(mod).filter(([name]) => name !== 'default');
    let found = 0;
    for (const [name, value] of entries) {
      if (isZodSchema(value)) {
        schemas[name] = value;
        found++;
      }
    }
    if (found === 0) {
      throw new Error(
        `No zod schema exports found in ${file}${fragment ? `#${fragment}` : ''}. ` +
          `Export your schemas by name, e.g. "export const product = z.object({...})".`,
      );
    }
  }
  return schemas;
}

function collectInputs(flags: CliFlags): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const pair of (flags.values['input'] as string[] | undefined) ?? []) {
    const eq = pair.indexOf('=');
    if (eq === -1) throw new Error(`--input must be name=value (got "${pair}")`);
    inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  for (const pair of (flags.values['input-env'] as string[] | undefined) ?? []) {
    const eq = pair.indexOf('=');
    if (eq === -1) throw new Error(`--input-env must be name=ENV_VAR (got "${pair}")`);
    const envName = pair.slice(eq + 1);
    const value = process.env[envName];
    if (value === undefined) throw new Error(`Environment variable ${envName} is not set`);
    inputs[pair.slice(0, eq)] = value;
  }
  return inputs;
}

function collectLimits(flags: CliFlags): Limits {
  const limits: Limits = {};
  const maxPages = flags.values['max-pages'];
  if (typeof maxPages === 'string') limits.maxPages = Number(maxPages);
  const delay = flags.values['delay'];
  if (typeof delay === 'string') limits.delayMs = Number(delay);
  const timeout = flags.values['timeout'];
  if (typeof timeout === 'string') limits.timeoutMs = Number(timeout);
  return limits;
}

function attachProgress(handle: CrawlHandle<unknown>, quiet: boolean, itemsOut?: NodeJS.WritableStream): void {
  if (!quiet) {
    handle.on('progress', (e) => process.stderr.write(`[${e.phase}] ${e.message}\n`));
    handle.on('log', (e) => {
      if (e.level !== 'debug') process.stderr.write(`[${e.level}] ${e.message}\n`);
    });
    handle.on('screenshot', (e) => {
      if (e.path) process.stderr.write(`[screenshot] ${e.path}\n`);
    });
    handle.on('llm-usage', (e) =>
      process.stderr.write(`[tokens] ${e.phase}: ${e.inputTokens} in / ${e.outputTokens} out\n`),
    );
  }
  if (itemsOut) {
    handle.on('item', (e) => itemsOut.write(`${JSON.stringify({ schema: e.schema, ...(e.item as object) })}\n`));
  }
  handle.on('error', () => undefined); // surfaced via the awaited rejection
}

async function cmdGenerate(flags: CliFlags): Promise<number> {
  const url = flags.positionals[1];
  const instructions = flags.values['instructions'] as string | undefined;
  if (!url || !instructions) {
    process.stderr.write('generate needs a <url> and -i "<instructions>"\n');
    return 2;
  }
  const schemas = await loadSchemas(flags.values['schema'] as string[] | undefined);
  if (!schemas) {
    process.stderr.write('generate needs at least one --schema module\n');
    return 2;
  }
  const model = await resolveModel(flags.values['model'] as string | undefined);
  const outFile = (flags.values['out'] as string | undefined) ?? 'crawler.json';
  const quiet = flags.values['quiet'] === true;

  const handle = generateCrawler({
    url,
    instructions,
    schemas,
    model,
    inputs: collectInputs(flags),
    limits: collectLimits(flags),
    ignoreRobots: flags.values['ignore-robots'] === true,
    headless: flags.values['headed'] !== true,
    ...(flags.values['no-sandbox'] === true ? { noSandbox: true } : {}),
    ...(typeof flags.values['screenshots'] === 'string'
      ? { screenshots: true, screenshotDir: flags.values['screenshots'] }
      : {}),
    ...(typeof flags.values['repair-attempts'] === 'string'
      ? { maxRepairAttempts: Number(flags.values['repair-attempts']) }
      : {}),
    ...(typeof flags.values['scout-steps'] === 'string'
      ? { maxScoutSteps: Number(flags.values['scout-steps']) }
      : {}),
  });
  attachProgress(handle, quiet);

  const { artifact, report } = await handle;
  await writeFile(outFile, artifact.serialize(), 'utf8');
  process.stderr.write(
    `\nWrote ${outFile} (engine: ${artifact.manifest.engine}, ` +
      `items in self-test: ${JSON.stringify(report.itemCounts)}, ` +
      `attempts: ${artifact.manifest.stats.attempts}, ` +
      `tokens: ${artifact.manifest.stats.tokens.input} in / ${artifact.manifest.stats.tokens.output} out)\n`,
  );
  return 0;
}

async function cmdRun(flags: CliFlags, forceHeal: boolean): Promise<number> {
  const artifactFile = flags.positionals[1];
  if (!artifactFile) {
    process.stderr.write('run/heal needs a <crawler.json>\n');
    return 2;
  }
  const artifact = loadArtifact(await readFile(artifactFile, 'utf8'));
  const schemas = await loadSchemas(flags.values['schema'] as string[] | undefined);
  const quiet = flags.values['quiet'] === true;
  const healFull = flags.values['heal-full'] === true;
  const heal = forceHeal || healFull || flags.values['heal'] === true;
  const model = heal ? await resolveModel(flags.values['model'] as string | undefined) : undefined;

  const outSpec = flags.values['out'] as string | undefined;
  const { createWriteStream } = await import('node:fs');
  const itemsOut = outSpec ? createWriteStream(outSpec) : process.stdout;

  const handle = runCrawler(artifact, {
    ...(schemas ? { schemas } : {}),
    inputs: collectInputs(flags),
    limits: collectLimits(flags),
    ignoreRobots: flags.values['ignore-robots'] === true,
    headless: flags.values['headed'] !== true,
    ...(flags.values['no-sandbox'] === true ? { noSandbox: true } : {}),
    ...(typeof flags.values['screenshots'] === 'string'
      ? { screenshots: true, screenshotDir: flags.values['screenshots'] }
      : {}),
    ...(heal && model ? { heal: healFull ? ('full' as const) : true, model } : {}),
  });
  attachProgress(handle, quiet, itemsOut);

  let result: RunResult;
  try {
    result = await handle;
  } finally {
    if (outSpec) (itemsOut as import('node:fs').WriteStream).end();
  }

  if (result.healed) {
    const target = (flags.values['save-healed'] as string | undefined) ?? artifactFile;
    await writeFile(target, result.artifact.serialize(), 'utf8');
    process.stderr.write(`[heal] updated artifact written to ${target}\n`);
  }

  process.stderr.write(
    `\n${result.report.ok ? 'OK' : 'FAILED'} — items: ${JSON.stringify(result.report.itemCounts)}, ` +
      `pages: ${result.report.pagesVisited}, ${result.report.durationMs}ms\n`,
  );
  if (!result.report.ok && result.report.runtimeError) {
    process.stderr.write(`error: ${result.report.runtimeError.message}\n`);
  }
  for (const failure of result.report.assertionFailures) {
    process.stderr.write(`assertion failed: ${JSON.stringify(failure.assertion)} (${failure.actual})\n`);
  }
  return result.report.ok ? 0 : 1;
}

async function main(): Promise<number> {
  let flags: CliFlags;
  try {
    flags = parse(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (flags.values['version'] === true) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const command = flags.positionals[0];
  if (flags.values['help'] === true || command === undefined) {
    process.stdout.write(USAGE);
    return command === undefined ? 2 : 0;
  }
  switch (command) {
    case 'generate':
      return cmdGenerate(flags);
    case 'run':
      return cmdRun(flags, false);
    case 'heal':
      return cmdRun(flags, true);
    default:
      process.stderr.write(`Unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`\nerror: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);

export { loadSchemas, resolveModel, Artifact };
