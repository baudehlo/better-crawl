import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { checkJsonSchema, createValidator } from '../src/runtime/validate.js';

describe('createValidator (zod path)', () => {
  const schema = z.object({
    name: z.string(),
    price: z.number().nullable(),
    note: z.string().optional(),
  });
  const validator = createValidator({ item: schema }, {});

  it('accepts valid items', () => {
    expect(validator.validate('item', { name: 'a', price: 1 }).ok).toBe(true);
  });

  it('keeps legitimate nulls on nullable fields', () => {
    const result = validator.validate('item', { name: 'a', price: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.value as { price: unknown }).price).toBeNull();
  });

  it('strips nulls on optional-but-not-nullable fields as a second chance', () => {
    const result = validator.validate('item', { name: 'a', price: 2, note: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect('note' in (result.value as object)).toBe(false);
  });

  it('reports issues from the raw parse when both attempts fail', () => {
    const result = validator.validate('item', { name: 7, price: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
  });

  it('rejects unknown schema names', () => {
    expect(validator.validate('nope', {}).ok).toBe(false);
  });

  it('handles non-object items without crashing the null-stripping retry', () => {
    expect(validator.validate('item', null).ok).toBe(false);
    expect(validator.validate('item', [1, 2]).ok).toBe(false);
    expect(validator.validate('item', 'a string').ok).toBe(false);
  });
});

describe('checkJsonSchema (replay fallback path)', () => {
  const jsonSchema = z.toJSONSchema(
    z.object({ name: z.string(), price: z.number(), tags: z.array(z.string()) }),
  ) as Record<string, unknown>;

  it('passes valid values', () => {
    expect(checkJsonSchema(jsonSchema, { name: 'a', price: 1, tags: ['x'] })).toEqual([]);
  });

  it('flags missing required fields and wrong types with paths', () => {
    const issues = checkJsonSchema(jsonSchema, { name: 5, tags: [1] });
    const messages = issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    expect(messages).toContain('price: required field missing');
    expect(messages).toContain('name: expected string, got number');
    expect(messages).toContain('tags.0: expected string, got number');
  });

  it('handles every primitive type check and describes values', () => {
    expect(checkJsonSchema({ type: 'integer' }, 3)).toEqual([]);
    expect(checkJsonSchema({ type: 'integer' }, 3.5)).toHaveLength(1);
    expect(checkJsonSchema({ type: 'boolean' }, true)).toEqual([]);
    expect(checkJsonSchema({ type: 'null' }, null)).toEqual([]);
    expect(checkJsonSchema({ type: 'null' }, 'x')[0]?.message).toBe('expected null, got string');
    expect(checkJsonSchema({ type: 'array' }, 'x')[0]?.message).toBe('expected array, got string');
    expect(checkJsonSchema({ type: 'object' }, [])[0]?.message).toBe('expected object, got array');
    expect(checkJsonSchema({ type: 'object' }, null)[0]?.message).toBe('expected object, got null');
    // unknown type constructs pass
    expect(checkJsonSchema({ type: 'date-time' }, 'anything')).toEqual([]);
  });

  it('checks enum membership', () => {
    expect(checkJsonSchema({ type: 'string', enum: ['a', 'b'] }, 'a')).toEqual([]);
    expect(checkJsonSchema({ type: 'string', enum: ['a', 'b'] }, 'c')[0]?.message).toContain(
      'expected one of',
    );
  });

  it('arrays without an items schema and objects without properties pass', () => {
    expect(checkJsonSchema({ type: 'array' }, [1, 'two', null])).toEqual([]);
    expect(checkJsonSchema({ type: 'object' }, { anything: 1 })).toEqual([]);
  });

  it('accepts a value matching any anyOf branch, rejects one matching none', () => {
    const anyOf = { anyOf: [{ type: 'string' }, { type: 'number' }] };
    expect(checkJsonSchema(anyOf, 'x')).toEqual([]);
    expect(checkJsonSchema(anyOf, 5)).toEqual([]);
    expect(checkJsonSchema(anyOf, true)[0]?.message).toBe('value matched no branch of anyOf');
  });
});

describe('createValidator (manifest JSON Schema fallback)', () => {
  const manifestSchemas = {
    item: z.toJSONSchema(z.object({ name: z.string(), note: z.string().optional() })) as Record<
      string,
      unknown
    >,
  };
  const validator = createValidator(undefined, manifestSchemas);

  it('exposes the manifest schema names', () => {
    expect(validator.schemaNames).toEqual(['item']);
  });

  it('accepts valid items and strips top-level nulls first', () => {
    expect(validator.validate('item', { name: 'a', note: null }).ok).toBe(true);
  });

  it('rejects invalid items with issues', () => {
    const result = validator.validate('item', { name: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toContain('expected string');
  });

  it('rejects unknown schema names', () => {
    const result = validator.validate('ghost', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toContain('unknown schema');
  });
});
