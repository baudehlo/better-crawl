import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { makeArtifact } from '../helpers/make-artifact.js';
import { startStaticStore, STATIC_STORE_PRODUCT_COUNT } from '../fixtures/sites/static-store.js';
import type { FixtureSite } from '../fixtures/sites/server.js';

type CliModule = typeof import('../../src/cli.js');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  module: CliModule;
}

/**
 * Import src/cli.ts fresh with a scripted argv. The CLI calls main() at import
 * time and finishes with process.exit, so exit/stdout/stderr are intercepted.
 */
async function runCli(args: string[]): Promise<CliResult> {
  vi.resetModules();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalArgv = process.argv;
  process.argv = [process.execPath, 'better-crawl', ...args];

  let resolveExit!: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    resolveExit(code ?? 0);
    return undefined as never;
  }) as never);

  try {
    const module = (await import('../../src/cli.js')) as CliModule;
    const code = await exitPromise;
    return { code, stdout: stdout.join(''), stderr: stderr.join(''), module };
  } finally {
    process.argv = originalArgv;
    outSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

const CRAWL_CODE = `export default async function crawl(ctx) {
  ctx.progress('fetching listing');
  const page = await ctx.fetch(ctx.entryUrl);
  ctx.select(page, 'row').each((i, el) => {
    ctx.emit('product', { name: page.$(el).find('a').text().trim() });
  });
}
`;

function storeArtifactJson(entryUrl: string, minItems = 1): string {
  return makeArtifact(
    {
      entryUrl,
      selectors: { row: { css: 'li.product', description: 'rows', expect: 'many' } },
      schemas: {
        product: z.toJSONSchema(z.object({ name: z.string().min(1) })) as Record<string, unknown>,
      },
      assertions: [{ kind: 'minItems', schema: 'product', min: minItems }],
    },
    CRAWL_CODE,
  ).serialize();
}

describe('cli', () => {
  let store: FixtureSite;
  let dir: string;

  beforeAll(async () => {
    store = await startStaticStore();
    dir = await mkdtemp(path.join(process.cwd(), 'test', '.cli-tmp-'));
  });
  afterAll(async () => {
    await store?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('--version prints the version', async () => {
    const { code, stdout } = await runCli(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('--help prints usage with exit 0; no command prints usage with exit 2', async () => {
    const help = await runCli(['run', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('USAGE');

    const bare = await runCli([]);
    expect(bare.code).toBe(2);
    expect(bare.stdout).toContain('USAGE');
  });

  it('rejects unknown commands and unknown flags with exit 2', async () => {
    const unknownCmd = await runCli(['frobnicate']);
    expect(unknownCmd.code).toBe(2);
    expect(unknownCmd.stderr).toContain('Unknown command "frobnicate"');

    const badFlag = await runCli(['run', '--no-such-flag']);
    expect(badFlag.code).toBe(2);
    expect(badFlag.stderr).toContain('USAGE');
  });

  it('generate requires url + instructions, then at least one schema', async () => {
    const missingArgs = await runCli(['generate']);
    expect(missingArgs.code).toBe(2);
    expect(missingArgs.stderr).toContain('generate needs a <url>');

    const missingSchema = await runCli(['generate', 'http://x/', '-i', 'find things']);
    expect(missingSchema.code).toBe(2);
    expect(missingSchema.stderr).toContain('--schema');
  });

  it('run requires an artifact path, and fails cleanly on a missing file', async () => {
    const noFile = await runCli(['run']);
    expect(noFile.code).toBe(2);
    expect(noFile.stderr).toContain('needs a <crawler.json>');

    const missing = await runCli(['run', path.join(dir, 'nope.json')]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('error:');
  });

  it('runs an artifact end to end, writing NDJSON to --out', async () => {
    const artifactFile = path.join(dir, 'crawler.json');
    await writeFile(artifactFile, storeArtifactJson(`${store.url}/`, STATIC_STORE_PRODUCT_COUNT));
    const itemsFile = path.join(dir, 'items.ndjson');
    process.env['BC_CLI_TEST_NOTE'] = 'from-env';
    try {
      const { code, stderr } = await runCli([
        'run',
        artifactFile,
        '--out',
        itemsFile,
        '--input',
        'note=hello',
        '--input-env',
        'envNote=BC_CLI_TEST_NOTE',
        '--max-pages',
        '10',
        '--delay',
        '0',
        '--timeout',
        '30000',
      ]);
      expect(stderr).toContain('[run]');
      expect(stderr).toContain('OK');
      expect(code).toBe(0);
      // the NDJSON stream may still be flushing when the (mocked) exit fires
      await vi.waitFor(async () => {
        const lines = (await readFile(itemsFile, 'utf8')).trim().split('\n');
        expect(lines).toHaveLength(STATIC_STORE_PRODUCT_COUNT);
      });
      const lines = (await readFile(itemsFile, 'utf8')).trim().split('\n');
      expect(JSON.parse(lines[0]!)).toEqual({ schema: 'product', name: 'Widget 1' });
    } finally {
      delete process.env['BC_CLI_TEST_NOTE'];
    }
  });

  it('exits 1 with assertion detail when the run fails, streaming items to stdout', async () => {
    const artifactFile = path.join(dir, 'failing.json');
    await writeFile(artifactFile, storeArtifactJson(`${store.url}/`, 99));
    const { code, stdout, stderr } = await runCli([
      'run',
      artifactFile,
      '--quiet',
      '--delay',
      '0',
      '--ignore-robots',
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain('FAILED');
    expect(stderr).toContain('assertion failed');
    expect(stdout).toContain('"schema":"product"');
  });

  it('reports the runtime error when the site is unreachable', async () => {
    const artifactFile = path.join(dir, 'unreachable.json');
    await writeFile(artifactFile, storeArtifactJson('http://127.0.0.1:1/'));
    const { code, stderr } = await runCli(['run', artifactFile, '--quiet', '--delay', '0']);
    expect(code).toBe(1);
    expect(stderr).toContain('error:');
  });

  it('rejects malformed --input and unset --input-env values', async () => {
    const artifactFile = path.join(dir, 'crawler2.json');
    await writeFile(artifactFile, storeArtifactJson(`${store.url}/`));

    const badPair = await runCli(['run', artifactFile, '--input', 'no-equals-sign']);
    expect(badPair.code).toBe(1);
    expect(badPair.stderr).toContain('--input must be name=value');

    const badEnvPair = await runCli(['run', artifactFile, '--input-env', 'name-only']);
    expect(badEnvPair.code).toBe(1);
    expect(badEnvPair.stderr).toContain('--input-env must be name=ENV_VAR');

    const unsetEnv = await runCli(['run', artifactFile, '--input-env', 'x=BC_CLI_NOT_SET']);
    expect(unsetEnv.code).toBe(1);
    expect(unsetEnv.stderr).toContain('BC_CLI_NOT_SET is not set');
  });

  it('surfaces a rejected run (missing required input) as an error exit', async () => {
    const artifact = makeArtifact(
      {
        entryUrl: `${store.url}/`,
        inputs: [{ name: 'apiKey', description: 'needed', secret: true, required: true }],
        selectors: { row: { css: 'li.product', description: 'rows', expect: 'many' } },
      },
      CRAWL_CODE,
    );
    const artifactFile = path.join(dir, 'needs-input.json');
    await writeFile(artifactFile, artifact.serialize());
    const { code, stderr } = await runCli(['run', artifactFile, '--delay', '0']);
    expect(code).toBe(1);
    expect(stderr).toContain('Input "apiKey" is required');
  });

  it('generate resolves the model, then fails cleanly without an API key', async () => {
    const savedKey = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    const schemaFile = path.join(dir, 'gen-schema.mjs');
    await writeFile(
      schemaFile,
      "import { z } from 'zod';\nexport const product = z.object({ name: z.string() });\n",
    );
    try {
      const { code, stderr } = await runCli([
        'generate',
        `${store.url}/`,
        '-i',
        'find products',
        '--schema',
        schemaFile,
        '--out',
        path.join(dir, 'never-written.json'),
        '--scout-steps',
        '3',
        '--repair-attempts',
        '0',
        '--delay',
        '0',
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain('error:');
    } finally {
      if (savedKey !== undefined) process.env['ANTHROPIC_API_KEY'] = savedKey;
    }
  }, 60_000);

  it('heal command resolves the default model and passes when the site is healthy', async () => {
    const artifactFile = path.join(dir, 'healthy.json');
    await writeFile(artifactFile, storeArtifactJson(`${store.url}/`, STATIC_STORE_PRODUCT_COUNT));
    const { code, stderr } = await runCli(['heal', artifactFile, '--quiet', '--delay', '0']);
    expect(code).toBe(0);
    expect(stderr).toContain('OK');
    // no drift → the artifact was not rewritten
    expect(stderr).not.toContain('[heal]');
  });

  describe('loadSchemas / resolveModel helpers', () => {
    let cli: CliModule;
    let goodSchemaFile: string;
    let emptySchemaFile: string;

    beforeAll(async () => {
      ({ module: cli } = await runCli(['--version']));
      goodSchemaFile = path.join(dir, 'schemas.mjs');
      await writeFile(
        goodSchemaFile,
        `import { z } from 'zod';
export const product = z.object({ name: z.string() });
export const review = z.object({ stars: z.number() });
export const notASchema = 42;
export default 'ignored';
`,
      );
      emptySchemaFile = path.join(dir, 'no-schemas.mjs');
      await writeFile(emptySchemaFile, 'export const nothing = 42;\n');
    });

    it('loadSchemas picks up every zod export, skipping default and non-schemas', async () => {
      const schemas = await cli.loadSchemas([goodSchemaFile]);
      expect(Object.keys(schemas ?? {}).sort()).toEqual(['product', 'review']);
    });

    it('loadSchemas honors #fragment to select one export', async () => {
      const schemas = await cli.loadSchemas([`${goodSchemaFile}#product`]);
      expect(Object.keys(schemas ?? {})).toEqual(['product']);
    });

    it('loadSchemas returns undefined without specs and throws on bad ones', async () => {
      await expect(cli.loadSchemas(undefined)).resolves.toBeUndefined();
      await expect(cli.loadSchemas([])).resolves.toBeUndefined();
      await expect(cli.loadSchemas(['#frag'])).rejects.toThrow(/Bad --schema value/);
      await expect(cli.loadSchemas([emptySchemaFile])).rejects.toThrow(/No zod schema exports/);
      await expect(cli.loadSchemas([`${goodSchemaFile}#notASchema`])).rejects.toThrow(
        /No zod schema exports/,
      );
    });

    it('resolveModel builds a model from provider:id and rejects bad specs', async () => {
      const model = await cli.resolveModel('anthropic:claude-opus-5');
      expect((model as { modelId?: string }).modelId).toBe('claude-opus-5');
      const fallback = await cli.resolveModel(undefined);
      expect((fallback as { modelId?: string }).modelId).toBeDefined();
      await expect(cli.resolveModel('justamodelid')).rejects.toThrow(/provider:model-id/);
      await expect(cli.resolveModel(':model')).rejects.toThrow(/provider:model-id/);
      await expect(cli.resolveModel('nosuchprovider:x')).rejects.toThrow(
        /@ai-sdk\/nosuchprovider/,
      );
      // an installed package that exports no matching factory
      await expect(cli.resolveModel('provider:x')).rejects.toThrow(/does not export/);
    });
  });
});
