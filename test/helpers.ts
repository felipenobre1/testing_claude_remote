import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/store.ts';
import type { CharacterProposal, InterpretResult } from '../src/domain/schemas.ts';
import { Engine } from '../src/engine/turn.ts';
import { ScriptedProvider } from '../src/llm/scripted.ts';

export function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'startup-test-')), 'game.db');
}

/** A "session": fresh store + provider + engine on an existing (or new) database file. */
export function openSession(path: string) {
  const store = new Store(path);
  const llm = new ScriptedProvider();
  const engine = new Engine(store, llm);
  return { store, llm, engine, close: () => store.close() };
}

export function interp(p: Partial<InterpretResult> = {}): InterpretResult {
  return {
    intents: ['speak'], target: null, channel: null, spokenText: null, visibleAction: null, privateThought: null,
    newLocation: null, newSceneDescription: null, safety: 'none', minutesElapsed: 0, narration: '', clarificationQuestion: null, ...p,
  };
}

export function npc(p: Record<string, unknown> = {}) {
  return {
    dialogue: 'Mm, ok.', perceivable: '', endsConversation: false, eventSummary: 'They chat briefly.', importance: 1,
    mentionedCharacterNames: [], minutesElapsed: 1, changes: [], ...p,
  };
}

export const MATTEO: CharacterProposal = {
  name: 'Matteo Ferrari',
  age: 18,
  gender: 'male',
  role: 'friend of the player',
  occupation: 'First-year engineering student at Politecnico di Milano',
  background: 'Grew up in Lambrate, two streets from Felipe. Friends since the first year of liceo. Parents run a small hardware shop.',
  personality: 'Warm but sardonic; loyal; teases people he likes; cautious with money because his family never had much.',
  traits: ['loyal', 'sarcastic', 'practical'],
  values: ['loyalty', 'honesty', 'family'],
  goals: ['Pass the first-year exams', 'Save for a trip to Japan'],
  fears: ['Disappointing his parents', 'Being left behind by friends'],
  location: 'Lambrate, Milan',
  relationshipToPlayer: 'Old friend from liceo. Thinks Felipe is brilliant with code but a bit of a dreamer.',
};

export const SOFIA: CharacterProposal = {
  name: 'Sofia Conti',
  age: 19,
  gender: 'female',
  role: 'friend of the player',
  occupation: 'Economics student at Bocconi',
  background: 'Met Felipe through a coding club in liceo. Organised, ambitious, works weekends at a café in Porta Romana.',
  personality: 'Direct, competitive, quick to spot weak arguments; generous with time for people she respects.',
  traits: ['direct', 'organised', 'ambitious'],
  values: ['competence', 'independence'],
  goals: ['Land a summer internship at a VC firm'],
  fears: ['Wasting time on things that go nowhere'],
  location: 'Porta Romana, Milan',
  relationshipToPlayer: 'Friend from the liceo coding club. Respects Felipe technically; unsure Felipe can sell anything.',
};

/** Starts a new game and places a phone call to a freshly generated Matteo. */
export async function gameWithMatteoOnPhone(path: string) {
  const s = openSession(path);
  const { game, player } = s.engine.newGame();
  s.llm
    .enqueue('interpret', interp({ intents: ['start_conversation'], target: { name: 'Matteo', relationHint: 'friend' }, channel: 'phone' }))
    .enqueue('generate_character', MATTEO)
    .enqueue('npc_turn', npc({ dialogue: 'Pronto? Felipe!' }));
  const r = await s.engine.takeTurn({ gameId: game.id, input: 'I call my friend Matteo.' });
  if (r.status !== 'committed') throw new Error(`setup failed: ${r.error}`);
  const matteo = s.store.listCharacters(game.id).find((c) => c.name === MATTEO.name)!;
  return { ...s, game, player, matteo };
}

export function counts(store: Store, gameId: string) {
  return Object.fromEntries(
    ['characters', 'relationships', 'facts', 'events', 'memories', 'knowledge', 'interactions'].map((t) => [t, store.count(t, gameId)]),
  );
}

export const lastPrompt = (llm: ScriptedProvider, task: 'interpret' | 'generate_character' | 'npc_turn') =>
  llm.callsFor(task).at(-1)!.user;
