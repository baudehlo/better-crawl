import type { z } from 'zod';
import type { JsonSchemaObject } from '../artifact.js';
import type { Schemas } from '../types.js';

export type ValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; issues: z.core.$ZodIssue[] };

export interface ItemValidator {
  readonly schemaNames: string[];
  validate(schemaName: string, item: unknown): ValidationResult;
}

/**
 * Strip top-level null values (LLMs and JSON have no undefined, so "absent"
 * arrives as null). Only used as a second chance: if the raw item parses, nulls
 * were legitimate (nullable fields); if not, we retry with nulls dropped so
 * optional-but-not-nullable fields validate.
 */
function withNullsStripped(item: unknown): unknown {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (value !== null) copy[key] = value;
  }
  return copy;
}

function customIssue(path: PropertyKey[], message: string): z.core.$ZodIssue {
  return { code: 'custom', path, message, input: undefined } as unknown as z.core.$ZodIssue;
}

/**
 * Best-effort structural check against a JSON Schema (the manifest's copies) for
 * replays where the caller didn't pass their zod schemas. Supports the subset
 * z.toJSONSchema emits for typical extraction schemas: type, properties,
 * required, items, enum, anyOf. Unknown constructs pass.
 */
export function checkJsonSchema(
  schema: JsonSchemaObject,
  value: unknown,
  path: PropertyKey[] = [],
): z.core.$ZodIssue[] {
  const issues: z.core.$ZodIssue[] = [];
  const anyOf = schema['anyOf'];
  if (Array.isArray(anyOf)) {
    const failures = anyOf.map((sub) =>
      checkJsonSchema(sub as JsonSchemaObject, value, path),
    );
    if (failures.every((f) => f.length > 0)) {
      issues.push(customIssue(path, 'value matched no branch of anyOf'));
    }
    return issues;
  }

  const type = schema['type'];
  if (typeof type === 'string' && !matchesType(type, value)) {
    issues.push(customIssue(path, `expected ${type}, got ${describe(value)}`));
    return issues;
  }

  const enumValues = schema['enum'];
  if (Array.isArray(enumValues) && !enumValues.some((v) => v === value)) {
    issues.push(customIssue(path, `expected one of ${JSON.stringify(enumValues)}`));
  }

  if (type === 'object' && typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const required = schema['required'];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === 'string' && !(key in record)) {
          issues.push(customIssue([...path, key], 'required field missing'));
        }
      }
    }
    const properties = schema['properties'];
    if (typeof properties === 'object' && properties !== null) {
      for (const [key, subSchema] of Object.entries(properties)) {
        if (key in record) {
          issues.push(
            ...checkJsonSchema(subSchema as JsonSchemaObject, record[key], [...path, key]),
          );
        }
      }
    }
  }

  if (type === 'array' && Array.isArray(value)) {
    const items = schema['items'];
    if (typeof items === 'object' && items !== null) {
      value.forEach((element, index) => {
        issues.push(
          ...checkJsonSchema(items as JsonSchemaObject, element, [...path, index]),
        );
      });
    }
  }

  return issues;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Build a validator from the caller's real zod schemas (strict) or, on replay
 * without them, from the manifest's JSON Schema copies (best-effort).
 * Validation is per item — one bad row never kills a batch.
 */
export function createValidator(
  schemas: Schemas | undefined,
  manifestSchemas: Record<string, JsonSchemaObject>,
): ItemValidator {
  const names = Object.keys(schemas ?? manifestSchemas);

  return {
    schemaNames: names,
    validate(schemaName, item) {
      const zodSchema = schemas?.[schemaName];
      if (zodSchema) {
        const raw = zodSchema.safeParse(item);
        if (raw.success) return { ok: true, value: raw.data };
        const stripped = zodSchema.safeParse(withNullsStripped(item));
        if (stripped.success) return { ok: true, value: stripped.data };
        return { ok: false, issues: raw.error.issues };
      }
      const jsonSchema = manifestSchemas[schemaName];
      if (!jsonSchema) {
        return {
          ok: false,
          issues: [customIssue([], `unknown schema "${schemaName}"`)],
        };
      }
      const issues = checkJsonSchema(jsonSchema, withNullsStripped(item));
      return issues.length === 0
        ? { ok: true, value: item }
        : { ok: false, issues };
    },
  };
}
