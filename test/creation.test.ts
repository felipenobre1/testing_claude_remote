// World Creation Copilot: IDEA → conversation → WorldDraft → approval → WorldSeed → canonical game.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db/store.ts';
import { EMPTY_DRAFT, type CopilotTurn, type WorldDraft, type WorldSeed } from '../src/domain/world.ts';
import { COPILOT_GREETING, WorldCreation } from '../src/engine/creation.ts';
import { Engine } from '../src/engine/turn.ts';
import { ScriptedProvider } from '../src/llm/scripted.ts';
import { PACKS } from '../src/packs/index.ts';
import { openPack } from '../src/packs/open/index.ts';
import { interp, lastPrompt, npc, tmpDbPath } from './helpers.ts';

/** A scripted Copilot turn that sets every top-level field to the given draft's value. */
const reply = (draft: WorldDraft, text = 'Noted.', intent: CopilotTurn['intent'] = 'discuss', approvalQuote: string | null = null): CopilotTurn =>
  ({ reply: text, updates: Object.entries(draft).map(([path, v]) => ({ path, value: JSON.stringify(v) })), intent, approvalQuote });

const count = (store: Store, table: string) => (store.get(`SELECT COUNT(*) AS n FROM ${table}`) as { n: number }).n;
const CANONICAL = ['games', 'characters', 'events', 'facts', 'relationships', 'accounts', 'story_threads', 'world_seeds'];

/** A Dune-like world on the generic Open World pack (no Startup code involved). */
const DESERT: WorldDraft = {
  ...EMPTY_DRAFT,
  packId: 'open',
  premise: 'A water-seller\'s apprentice on a desert planet, years before the great houses clash.',
  sourceWorld: 'Dune',
  canonPolicy: 'alternate_from_start',
  setting: { place: 'Arrakeen, Arrakis', era: 'the years of Harkonnen rule', startDate: '2026-05-01T06:00', timezone: 'UTC', description: 'A garrison city of sand and heat.' },
  style: { tone: 'harsh, political', realism: 'high — water is life and every favour has a price', difficulty: 'hard', narrativeStyle: null,
    playerSignificance: 'insignificant: an apprentice nobody at court has heard of' },
  designPrinciples: ['Do not manufacture destiny around the player.', 'Great houses never notice the player without a concrete reason.'],
  worldRules: ['Water is the scarcest resource; spice is controlled by the ruling house.'],
  player: { ...EMPTY_DRAFT.player, name: 'Kaleb', age: 17, occupation: 'water-seller\'s apprentice', background: 'Born in the lower city; apprenticed to a water-seller since age ten.',
    skills: ['haggling'], goals: ['buy his own water license'], circumstances: ['sleeps in the master\'s storeroom', 'owes the master two years of work'],
    startingMoney: 30, currency: { code: 'SOL', symbol: 'S ' }, possessions: ['a stillsuit, patched'] },
  actors: [{ name: 'Old Harun', age: 64, role: 'water-seller, Kaleb\'s master', description: 'Tight-fisted, honest by his own measure.', personality: 'gruff',
    goals: ['keep his license'], relationshipToPlayer: 'His apprentice: useful, cheeky, not yet trustworthy with money.' }],
  currentSituation: 'Water rations were cut again this week; the garrison is searching houses for hoarded water.',
  initialPressures: ['The master wants the debt worked off before any wages.'],
  initialSituations: [{ title: 'Harun\'s license renewal', summary: 'Harun\'s water license is up for renewal and the new inspector wants a bribe.', involves: ['Old Harun'] }],
  startingScene: { location: 'Harun\'s water shop, lower Arrakeen', description: 'Before dawn. The cistern gauge reads lower than yesterday.' },
};

function setup(path = tmpDbPath()) {
  const store = new Store(path);
  const llm = new ScriptedProvider();
  const creation = new WorldCreation(store, llm, { packs: PACKS });
  return { path, store, llm, creation };
}

test('talking about a world creates no canonical state; the draft survives a restart', async () => {
  const s = setup();
  const { draftId, text } = s.creation.start();
  assert.equal(text, COPILOT_GREETING);

  s.llm.enqueue('world_copilot', reply({ ...EMPTY_DRAFT, packId: 'open', premise: 'A desert planet story.', sourceWorld: 'Dune' }, 'Dune-like, then. Canon as background, or should history play out?'));
  const r = await s.creation.say(draftId, 'I want something like Dune');
  assert.equal(r.status, 'drafting');
  s.llm.enqueue('world_copilot', reply({ ...DESERT, contradictions: [] }, 'Got it — an apprentice.'));
  await s.creation.say(draftId, 'I am a water-seller apprentice, alternate history from the start');

  for (const t of CANONICAL) assert.equal(count(s.store, t), 0, `${t} must stay empty while drafting`);
  // The Copilot sees the pack list, its guidance and the rules of the job.
  const sys = s.llm.callsFor('world_copilot')[0]!.system;
  assert.match(sys, /- startup: /);
  assert.match(sys, /- open: /);
  assert.match(sys, /we don't need to decide that yet/);
  assert.match(sys, /never outcomes/);
  s.store.close();

  // A new process: the draft, its version and the whole conversation are still there.
  const s2 = setup(s.path);
  const open = s2.creation.latestOpen()!;
  assert.equal(open.id, draftId);
  assert.equal(open.version, 2);
  assert.equal(s2.creation.draft(draftId).player.name, 'Kaleb');
  assert.deepEqual(s2.creation.messages(draftId).map((m) => m.role), ['copilot', 'player', 'copilot', 'player', 'copilot']);
  assert.match(s2.creation.view(draftId), /Player: Kaleb, 17/);
  // The next turn is given the persisted conversation.
  s2.llm.enqueue('world_copilot', reply(s2.creation.draft(draftId), 'Still here.'));
  await s2.creation.say(draftId, 'where were we?');
  assert.match(lastPrompt(s2.llm, 'world_copilot'), /PLAYER: I want something like Dune[\s\S]*PLAYER'S NEW MESSAGE: where were we\?/);
  s2.store.close();
});

test('revision changes only what changed; an unchanged draft keeps its version; a summary request is deterministic', async () => {
  const s = setup();
  const { draftId } = s.creation.start();
  s.llm.enqueue('world_copilot', reply(DESERT));
  await s.creation.say(draftId, 'here is my world');
  s.llm.enqueue('world_copilot', reply({ ...DESERT, player: { ...DESERT.player, age: 19 } }, 'Nineteen it is.'));
  await s.creation.say(draftId, 'actually make him 19');
  assert.equal(s.store.getDraft(draftId)!.version, 2);
  assert.equal(s.creation.draft(draftId).player.age, 19);
  assert.equal(s.creation.draft(draftId).player.name, 'Kaleb');

  // Partial reset: the starting people are cleared, the rest stays.
  s.llm.enqueue('world_copilot', reply({ ...DESERT, player: { ...DESERT.player, age: 19 }, actors: [], initialSituations: [] }, 'Cleared the master.'));
  await s.creation.say(draftId, 'forget the master, start that part over');
  assert.equal(s.creation.draft(draftId).actors.length, 0);
  assert.equal(s.creation.draft(draftId).setting.place, 'Arrakeen, Arrakis');

  s.llm.enqueue('world_copilot', reply(s.creation.draft(draftId), 'Still open: nothing essential.', 'summarize'));
  const sum = await s.creation.say(draftId, 'what have we decided?');
  assert.equal(s.store.getDraft(draftId)!.version, 3);
  assert.match(sum.text, /^So far:\n[\s\S]*Source world: Dune[\s\S]*Canon policy: alternate from start[\s\S]*Still open: nothing essential\./);
  s.store.close();
});

test('an unresolved contradiction blocks finalization', async () => {
  const s = setup();
  const { draftId } = s.creation.start();
  const contradictory = { ...DESERT, player: { ...DESERT.player, background: 'Son of the planetary governor.' },
    contradictions: ['The player is meant to be an insignificant nobody, but his father rules the planet.'] };
  s.llm.enqueue('world_copilot', reply(contradictory, 'A nobody whose father rules the planet is not a nobody — which do you want?'));
  await s.creation.say(draftId, 'I am a nobody, and my father is the governor');
  s.llm.enqueue('world_copilot', reply(contradictory, 'Let me check.', 'request_finalize'));
  const r = await s.creation.say(draftId, "let's start");
  assert.equal(r.status, 'drafting');
  assert.match(r.text, /unresolved contradiction: The player is meant to be an insignificant nobody/);
  assert.equal(s.creation.approve(draftId).gameId, undefined);
  assert.equal(count(s.store, 'games'), 0);
  s.store.close();
});

test('the game is created only on explicit approval of the exact summary shown', async () => {
  const s = setup();
  const { draftId } = s.creation.start();
  s.llm.enqueue('world_copilot', reply(DESERT));
  await s.creation.say(draftId, 'here is my world');

  // /approve before any summary: refused.
  assert.match(s.creation.approve(draftId).text, /no final summary awaiting approval/);

  // The model claims approval before a summary was shown: the engine shows the summary instead.
  s.llm.enqueue('world_copilot', reply(DESERT, 'Creating it!', 'confirm_finalize', 'go'));
  const early = await s.creation.say(draftId, 'go');
  assert.equal(early.status, 'awaiting_approval');
  assert.match(early.text, /^Here is the world I'll create:\n\nWorld: Arrakeen, Arrakis, [^\n]*Source: Dune \(alternate from start\)\.\nPlayer: Kaleb, 17\.[\s\S]*Principles: Do not manufacture destiny around the player; Great[\s\S]*cannot be edited/);
  assert.equal(count(s.store, 'games'), 0);

  // A made-up approval quote (twice) is never accepted.
  s.llm.enqueue('world_copilot', reply(DESERT, 'Great, creating.', 'confirm_finalize', 'yes, create it'), reply(DESERT, 'Great, creating.', 'confirm_finalize', 'yes'));
  const fake = await s.creation.say(draftId, 'hmm, how hot is it there?');
  assert.equal(fake.status, 'awaiting_approval');
  assert.match(fake.text, /Say explicitly that you approve/);
  assert.equal(count(s.store, 'games'), 0);

  // Approval plus a change: the change needs a new summary.
  const older = { ...DESERT, player: { ...DESERT.player, age: 18 } };
  s.llm.enqueue('world_copilot', reply(older, 'Eighteen, then.', 'confirm_finalize', 'yes but make him 18'));
  const changed = await s.creation.say(draftId, 'yes but make him 18');
  assert.equal(changed.status, 'awaiting_approval');
  assert.match(changed.text, /Player: Kaleb, 18/);
  assert.equal(count(s.store, 'games'), 0);

  // Explicit approval of the current summary.
  s.llm.enqueue('world_copilot', reply(older, 'Here we go.', 'confirm_finalize', 'Yes, create it'));
  const done = await s.creation.say(draftId, 'Yes, create it.');
  assert.equal(done.status, 'finalized');
  assert.ok(done.gameId);
  assert.match(done.opening!, /^Arrakeen, Arrakis — [\s\S]*Before dawn\.[\s\S]*What do you do\?$/);
  const row = s.store.getDraft(draftId)!;
  assert.equal(row.gameId, done.gameId);
  assert.equal(s.store.getGame(done.gameId)!.packId, 'open');
  await assert.rejects(() => s.creation.say(draftId, 'one more thing'), /is finalized/);
  s.store.close();
});

test('the WorldSeed is written once and is immutable; the starting state holds conditions, not outcomes', async () => {
  const s = setup();
  const { draftId } = s.creation.start();
  s.llm.enqueue('world_copilot', reply(DESERT, 'Ok.', 'request_finalize'));
  await s.creation.say(draftId, 'start it');
  const { gameId } = s.creation.approve(draftId);
  assert.ok(gameId);

  const seed = s.store.getWorldSeed<WorldSeed>(gameId)!;
  assert.equal(seed.draftId, draftId);
  assert.equal(seed.world.canonPolicy, 'alternate_from_start');
  assert.deepEqual(seed.style.designPrinciples, DESERT.designPrinciples);
  assert.throws(() => s.store.run('UPDATE world_seeds SET seed_json = :j WHERE game_id = :g', { j: '{}', g: gameId }), /immutable/);
  assert.throws(() => s.store.insertWorldSeed(gameId, draftId, 'open', seed, 'x'), /UNIQUE|PRIMARY/);

  // Only the people the opening needs; their view of the player; the player's circumstances; money.
  const chars = s.store.listCharacters(gameId);
  assert.deepEqual(chars.map((c) => c.name).sort(), ['Kaleb', 'Old Harun']);
  const harun = chars.find((c) => c.name === 'Old Harun')!;
  const player = chars.find((c) => c.isPlayer)!;
  assert.match(s.store.getRelationship(harun.id, player.id)!.summary, /not yet trustworthy/);
  assert.deepEqual(s.store.listFacts(gameId).map((f) => `${f.predicate}=${f.value}`),
    ['circumstance=sleeps in the master\'s storeroom', 'circumstance_2=owes the master two years of work', 'possession=a stillsuit, patched']);
  assert.equal(s.store.getAccountOf(gameId, 'character', player.id)!.balanceCents, 3_000);

  // Starting situations exist as observed conditions — known only to those involved — with no outcome.
  const events = s.store.listEvents(gameId);
  const license = events.find((e) => e.type === 'situation_seed')!;
  assert.match(license.summary, /license is up for renewal/);
  assert.deepEqual(license.observers.map((o) => o.characterId), [harun.id]);
  assert.equal(count(s.store, 'story_threads'), 0);
  assert.equal(count(s.store, 'decisions'), 0);
  assert.equal(s.store.getGame(gameId)!.gameTime, '2026-05-01T06:00');
  s.store.close();
});

test('pack reuse: a Dune-like world plays on the Open World pack; the Director is bound by the world bible', async () => {
  const s = setup();
  const { draftId } = s.creation.start();
  s.llm.enqueue('world_copilot', reply(DESERT, 'Ok.', 'request_finalize'));
  await s.creation.say(draftId, 'start it');
  const { gameId } = s.creation.approve(draftId);

  const engine = new Engine(s.store, s.llm, { pack: openPack, rng: () => () => 0.5, director: true });
  s.llm.enqueue('interpret', interp({ intents: ['start_conversation', 'speak'], target: { name: 'Old Harun', relationHint: null }, channel: 'in_person', spokenText: 'Morning, master.' }))
    .enqueue('npc_turn', npc({ dialogue: 'You\'re late. The gauge is down again.' }));
  const r = await engine.takeTurn({ gameId: gameId!, input: 'I greet Harun' });
  assert.equal(r.status, 'committed', r.error ?? '');
  assert.match(s.llm.callsFor('interpret')[0]!.system, /Arrakeen, Arrakis, the years of Harkonnen rule \(Dune\)/);
  assert.match(s.llm.callsFor('interpret')[0]!.system, /Water is the scarcest resource/);
  assert.match(lastPrompt(s.llm, 'npc_turn'), /Arrakeen/);
  assert.doesNotMatch(lastPrompt(s.llm, 'npc_turn'), /Milan|startup/i);

  // A day passes: the Director reviews the world with the immutable bible in its instructions.
  s.llm.enqueue('interpret', interp({ intents: ['general_action'], minutesElapsed: 1440, narration: 'You haul water all day.' }))
    .enqueue('director', { newThreads: [], escalations: [] });
  const day = await engine.takeTurn({ gameId: gameId!, input: 'I work all day' });
  assert.equal(day.status, 'committed', day.error ?? '');
  const director = s.llm.callsFor('director')[0]!.system;
  assert.match(director, /PLAYER SIGNIFICANCE: insignificant: an apprentice nobody at court has heard of/);
  assert.match(director, /- Great houses never notice the player without a concrete reason\./);
  assert.match(director, /Canon policy: alternate from start/);
  s.store.close();
});

test('quick start compiles the pack template through the same seed pipeline', () => {
  const store = new Store(tmpDbPath());
  const engine = new Engine(store, new ScriptedProvider(), { pack: openPack });
  const { game, opening } = engine.newGame();
  assert.equal(game.packId, 'open');
  assert.match(opening, /Varessa/);
  assert.equal(store.getWorldSeed<WorldSeed>(game.id)!.draftId, null);
  assert.equal(count(store, 'world_drafts'), 0);
  store.close();
});

test('the Copilot sends only changes; a bad path or value is sent back for correction, never half-applied', async () => {
  const s = setup();
  const { draftId } = s.creation.start();
  s.llm.enqueue('world_copilot',
    { reply: 'x', updates: [{ path: 'player.name', value: '"Kaleb"' }, { path: 'player.nickname', value: '"K"' }], intent: 'discuss', approvalQuote: null },
    { reply: 'Kaleb, then.', updates: [{ path: 'player.name', value: '"Kaleb"' }, { path: 'setting.place', value: '"Arrakeen"' }], intent: 'discuss', approvalQuote: null });
  const r = await s.creation.say(draftId, 'I am Kaleb, in Arrakeen');
  assert.equal(r.text, 'Kaleb, then.');
  assert.match(lastPrompt(s.llm, 'world_copilot'), /YOUR PREVIOUS OUTPUT WAS REJECTED:\n- updates: "player\.nickname" is not a field of the draft/);
  const d = s.creation.draft(draftId);
  assert.deepEqual([d.player.name, d.setting.place, d.player.age], ['Kaleb', 'Arrakeen', null]);
  assert.equal(s.store.getDraft(draftId)!.version, 1);
  s.store.close();
});
