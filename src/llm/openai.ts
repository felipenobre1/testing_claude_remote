import OpenAI from 'openai';
import { toWireSchema } from '../domain/schemas.ts';
import { LLMError, type LLMProvider, type LLMRequest, type LLMResponse, type LLMTask } from './provider.ts';

type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface OpenAIProviderOptions {
  apiKey?: string;
  model?: string;
  /** Per-task reasoning effort. Interpretation is a simple parsing job; NPC turns need more judgement. */
  effort?: Partial<Record<LLMTask, Effort>>;
  timeoutMs?: number;
  baseURL?: string;
  maxRetries?: number;
}

export const DEFAULT_OPENAI_MODEL = 'gpt-6-luna';

/** Live provider: OpenAI Responses API with strict JSON-schema structured output. */
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  readonly model: string;
  private client: OpenAI;
  private effort: Record<LLMTask, Effort>;

  constructor(opts: OpenAIProviderOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new LLMError('config', 'OPENAI_API_KEY is not set');
    this.client = new OpenAI({ apiKey, baseURL: opts.baseURL, timeout: opts.timeoutMs ?? 120_000, maxRetries: opts.maxRetries ?? 2 });
    this.model = opts.model ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
    this.effort = {
      interpret: (process.env.OPENAI_EFFORT_INTERPRET as Effort) ?? 'low',
      generate_character: (process.env.OPENAI_EFFORT_GENERATE as Effort) ?? 'low',
      npc_turn: (process.env.OPENAI_EFFORT_NPC as Effort) ?? 'medium',
      decision_state: (process.env.OPENAI_EFFORT_DECISION_STATE as Effort) ?? 'low',
      npc_appraise: (process.env.OPENAI_EFFORT_APPRAISE as Effort) ?? 'medium',
      director: (process.env.OPENAI_EFFORT_DIRECTOR as Effort) ?? 'medium',
      world_copilot: (process.env.OPENAI_EFFORT_COPILOT as Effort) ?? 'medium',
      scene_beat: (process.env.OPENAI_EFFORT_BEAT as Effort) ?? 'medium',
      narrate: (process.env.OPENAI_EFFORT_NARRATE as Effort) ?? 'medium',
      game_master: (process.env.OPENAI_EFFORT_GM as Effort) ?? 'low',
      ...opts.effort,
    };
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    let res: OpenAI.Responses.Response;
    try {
      res = await this.client.responses.create({
        model: this.model,
        instructions: req.system,
        input: req.user,
        reasoning: { effort: this.effort[req.task] },
        text: { format: { type: 'json_schema', name: req.schemaName, schema: toWireSchema(req.schema), strict: true } },
        store: false,
      });
    } catch (e) {
      if (e instanceof OpenAI.APIConnectionError) throw new LLMError('network', `OpenAI unreachable: ${e.message}`);
      if (e instanceof OpenAI.APIError) throw new LLMError(`http_${e.status ?? 'unknown'}`, e.message);
      throw e;
    }

    const meta = { responseId: res.id, status: res.status, usage: res.usage, incomplete: res.incomplete_details };
    for (const item of res.output) {
      if (item.type === 'message') {
        for (const c of item.content) {
          if (c.type === 'refusal') throw new LLMError('refusal', `model refused: ${c.refusal}`);
        }
      }
    }
    if (res.status === 'incomplete') {
      throw new LLMError('incomplete', `response incomplete: ${res.incomplete_details?.reason ?? 'unknown'}`);
    }
    return { rawText: res.output_text, model: res.model, meta };
  }
}
