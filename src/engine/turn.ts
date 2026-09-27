import type { z } from 'zod';
import type { Store } from '../db/store.ts';
import {
  CharacterProposalSchema, InterpretResultSchema, NpcTurnEnvelopeSchema, NpcTurnWireSchema,
  type InterpretResult, type NpcTurnEnvelope,
} from '../domain/schemas.ts';
import type {
  Character, Game, GameEvent, Interaction, Relationship, Scene, TranscriptLine, TurnResponse,
} from '../domain/types.ts';
import type { LLMProvider, LLMTask } from '../llm/provider.ts';
import {
  perspectiveTrace, renderNpcBriefing, renderPlayerBriefing, retrieveNpcPerspective, retrievePlayerPerspective,
  type NpcContextInput, type PendingCharacter,
} from './context.ts';
import { createGame, openingText, type NewGameOptions } from './newGame.ts';
import { GENERATE_SYSTEM_PROMPT, generateUserPrompt, interpretSystemPrompt, npcSystemPrompt } from './prompts.ts';
import { newTrace, type Trace, type WriteRecord } from './trace.ts';
import { addMinutes, formatGameTime, newId } from './util.ts';
import { validateChanges, validateCharacterProposal, type AcceptedChange, type Rejection } from './validate.ts';

export interface TurnRequest {
  gameId: string;
  input: string;
  requestId?: string; // same id ⇒ same committed result, never applied twice
}

/** Turn could not be completed; nothing canonical was written. */
export class TurnFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnFailure';
  }
}
class RevisionConflict extends TurnFailure {}
class AlreadyFinal extends Error {
  readonly response: TurnResponse;
  constructor(response: TurnResponse) {
    super('request already committed');
    this.response = response;
  }
}

/** Everything a turn wants to write, assembled before the transaction opens. */
interface WritePlan {
  newCharacter: { character: Character; relationship: Relationship } | null;
  interactionsToInsert: Interaction[];
  interactionsToEnd: { id: string; gameTime: string }[];
  events: GameEvent[];
  changes: { change: AcceptedChange; sourceEventId: string; gameTime: string; channel: string }[];
  scene: Scene;
  newGameTime: string;
}

export class Engine {
  readonly store: Store;
  readonly llm: LLMProvider;
  private now: () => string;

  constructor(store: Store, llm: LLMProvider, opts: { now?: () => string } = {}) {
    this.store = store;
    this.llm = llm;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  newGame(opts: NewGameOptions = {}) {
    const { game, player } = createGame(this.store, { now: this.now(), ...opts });
    return { game, player, opening: openingText(game) };
  }

  async takeTurn(req: TurnRequest): Promise<TurnResponse> {
    const requestId = req.requestId ?? newId('req');
    const prior = this.store.getFinalTurnByRequest(req.gameId, requestId);
    if (prior?.response) return { ...prior.response, replayed: true };

    const game = this.store.getGame(req.gameId);
    if (!game) throw new Error(`game ${req.gameId} not found`);
    const trace = newTrace({ turnId: newId('turn'), requestId, game, input: req.input, provider: this.llm.name });

    try {
      return await this.run(req.input, game, trace);
    } catch (e) {
      if (e instanceof AlreadyFinal) return { ...e.response, replayed: true };
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      trace.status = 'failed';
      trace.error = message;
      const response = this.response(trace, game.gameTime, {
        status: 'failed',
        error: message,
        text: 'Something went wrong while resolving that — nothing was saved. Try again.',
      });
      trace.response = response;
      this.store.insertTurn({
        id: trace.turnId, gameId: game.id, requestId, status: 'failed', baseRevision: game.revision, committedRevision: null,
        playerInput: req.input, response, trace, createdAt: this.now(),
      });
      return response;
    }
  }

  // --------------------------------------------------------------------------

  private async run(input: string, game: Game, trace: Trace): Promise<TurnResponse> {
    const store = this.store;
    const now = this.now();
    const pp = retrievePlayerPerspective(store, game.id);
    const player = pp.player;
    trace.scene = pp.scene;
    trace.openInteraction = pp.interaction;

    // 1. Interpret raw input from the player's perspective.
    const interp = await this.callStructured<InterpretResult>(trace, 'interpret', interpretSystemPrompt(player.name),
      renderPlayerBriefing(pp, input), 'interpretation', InterpretResultSchema, InterpretResultSchema);
    trace.interpretation = interp;
    if (interp.clarificationQuestion) return this.clarify(trace, game, interp.clarificationQuestion);

    // 2. Resolve who the player is addressing; generate them if they don't exist yet.
    const everyone = store.listCharacters(game.id);
    const npcs = everyone.filter((c) => !c.isPlayer);
    const open = pp.interaction && !pp.interaction.endedGameTime ? pp.interaction : null;
    let target: Character | undefined;
    let pending: PendingCharacter | undefined;
    const intents = new Set(interp.intents);
    const contacting = intents.has('start_conversation') || Boolean(interp.spokenText);
    const targetName = interp.target?.name;
    if (targetName && !sameName(targetName, player.name) && contacting) {
      const matches = findByName(npcs, targetName);
      if (matches.length > 1) {
        trace.resolution = { kind: 'ambiguous', name: targetName, candidates: matches.map((c) => c.id) };
        return this.clarify(trace, game, `Who do you mean — ${matches.map((c) => c.name).join(' or ')}?`);
      }
      if (matches.length === 1) {
        target = matches[0];
        trace.resolution = { kind: 'existing', name: targetName, characterId: target!.id };
      } else {
        pending = await this.generateCharacter(trace, game, player, everyone, targetName, interp.target!.relationHint);
        target = pending.character;
        trace.resolution = { kind: 'generated', name: targetName, characterId: target.id };
      }
    } else if (targetName && !contacting) {
      trace.resolution = { kind: 'none', name: targetName }; // mentioned, not contacted: nobody is created
    } else if (open && interp.spokenText) {
      target = store.getCharacter(open.participantIds.find((id) => id !== player.id)!);
      trace.resolution = { kind: 'open_conversation', characterId: target?.id };
    } else {
      trace.resolution = { kind: 'none' };
    }

    // 3. Conversation bookkeeping.
    const t0 = game.gameTime;
    const t1 = addMinutes(t0, interp.minutesElapsed);
    const location = interp.newLocation ?? pp.scene.location;
    const scene: Scene = { ...pp.scene, location, activeCharacterIds: [...pp.scene.activeCharacterIds], updatedAt: now };
    const plan: WritePlan = {
      newCharacter: null, interactionsToInsert: [], interactionsToEnd: [], events: [], changes: [], scene, newGameTime: t1,
    };
    const event = (e: Omit<GameEvent, 'id' | 'gameId' | 'turnId' | 'createdAt' | 'location'> & { location?: string | null }): GameEvent => {
      const ev: GameEvent = { id: newId('evt'), gameId: game.id, turnId: trace.turnId, createdAt: now, location, ...e };
      plan.events.push(ev);
      return ev;
    };
    const endInteraction = (i: Interaction, at: string, byName: string) => {
      plan.interactionsToEnd.push({ id: i.id, gameTime: at });
      event({
        interactionId: i.id, gameTime: at, type: 'conversation_ended', summary: `${byName} ended the ${label(i.channel)}.`,
        transcript: [{ speakerId: null, speakerName: null, text: `${byName} ended the ${label(i.channel)}.` }], importance: 1,
        participants: i.participantIds.map((id) => ({ characterId: id, role: 'actor' as const })),
        observers: i.participantIds.map((id) => ({ characterId: id, channel: i.channel })),
      });
      if (scene.interactionId === i.id) scene.interactionId = null;
      if (i.channel === 'in_person') scene.activeCharacterIds = scene.activeCharacterIds.filter((id) => !i.participantIds.includes(id) || id === player.id);
    };

    let interaction: Interaction | null = open;
    let startedNew = false;
    if (target && contacting && (!open || !open.participantIds.includes(target.id))) {
      if (open) endInteraction(open, t0, player.name);
      interaction = {
        id: newId('int'), gameId: game.id, channel: interp.channel ?? 'phone', participantIds: [player.id, target.id],
        startedGameTime: t1, endedGameTime: null, createdAt: now,
      };
      plan.interactionsToInsert.push(interaction);
      scene.interactionId = interaction.id;
      if (interaction.channel === 'in_person') scene.activeCharacterIds.push(target.id);
      startedNew = true;
    }
    const inPersonHere = scene.activeCharacterIds.filter((id) => id !== player.id);

    // 4. Player-side events. Private thoughts are observed by the player alone.
    if (interp.privateThought) {
      event({
        interactionId: null, gameTime: t0, type: 'private_thought', summary: `${player.name} thought: ${interp.privateThought}`,
        transcript: [], importance: 1,
        participants: [{ characterId: player.id, role: 'actor' }], observers: [{ characterId: player.id, channel: 'self' }],
      });
    }
    const speakingToNobody = interp.spokenText && !(target && interaction);
    if (interp.visibleAction || speakingToNobody) {
      const what = [interp.visibleAction, speakingToNobody ? `says aloud: "${interp.spokenText}"` : null].filter(Boolean).join('; ');
      const inConversationInPerson = interaction?.channel === 'in_person';
      event({
        interactionId: inConversationInPerson ? interaction!.id : null, gameTime: t0, type: 'action', summary: `${player.name}: ${what}`,
        transcript: inConversationInPerson ? [{ speakerId: null, speakerName: null, text: `${player.name} ${what}` }] : [],
        importance: 1, participants: [{ characterId: player.id, role: 'actor' }],
        observers: [{ characterId: player.id, channel: 'self' }, ...inPersonHere.map((id) => ({ characterId: id, channel: 'in_person' as const }))],
      });
    }
    if (startedNew && interaction && target) {
      const text = `${player.name} ${interaction.channel === 'phone' ? 'calls' : interaction.channel === 'message' ? 'texts' : 'meets'} ${target.name}${interaction.channel === 'phone' ? ' on the phone' : ''}.`;
      event({
        interactionId: interaction.id, gameTime: t1, type: 'conversation_started', summary: text,
        transcript: [{ speakerId: null, speakerName: null, text }], importance: 1,
        participants: [{ characterId: player.id, role: 'actor' }, { characterId: target.id, role: 'addressee' }],
        observers: interaction.participantIds.map((id) => ({ characterId: id, channel: interaction!.channel })),
      });
    }
    if (pending) {
      plan.newCharacter = {
        character: pending.character,
        relationship: {
          id: newId('rel'), gameId: game.id, fromCharacterId: pending.character.id, toCharacterId: player.id,
          summary: pending.relationshipSummary, source: 'backstory', sourceEventId: null, createdAt: now, updatedAt: now,
        },
      };
    }

    // 5. NPC turn — from the NPC's restricted perspective.
    let npcOut: NpcTurnEnvelope | null = null;
    // "I hang up and call Sofia": the old call was already ended by the switch above.
    const endRequested = intents.has('end_conversation') && !startedNew;
    const npcShouldRespond = target && interaction && (startedNew || Boolean(interp.spokenText));
    if (npcShouldRespond && target && interaction) {
      // What the NPC perceives this turn, in order. Never the raw input, never private thoughts.
      const pendingLines: TranscriptLine[] = [];
      if (startedNew) pendingLines.push(plan.events.find((e) => e.type === 'conversation_started')!.transcript[0]!);
      if (interaction.channel === 'in_person' && interp.visibleAction) {
        pendingLines.push({ speakerId: null, speakerName: null, text: `${player.name} ${interp.visibleAction}` });
      }
      if (interp.spokenText) pendingLines.push({ speakerId: player.id, speakerName: player.name, text: interp.spokenText });
      if (endRequested) pendingLines.push({ speakerId: null, speakerName: null, text: `${player.name} is wrapping up the ${label(interaction.channel)}.` });
      const ctxInput: NpcContextInput = {
        npcId: target.id, partner: player, channel: interaction.channel, interactionId: startedNew ? null : interaction.id,
        pendingLines, gameTime: t1, sceneLocation: location, pending,
      };
      const perspective = retrieveNpcPerspective(store, ctxInput);
      trace.retrieval = perspectiveTrace(perspective);

      const known = pending ? [...everyone, pending.character] : everyone;
      const vctx = { npc: target, observerIds: interaction.participantIds, findCharacter: (n: string) => findByName(known, n)[0] };
      trace.validation = [];
      npcOut = await this.callStructured<NpcTurnEnvelope>(trace, 'npc_turn', npcSystemPrompt(target), renderNpcBriefing(perspective, ctxInput),
        'npc_turn', NpcTurnWireSchema, NpcTurnEnvelopeSchema, (out, attempt) => {
          const v = validateChanges(out.changes, vctx);
          trace.validation!.push({ attempt, proposals: out.changes, accepted: v.accepted, rejected: v.rejected });
          return v.rejected.map((r: Rejection) => `changes[${r.index}] rejected: ${r.reason}`);
        });
      trace.npcOutput = npcOut;
      const accepted = trace.validation.at(-1)!.accepted;

      const mentioned = npcOut.mentionedCharacterNames
        .map((n) => findByName(known, n)[0])
        .filter((c): c is Character => Boolean(c) && c!.id !== player.id && c!.id !== target!.id);
      const exchange = event({
        interactionId: interaction.id, gameTime: t1, type: 'conversation_turn', summary: npcOut.eventSummary,
        transcript: [
          ...(interp.spokenText ? [{ speakerId: player.id, speakerName: player.name, text: interp.spokenText }] : []),
          ...(npcOut.dialogue ? [{ speakerId: target.id, speakerName: target.name, text: npcOut.dialogue }] : []),
        ],
        importance: npcOut.importance,
        participants: [
          { characterId: player.id, role: 'actor' }, { characterId: target.id, role: 'actor' },
          ...mentioned.map((c) => ({ characterId: c.id, role: 'mentioned' as const })),
        ],
        observers: interaction.participantIds.map((id) => ({ characterId: id, channel: interaction!.channel })),
      });
      const tExchange = addMinutes(t1, npcOut.minutesElapsed);
      plan.newGameTime = tExchange;
      for (const change of accepted) plan.changes.push({ change, sourceEventId: exchange.id, gameTime: t1, channel: interaction.channel });
    }

    // 6. Endings.
    let conversationEnded = false;
    if (interaction && (endRequested || npcOut?.endsConversation)) {
      endInteraction(interaction, plan.newGameTime, npcOut?.endsConversation && !endRequested ? target!.name : player.name);
      conversationEnded = true;
    }

    // 7. Commit atomically, then respond.
    const parts = [interp.narration.trim() || (!npcOut && interp.privateThought ? 'You turn the thought over in your head for a while.' : '')];
    if (npcOut && target) {
      if (npcOut.perceivable.trim()) parts.push(npcOut.perceivable.trim());
      if (npcOut.dialogue.trim()) parts.push(`${target.name}: “${npcOut.dialogue.trim()}”`);
    }
    if (conversationEnded) parts.push(`[The ${label(interaction!.channel)} has ended.]`);
    const response = this.response(trace, plan.newGameTime, {
      status: 'committed',
      narration: interp.narration,
      npc: npcOut && target
        ? { characterId: target.id, name: target.name, dialogue: npcOut.dialogue, perceivable: npcOut.perceivable, isNew: Boolean(pending) }
        : null,
      conversationEnded,
      text: parts.filter(Boolean).join('\n\n') || '(Nothing much happens.)',
    });
    this.commit(game, player, plan, trace, response, input);
    return response;
  }

  /** Single transaction: revision check, all writes, turn record. Throws ⇒ nothing written. */
  private commit(game: Game, player: Character, plan: WritePlan, trace: Trace, response: TurnResponse, input: string): void {
    const store = this.store;
    const now = this.now();
    const writes: WriteRecord[] = [];
    const w = (table: string, op: string, id: string, note?: string) => writes.push(note ? { table, op, id, note } : { table, op, id });

    store.tx(() => {
      const final = store.getFinalTurnByRequest(game.id, trace.requestId);
      if (final?.response) throw new AlreadyFinal(final.response);
      const current = store.getGame(game.id)!;
      if (current.revision !== game.revision) {
        throw new RevisionConflict(`game changed during the turn (revision ${game.revision} → ${current.revision}); retry`);
      }

      if (plan.newCharacter) {
        store.insertCharacter(plan.newCharacter.character);
        w('characters', 'insert', plan.newCharacter.character.id, plan.newCharacter.character.name);
        store.upsertRelationship(plan.newCharacter.relationship);
        w('relationships', 'insert', plan.newCharacter.relationship.id, 'backstory');
      }
      for (const i of plan.interactionsToInsert) {
        store.insertInteraction(i);
        w('interactions', 'insert', i.id);
      }
      for (const e of plan.events) {
        store.insertEvent(e);
        w('events', 'insert', e.id, `${e.type}; observers=${e.observers.map((o) => o.characterId).join(',')}`);
      }
      for (const i of plan.interactionsToEnd) {
        store.endInteraction(i.id, i.gameTime);
        w('interactions', 'update', i.id, 'ended');
      }
      const existingMemories = new Map<string, Set<string>>();
      for (const { change, sourceEventId, gameTime, channel } of plan.changes) {
        if (change.op === 'create_memory') {
          if (!existingMemories.has(change.ownerId)) {
            existingMemories.set(change.ownerId, new Set(store.listMemoriesOwnedBy(change.ownerId).map((m) => norm(m.summary))));
          }
          if (existingMemories.get(change.ownerId)!.has(norm(change.summary))) {
            w('memories', 'skip', '-', 'identical memory already exists');
            continue;
          }
          const id = newId('mem');
          store.insertMemory({
            id, gameId: game.id, ownerCharacterId: change.ownerId, summary: change.summary, importance: change.importance,
            emotionalWeight: change.emotionalWeight, source: 'gameplay', sourceEventId, gameTime, createdAt: now, subjectIds: change.subjectIds,
          });
          w('memories', 'insert', id);
        } else if (change.op === 'upsert_knowledge') {
          const source = `${change.sourceKind === 'told' ? `told by ${player.name}` : change.sourceKind} (${channel}, ${formatGameTime(gameTime)})`;
          const r = store.upsertKnowledge({
            id: newId('know'), gameId: game.id, characterId: change.ownerId, topic: change.topic, belief: change.belief,
            confidence: change.confidence, aboutCharacterId: change.aboutCharacterId, factId: null, source, sourceEventId, gameTime,
            createdAt: now, updatedAt: now,
          });
          w('knowledge', r.op, r.id, change.topic);
        } else {
          const op = store.upsertRelationship({
            id: newId('rel'), gameId: game.id, fromCharacterId: change.fromId, toCharacterId: change.toId, summary: change.summary,
            source: 'gameplay', sourceEventId, createdAt: now, updatedAt: now,
          });
          w('relationships', op, `${change.fromId}→${change.toId}`);
        }
      }
      store.updateScene(plan.scene);
      w('scenes', 'update', plan.scene.id);
      const revision = current.revision + 1;
      store.advanceGame(game.id, plan.newGameTime, revision, now);
      w('games', 'update', game.id, `revision ${revision}, time ${plan.newGameTime}`);

      trace.status = 'committed';
      trace.writes = writes;
      trace.committedRevision = revision;
      trace.response = response;
      store.insertTurn({
        id: trace.turnId, gameId: game.id, requestId: trace.requestId, status: 'committed', baseRevision: game.revision,
        committedRevision: revision, playerInput: input, response, trace, createdAt: now,
      });
    });
  }

  private async generateCharacter(trace: Trace, game: Game, player: Character, everyone: Character[], name: string, relationHint: string | null): Promise<PendingCharacter> {
    const user = generateUserPrompt({ name, relationHint, player, gameTime: game.gameTime, existingNames: everyone.filter((c) => !c.isPlayer).map((c) => c.name) });
    const p = await this.callStructured(trace, 'generate_character', GENERATE_SYSTEM_PROMPT, user, 'character',
      CharacterProposalSchema, CharacterProposalSchema, (proposal) => validateCharacterProposal(proposal, name, everyone));
    const now = this.now();
    const character: Character = {
      id: newId('chr'), gameId: game.id, isPlayer: false, name: p.name.trim(), age: p.age, gender: p.gender, role: p.role,
      occupation: p.occupation, background: p.background, personality: p.personality, traits: p.traits, values: p.values,
      goals: p.goals, fears: p.fears, location: p.location, origin: 'generated', createdAt: now, updatedAt: now,
    };
    trace.generatedCharacter = { ...character, relationshipToPlayer: p.relationshipToPlayer };
    return { character, relationshipSummary: p.relationshipToPlayer };
  }

  /**
   * One structured call with at most one corrective retry. Output must be JSON, match the schema,
   * and pass `check` (backend rules). Every attempt is recorded verbatim in the trace.
   */
  private async callStructured<T>(
    trace: Trace, task: LLMTask, system: string, user: string, schemaName: string,
    wire: z.ZodType, parse: z.ZodType<T>, check?: (value: T, attempt: number) => string[],
  ): Promise<T> {
    let feedback: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const prompt = feedback.length
        ? `${user}\n\nYOUR PREVIOUS OUTPUT WAS REJECTED BY THE GAME ENGINE:\n${feedback.map((f) => `- ${f}`).join('\n')}\nReturn corrected JSON.`
        : user;
      const call: Trace['llmCalls'][number] = { task, attempt, system, user: prompt, rawText: null, model: null, problems: [] };
      trace.llmCalls.push(call);
      const res = await this.llm.complete({ task, system, user: prompt, schemaName, schema: wire });
      call.rawText = res.rawText;
      call.model = res.model;
      if (res.meta) call.meta = res.meta;

      let value: unknown;
      try {
        value = JSON.parse(res.rawText);
      } catch {
        feedback = [`output was not valid JSON`];
        call.problems = feedback;
        continue;
      }
      const parsed = parse.safeParse(value);
      if (!parsed.success) {
        feedback = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
        call.problems = feedback;
        continue;
      }
      feedback = check?.(parsed.data, attempt) ?? [];
      call.problems = feedback;
      if (feedback.length === 0) return parsed.data;
    }
    throw new TurnFailure(`${task}: model output rejected on both attempts (${feedback.join('; ')})`);
  }

  private clarify(trace: Trace, game: Game, question: string): TurnResponse {
    const response = this.response(trace, game.gameTime, { status: 'clarification', clarificationQuestion: question, text: question });
    trace.status = 'clarification';
    trace.response = response;
    this.store.insertTurn({
      id: trace.turnId, gameId: game.id, requestId: trace.requestId, status: 'clarification', baseRevision: game.revision,
      committedRevision: null, playerInput: trace.input, response, trace, createdAt: this.now(),
    });
    return response;
  }

  private response(trace: Trace, gameTime: string, r: Partial<TurnResponse> & Pick<TurnResponse, 'status' | 'text'>): TurnResponse {
    return {
      requestId: trace.requestId, turnId: trace.turnId, gameTime, narration: '', npc: null, conversationEnded: false,
      clarificationQuestion: null, error: null, ...r,
    };
  }
}

// ---- helpers ----

const label = (channel: string) => (channel === 'phone' ? 'call' : channel === 'message' ? 'chat' : 'conversation');
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const sameName = (a: string, b: string) => norm(a) === norm(b) || norm(a).split(' ')[0] === norm(b).split(' ')[0];

/** Exact full-name match; a bare first name ("Marco") also matches by first name. */
export function findByName(characters: Character[], name: string): Character[] {
  const n = norm(name);
  const exact = characters.filter((c) => norm(c.name) === n);
  if (exact.length || n.includes(' ')) return exact;
  return characters.filter((c) => norm(c.name).split(' ')[0] === n);
}
