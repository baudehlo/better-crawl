import type { Artifact } from '../artifact.js';

/**
 * Cheap static checks on generated code so obviously-broken candidates never
 * burn a live crawl. Not a parser — pragmatic regexes over known ctx idioms.
 */
export function lintArtifact(artifact: Artifact): string[] {
  const errors: string[] = [];
  const { code } = artifact;
  const selectorNames = new Set(Object.keys(artifact.manifest.selectors));

  if (!/export\s+default\s/.test(code)) {
    errors.push('code must `export default` an async crawl(ctx) function');
  }
  if (/^\s*import\s/m.test(code)) {
    errors.push('code must not use import — everything comes through ctx');
  }
  if (/\brequire\s*\(/.test(code)) {
    errors.push('code must not use require — everything comes through ctx');
  }
  if (/document\.querySelector/.test(code)) {
    errors.push(
      'code must not query the DOM directly — use the named-selector ctx helpers',
    );
  }

  // Every string-literal selector name handed to a ctx helper must exist.
  const helperCalls = [
    ...code.matchAll(
      /ctx\.(sel|click|waitFor|fill|text|attr|links|count|loadAll)\(\s*['"`]([^'"`]+)['"`]/g,
    ),
    ...code.matchAll(/ctx\.select\(\s*[\w$]+\s*,\s*['"`]([^'"`]+)['"`]/g),
  ];
  for (const match of helperCalls) {
    const name = match[2] ?? match[1];
    if (name !== undefined && !selectorNames.has(name)) {
      errors.push(
        `ctx helper references selector "${name}" which is not in the manifest`,
      );
    }
  }

  // Raw CSS smuggled into helpers designed for names is the anti-healing smell.
  for (const match of code.matchAll(
    /ctx\.(click|waitFor|fill|text|attr|links|count|loadAll)\(\s*['"`]([^'"`]*[.#[][^'"`]*)['"`]/g,
  )) {
    const name = match[2];
    if (name !== undefined && !selectorNames.has(name)) {
      errors.push(
        `ctx.${match[1]}("${name}") looks like raw CSS — declare it as a named selector in the manifest`,
      );
    }
  }

  return [...new Set(errors)];
}
