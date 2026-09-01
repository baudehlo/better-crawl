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
    expect(call.abortSignal).toBe(signal);
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
    expect('abortSignal' in call).toBe(false);
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

describe('createLlmClient().generateObject', () => {
  const schema = z.object({ answer: z.number() });

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
    expect(call.abortSignal).toBe(signal);
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
    expect('abortSignal' in call).toBe(false);
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
