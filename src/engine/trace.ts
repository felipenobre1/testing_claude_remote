import type { InterpretResult, NpcTurnEnvelope } from '../domain/schemas.ts';
import type { Character, Game, Interaction, Scene, TurnResponse } from '../domain/types.ts';
import type { AcceptedChange, Rejection } from './validate.ts';
import type { perspectiveTrace } from './context.ts';

export interface WriteRecord {
  table: string;
  op: string;
  id: string;
  note?: string;
}

/**
 * Everything needed to explain a turn after the fact. Stored as JSON in turns.trace_json.
 * Contains inputs, outputs and state transitions — never model chain-of-thought.
 */
export interface Trace {
  turnId: string;
  requestId: string;
  gameId: string;
  provider: string;
  baseRevision: number;
  gameTimeBefore: string;
  input: string;
  scene?: Scene;
  openInteraction?: Interaction | null;
  llmCalls: {
    task: string;
    attempt: number;
    system: string;
    user: string; // exact prompt sent
    rawText: string | null; // exact model output
    model: string | null;
    meta?: Record<string, unknown>;
    problems: string[]; // parse/validation problems with this attempt
  }[];
  interpretation?: InterpretResult;
  resolution?: { kind: 'existing' | 'generated' | 'open_conversation' | 'none' | 'ambiguous'; name?: string; characterId?: string; candidates?: string[] };
  generatedCharacter?: Character & { relationshipToPlayer: string };
  retrieval?: ReturnType<typeof perspectiveTrace> & { economyIds?: string[] };
  documents?: { id: string; url: string; finalUrl: string; status: string; title: string | null; chars: number; error: string | null }[];
  npcOutput?: NpcTurnEnvelope;
  economy?: { actions: unknown[]; actionErrors: string[]; rejected: { action: unknown; reason: string }[]; results: string[]; ops: string[]; events: string[] };
  validation?: { attempt: number; proposals: unknown[]; accepted: AcceptedChange[]; rejected: Rejection[] }[];
  writes?: WriteRecord[];
  committedRevision?: number;
  status: 'pending' | 'committed' | 'clarification' | 'failed';
  error?: string;
  response?: TurnResponse;
}

export function newTrace(a: { turnId: string; requestId: string; game: Game; input: string; provider: string }): Trace {
  return {
    turnId: a.turnId, requestId: a.requestId, gameId: a.game.id, provider: a.provider, baseRevision: a.game.revision,
    gameTimeBefore: a.game.gameTime, input: a.input, llmCalls: [], status: 'pending',
  };
}
