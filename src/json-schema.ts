import { z } from 'zod';
import type { JsonSchemaObject } from './artifact.js';

/**
 * JSON Schema rendering of a caller schema, for LLM prompts and the manifest's
 * fallback validators. Rendered from the INPUT side: crawler code emits raw
 * values that the caller's zod schema then refines, so a `.transform()` is
 * described by what it accepts — and anything JSON Schema cannot express at
 * all degrades to an unconstrained schema instead of throwing. Real validation
 * always uses the caller's zod schema directly; this rendering only has to be
 * descriptive.
 */
export function toJsonSchema(schema: z.ZodType): JsonSchemaObject {
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchemaObject;
}
