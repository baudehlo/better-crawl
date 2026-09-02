import {
  generateText,
  Output,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type StepResult,
  type ToolSet,
} from 'ai';
import type { z } from 'zod';
import { GenerationRefusedError } from '../errors.js';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentLoopOptions {
  model: LanguageModel;
  system: string;
  prompt: string;
  tools: ToolSet;
  maxSteps: number;
  onStepFinish?: (step: StepResult<ToolSet>) => void | Promise<void>;
  signal?: AbortSignal;
  /**
   * Force this tool on the loop's last few steps. For loops whose only valid
   * exit is a specific tool (the scout's report_findings), this stops a model
   * from exploring right through its budget and never reporting.
   */
  finalTool?: string;
}

/** How many trailing steps get the forced finalTool (room for one rejection + fix). */
const FINAL_TOOL_FORCED_STEPS = 3;

export interface ObjectCallOptions<T> {
  model: LanguageModel;
  messages: ModelMessage[];
  schema: z.ZodType<T>;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

/**
 * Thin adapter over the Vercel AI SDK so the scout/codegen/heal layers depend
 * on one small interface — and tests can inject a scripted fake.
 */
export interface LlmClient {
  /** Tool-use agent loop; runs until the model stops calling tools or maxSteps. */
  runAgentLoop(opts: AgentLoopOptions): Promise<{ usage: LlmUsage; steps: number }>;
  /** One structured-output call returning a schema-validated object. */
  generateObject<T>(opts: ObjectCallOptions<T>): Promise<{ object: T; usage: LlmUsage }>;
}

function toUsage(usage: { inputTokens?: number | undefined; outputTokens?: number | undefined }): LlmUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
}

// A stalled connection must become a failure, never a hang — a hung LLM call
// blocks the whole generation (and, in serial-queue hosts, everything behind
// it). Structured-output calls are a single request; the agent loop spans many
// steps, so its budget is much larger. Both merge with the caller's signal.
const OBJECT_CALL_TIMEOUT_MS = 10 * 60_000;
const AGENT_LOOP_TIMEOUT_MS = 45 * 60_000;

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Anthropic-specific niceties (prompt caching, jsonTool structured-output mode)
 * are passed via providerOptions — other providers simply ignore them.
 */
const ANTHROPIC_PROVIDER_OPTIONS = {
  anthropic: {
    cacheControl: { type: 'ephemeral' as const },
    structuredOutputMode: 'jsonTool' as const,
  },
};

export function createLlmClient(): LlmClient {
  return {
    async runAgentLoop(opts) {
      const result = await generateText({
        model: opts.model,
        maxRetries: 3,
        system: opts.system,
        prompt: opts.prompt,
        tools: opts.tools,
        toolChoice: 'auto',
        stopWhen: stepCountIs(opts.maxSteps),
        abortSignal: withTimeout(opts.signal, AGENT_LOOP_TIMEOUT_MS),
        ...(opts.onStepFinish ? { onStepFinish: opts.onStepFinish } : {}),
        ...(opts.finalTool !== undefined
          ? {
              prepareStep: ({ stepNumber }: { stepNumber: number }) =>
                stepNumber >= opts.maxSteps - FINAL_TOOL_FORCED_STEPS
                  ? { toolChoice: { type: 'tool' as const, toolName: opts.finalTool as string } }
                  : undefined,
            }
          : {}),
        providerOptions: {
          anthropic: { cacheControl: { type: 'ephemeral' as const } },
        },
      });
      if (result.finishReason === 'content-filter') {
        throw new GenerationRefusedError('content filter triggered during the scout phase');
      }
      return { usage: toUsage(result.totalUsage), steps: result.steps.length };
    },

    async generateObject(opts) {
      let result: Awaited<ReturnType<typeof generateText>> & { output?: unknown };
      try {
        result = await generateText({
          model: opts.model,
          maxRetries: 3,
          messages: opts.messages,
          output: Output.object({ schema: opts.schema }),
          ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
          abortSignal: withTimeout(opts.signal, OBJECT_CALL_TIMEOUT_MS),
          providerOptions: ANTHROPIC_PROVIDER_OPTIONS,
        });
      } catch (err) {
        // The SDK's schema-mismatch error is generic; repair turns need the
        // actual issues or the model just fails the same way again.
        if (err instanceof Error && err.name === 'AI_NoObjectGeneratedError') {
          throw invalidObjectError(err);
        }
        throw err;
      }
      if (result.finishReason === 'content-filter') {
        throw new GenerationRefusedError('content filter triggered during code generation');
      }
      if (result.finishReason === 'length') {
        throw new Error(
          'OUTPUT_TRUNCATED: the model hit the output-token limit before finishing — ' +
            'generate shorter code and lean on the ctx helpers',
        );
      }
      return { object: result.output as never, usage: toUsage(result.totalUsage) };
    },
  };
}

/**
 * Distill an AI_NoObjectGeneratedError into feedback a repair turn can act on.
 * The zod issues live at err.cause (TypeValidationError) → .cause (ZodError)
 * .issues; a JSON-parse failure only has a cause message. Everything is capped
 * so a giant embedded value can't blow up the conversation.
 */
function invalidObjectError(err: Error & { cause?: unknown }): Error {
  const nested = err.cause as
    | { message?: string; cause?: { issues?: Array<{ path?: Array<string | number>; message?: string }> } }
    | undefined;
  const issues = nested?.cause?.issues;
  const detail =
    Array.isArray(issues) && issues.length > 0
      ? issues
          .slice(0, 20)
          .map((issue) => `- ${(issue.path ?? []).join('.') || '(root)'}: ${issue.message ?? 'invalid'}`)
          .join('\n')
      : (nested?.message ?? err.message).slice(0, 1_500);
  return new Error(
    `INVALID_OBJECT: the response did not match the expected schema:\n${detail}`,
    { cause: err },
  );
}
