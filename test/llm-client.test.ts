import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const generateText = vi.hoisted(() => vi.fn());

vi.mock('ai', () => ({
  generateText,
  Output: { object: (opts: unknown) => ({ __output: opts }) },
  stepCountIs: (n: number) => ({ __stopWhen: n }),
}));

const { createLlmClient } = await import('../src/llm/client.js');
const { GenerationRefusedError } = await import('../src/errors.js');

const MODEL = 'fake-model' as never;

beforeEach(() => {
  generateText.mockReset();
});

describe('createLlmClient().runAgentLoop', () => {
  it('returns usage and step count from the SDK result', async () => {
    generateText.mockResolvedValue({
      finishReason: 'stop',
      totalUsage: { inputTokens: 11, outputTokens: 22 },
      steps: [1, 2, 3],
    });
    const client = createLlmClient();
    const onStepFinish = vi.fn();
    const signal = new AbortController().signal;
    const result = await client.runAgentLoop({
      model: MODEL,
      system: 'sys',
      prompt: 'go',
      tools: {},
      maxSteps: 5,
      onStepFinish,
      signal,
    });
    expect(result).toEqual({ usage: { inputTokens: 11, outputTokens: 22 }, steps: 3 });
    const call = generateText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.system).toBe('sys');
    // the caller signal is merged with the hang-breaker timeout
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
    expect((call.abortSignal as AbortSignal).aborted).toBe(false);
    expect(call.onStepFinish).toBe(onStepFinish);
    expect(call.stopWhen).toEqual({ __stopWhen: 5 });
  });

  it('defaults missing token counts to 0 and omits optional params', async () => {
    generateText.mockResolvedValue({
      finishReason: 'stop',
      totalUsage: {},
      steps: [],
    });
    const client = createLlmClient();
    const result = await client.runAgentLoop({
      model: MODEL,
      system: 's',
      prompt: 'p',
      tools: {},
      maxSteps: 1,
    });
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    const call = generateText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.abortSignal).toBeInstanceOf(AbortSignal); // timeout signal is always attached
    expect('onStepFinish' in call).toBe(false);
  });

  it('throws GenerationRefusedError on a content filter', async () => {
    generateText.mockResolvedValue({
      finishReason: 'content-filter',
      totalUsage: { inputTokens: 1, outputTokens: 1 },
      steps: [],
    });
    const client = createLlmClient();
    await expect(
      client.runAgentLoop({ model: MODEL, system: 's', prompt: 'p', tools: {}, maxSteps: 1 }),
    ).rejects.toThrow(GenerationRefusedError);
  });
});

describe('createLlmClient().runAgentLoop finalTool', () => {
  it('forces the named tool on the last steps of the budget, and only there', async () => {
    generateText.mockResolvedValue({ finishReason: 'stop', totalUsage: {}, steps: [] });
    const client = createLlmClient();
    await client.runAgentLoop({ model: MODEL, system: 's', prompt: 'p', tools: {}, maxSteps: 40, finalTool: 'report_findings' });
    const call = generateText.mock.calls[0]?.[0] as {
      prepareStep: (ctx: { stepNumber: number }) => { toolChoice?: { type: string; toolName: string } } | undefined;
    };
    expect(call.prepareStep({ stepNumber: 0 })).toBeUndefined();
    expect(call.prepareStep({ stepNumber: 36 })).toBeUndefined();
    expect(call.prepareStep({ stepNumber: 37 })).toEqual({ toolChoice: { type: 'tool', toolName: 'report_findings' } });
    expect(call.prepareStep({ stepNumber: 39 })).toEqual({ toolChoice: { type: 'tool', toolName: 'report_findings' } });
  });

  it('omits prepareStep when no finalTool is set', async () => {
    generateText.mockResolvedValue({ finishReason: 'stop', totalUsage: {}, steps: [] });
    const client = createLlmClient();
    await client.runAgentLoop({ model: MODEL, system: 's', prompt: 'p', tools: {}, maxSteps: 5 });
    const call = generateText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.prepareStep).toBeUndefined();
  });
});

describe('createLlmClient().generateObject', () => {
  const schema = z.object({ answer: z.number() });

  it('rewrites AI_NoObjectGeneratedError into actionable INVALID_OBJECT feedback with the zod issues', async () => {
    const sdkError = Object.assign(new Error('No object generated: response did not match schema.'), {
      name: 'AI_NoObjectGeneratedError',
      cause: {
        message: 'Type validation failed',
        cause: {
          issues: [
            { path: ['assertions', 0, 'kind'], message: 'Invalid enum value' },
            { path: ['code'], message: 'Required' },
          ],
        },
      },
    });
    generateText.mockRejectedValue(sdkError);
    const client = createLlmClient();
    const rejection = await client
      .generateObject({ model: MODEL, messages: [], schema })
      .then(() => undefined)
      .catch((err: Error) => err);
    expect(rejection?.message).toContain('INVALID_OBJECT');
    expect(rejection?.message).toContain('assertions.0.kind: Invalid enum value');
    expect(rejection?.message).toContain('code: Required');
    expect(rejection?.cause).toBe(sdkError);
  });

  it('falls back to the cause message when no zod issues are attached (JSON parse failure)', async () => {
    generateText.mockRejectedValue(
      Object.assign(new Error('No object generated.'), {
        name: 'AI_NoObjectGeneratedError',
        cause: { message: 'JSON parsing failed: unexpected end of input' },
      }),
    );
    const client = createLlmClient();
    await expect(client.generateObject({ model: MODEL, messages: [], schema })).rejects.toThrow(
      /INVALID_OBJECT.*JSON parsing failed/s,
    );
  });

  it('rethrows unrelated errors untouched', async () => {
    generateText.mockRejectedValue(new Error('ECONNRESET'));
    const client = createLlmClient();
    await expect(client.generateObject({ model: MODEL, messages: [], schema })).rejects.toThrow('ECONNRESET');
  });

  it('returns the structured output and usage', async () => {
    generateText.mockResolvedValue({
      finishReason: 'stop',
      totalUsage: { inputTokens: 5, outputTokens: 6 },
      output: { answer: 42 },
    });
    const client = createLlmClient();
    const signal = new AbortController().signal;
    const result = await client.generateObject({
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      schema,
      maxOutputTokens: 1000,
      signal,
    });
    expect(result.object).toEqual({ answer: 42 });
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 6 });
    const call = generateText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.maxOutputTokens).toBe(1000);
    // the caller signal is merged with the hang-breaker timeout
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
    expect((call.abortSignal as AbortSignal).aborted).toBe(false);
  });

  it('omits maxOutputTokens and signal when not provided', async () => {
    generateText.mockResolvedValue({
      finishReason: 'stop',
      totalUsage: { inputTokens: 1, outputTokens: 1 },
      output: { answer: 1 },
    });
    const client = createLlmClient();
    await client.generateObject({ model: MODEL, messages: [], schema });
    const call = generateText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('maxOutputTokens' in call).toBe(false);
    expect(call.abortSignal).toBeInstanceOf(AbortSignal); // timeout signal is always attached
  });

  it('throws GenerationRefusedError on a content filter', async () => {
    generateText.mockResolvedValue({
      finishReason: 'content-filter',
      totalUsage: {},
      output: undefined,
    });
    const client = createLlmClient();
    await expect(
      client.generateObject({ model: MODEL, messages: [], schema }),
    ).rejects.toThrow(GenerationRefusedError);
  });

  it('throws OUTPUT_TRUNCATED when the model hit the token limit', async () => {
    generateText.mockResolvedValue({
      finishReason: 'length',
      totalUsage: {},
      output: undefined,
    });
    const client = createLlmClient();
    await expect(
      client.generateObject({ model: MODEL, messages: [], schema }),
    ).rejects.toThrow(/OUTPUT_TRUNCATED/);
  });
});
