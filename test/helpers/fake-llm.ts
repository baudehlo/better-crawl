import type {
  AgentLoopOptions,
  LlmClient,
  ObjectCallOptions,
} from '../../src/llm/client.js';

const USAGE = { inputTokens: 100, outputTokens: 50 };

/**
 * Scripted LlmClient double. Structured-output calls pop from `objects` (and
 * are validated through the call's real zod schema, like the SDK would).
 * Agent loops are driven by `driveAgent`, which can invoke the real tools.
 */
export class FakeLlm implements LlmClient {
  readonly agentCalls: AgentLoopOptions[] = [];
  readonly objectCalls: ObjectCallOptions<unknown>[] = [];

  constructor(
    private readonly script: {
      driveAgent?: (loop: AgentLoopOptions) => Promise<void>;
      objects?: unknown[];
    } = {},
  ) {}

  async runAgentLoop(opts: AgentLoopOptions): Promise<{ usage: typeof USAGE; steps: number }> {
    this.agentCalls.push(opts);
    await this.script.driveAgent?.(opts);
    return { usage: { ...USAGE }, steps: 1 };
  }

  async generateObject<T>(opts: ObjectCallOptions<T>): Promise<{ object: T; usage: typeof USAGE }> {
    this.objectCalls.push(opts as ObjectCallOptions<unknown>);
    const next = this.script.objects?.shift();
    if (next === undefined) {
      throw new Error('FakeLlm: generateObject called but no scripted object remains');
    }
    return { object: opts.schema.parse(next), usage: { ...USAGE } };
  }
}
