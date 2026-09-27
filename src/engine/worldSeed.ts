import type { Store } from '../db/store.ts';
import type { Character, Game } from '../domain/types.ts';
import type { WorldDraft, WorldSeed } from '../domain/world.ts';
import type { GamePack } from '../packs/types.ts';
import { formatGameTime, newId } from './util.ts';

// ============================================================================
// WorldSeed compiler + canonical game creation (generic, deterministic, no model calls).
//
//   WorldDraft ──compile──▶ WorldSeed (validated, immutable) ──create──▶ canonical game
//
// Creation builds only what the opening needs: the player, the few people who already exist,
// their relationships, money, facts, the starting scene, and the starting situations as observed
// world events (causes the Story Director can later build on). No outcomes are created.
// ============================================================================

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Checks a draft is a coherent starting world and compiles it. Problems are phrased for the player. */
export function compileDraft(draft: WorldDraft, packs: GamePack[], opts: { gameId?: string; draftId?: string | null; now: string }): { seed: WorldSeed | null; problems: string[] } {
  const problems: string[] = [];
  const need = (ok: unknown, what: string) => { if (!ok) problems.push(what); };
  const pack = packs.find((p) => p.id === draft.packId);
  need(pack, `which kind of game this is (one of: ${packs.map((p) => `${p.id} — ${p.worldCreation.summary}`).join('; ')})`);
  need(draft.premise, 'the premise in a sentence or two');
  need(draft.canonPolicy, 'how existing history/canon behaves (background only, continues unless changed, alternate from the start, or an original world)');
  need(draft.setting.place, 'where the story starts');
  need(draft.setting.era, 'when the story takes place');
  need(draft.setting.startDate && TIME_RE.test(draft.setting.startDate), 'the exact starting date and time');
  need(draft.style.tone, 'the tone');
  need(draft.style.realism, 'how realistic/unforgiving the world is');
  need(draft.style.playerSignificance, 'how significant the player is at the start');
  need(draft.player.name, "the player character's name");
  need(draft.player.age, "the player character's age");
  need(draft.player.background, "the player character's background");
  need(draft.currentSituation, 'the situation in the world when play begins');
  need(draft.startingScene.location && draft.startingScene.description, 'the opening scene');
  for (const c of draft.contradictions) problems.push(`unresolved contradiction: ${c}`);
  const actorNames = draft.actors.map((a) => a.name.toLowerCase());
  if (new Set(actorNames).size !== actorNames.length) problems.push('two starting characters share a name');
  if (draft.player.name && actorNames.includes(draft.player.name.toLowerCase())) problems.push('a starting character has the same name as the player');
  for (const s of draft.initialSituations) {
    for (const who of s.involves) {
      if (who.toLowerCase() !== 'player' && !actorNames.includes(who.toLowerCase())) problems.push(`situation "${s.title}" involves "${who}", who is not a starting character`);
    }
  }
  if (problems.length) return { seed: null, problems };

  const d = draft;
  const seed: WorldSeed = {
    gameId: opts.gameId ?? newId('game'),
    draftId: opts.draftId ?? null,
    packId: pack!.id,
    createdAt: opts.now,
    premise: d.premise!,
    world: {
      sourceWorld: d.sourceWorld, canonPolicy: d.canonPolicy!, place: d.setting.place!, era: d.setting.era!, startDate: d.setting.startDate!,
      timezone: d.setting.timezone || 'UTC', description: d.setting.description ?? d.premise!, rules: d.worldRules,
      historicalContext: d.historicalContext, currentSituation: d.currentSituation!, locations: d.locations, factions: d.factions,
    },
    style: {
      tone: d.style.tone!, realism: d.style.realism!, difficulty: d.style.difficulty, narrativeStyle: d.style.narrativeStyle,
      playerSignificance: d.style.playerSignificance!, designPrinciples: d.designPrinciples,
    },
    player: { ...d.player, name: d.player.name!, age: d.player.age!, background: d.player.background! },
    actors: d.actors,
    initialPressures: d.initialPressures,
    initialSituations: d.initialSituations,
    startingScene: { location: d.startingScene.location!, description: d.startingScene.description! },
  };
  return { seed, problems: [] };
}

/** Creates the canonical game from an approved seed, in one transaction. */
export function createGameFromSeed(store: Store, pack: GamePack, seed: WorldSeed, now: string, alsoInTx?: () => void): { game: Game; player: Character; opening: string } {
  const gameId = seed.gameId;
  const p = seed.player;
  const player: Character = {
    id: newId('chr'), gameId, isPlayer: true, name: p.name, age: p.age, gender: p.gender, role: 'player', occupation: p.occupation,
    background: p.background, personality: p.personality ?? 'Shaped by the player through play.', traits: p.skills, values: [], goals: p.goals, fears: p.fears,
    location: p.location ?? seed.world.place, origin: 'seed', createdAt: now, updatedAt: now,
  };
  const game: Game = {
    id: gameId, title: `${seed.world.place} — ${p.name}`, timezone: seed.world.timezone, gameTime: seed.world.startDate, playerCharacterId: player.id,
    packId: pack.id, revision: 0, createdAt: now, updatedAt: now,
  };
  const actors: Character[] = seed.actors.map((a) => ({
    id: newId('chr'), gameId, isPlayer: false, name: a.name, age: a.age ?? 35, gender: null, role: a.role, occupation: a.role, background: a.description,
    personality: a.personality ?? a.description, traits: [], values: [], goals: a.goals, fears: [], location: seed.world.place, origin: 'seed',
    createdAt: now, updatedAt: now,
  }));
  const idOf = (name: string) => (name.toLowerCase() === 'player' ? player.id : actors.find((a) => a.name.toLowerCase() === name.toLowerCase())!.id);
  const worldEvent = (summary: string, observers: string[], type = 'world') => {
    store.insertEvent({
      id: newId('evt'), gameId, turnId: null, interactionId: null, gameTime: seed.world.startDate, type, summary, transcript: [], importance: 3,
      location: seed.world.place, createdAt: now, participants: observers.map((id) => ({ characterId: id, role: 'actor' as const })),
      observers: [...new Set(observers)].map((id) => ({ characterId: id, channel: 'self' as const })),
    });
  };

  store.tx(() => {
    store.insertGame(game);
    store.insertCharacter(player);
    for (const a of actors) store.insertCharacter(a);
    for (const [i, a] of seed.actors.entries()) {
      if (!a.relationshipToPlayer) continue;
      store.upsertRelationship({ id: newId('rel'), gameId, fromCharacterId: actors[i]!.id, toCharacterId: player.id, summary: a.relationshipToPlayer,
        source: 'backstory', sourceEventId: null, createdAt: now, updatedAt: now });
    }
    const fact = (predicate: string, value: string) =>
      store.insertFact({ id: newId('fact'), gameId, subject: player.id, predicate, value, createdAt: now, updatedAt: now });
    // Facts are keyed by predicate: number repeats (circumstance, circumstance_2, …).
    const facts = (kind: string, values: string[]) => values.forEach((v, i) => fact(i ? `${kind}_${i + 1}` : kind, v));
    facts('circumstance', p.circumstances);
    facts('possession', p.possessions);
    facts('knows', p.knowledge);
    // Money is canonical state in the ledger, never a free-text fact.
    store.insertAccount({ id: newId('acct'), gameId, ownerKind: 'character', ownerId: player.id, balanceCents: Math.round((p.startingMoney ?? 0) * 100), createdAt: now, updatedAt: now });
    store.insertScene({ id: newId('scn'), gameId, location: seed.startingScene.location, description: seed.startingScene.description,
      activeCharacterIds: [player.id], interactionId: null, updatedAt: now });
    // Starting conditions as observed world truth — causes, not outcomes.
    worldEvent(`The situation when the story begins: ${seed.world.currentSituation}`, [player.id, ...actors.map((a) => a.id)]);
    for (const pr of seed.initialPressures) worldEvent(`Pressure on ${p.name}: ${pr}`, [player.id]);
    for (const s of seed.initialSituations) worldEvent(`${s.title}: ${s.summary}`, s.involves.map(idOf), 'situation_seed');
    store.insertWorldSeed(gameId, seed.draftId, pack.id, seed, now);
    alsoInTx?.(); // e.g. marking the draft finalized — atomically with the game it created
  });
  return { game, player, opening: openingText(seed) };
}

export function openingText(seed: WorldSeed): string {
  return [
    `${seed.world.place} — ${formatGameTime(seed.world.startDate)}`, '',
    seed.startingScene.description, '',
    seed.world.currentSituation, '',
    'What do you do?',
  ].join('\n');
}

/** The design contract, as every Story Director call sees it (it must not drift over a long game). */
export function bibleText(seed: WorldSeed): string {
  return [
    `PREMISE: ${seed.premise}`,
    `WORLD: ${seed.world.place}, ${seed.world.era}${seed.world.sourceWorld ? ` (source: ${seed.world.sourceWorld})` : ''}. Canon policy: ${seed.world.canonPolicy.replace(/_/g, ' ')}.`,
    `TONE: ${seed.style.tone}. REALISM: ${seed.style.realism}.${seed.style.difficulty ? ` DIFFICULTY: ${seed.style.difficulty}.` : ''}${seed.style.narrativeStyle ? ` STYLE: ${seed.style.narrativeStyle}.` : ''}`,
    `PLAYER SIGNIFICANCE: ${seed.style.playerSignificance}`,
    ...(seed.style.designPrinciples.length ? ['DESIGN PRINCIPLES (binding for the whole game):', ...seed.style.designPrinciples.map((x) => `- ${x}`)] : []),
    ...(seed.world.rules.length ? ['WORLD RULES:', ...seed.world.rules.map((x) => `- ${x}`)] : []),
  ].join('\n');
}

/** Short setting line for in-scene prompts. */
export function worldLine(seed: WorldSeed): string {
  return `${seed.world.place}, ${seed.world.era}${seed.world.sourceWorld && !/real world/i.test(seed.world.sourceWorld) ? ` (${seed.world.sourceWorld})` : ''}; tone: ${seed.style.tone}; realism: ${seed.style.realism}`;
}

/** The concise final summary shown before approval. */
export function seedSummary(seed: WorldSeed, pack: GamePack): string {
  const p = seed.player;
  const money = p.startingMoney !== null ? `${(p.currency?.symbol ?? pack.currency.symbol)}${p.startingMoney.toLocaleString('en-GB')}` : null;
  return [
    `World: ${seed.world.place}, ${seed.world.era}.${seed.world.sourceWorld ? ` Source: ${seed.world.sourceWorld} (${seed.world.canonPolicy.replace(/_/g, ' ')}).` : ` ${seed.world.canonPolicy.replace(/_/g, ' ')}.`}`,
    `Player: ${p.name}, ${p.age}. ${p.background}${money ? ` Money: ${money}.` : ''}`,
    `Tone: ${seed.style.tone}. Realism: ${seed.style.realism}. Player significance: ${seed.style.playerSignificance}.`,
    ...(seed.style.designPrinciples.length ? [`Principles: ${seed.style.designPrinciples.map((x) => x.replace(/[.;\s]+$/, '')).join('; ')}.`] : []),
    `Current situation: ${seed.world.currentSituation}`,
    ...(seed.actors.length ? [`People at the start: ${seed.actors.map((a) => `${a.name} (${a.role})`).join(', ')}.`] : []),
    ...(seed.initialSituations.length ? [`Situations already in motion (no set outcomes): ${seed.initialSituations.map((s) => s.title).join('; ')}.`] : []),
    `World behaviour: ${pack.worldCreation.summary}. New people are created when needed; the world continues without you.`,
    `Starting scene: ${seed.startingScene.location} — ${formatGameTime(seed.world.startDate)}.`,
  ].join('\n');
}

/** "What have we decided so far?" — deterministic view of the current draft. */
export function draftView(d: WorldDraft): string {
  const line = (label: string, v: unknown) => (v === null || v === undefined || (Array.isArray(v) && !v.length) ? null : `${label}: ${Array.isArray(v) ? v.join('; ') : v}`);
  return [
    line('Game pack', d.packId), line('Premise', d.premise), line('Source world', d.sourceWorld), line('Canon policy', d.canonPolicy?.replace(/_/g, ' ')),
    line('Place', d.setting.place), line('Era', d.setting.era), line('Starts', d.setting.startDate),
    line('Tone', d.style.tone), line('Realism', d.style.realism), line('Difficulty', d.style.difficulty), line('Player significance', d.style.playerSignificance),
    line('Design principles', d.designPrinciples), line('World rules', d.worldRules),
    line('Player', d.player.name ? `${d.player.name}${d.player.age ? `, ${d.player.age}` : ''}${d.player.occupation ? ` — ${d.player.occupation}` : ''}` : null),
    line('Background', d.player.background), line('Skills', d.player.skills), line('Money', d.player.startingMoney),
    line('Circumstances', d.player.circumstances), line('People at the start', d.actors.map((a) => `${a.name} (${a.role})`)),
    line('Current situation', d.currentSituation), line('Pressures', d.initialPressures), line('Situations in motion', d.initialSituations.map((s) => s.title)),
    line('Opening scene', d.startingScene.location ? `${d.startingScene.location} — ${d.startingScene.description ?? ''}` : null),
    line('Still open', d.unresolvedQuestions), line('Contradictions to resolve', d.contradictions),
  ].filter(Boolean).join('\n') || '(nothing decided yet)';
}
