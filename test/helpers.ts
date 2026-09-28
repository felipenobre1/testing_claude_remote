import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/store.ts';
import type { CharacterProposal, DecisionState, InterpretResult } from '../src/domain/schemas.ts';
import { Engine } from '../src/engine/turn.ts';
import { ScriptedProvider } from '../src/llm/scripted.ts';
import type { LLMTask } from '../src/llm/provider.ts';
import { CLASSIC_DRAFT, startupPack } from '../src/packs/startup/index.ts';

/** The Startup pack with its original opening (idea stage, €2,500) — the world most tests were written against. */
export const classicStartupPack = { ...startupPack, worldCreation: { ...startupPack.worldCreation, template: CLASSIC_DRAFT } };

export function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'startup-test-')), 'game.db');
}

/** A "session": fresh store + provider + engine on an existing (or new) database file. */
export function openSession(path: string, opts: { rng?: (seed: string) => () => number; director?: boolean } = {}) {
  const store = new Store(path);
  const llm = new ScriptedProvider();
  const engine = new Engine(store, llm, { pack: classicStartupPack, beats: false, narrator: false, ...opts });
  return { store, llm, engine, close: () => store.close() };
}

export function interp(p: Partial<InterpretResult> = {}): InterpretResult {
  return {
    intents: ['speak'], target: null, channel: null, spokenText: null, visibleAction: null, privateThought: null,
    newLocation: null, newSceneDescription: null, safety: 'none', actions: [], minutesElapsed: 0, narration: '', clarificationQuestion: null, suggestions: [], deeds: [], ...p,
  };
}

export function npc(p: Record<string, unknown> = {}) {
  return {
    expressedDecision: null, counterTerms: null, condition: null,
    dialogue: 'Mm, ok.', perceivable: '', endsConversation: false, eventSummary: 'They chat briefly.', importance: 1,
    mentionedCharacterNames: [], minutesElapsed: 1, attack: null, changes: [], ...p,
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

export const lastPrompt = (llm: ScriptedProvider, task: LLMTask) =>
  llm.callsFor(task).at(-1)!.user;

/** A fixed roll: 0.5 ⇒ +0, 1 ⇒ +10, 0 ⇒ −10. */
export const fixedRng = (x: number) => () => () => x;

export function seedDecisionState(store: Store, gameId: string, characterId: string, domain: string, state: DecisionState) {
  store.upsertDecisionState(gameId, characterId, domain, state, 'seed', new Date().toISOString());
}

/** Matteo, happy to join as cofounder: no hard limits, weak alternative, trusts Felipe. */
export const MATTEO_KEEN: DecisionState = {
  role: 'student offered a cofounder role by a close friend',
  goals: ['Do something that matters alongside university'],
  pressures: [],
  alternatives: [{ text: 'keep studying and working weekends at the hardware shop', strength: 0.2 }],
  limits: [],
  requiresApproval: null,
  criteria: [
    { factor: 'trust', weight: 2, note: 'trusts Felipe' },
    { factor: 'offer_quality', weight: 2, note: 'a fair stake' },
    { factor: 'confidence_in_player', weight: 2, note: 'believes Felipe can build it' },
  ],
  baseWillingness: 55,
};
