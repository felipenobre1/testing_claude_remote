import type { LLMProvider, LLMRequest, LLMResponse, LLMTask } from './provider.ts';

/** A scripted reply: an object (serialized to JSON), a raw string (sent as-is), or a function of the request. */
export type ScriptedReply = unknown | ((req: LLMRequest) => unknown);

/**
 * Deterministic provider for tests. Replies are queued per task and consumed in order;
 * every request is recorded so tests can assert on the exact prompts.
 */
export class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  readonly calls: LLMRequest[] = [];
  private queues = new Map<LLMTask, ScriptedReply[]>();

  enqueue(task: LLMTask, ...replies: ScriptedReply[]): this {
    const q = this.queues.get(task) ?? [];
    q.push(...replies);
    this.queues.set(task, q);
    return this;
  }

  pending(task?: LLMTask): number {
    if (task) return this.queues.get(task)?.length ?? 0;
    return [...this.queues.values()].reduce((n, q) => n + q.length, 0);
  }

  callsFor(task: LLMTask): LLMRequest[] {
    return this.calls.filter((c) => c.task === task);
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const reply = this.queues.get(req.task)?.shift();
    if (reply === undefined) throw new Error(`ScriptedProvider: no scripted reply queued for task "${req.task}"`);
    const value = typeof reply === 'function' ? (reply as (r: LLMRequest) => unknown)(req) : reply;
    const rawText = typeof value === 'string' ? value : JSON.stringify(value);
    // Streams in a few uneven chunks, so tests exercise the incremental path.
    if (req.onText) for (let i = 0; i < rawText.length; i += 37) req.onText(rawText.slice(i, i + 37));
    return { rawText, model: 'scripted' };
  }
}
