import type { z } from 'zod';
import type { Store } from '../db/store.ts';
import {
  AppraisalSchema, CharacterProposalSchema, COMPUTED_FACTORS, DecisionStateProposalSchema, DirectorProposalSchema, interpretSchemaFor, NpcTurnEnvelopeSchema,
  NpcTurnWireSchema, type Appraisal, type DecisionState, type DecisionStateProposal, type DirectorProposal, type InterpretResult, type NpcTurnEnvelope,
} from '../domain/schemas.ts';
import type {
  Character, Game, GameEvent, Interaction, Offer, Relationship, Scene, TranscriptLine, TurnResponse, WebDocument,
} from '../domain/types.ts';
import type { LLMProvider, LLMTask } from '../llm/provider.ts';
import {
  perspectiveTrace, renderNpcBriefing, renderPlayerBriefing, retrieveNpcPerspective, retrievePlayerPerspective,
  type NpcContextInput, type NpcPerspective, type PendingCharacter,
} from './context.ts';
import {
  appraiseSystemPrompt, appraiseUserPrompt, decisionStateSystemPrompt, decisionStateUserPrompt, generateSystemPrompt, generateUserPrompt,
  interpretSystemPrompt, npcSystemPrompt, type WorldContext,
} from './prompts.ts';
import { newTrace, type Trace, type WriteRecord } from './trace.ts';
import { addMinutes, formatGameTime, newId } from './util.ts';
import { decisionStateProblems, validateChanges, validateCharacterProposal, validatePortrayal, type AcceptedChange, type Rejection } from './validate.ts';
import { extractUrls, type PageFetcher } from './web.ts';
import { applyOps, npcThreadsBriefing, npcWorldBriefing, opportunityLine, playerWorldBriefing, upcoming, WorldPlanner, type PlanContext } from './planner.ts';
import { resolveDecision, type Resolution } from './decision.ts';
import { seededRng, type RngFactory } from './random.ts';
import { runWorldTurn } from './world.ts';
import { backgroundOf, bibleText, compileDraft, createGameFromSeed, worldLine } from './worldSeed.ts';
import { beatDue, beatProblems, beatSystemPrompt, beatUserPrompt, NarrationSchema, narrationProblems, narratorSystemPrompt, narratorUserPrompt, SceneBeatSchema, type NarratorInput, type SceneBeat } from './story.ts';
import type { WorldSeed } from '../domain/world.ts';
import type { GamePack } from '../packs/types.ts';

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
  extraCharacters: { character: Character; relationship: Relationship }[]; // people who arrived in a scene beat
  interactionsToInsert: Interaction[];
  interactionsToEnd: { id: string; gameTime: string }[];
  events: GameEvent[];
  documents: { doc: WebDocument; eventId: string }[];
  changes: { change: AcceptedChange; sourceEventId: string; gameTime: string; channel: string }[];
  scene: Scene;
  newGameTime: string;
}

export class Engine {
  readonly store: Store;
  readonly llm: LLMProvider;
  private now: () => string;
  readonly pack: GamePack;
  private beatsEnabled: boolean;
  private narratorEnabled: boolean;
  private fetcher: PageFetcher | null;
  private rng: RngFactory;
  private directorEnabled: boolean;
  private interpretSchema;

  /**
   * `pack`: the world this engine runs (chosen by the application; the engine knows no packs).
   * `fetcher`: how shared links are opened (null = links are heard but never opened).
   * `rng`: randomness for decisions and world turns, from seeds derived from game + request (tests pass a fixed one).
   * `director`: let the Story Director propose new situations during world turns (one model call per game day).
   */
  constructor(store: Store, llm: LLMProvider, opts: {
    pack: GamePack; now?: () => string; fetcher?: PageFetcher | null; rng?: RngFactory; director?: boolean;
    /** The storyteller: scene beats (by the world's pace) and literary narration (by the world's narration style). Default on. */
    beats?: boolean; narrator?: boolean;
  }) {
    this.store = store;
    this.llm = llm;
    this.pack = opts.pack;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.fetcher = opts.fetcher ?? null;
    this.rng = opts.rng ?? seededRng;
    this.directorEnabled = opts.director ?? false;
    this.beatsEnabled = opts.beats ?? true;
    this.narratorEnabled = opts.narrator ?? true;
    this.interpretSchema = interpretSchemaFor(this.pack.actions.map((a) => a.schema));
    store.migratePack(this.pack.id, this.pack.migrations);
  }

  /**
   * Quick start: create a game straight from the pack's template world (no Copilot conversation).
   * Uses the same compile → seed → create pipeline as a finalized World Creation draft.
   */
  newGame(opts: { playerName?: string } = {}) {
    const t = this.pack.worldCreation.template;
    const draft = opts.playerName ? { ...t, player: { ...t.player, name: opts.playerName } } : t;
    const { seed, problems } = compileDraft(draft, [this.pack], { now: this.now() });
    if (!seed) throw new Error(`the pack template does not compile: ${problems.join('; ')}`);
    return createGameFromSeed(this.store, this.pack, seed, this.now());
  }

  /**
   * In a literary world, the narrator writes the opening scene (who you are, where you are, what presses on you).
   * Returns null when narration is concise, the narrator is off, or it fails — the caller shows the plain opening then.
   */
  async openingProse(gameId: string): Promise<string | null> {
    const world = this.worldOf(gameId);
    if (!this.narratorEnabled || (world.seed.style.narration ?? 'literary') !== 'literary') return null;
    const store = this.store;
    const game = store.getGame(gameId)!;
    const player = store.getCharacter(game.playerCharacterId)!;
    const scene = store.getScene(gameId);
    const planner = new WorldPlanner({ store, pack: world.pack, gameId, turnId: 'opening', now: this.now(), gameTime: game.gameTime, location: scene.location,
      player, characters: store.listCharacters(gameId), interaction: null });
    const seed = world.seed;
    const input: NarratorInput = {
      gameTime: game.gameTime, location: scene.location, sceneDescription: scene.description, playerState: world.pack.briefing.player(planner),
      input: '(the story begins)', playerSaid: null, playerDid: null, draftNarration: '',
      facts: [
        'This is the opening of the story: show the reader who they are, where they wake into the world, and what presses on them.',
        `${player.name}: ${player.background}`, ...(seed.player.ambition ? [`${player.name} dreams ${seed.player.ambition}.`] : []),
        seed.world.currentSituation, ...seed.initialPressures, ...upcoming(store, gameId, game.gameTime, 14).map((i) => `Coming up: ${opportunityLine(i)}`),
      ],
      words: [], conversationEnded: false, choice: null,
    };
    try {
      const res = await this.llm.complete({ task: 'narrate', system: narratorSystemPrompt(world.ctx, world.bible, player.name), user: narratorUserPrompt(input), schemaName: 'narration', schema: NarrationSchema });
      const parsed = NarrationSchema.safeParse(JSON.parse(res.rawText));
      return parsed.success ? parsed.data.prose.trim() : null;
    } catch {
      return null;
    }
  }

  /** The game's setting and design contract, from its immutable WorldSeed. */
  private worldOf(gameId: string): { ctx: WorldContext; bible: string; seed: WorldSeed; pack: GamePack } {
    let seed = this.store.getWorldSeed<WorldSeed>(gameId);
    if (!seed) {
      // Saves from before World Creation: fall back to the pack's template world (not persisted).
      seed = compileDraft(this.pack.worldCreation.template, [this.pack], { gameId, now: this.now() }).seed!;
    }
    // A world may set its own currency at creation; the pack's is the default.
    const pack = seed.player.currency ? { ...this.pack, currency: seed.player.currency } : this.pack;
    return {
      seed, bible: bibleText(seed), pack,
      ctx: { line: worldLine(seed), rules: seed.world.rules, homes: `somewhere plausible in or near ${seed.world.place}`, background: backgroundOf(seed), violence: seed.style.violence ?? 'non_graphic' },
    };
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
    const world = this.worldOf(game.id);
    const pp = retrievePlayerPerspective(store, game.id);
    const player = pp.player;
    trace.scene = pp.scene;
    trace.openInteraction = pp.interaction;
    const everyone = store.listCharacters(game.id);
    const nameOf = (id: string) => everyone.find((c) => c.id === id)?.name ?? id;
    // The world planner simulates resource/offer/promise/thread changes on a copy of canonical state.
    const econCtx: PlanContext = {
      store, pack: world.pack, gameId: game.id, turnId: trace.turnId, now, gameTime: game.gameTime, location: pp.scene.location,
      player, characters: everyone, interaction: null, rng: this.rng, seedBase: `${game.id}:${trace.requestId}`,
    };
    const economy = new WorldPlanner(econCtx);

    // 1. Interpret raw input from the player's perspective.
    const interp = await this.callStructured<InterpretResult>(trace, 'interpret', interpretSystemPrompt(player.name, world.pack, world.ctx),
      renderPlayerBriefing(pp, input, playerWorldBriefing(economy, game.gameTime), world.ctx.line),
      'interpretation', this.interpretSchema, this.interpretSchema as unknown as z.ZodType<InterpretResult>);
    trace.interpretation = interp;
    // Self-harm is never simulated: step out of the fiction, change nothing.
    if (interp.safety === 'self_harm') return this.clarify(trace, game, SELF_HARM_MESSAGE);
    if (interp.clarificationQuestion) return this.clarify(trace, game, interp.clarificationQuestion);

    // 2. Resolve who the player is addressing; generate them if they don't exist yet.
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

    if (target && target.status === 'dead') return this.clarify(trace, game, `${target.name} is dead.`);

    // 3. Conversation bookkeeping.
    const t0 = game.gameTime;
    const t1 = addMinutes(t0, interp.minutesElapsed);
    const location = interp.newLocation ?? pp.scene.location;
    const description = interp.newLocation ? interp.newSceneDescription ?? '' : pp.scene.description; // a new place never inherits the old description
    const scene: Scene = { ...pp.scene, location, description, activeCharacterIds: [...pp.scene.activeCharacterIds], updatedAt: now };
    const plan: WritePlan = {
      newCharacter: null, extraCharacters: [], interactionsToInsert: [], interactionsToEnd: [], events: [], documents: [], changes: [], scene, newGameTime: t1,
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
    // Hours of work or waiting don't happen mid-call: a long activity ends the open conversation.
    if (interaction && !startedNew && interp.minutesElapsed > 60) {
      endInteraction(interaction, t0, player.name);
      interaction = null;
    }
    const inPersonHere = scene.activeCharacterIds.filter((id) => id !== player.id);

    // Player mechanics (money, company, equity, promises) — deterministic, checked against real balances.
    if (pending) econCtx.characters = [...everyone, pending.character];
    econCtx.interaction = interaction;
    econCtx.gameTime = t1;
    econCtx.location = location;
    const actionErrors: string[] = [];
    for (const a of interp.actions) {
      const err = economy.playerAction(a);
      if (err) {
        actionErrors.push(err);
        economy.results.push(`✗ Couldn't do that (${err}).`);
      }
    }
    const playerResultCount = economy.results.length;

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
    // Someone killed this turn does not answer; the conversation is over.
    const targetDied = Boolean(target && target.status === 'dead');
    if (targetDied && interaction) { endInteraction(interaction, t1, player.name); interaction = null; }
    const npcShouldRespond = !targetDied && target && interaction && (startedNew || Boolean(interp.spokenText));
    if (npcShouldRespond && target && interaction) {
      // What the NPC perceives this turn, in order. Never the raw input, never private thoughts.
      const pendingLines: TranscriptLine[] = [];
      if (startedNew) pendingLines.push(plan.events.find((e) => e.type === 'conversation_started')!.transcript[0]!);
      if (interaction.channel === 'in_person' && interp.visibleAction) {
        pendingLines.push({ speakerId: null, speakerName: null, text: `${player.name} ${interp.visibleAction}` });
      }
      if (interp.spokenText) pendingLines.push({ speakerId: player.id, speakerName: player.name, text: interp.spokenText });
      if (endRequested) pendingLines.push({ speakerId: null, speakerName: null, text: `${player.name} is wrapping up the ${label(interaction.channel)}.` });
      // Links the player shares are opened by the backend and shown to the people who received them.
      const pendingDocuments = await this.openSharedLinks(trace, plan, game, player, target, interaction, interp.spokenText, t1);
      const ctxInput: NpcContextInput = {
        npcId: target.id, partner: player, channel: interaction.channel, interactionId: startedNew ? null : interaction.id,
        pendingLines, gameTime: t1, sceneLocation: location, pending, pendingDocuments,
      };
      const econView = npcWorldBriefing(economy, target.id, t1);
      ctxInput.economy = econView.text;
      ctxInput.situations = npcThreadsBriefing(economy, target.id);
      ctxInput.world = world.ctx.line;
      if (economy.witnessed.length) ctxInput.witnessed = economy.witnessed.join('\n');
      const perspective = retrieveNpcPerspective(store, ctxInput);
      trace.retrieval = { ...perspectiveTrace(perspective), economyIds: econView.ids };

      const known = pending ? [...everyone, pending.character] : everyone;
      const vctx = {
        npc: target, observerIds: interaction.participantIds, findCharacter: (n: string) => findByName(known, n)[0], partnerId: player.id,
        obligation: (id: string) => economy.obligation(id), thread: (id: string) => economy.thread(id),
      };

      // Meaningful decision? The engine resolves it BEFORE the NPC is portrayed.
      const decision = await this.resolvePendingDecision(trace, economy, store, game, player, target, perspective, ctxInput, t1);
      if (decision) {
        ctxInput.privateSituation = renderDecisionState(decision.state);
        ctxInput.resolvedDecision = renderResolution(decision.resolution, economy.describeOffer(decision.offer));
      }

      trace.validation = [];
      let counterTerms: Record<string, number> | null = null;
      npcOut = await this.callStructured<NpcTurnEnvelope>(trace, 'npc_turn', npcSystemPrompt(target, world.ctx.line, world.ctx.background, world.ctx.violence), renderNpcBriefing(perspective, ctxInput),
        'npc_turn', NpcTurnWireSchema, NpcTurnEnvelopeSchema, (out, attempt) => {
          const v = validateChanges(out.changes, vctx);
          const p = validatePortrayal(out, decision);
          counterTerms = p.counter;
          trace.validation!.push({ attempt, proposals: out.changes, accepted: v.accepted, rejected: v.rejected, portrayal: p.problems });
          return [...v.rejected.map((r: Rejection) => `changes[${r.index}] rejected: ${r.reason}`), ...p.problems];
        });
      if (decision) {
        economy.applyDecision(decision.offer, decision.resolution, { counter: counterTerms, condition: npcOut.condition, counterNote: npcOut.counterTerms?.note ?? '', appraisal: decision.appraisal });
      }
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
      for (const change of accepted) {
        // Decisions with mechanical consequences are executed by the economy engine; the rest are mind changes.
        let err: string | null = null;
        if (change.op === 'make_promise') economy.npcPromise(target.id, change.toId, change.description, change.dueInDays);
        else if (change.op === 'thread_signal') economy.threadSignal(change.threadId, change.factor, change.value, change.reason);
        else if (change.op === 'fulfill_promise') err = economy.npcFulfill(target.id, change.promiseId);
        else plan.changes.push({ change, sourceEventId: exchange.id, gameTime: t1, channel: interaction.channel });
        if (err) economy.results.push(`✗ ${err}`);
      }
    }
    const npcResultCount = economy.results.length;

    // 6. The world turn: time passes for everyone, not just the player.
    trace.world = await runWorldTurn(economy, t0, plan.newGameTime, {
      store, rng: this.rng, seedBase: `${game.id}:${trace.requestId}`, bible: world.bible,
      director: this.directorEnabled
        ? (system, user) => this.callStructured<DirectorProposal>(trace, 'director', system, user, 'director', DirectorProposalSchema, DirectorProposalSchema)
        : null,
    });
    trace.economy = {
      actions: interp.actions, actionErrors, rejected: economy.rejected, results: economy.results,
      ops: economy.ops.map((o) => o.op), events: economy.events.map((e) => e.id),
    };

    // 7. Endings.
    let conversationEnded = false;
    if (interaction && (endRequested || npcOut?.endsConversation)) {
      endInteraction(interaction, plan.newGameTime, npcOut?.endsConversation && !endRequested ? target!.name : player.name);
      conversationEnded = true;
    }

    // 8. The storyteller: when the pacing clock says so, the world comes to the player.
    const seed = world.seed;
    let beat: SceneBeat | null = null;
    const conversationOpen = Boolean(interaction && !conversationEnded);
    if (this.beatsEnabled && beatDue(store, game.id, seed.style.pace ?? 'steady', { npcResponded: Boolean(npcOut), minutes: interp.minutesElapsed })) {
      beat = await this.sceneBeat(trace, game, player, everyone, pending, economy, plan, interp, conversationOpen, world);
    }

    // 9. Compose the turn: literary narration (everything already decided) or the concise game text.
    const results = economy.results;
    const beatNewcomer = beat?.newPerson ? plan.extraCharacters.at(-1)?.character : undefined;
    const words: NarratorInput['words'] = [];
    if (npcOut && target && npcOut.dialogue.trim()) words.push({ speaker: target.name, text: npcOut.dialogue.trim(), how: npcOut.perceivable.trim() });
    if (beat?.opensConversation) words.push({ speaker: beat.opensConversation.name, text: beat.opensConversation.openingLine.trim(), how: '' });
    let prose: string | null = null;
    if (this.narratorEnabled && (seed.style.narration ?? 'literary') === 'literary') {
      prose = await this.narrate(trace, world, player, economy, {
        gameTime: plan.newGameTime, location: scene.location, sceneDescription: scene.description, playerState: this.pack.briefing.player(economy),
        input, playerSaid: interp.spokenText, playerDid: interp.visibleAction, draftNarration: interp.narration,
        facts: [...results, ...economy.witnessed, ...(beat ? [`${beat.title}: ${beat.perceived}${beatNewcomer ? ` (${beatNewcomer.name}: ${beatNewcomer.role})` : ''}`] : [])],
        words, conversationEnded, choice: beat?.choice ?? null,
      });
    }
    const parts: string[] = [];
    if (prose) {
      parts.push(prose, results.join('\n'));
    } else {
      parts.push(interp.narration.trim() || (!npcOut && interp.privateThought ? 'You turn the thought over in your head for a while.' : ''));
      parts.push(results.slice(0, playerResultCount).join('\n'));
      if (npcOut && target) {
        if (npcOut.perceivable.trim()) parts.push(npcOut.perceivable.trim());
        if (npcOut.dialogue.trim()) parts.push(`${target.name}: “${npcOut.dialogue.trim()}”`);
      }
      parts.push(results.slice(playerResultCount, npcResultCount).join('\n'), results.slice(npcResultCount).join('\n'));
      if (beat) {
        parts.push(`⚡ ${beat.perceived}${beat.opensConversation ? `\n${beat.opensConversation.name}: “${beat.opensConversation.openingLine.trim()}”` : ''}\n→ ${beat.choice}`);
      }
    }
    if (conversationEnded) parts.push(`[The ${label(interaction!.channel)} has ended.]`);
    const response = this.response(trace, plan.newGameTime, {
      status: 'committed',
      narration: prose ?? interp.narration,
      npc: npcOut && target
        ? { characterId: target.id, name: target.name, dialogue: npcOut.dialogue, perceivable: npcOut.perceivable, isNew: Boolean(pending) }
        : null,
      conversationEnded,
      results,
      text: parts.filter(Boolean).join('\n\n') || '(Nothing much happens.)',
      suggestions: interp.suggestions ?? [],
      ...(beat ? { beat: beat.title } : {}),
    });
    this.commit(game, player, plan, economy, trace, response, input);
    return response;
  }

  /** Single transaction: revision check, all writes, turn record. Throws ⇒ nothing written. */
  private commit(game: Game, player: Character, plan: WritePlan, economy: WorldPlanner, trace: Trace, response: TurnResponse, input: string): void {
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

      for (const nc of [...(plan.newCharacter ? [plan.newCharacter] : []), ...plan.extraCharacters]) {
        store.insertCharacter(nc.character);
        w('characters', 'insert', nc.character.id, nc.character.name);
        store.upsertRelationship(nc.relationship);
        w('relationships', 'insert', nc.relationship.id, 'backstory');
      }
      for (const i of plan.interactionsToInsert) {
        store.insertInteraction(i);
        w('interactions', 'insert', i.id);
      }
      for (const { doc } of plan.documents) {
        store.insertDocument(doc);
        w('documents', 'insert', doc.id, `${doc.status} ${doc.url}`);
      }
      for (const e of [...plan.events, ...economy.events]) {
        store.insertEvent(e);
        w('events', 'insert', e.id, `${e.type}; observers=${e.observers.map((o) => o.characterId).join(',')}`);
      }
      for (const { doc, eventId } of plan.documents) {
        store.linkEventDocument(eventId, doc.id);
        w('event_documents', 'insert', `${eventId}→${doc.id}`);
      }
      // Pack state, then engine operations (accounts, offers, decisions, threads, schedule) — after the events they link to.
      for (const wr of economy.packState.commit(store)) writes.push(wr);
      for (const wr of applyOps(store, economy)) writes.push(wr);
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
        } else if (change.op === 'update_relationship') {
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

  private async openSharedLinks(
    trace: Trace, plan: WritePlan, game: Game, player: Character, target: Character, interaction: Interaction,
    spokenText: string | null, gameTime: string,
  ): Promise<WebDocument[]> {
    const urls = spokenText ? extractUrls(spokenText) : [];
    if (!urls.length || !this.fetcher) return [];
    const pages = await Promise.all(urls.map((u) => this.fetcher!.fetch(u)));
    const now = this.now();
    const docs: WebDocument[] = pages.map((p) => ({
      id: newId('doc'), gameId: game.id, url: p.url, finalUrl: p.finalUrl, status: p.status, title: p.title, text: p.text,
      error: p.error, fetchedAt: now, gameTime, createdAt: now,
    }));
    const summary = `${player.name} shared ${docs.map((d) => d.url).join(' and ')} with ${target.name}.`;
    const ev: GameEvent = {
      id: newId('evt'), gameId: game.id, turnId: trace.turnId, interactionId: interaction.id, gameTime, type: 'link_shared', summary,
      transcript: [], importance: 2, location: plan.scene.location, createdAt: now,
      participants: [{ characterId: player.id, role: 'actor' }, { characterId: target.id, role: 'addressee' }],
      observers: interaction.participantIds.map((id) => ({ characterId: id, channel: interaction.channel })),
    };
    plan.events.push(ev);
    for (const doc of docs) plan.documents.push({ doc, eventId: ev.id });
    trace.documents = docs.map((d) => ({ id: d.id, url: d.url, finalUrl: d.finalUrl, status: d.status, title: d.title, chars: d.text.length, error: d.error }));
    return docs;
  }

  /**
   * If an offer is waiting on this NPC and they may decide now: load (or create) their private decision state,
   * have the model appraise the factors THEY care about, then resolve the outcome deterministically.
   */
  private async resolvePendingDecision(
    trace: Trace, economy: WorldPlanner, store: Store, game: Game, player: Character, npc: Character,
    perspective: NpcPerspective, ctxInput: NpcContextInput, gameTime: string,
  ): Promise<{ offer: Offer; state: DecisionState; resolution: Resolution; appraisal: Appraisal } | null> {
    const offer = economy.decidableOffersFor(npc.id)[0];
    if (!offer) return null;
    const offerText = `${economy.describeOffer(offer)} — "${offer.description}"`;

    let state = store.getDecisionState(npc.id, offer.kind);
    let stateSource = 'stored';
    if (!state) {
      const rel = perspective.relationships.find((r) => r.relationship.toCharacterId === player.id)?.relationship.summary ?? '';
      const kind = this.pack.offerKinds.find((k) => k.kind === offer.kind);
      const termKeys = kind?.terms.map((t) => `${t.key} (${t.description})`).join(', ') ?? Object.keys(offer.terms).join(', ');
      const proposal = await this.callStructured<DecisionStateProposal>(trace, 'decision_state', decisionStateSystemPrompt(this.worldOf(game.id).ctx.line, termKeys),
        decisionStateUserPrompt(npc, rel, `${kind?.summary ?? offer.kind}: ${offerText}`, gameTime, this.worldOf(game.id).ctx.line), 'decision_state',
        DecisionStateProposalSchema, DecisionStateProposalSchema, (p) => decisionStateProblems(p));
      state = {
        ...proposal,
        pressures: proposal.pressures.map((p) => ({ text: p.text, expiresGameTime: p.expiresInDays === null ? null : addMinutes(gameTime, Math.round(p.expiresInDays * 1440)) })),
      };
      economy.saveDecisionState(npc.id, offer.kind, state);
      stateSource = 'generated';
    }
    // Temporary pressures stop mattering once they expire.
    state = { ...state, pressures: state.pressures.filter((p) => !p.expiresGameTime || p.expiresGameTime > gameTime) };

    const toAssess = state.criteria.filter((c) => c.weight > 0 && !COMPUTED_FACTORS.includes(c.factor));
    const briefing = renderNpcBriefing(perspective, { ...ctxInput, privateSituation: renderDecisionState(state) });
    const appraisal = toAssess.length
      ? await this.callStructured<Appraisal>(trace, 'npc_appraise', appraiseSystemPrompt(npc), appraiseUserPrompt(briefing, offerText, toAssess),
        'appraisal', AppraisalSchema, AppraisalSchema, (a) => {
          const got = a.factors.map((f) => f.factor);
          const missing = toAssess.filter((c) => !got.includes(c.factor)).map((c) => c.factor);
          const extra = got.filter((f) => !toAssess.some((c) => c.factor === f));
          return [...(missing.length ? [`missing factors: ${missing.join(', ')}`] : []), ...(extra.length ? [`assess only the requested factors (not: ${extra.join(', ')})`] : [])];
        })
      : { factors: [] };

    // Seeded by game + request + offer + attempt: a retried request resolves identically; nothing is rerolled.
    const seed = `${game.id}:${trace.requestId}:${offer.id}:${offer.attempts + 1}`;
    const resolution = resolveDecision({ state, option: { kind: offer.kind, terms: offer.terms }, appraisal, rng: this.rng(seed), seed });
    trace.decision = { offerId: offer.id, npcId: npc.id, stateSource, state, appraisal, resolution };
    return { offer, state, resolution, appraisal };
  }

  /** A scene beat: proposed by the model, validated against the world, made canonical in this turn's plan. */
  private async sceneBeat(trace: Trace, game: Game, player: Character, everyone: Character[], pending: PendingCharacter | undefined,
    economy: WorldPlanner, plan: WritePlan, interp: InterpretResult, conversationOpen: boolean, world: ReturnType<Engine['worldOf']>): Promise<SceneBeat | null> {
    const store = this.store;
    const known = pending ? [...everyone, pending.character] : everyone;
    const recent = [...store.listEventsObservedBy(player.id).slice(-8), ...plan.events, ...economy.events]
      .filter((e) => e.observers.some((o) => o.characterId === player.id)).slice(-10).map((e) => `[${e.gameTime}] ${e.summary}`);
    const notes = store.listKnowledgeOf(player.id).slice(-8).map((k) => `- ${k.topic}: ${k.belief}`);
    const user = beatUserPrompt({
      gameTime: plan.newGameTime, scene: plan.scene, player, people: known.filter((c) => !c.isPlayer), recent, notes,
      justNow: [interp.narration, ...economy.results].filter(Boolean).join(' '), playerState: this.pack.briefing.player(economy),
    });
    const beat = await this.callStructured<SceneBeat>(trace, 'scene_beat', beatSystemPrompt(world.bible, world.ctx), user, 'scene_beat', SceneBeatSchema, SceneBeatSchema,
      (b) => beatProblems(b, { characters: known, playerId: player.id, conversationOpen }));
    const now = this.now();
    const at = plan.newGameTime;
    let newcomer: Character | undefined;
    if (beat.newPerson) {
      const p = beat.newPerson;
      newcomer = {
        id: newId('chr'), gameId: game.id, isPlayer: false, name: p.name.trim(), age: p.age, gender: p.gender, role: p.role, occupation: p.occupation,
        background: p.background, personality: p.personality, traits: p.traits, values: p.values, goals: p.goals, fears: p.fears, location: p.location,
        origin: 'generated', createdAt: now, updatedAt: now,
      };
      plan.extraCharacters.push({ character: newcomer, relationship: {
        id: newId('rel'), gameId: game.id, fromCharacterId: newcomer.id, toCharacterId: player.id, summary: p.relationshipToPlayer,
        source: 'backstory', sourceEventId: null, createdAt: now, updatedAt: now } });
    }
    const idOf = (n: string) => (newcomer && newcomer.name.toLowerCase() === n.toLowerCase() ? newcomer.id : known.find((c) => c.name.toLowerCase() === n.toLowerCase())!.id);
    const involved = [...beat.involves.map(idOf), ...(newcomer ? [newcomer.id] : [])];
    const ev = (e: Omit<GameEvent, 'id' | 'gameId' | 'turnId' | 'createdAt'>) => plan.events.push({ id: newId('evt'), gameId: game.id, turnId: trace.turnId, createdAt: now, ...e });
    ev({ interactionId: null, gameTime: at, type: 'scene_beat', summary: `${beat.title}: ${beat.perceived}`, transcript: [], importance: 3, location: plan.scene.location,
      participants: involved.map((id) => ({ characterId: id, role: 'actor' as const })),
      observers: [...new Set([player.id, ...involved])].map((id) => ({ characterId: id, channel: id === player.id ? 'self' as const : 'in_person' as const })) });
    if (beat.opensConversation) {
      const speaker = idOf(beat.opensConversation.name);
      const channel = beat.opensConversation.channel;
      const interaction: Interaction = { id: newId('int'), gameId: game.id, channel, participantIds: [player.id, speaker], startedGameTime: at, endedGameTime: null, createdAt: now };
      plan.interactionsToInsert.push(interaction);
      plan.scene.interactionId = interaction.id;
      if (channel === 'in_person' && !plan.scene.activeCharacterIds.includes(speaker)) plan.scene.activeCharacterIds.push(speaker);
      const name = newcomer?.id === speaker ? newcomer.name : known.find((c) => c.id === speaker)!.name;
      ev({ interactionId: interaction.id, gameTime: at, type: 'conversation_turn', summary: `${name} to ${player.name}: "${beat.opensConversation.openingLine}"`,
        transcript: [{ speakerId: speaker, speakerName: name, text: beat.opensConversation.openingLine }], importance: 3, location: plan.scene.location,
        participants: [{ characterId: speaker, role: 'actor' }, { characterId: player.id, role: 'addressee' }],
        observers: [player.id, speaker].map((id) => ({ characterId: id, channel })) });
    }
    trace.beat = beat;
    return beat;
  }

  /** Literary narration of a fully decided turn. Falls back to the concise text if the narrator fails twice. */
  private async narrate(trace: Trace, world: ReturnType<Engine['worldOf']>, player: Character, _economy: WorldPlanner, input: NarratorInput): Promise<string | null> {
    try {
      const out = await this.callStructured<{ prose: string }>(trace, 'narrate', narratorSystemPrompt(world.ctx, world.bible, player.name), narratorUserPrompt(input),
        'narration', NarrationSchema, NarrationSchema, (n) => narrationProblems(n.prose, input.words));
      return out.prose.trim();
    } catch (e) {
      if (!(e instanceof TurnFailure)) throw e;
      trace.narratorFailed = (e as Error).message;
      return null;
    }
  }

  private async generateCharacter(trace: Trace, game: Game, player: Character, everyone: Character[], name: string, relationHint: string | null): Promise<PendingCharacter> {
    const user = generateUserPrompt({ name, relationHint, player, gameTime: game.gameTime, existingNames: everyone.filter((c) => !c.isPlayer).map((c) => c.name), world: this.worldOf(game.id).ctx.line });
    const p = await this.callStructured(trace, 'generate_character', generateSystemPrompt(this.worldOf(game.id).ctx), user, 'character',
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
      clarificationQuestion: null, error: null, results: [], ...r,
    };
  }
}

// ---- helpers ----

export const SELF_HARM_MESSAGE = [
  '[Pausing the story]',
  "This game doesn't play out self-harm. If any part of this is real for you right now, you don't have to handle it alone:",
  'in Italy you can call Telefono Amico on 02 2327 2327, or 112 in an emergency; elsewhere, findahelpline.com lists free, confidential lines.',
  "When you're ready, tell me what you do next and the story continues from before that moment.",
].join('\n');

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

/** The NPC's own private situation, as they know it (for their briefing only). */
export function renderDecisionState(d: DecisionState): string {
  const lim = [
    ...d.limits.map((l) => `- ${l.term}: ${l.op === 'max' ? 'at most' : 'at least'} ${l.value}${l.note ? ` (${l.note})` : ''}`),
    ...(d.requiresApproval ? [`- you cannot give a final yes without ${d.requiresApproval}`] : []),
  ];
  return [
    `Your position: ${d.role}`,
    `What you want: ${d.goals.join('; ')}`,
    `Right now: ${d.pressures.map((p) => p.text).join('; ') || 'nothing unusual'}`,
    `If you say no: ${d.alternatives.map((a) => a.text).join('; ') || 'things just stay as they are'}`,
    'Your real limits:', ...(lim.length ? lim : ['- none in particular']),
    `What would matter to you: ${d.criteria.map((c) => c.note || c.factor).join('; ')}`,
  ].join('\n');
}

/** What the portrayal receives: the outcome and plain reasons. No scores, no roll. */
export function renderResolution(r: Resolution, offerText: string): string {
  const reasons = r.reasons.map((x) => `- ${x}`);
  const counter = r.counterTerms ? Object.entries(r.counterTerms).map(([k, v]) => `${k} = ${v}`).join(', ') : '';
  return [
    `About: ${offerText}`,
    `Outcome: ${r.outcome}`,
    'Why (your honest reasons):', ...reasons,
    ...(r.outcome === 'counter' ? [`A counter must respect your limits${counter ? ` (for example: ${counter})` : ''}.`] : []),
  ].join('\n');
}
