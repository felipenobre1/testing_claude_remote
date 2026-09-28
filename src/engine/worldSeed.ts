import type { Store } from '../db/store.ts';
import type { Character, Game } from '../domain/types.ts';
import type { WorldDraft, WorldSeed } from '../domain/world.ts';
import type { GamePack } from '../packs/types.ts';
import { firstOfNextMonth, formatGameTime, newId, nextWeekStart } from './util.ts';

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
  const stages = pack?.worldCreation.stages;
  if (stages && draft.startingStage && !stages.some((x) => x.id === draft.startingStage)) {
    problems.push(`the starting stage must be one of: ${stages.map((x) => x.id).join(', ')}`);
  }
  if (draft.player.startingMoney !== null && draft.player.startingMoney < 0) problems.push('starting money cannot be negative');
  const money = [...draft.economy.priceList.map((x) => x.price), ...draft.economy.livingCosts.map((x) => x.amount), ...draft.economy.income.map((x) => x.amount),
    ...draft.player.assets.flatMap((a) => a.monthlyCosts.map((c) => c.amount)), ...draft.openLeads.map((l) => l.cost ?? 0)];
  if (money.some((x) => x < 0)) problems.push('prices, costs and income cannot be negative');
  for (const l of draft.openLeads) {
    if (l.when && (!TIME_RE.test(l.when) || (draft.setting.startDate && l.when < draft.setting.startDate))) problems.push(`"${l.title}" needs a date/time after the start`);
  }
  if (pack?.worldCreation.validate) problems.push(...pack.worldCreation.validate(draft));
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
    startingStage: d.startingStage ?? pack!.worldCreation.defaultStage ?? null,
    world: {
      sourceWorld: d.sourceWorld, canonPolicy: d.canonPolicy!, place: d.setting.place!, era: d.setting.era!, startDate: d.setting.startDate!,
      timezone: d.setting.timezone || 'UTC', description: d.setting.description ?? d.premise!, rules: d.worldRules,
      historicalContext: d.historicalContext, currentSituation: d.currentSituation!, locations: d.locations, factions: d.factions,
    },
    style: {
      tone: d.style.tone!, realism: d.style.realism!, difficulty: d.style.difficulty, narrativeStyle: d.style.narrativeStyle,
      playerSignificance: d.style.playerSignificance!, designPrinciples: d.designPrinciples,
      pace: d.style.pace ?? 'steady', violence: d.style.violence ?? 'non_graphic', narration: d.style.narration ?? 'literary', language: d.style.language || 'English',
    },
    player: { ...d.player, name: d.player.name!, age: d.player.age!, background: d.player.background! },
    actors: d.actors,
    initialPressures: d.initialPressures,
    initialSituations: d.initialSituations,
    economy: d.economy,
    openLeads: d.openLeads,
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
    facts('asset', p.assets.map((a) => `${a.name} (${a.kind}${a.state ? `, ${a.state}` : ''}): ${a.description}${a.url ? ` — ${a.url}` : ''}`));
    facts('lead', seed.openLeads.filter((l) => !l.when).map((l) => `${l.title}: ${l.description}`));
    // Money is canonical state in the ledger, never a free-text fact.
    const account = { id: newId('acct'), gameId, ownerKind: 'character' as const, ownerId: player.id, balanceCents: Math.round((p.startingMoney ?? 0) * 100), createdAt: now, updatedAt: now };
    store.insertAccount(account);
    const firstDue = firstOfNextMonth(seed.world.startDate);
    const addMonthly = (fromAccountId: string | null, toAccountId: string | null, description: string, cents: number) => {
      if (cents <= 0) return;
      store.insertRecurringPayment({ id: newId('rec'), gameId, fromAccountId, toAccountId, description, amountCents: cents, nextDueGameTime: firstDue, active: true, createdAt: now });
    };
    // Running costs and income are part of the starting position: time costs money.
    for (const c of seed.economy.livingCosts) addMonthly(account.id, null, c.label, Math.round(c.amount * 100));
    for (const c of seed.economy.income) addMonthly(null, account.id, c.label, Math.round(c.amount * 100));
    for (const x of seed.economy.priceList) store.upsertPrice({ gameId, item: x.item, priceCents: Math.round(x.price * 100), source: 'seed', gameTime: seed.world.startDate });
    // Dated opportunities go on the world calendar; nobody has to go.
    const schedule = (dueGameTime: string, kind: string, payload: Record<string, unknown>) => store.insertScheduled({
      id: newId('sch'), gameId, dueGameTime, kind, payload, threadId: null, status: 'pending', createdGameTime: seed.world.startDate, createdAt: now,
    });
    for (const l of seed.openLeads.filter((x) => x.when)) schedule(l.when!, 'opportunity', { ...l });
    schedule(nextWeekStart(seed.world.startDate), 'weekly_report', { since: seed.world.startDate });
    store.insertScene({ id: newId('scn'), gameId, location: seed.startingScene.location, description: seed.startingScene.description,
      activeCharacterIds: [player.id], interactionId: null, updatedAt: now });
    // Starting conditions as observed world truth — causes, not outcomes.
    worldEvent(`The situation when the story begins: ${seed.world.currentSituation}`, [player.id, ...actors.map((a) => a.id)]);
    for (const pr of seed.initialPressures) worldEvent(`Pressure on ${p.name}: ${pr}`, [player.id]);
    for (const s of seed.initialSituations) worldEvent(`${s.title}: ${s.summary}`, s.involves.map(idOf), 'situation_seed');
    pack.worldCreation.seed?.({ store, gameId, player, playerAccountId: account.id, seed, now, addMonthly });
    store.insertWorldSeed(gameId, seed.draftId, pack.id, seed, now);
    alsoInTx?.(); // e.g. marking the draft finalized — atomically with the game it created
  });
  return { game, player, opening: openingText(seed) };
}

export function openingText(seed: WorldSeed): string {
  const soon = seed.openLeads.filter((l) => l.when && l.when <= addDays(seed.world.startDate, 14)).sort((a, b) => a.when!.localeCompare(b.when!));
  return [
    `${seed.world.place} — ${formatGameTime(seed.world.startDate)}`, '',
    seed.startingScene.description, '',
    seed.world.currentSituation, '',
    ...(seed.initialPressures.length ? [...seed.initialPressures, ''] : []),
    ...(soon.length ? ['Coming up:', ...soon.map((l) => `  • ${formatGameTime(l.when!)} — ${l.title}${l.location ? ` (${l.location})` : ''}`), ''] : []),
    'What do you do?',
  ].join('\n');
}

const addDays = (t: string, n: number) => new Date(new Date(`${t}:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 16);

/** The design contract, as every Story Director call sees it (it must not drift over a long game). */
export function bibleText(seed: WorldSeed): string {
  return [
    `PREMISE: ${seed.premise}`,
    `WORLD: ${seed.world.place}, ${seed.world.era}${seed.world.sourceWorld ? ` (source: ${seed.world.sourceWorld})` : ''}. Canon policy: ${seed.world.canonPolicy.replace(/_/g, ' ')}.`,
    `TONE: ${seed.style.tone}. REALISM: ${seed.style.realism}.${seed.style.difficulty ? ` DIFFICULTY: ${seed.style.difficulty}.` : ''}${seed.style.narrativeStyle ? ` STYLE: ${seed.style.narrativeStyle}.` : ''}`,
    `PLAYER SIGNIFICANCE: ${seed.style.playerSignificance}`,
    `STORY PACE: ${paceOf(seed)}`,
    ...(seed.style.language && !/^english$/i.test(seed.style.language) ? [`PLAYER'S LANGUAGE: ${seed.style.language} — everything the player reads (narration, dialogue, messages to the player) is in ${seed.style.language}.`] : []),
    ...(seed.player.ambition ? [`${seed.player.name.toUpperCase()}'S AMBITION: ${seed.player.ambition} — the story should keep putting opportunities, rivals, costs and hard choices on the road to it (never hand it over).`] : []),
    `VIOLENCE: ${violenceRule(seed.style.violence ?? 'non_graphic')}`,
    ...(seed.world.historicalContext ? [`RECENT HISTORY AND CONTEXT (world truth at the start): ${seed.world.historicalContext}`] : []),
    ...(seed.style.designPrinciples.length ? ['DESIGN PRINCIPLES (binding for the whole game):', ...seed.style.designPrinciples.map((x) => `- ${x}`)] : []),
    ...(seed.world.rules.length ? ['WORLD RULES:', ...seed.world.rules.map((x) => `- ${x}`)] : []),
  ].join('\n');
}

export function paceOf(seed: WorldSeed): string {
  switch (seed.style.pace ?? 'steady') {
    case 'quiet': return 'quiet — the world mostly waits for the player; developments are rare and slow';
    case 'eventful': return 'eventful — the world keeps coming to the player: people arrive, trouble finds them, choices are forced; rarely a dull turn';
    default: return 'steady — the world regularly reaches the player (people get in touch, situations develop) without constant drama';
  }
}

export function violenceRule(v: 'none' | 'non_graphic' | 'graphic'): string {
  if (v === 'graphic') return 'allowed and shown in full: fights, wounds, pain and death are described vividly and concretely when they happen. No softening.';
  if (v === 'none') return 'none: conflicts are resolved without physical violence.';
  return 'can happen and has real consequences (injury, death), but is described without gore.';
}

/** What everyone in the world knows: the recent history agreed at creation (kept short for in-scene prompts). */
export function backgroundOf(seed: WorldSeed, max = 700): string | null {
  const h = seed.world.historicalContext?.trim();
  if (!h) return null;
  return h.length <= max ? h : `${h.slice(0, max - 1)}…`;
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
    ...(seed.startingStage ? [`Starting point: ${pack.worldCreation.stages?.find((x) => x.id === seed.startingStage)?.label ?? seed.startingStage}.`] : []),
    ...p.assets.map((a) => `You have: ${a.name} — ${a.description}${a.url ? ` (${a.url})` : ''}${a.metrics.length ? ` · ${a.metrics.map((m) => `${m.key} ${m.value}`).join(', ')}` : ''}${a.knownIssues.length ? ` · known problems: ${a.knownIssues.join('; ')}` : ''}.`),
    ...moneyLines(seed, money ? (p.currency?.symbol ?? pack.currency.symbol) : pack.currency.symbol),
    ...(seed.openLeads.length ? [`Open leads: ${seed.openLeads.map((l) => `${l.title}${l.when ? ` (${formatGameTime(l.when)}${l.repeatsWeekly ? ', weekly' : ''})` : ''}`).join('; ')}.`] : []),
    ...(seed.initialSituations.length ? [`Situations already in motion (no set outcomes): ${seed.initialSituations.map((s) => s.title).join('; ')}.`] : []),
    `World behaviour: ${pack.worldCreation.summary}. New people are created when needed; the world continues without you.`,
    `Starting scene: ${seed.startingScene.location} — ${formatGameTime(seed.world.startDate)}.`,
  ].join('\n');
}

function moneyLines(seed: WorldSeed, sym: string): string[] {
  const f = (x: number) => `${sym}${x.toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;
  const costs = [...seed.economy.livingCosts, ...seed.player.assets.flatMap((a) => a.monthlyCosts)];
  const out: string[] = [];
  if (costs.length) out.push(`Monthly costs: ${costs.map((c) => `${c.label} ${f(c.amount)}`).join(', ')} (total ${f(costs.reduce((n, c) => n + c.amount, 0))}).`);
  if (seed.economy.income.length) out.push(`Monthly income: ${seed.economy.income.map((c) => `${c.label} ${f(c.amount)}`).join(', ')}.`);
  if (seed.economy.priceList.length) out.push(`Price list (approximate, fixed for this world): ${seed.economy.priceList.slice(0, 8).map((x) => `${x.item} ${f(x.price)}`).join(', ')}${seed.economy.priceList.length > 8 ? ', …' : ''}.`);
  return out;
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
    line('Starting stage', d.startingStage),
    line('Background', d.player.background), line('Skills', d.player.skills), line('Money', d.player.startingMoney),
    line('Has made / owns', d.player.assets.map((a) => `${a.name} (${a.kind}${a.state ? `, ${a.state}` : ''})${a.url ? ` ${a.url}` : ''}`)),
    line('Monthly costs', [...d.economy.livingCosts, ...d.player.assets.flatMap((a) => a.monthlyCosts)].map((c) => `${c.label} ${c.amount}`)),
    line('Monthly income', d.economy.income.map((c) => `${c.label} ${c.amount}`)),
    line('Prices', d.economy.priceList.length ? `${d.economy.priceList.length} items` : null),
    line('Open leads', d.openLeads.map((l) => `${l.title}${l.when ? ` @ ${l.when}` : ''}`)),
    line('Circumstances', d.player.circumstances), line('People at the start', d.actors.map((a) => `${a.name} (${a.role})`)),
    line('Current situation', d.currentSituation), line('Pressures', d.initialPressures), line('Situations in motion', d.initialSituations.map((s) => s.title)),
    line('Opening scene', d.startingScene.location ? `${d.startingScene.location} — ${d.startingScene.description ?? ''}` : null),
    line('Still open', d.unresolvedQuestions), line('Contradictions to resolve', d.contradictions),
  ].filter(Boolean).join('\n') || '(nothing decided yet)';
}
