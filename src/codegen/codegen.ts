import type { LanguageModel, ModelMessage } from 'ai';
import { z } from 'zod';
import { assertionSchema, type Assertion } from '../artifact.js';
import type { LlmClient, LlmUsage } from '../llm/client.js';

export const codegenOutputSchema = z.object({
  engine: z.enum(['playwright', 'cheerio']),
  selectors: z.record(
    z.string(),
    z.object({
      css: z.string().min(1),
      description: z.string(),
      expect: z.enum(['one', 'many', 'maybe']),
    }),
  ),
  inputs: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string(),
      secret: z.boolean(),
      required: z.boolean(),
    }),
  ),
  assertions: z.array(assertionSchema),
  code: z.string().min(1),
  notes: z.string(),
});

export type CodegenOutput = z.infer<typeof codegenOutputSchema> & {
  assertions: Assertion[];
};

const CODEGEN_MAX_OUTPUT_TOKENS = 64_000;

/**
 * One structured-output call on an owned conversation. The caller appends the
 * returned assistant JSON + a failure digest to `messages` for repair turns, so
 * the cached prefix keeps paying across attempts.
 */
export async function runCodegenCall(opts: {
  llm: LlmClient;
  model: LanguageModel;
  messages: ModelMessage[];
  signal?: AbortSignal;
}): Promise<{ output: CodegenOutput; usage: LlmUsage }> {
  const { object, usage } = await opts.llm.generateObject({
    model: opts.model,
    messages: opts.messages,
    schema: codegenOutputSchema,
    maxOutputTokens: CODEGEN_MAX_OUTPUT_TOKENS,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return { output: object as CodegenOutput, usage };
}
