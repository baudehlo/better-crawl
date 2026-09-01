import { describe, expect, it } from 'vitest';
import { Artifact, loadArtifact } from '../src/artifact.js';
import { ArtifactFormatError } from '../src/errors.js';
import { makeArtifact } from './helpers/make-artifact.js';

describe('Artifact', () => {
  it('round-trips through serialize/parse', () => {
    const original = makeArtifact({
      engine: 'playwright',
      selectors: {
        itemLink: { css: 'a.item', description: 'listing item link', expect: 'many' },
      },
      inputs: [{ name: 'username', description: 'login user', secret: false, required: true }],
      assertions: [{ kind: 'minItems', schema: 'product', min: 3 }],
    });

    const parsed = Artifact.parse(original.serialize());
    expect(parsed.manifest).toEqual(original.manifest);
    expect(parsed.code).toBe(original.code);
  });

  it('loadArtifact accepts an already-parsed object', () => {
    const original = makeArtifact();
    const obj = JSON.parse(original.serialize());
    expect(loadArtifact(obj).manifest.engine).toBe('cheerio');
  });

  it('rejects invalid JSON', () => {
    expect(() => Artifact.parse('{nope')).toThrow(ArtifactFormatError);
  });

  it('rejects an unsupported formatVersion', () => {
    const artifact = makeArtifact();
    const raw = JSON.parse(artifact.serialize());
    raw.manifest.formatVersion = 99;
    expect(() => loadArtifact(raw)).toThrow(/formatVersion 99/);
  });

  it('rejects a missing/empty code string', () => {
    const raw = JSON.parse(makeArtifact().serialize());
    raw.code = '';
    expect(() => loadArtifact(raw)).toThrow(/code/);
  });

  it('rejects a manifest with a malformed selector', () => {
    const raw = JSON.parse(makeArtifact().serialize());
    raw.manifest.selectors = { bad: { css: '', description: 'x', expect: 'many' } };
    expect(() => loadArtifact(raw)).toThrow(ArtifactFormatError);
  });

  it('rejects unknown assertion kinds', () => {
    const raw = JSON.parse(makeArtifact().serialize());
    raw.manifest.assertions = [{ kind: 'sparkles', level: 11 }];
    expect(() => loadArtifact(raw)).toThrow(ArtifactFormatError);
  });

  it('rejects JSON that is not an object', () => {
    expect(() => Artifact.parse('null')).toThrow(/must be a JSON object/);
    expect(() => Artifact.parse('"just a string"')).toThrow(/must be a JSON object/);
  });
});
