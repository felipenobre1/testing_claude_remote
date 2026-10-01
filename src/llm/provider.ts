import type { z } from 'zod';

export type LLMTask = 'interpret' | 'generate_character' | 'npc_turn' | 'decision_state' | 'npc_appraise' | 'director' | 'world_copilot' | 'scene_beat' | 'narrate' | 'game_master';

/**
 * One structured completion. The engine builds the prompts (so traces show exactly what was sent);
 * providers only transport them and return the raw text. Parsing and validation happen in the engine.
 */
export interface LLMRequest {
  task: LLMTask;
  system: string;
  user: string;
  schemaName: string;
  schema: z.ZodType; // the provider converts it to its structured-output format
  /** Streaming: called with the raw output text as it arrives (a provider that can't stream calls it once with everything). */
  onText?: (delta: string) => void;
}

export interface LLMResponse {
  rawText: string;
  model: string;
  meta?: Record<string, unknown>; // usage, stop reason, response id…
}

export interface LLMProvider {
  readonly name: string;
  complete(req: LLMRequest): Promise<LLMResponse>;
}

/** Transport-level failure (network, refusal, truncation). Distinct from invalid output. */
export class LLMError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(`[${kind}] ${message}`);
    this.name = 'LLMError';
    this.kind = kind;
  }
}
