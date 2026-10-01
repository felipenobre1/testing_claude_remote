// The Adventure pack and the storyteller: fights, wounds, death, skills, gear, fame;
// scene beats that bring the world to the player; a narrator that writes decided turns as prose.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db/store.ts';
import type { Trace } from '../src/engine/trace.ts';
import { Engine } from '../src/engine/turn.ts';
import { formatStatusLine } from '../src/debug/inspect.ts';
import { ScriptedProvider } from '../src/llm/scripted.ts';
import { adventurePack as defaultAdventure } from '../src/packs/adventure/index.ts';
import { ASHKAR_WORLD } from '../src/packs/adventure/world.ts';
import { advRepo } from '../src/packs/adventure/state.ts';
import { fixedRng, interp, lastPrompt, npc, tmpDbPath } from './helpers.ts';

// The tests play in Ashkar (Rhen, Kesh, Oda…); the pack's default opening is the Kingkiller world.
const adventurePack = { ...defaultAdventure, worldCreation: { ...defaultAdventure.worldCreation, template: ASHKAR_WORLD } };

function start(opts: { roll?: number; beats?: boolean; narrator?: boolean; director?: boolean } = {}) {
  const store = new Store(tmpDbPath());
  const llm = new ScriptedProvider();
  const engine = new Engine(store, llm, { pack: adventurePack, rng: fixedRng(opts.roll ?? 0.5), beats: opts.beats ?? false, narrator: opts.narrator ?? false, director: opts.director ?? false });
  const { game, player, opening } = engine.newGame();
  const me = () => advRepo.profile(store, player.id)!;
  const char = (name: string) => store.listCharacters(game.id).find((c) => c.name === name)!;
  const turn = async (input: string, i: Parameters<typeof interp>[0]) => {
    llm.enqueue('interpret', interp(i));
    const r = await engine.takeTurn({ gameId: game.id, input });
    assert.equal(r.status, 'committed', r.error ?? '');
    return r;
  };
  return { store, llm, engine, game, player, opening, me, char, turn };
}
const fight = (opponent: string, extra: Record<string, unknown> = {}) =>
  ({ action: 'fight', opponent, count: 1, threat: 3, style: 'aggressive', intent: 'kill', weaponName: 'curved knife', theirWeapon: 'a long knife', witnessed: true, guards: null, move: 'strong', how: 'a slash', cleverness: 0, ...extra });
const move = (m: string, extra: Record<string, unknown> = {}) => ({ action: 'combat_move', target: null, weaponName: null, move: m, how: m, cleverness: 0, ...extra });
/** Keeps making the same move until the fight is over (or `max` exchanges). Returns every turn's text. */
async function fightOn(s: ReturnType<typeof start>, m: string, max = 12) {
  const texts: string[] = [];
  for (let i = 0; i < max && advRepo.encounter(s.store, s.game.id); i++) texts.push((await s.turn(m, { intents: ['general_action'], minutesElapsed: 1, narration: '', actions: [move(m)] })).text);
  return texts;
}

test('the example world: a fighter with skills, gear, fame, a debt and people who matter', () => {
  const s = start();
  assert.match(s.opening, /^Ashkar, the pit-city of Qasr — Thursday, 11 March 94, 05:40/);
  assert.match(s.opening, /Your share of the water tithe is due within days/);
  const p = s.me();
  assert.deepEqual([p.health, p.skills.combat!.level, p.skills.athletics!.level, p.fame], [100, 2, 2, 1]);
  assert.deepEqual(advRepo.items(s.store, s.game.id).map((i) => `${i.name}/${i.kind}/${i.quality}`), ['curved knife/weapon/1', 'padded desert coat/armor/0']);
  assert.deepEqual(s.store.listCharacters(s.game.id).map((c) => c.name).sort(), ['Kesh Adar', 'Oda Venn', 'Rhen', 'Sarai Tul']);
  assert.match(formatStatusLine(s.store, s.game.id), /❤ 100\/100 · level 1 · ★ a few people know your name/);
  s.store.close();
});

test('the default opening: Kvothe at the University, the day before admissions (Kingkiller-inspired, alternate from the start)', () => {
  const store = new Store(tmpDbPath());
  const engine = new Engine(store, new ScriptedProvider(), { pack: defaultAdventure, rng: fixedRng(0.5), beats: false, narrator: false, director: false });
  const { game, player, opening } = engine.newGame();
  assert.equal(player.name, 'Kvothe');
  assert.match(opening, /^The University, across the river from Imre — /);
  assert.match(opening, /Admissions \(The Hollows, the University\)/);
  assert.match(formatStatusLine(store, game.id), /· j 13\.00 · ❤ 80\/80 · level 1 · ★ unknown ──$/); // strength 1: a scholar's body
  const sheet = defaultAdventure.commands!.sheet!.run(store, game.id, [], 'pt');
  assert.match(sheet, /astúcia ●●●●●/);
  assert.match(sheet, /arcanismo +●○○○○\n +atuação +●●●○○/);
  assert.deepEqual(store.listCharacters(game.id).map((c) => c.name).sort(), ['Ambrose Jakis', 'Denna', 'Devi', 'Elodin', 'Kilvin', 'Kvothe', 'Simmon']);
  const seed = store.getWorldSeed<{ world: { sourceWorld: string; canonPolicy: string } }>(game.id)!;
  assert.deepEqual([seed.world.sourceWorld, seed.world.canonPolicy], ['The Kingkiller Chronicle (Patrick Rothfuss)', 'alternate_from_start']);
  store.close();
});

test('fights go exchange by exchange: moves, a counter-table, momentum, a d20; a killed person is dead for good', async () => {
  // Roll 1: d20 20 every time, Kesh always grapples. A heavy attack beats a grapple (+1); each clean hit builds the upper hand.
  const s = start({ roll: 1 });
  const r = await s.turn('I draw my knife and go for Kesh\'s throat', { intents: ['general_action'], minutesElapsed: 1, narration: 'Steel.', actions: [fight('Kesh Adar')] });
  assert.match(r.text, /⚔ A fight begins — Kesh Adar\.\n⚔ Exchange 1 · your heavy attack vs Kesh Adar's grapple: clean hit on Kesh Adar \(−24\)\. \[you 5 \(combat 2, strength \+0\.5, curved knife \+2, padded desert coat \+0\.5\) heavy attack vs grapple \+1 vs Kesh Adar 4\.5 · d20 20 → \+6\.5\]\n   You ❤ 100\/100 · 💨 85 · ▲1 \| Kesh Adar: hurt/);
  assert.ok(advRepo.encounter(s.store, s.game.id)); // the fight goes on: one exchange per player message
  const texts = await fightOn(s, 'strong');
  assert.match(texts.at(-1)!, /Kesh Adar: dead\n⚔ The fight is over: you win — Kesh Adar dead\. · fame \+2 \(known around here\) · ✨ \+\d+ XP/);
  assert.match(lastPrompt(s.llm, 'interpret'), /Fight in progress \(fight, exchange \d; every player message is a combat_move until it ends\)/);
  assert.equal(advRepo.encounter(s.store, s.game.id), null);
  assert.ok(s.me().xp > 0);
  assert.equal(s.char('Kesh Adar').status, 'dead');
  assert.equal(s.me().fame, 3);
  assert.match(s.me().deeds.join(), /killed Kesh Adar in front of witnesses/);

  // The dead don't talk, can't be fought again, and are marked dead in the briefing.
  const talk = await s.engine.takeTurn({ gameId: s.game.id, input: 'I talk to Kesh',
    ...(s.llm.enqueue('interpret', interp({ intents: ['start_conversation'], target: { name: 'Kesh Adar', relationHint: null }, channel: 'in_person' })), {}) });
  assert.equal(talk.text, 'Kesh Adar is dead.');
  const again = await s.turn('I stab Kesh again', { intents: ['general_action'], minutesElapsed: 1, narration: '', actions: [fight('Kesh Adar')] });
  assert.match(again.text, /✗ Kesh Adar is already dead\./);
  assert.match(lastPrompt(s.llm, 'interpret'), /Kesh Adar \(rising pit fighter sponsored by House Varr, DEAD\)/);
  const none = await s.turn('I parry', { intents: ['general_action'], minutesElapsed: 1, narration: '', actions: [move('defend')] });
  assert.match(none.text, /✗ There is no fight going on\./);
  s.store.close();
});

test('losing hurts; several opponents; a fight nobody means to be lethal never kills', async () => {
  const s = start({ roll: 0 }); // d20 1 every time
  const r = await s.turn('I pick a fight with the house guards', { intents: ['general_action'], minutesElapsed: 1, narration: '',
    actions: [fight('house guard', { count: 3, threat: 5, intent: 'drive_off' })] });
  assert.match(r.text, /⚔ A fight begins — house guard 1, house guard 2, house guard 3\.\n⚔ Exchange 1 · your heavy attack vs house guard 1's heavy attack: house guard 1 lands a heavy blow — a cut to the left arm \(−11; 89\/100\)/);
  const texts = await fightOn(s, 'quick');
  assert.match(texts.at(-1)!, /⚔ The fight is over: you are beaten — at their mercy/);
  assert.ok(s.me().health >= 1 && s.me().health <= 50, `health ${s.me().health}`); // they only meant to drive you off
  // Again, unseen: beaten again, still alive.
  await s.turn('again', { intents: ['general_action'], minutesElapsed: 1, narration: '', actions: [fight('house guard', { count: 3, threat: 5, intent: 'drive_off', witnessed: false })] });
  await fightOn(s, 'strong');
  assert.ok(s.me().health >= 1);
  assert.equal(s.store.getCharacter(s.player.id)!.status, 'alive');
  assert.match(formatStatusLine(s.store, s.game.id), /❤ \d+\/100/);
  s.store.close();
});

test('whoever is in the scene witnesses the fight: the NPC\'s reaction must be consistent with what the engine decided', async () => {
  const s = start({ roll: 1 });
  s.llm.enqueue('interpret', interp({ intents: ['start_conversation', 'speak'], target: { name: 'Oda Venn', relationHint: null }, channel: 'in_person', spokenText: 'Watch this.',
    actions: [fight('a drunk dock thug', { threat: 1, intent: 'subdue' })] }))
    .enqueue('npc_turn', npc({ dialogue: 'Not bad.' }));
  await s.engine.takeTurn({ gameId: s.game.id, input: 'I floor a thug in front of Oda' });
  assert.match(lastPrompt(s.llm, 'npc_turn'), /WHAT JUST HAPPENED \(decided by the game — your reaction must be consistent with it\)\nRhen and a drunk dock thug fight \(exchange 1\): clean hit on a drunk dock thug/);
  s.llm.enqueue('interpret', interp({ intents: ['speak'], target: { name: 'Oda Venn', relationHint: null }, spokenText: 'And stay down.', actions: [move('strong')] }))
    .enqueue('npc_turn', npc({ dialogue: 'Come at dawn.' }));
  const r = await s.engine.takeTurn({ gameId: s.game.id, input: 'I finish him' });
  assert.match(r.text, /⚔ The fight is over: you win — a drunk dock thug down\. · fame \+1/);
  s.llm.enqueue('interpret', interp({ intents: ['speak'], target: { name: 'Oda Venn', relationHint: null }, spokenText: 'Well?' }))
    .enqueue('npc_turn', npc({ dialogue: 'Dawn.' }));
  await s.engine.takeTurn({ gameId: s.game.id, input: 'Well?' });
  assert.match(lastPrompt(s.llm, 'npc_turn'), /What people say about Rhen: a few people know your name — beat a drunk dock thug in front of witnesses/);
  s.store.close();
});

test('feats, rest, training and gear', async () => {
  const s = start({ roll: 0.5 });
  const climb = await s.turn('I climb the cistern wall', { intents: ['general_action'], minutesElapsed: 10, narration: '',
    actions: [{ action: 'attempt', feat: 'climb the cistern wall at night', skill: 'athletics', difficulty: 4, risk: 'injury' }] });
  assert.match(climb.text, /🎲 climb the cistern wall at night: partly — it works, but not cleanly\. You took a cut to the face \(−9; 91\/100\)\. · ✨ \+16 XP \[athletics 2 agility \+0\.5 − difficulty 4 · d20 11 → −0\.3\]/);
  const train = await s.turn('I train with Oda all day', { intents: ['general_action'], minutesElapsed: 600, narration: '',
    actions: [{ action: 'train', skill: 'combat', hours: 14, teacherName: 'Oda Venn' }] });
  assert.match(train.text, /🏋 Trained combat with Oda Venn: ⬆ combat is now 3/);
  const rest = await s.turn('I sleep', { intents: ['general_action'], minutesElapsed: 480, narration: '', actions: [{ action: 'rest', hours: 8, tended: false }] });
  assert.match(rest.text, /🛏 Rested 8h: health \d+ → \d+ · healed: a cut to the/);
  assert.equal(s.me().injuries.length, 0);
  const tooDear = await s.turn('I buy a short sword', { intents: ['general_action'], minutesElapsed: 20, narration: '',
    actions: [{ action: 'acquire_item', name: 'short sword', kind: 'weapon', quality: 2, quantity: 1, how: 'bought', price: 120 }] });
  assert.match(tooDear.text, /✗ You can't afford short sword \(dr 120\.00; you have dr 30\.00\)/);
  const knife = await s.turn('I buy a cheap spare knife', { intents: ['general_action'], minutesElapsed: 20, narration: '',
    actions: [{ action: 'acquire_item', name: 'spare knife', kind: 'weapon', quality: 0, quantity: 1, how: 'bought', price: 6 }] });
  assert.match(knife.text, /🎒 Bought: spare knife \(crude weapon\)/);
  assert.equal(s.store.getAccountOf(s.game.id, 'character', s.player.id)!.balanceCents, 2_400);
  s.store.close();
});

test('scene beats: in an eventful world, quiet turns end with the world coming to the player', async () => {
  const s = start({ beats: true });
  const idle = { intents: ['general_action'] as const, minutesElapsed: 20, narration: 'You mend your coat.' };
  const first = await s.turn('I mend my coat', { ...idle, intents: ['general_action'] });
  assert.equal(first.beat, undefined); // eventful: a beat after two quiet turns
  const stranger = {
    name: 'Imra Qell', age: 34, gender: 'female', role: 'fighter-broker for House Qell', occupation: 'broker', background: 'Buys promising fighters for a rival house, quietly.',
    personality: 'Soft-spoken, amused, dangerous to disappoint.', traits: ['patient', 'calculating'], values: ['leverage'], goals: ['Poach fighters from House Varr'],
    fears: ['Being exposed'], location: 'Ashkar', relationshipToPlayer: 'Has watched Rhen fight twice. Thinks he is underpriced.',
  };
  s.llm.enqueue('interpret', interp({ ...idle, intents: ['general_action'] }))
    .enqueue('scene_beat', { kind: 'encounter', title: 'A broker at the door', perceived: 'A woman in a dust-grey veil is waiting at the foot of your ladder.', involves: ['Nobody Real'],
      newPerson: stranger, opensConversation: { name: 'Imra Qell', channel: 'in_person', openingLine: 'Your father owed Varr. You don\'t have to.' }, choice: 'Hear her out, or climb back up.' })
    .enqueue('scene_beat', { kind: 'encounter', title: 'A broker at the door', perceived: 'A woman in a dust-grey veil is waiting at the foot of your ladder.', involves: [],
      newPerson: stranger, opensConversation: { name: 'Imra Qell', channel: 'in_person', openingLine: 'Your father owed Varr. You don\'t have to.' }, choice: 'Hear her out, or climb back up.' });
  const r = await s.engine.takeTurn({ gameId: s.game.id, input: 'I keep mending' });
  assert.equal(r.status, 'committed', r.error ?? '');
  assert.equal(r.beat, 'A broker at the door');
  assert.match(r.text, /⚡ A woman in a dust-grey veil is waiting at the foot of your ladder\.\nImra Qell: “Your father owed Varr\. You don't have to\.”\n→ Hear her out, or climb back up\./);
  // The first proposal named someone who doesn't exist; the engine sent it back.
  const calls = (s.store.lastTurn(s.game.id)!.trace as Trace).llmCalls.filter((c) => c.task === 'scene_beat');
  assert.match(calls[0]!.problems.join(), /"Nobody Real" is not an existing character/);
  // She exists now, and a conversation with her is open: the player's next words go to her.
  const imra = s.char('Imra Qell');
  assert.ok(imra);
  const scene = s.store.getScene(s.game.id);
  assert.ok(scene.activeCharacterIds.includes(imra.id));
  assert.equal(s.store.getInteraction(scene.interactionId!)!.participantIds.includes(imra.id), true);
  // Beat prompts carry the bible: pace and ambition.
  assert.match(s.llm.callsFor('scene_beat')[0]!.system, /STORY PACE: eventful[\s\S]*RHEN'S AMBITION: to become a warrior whose name is known across the known worlds/);
  s.store.close();
});

test('the narrator writes the decided turn as prose, quoting NPC words exactly; if it fails, the game text is used', async () => {
  const s = start({ narrator: true, roll: 1 });
  const talk = () => interp({ intents: ['start_conversation', 'speak'], target: { name: 'Oda Venn', relationHint: null }, channel: 'in_person', spokenText: 'Train me.' });
  s.llm.enqueue('interpret', talk()).enqueue('npc_turn', npc({ dialogue: 'Come back at dawn. Bring water.', perceivable: 'She does not look up from the blade she is oiling.' }))
    .enqueue('narrate', { prose: 'The yard smells of oil and old blood. Oda tells you to leave.' }) // misquotes her: rejected
    .enqueue('narrate', { prose: 'The yard smells of oil and old blood. Oda does not look up. "Come back at dawn. Bring water." The blade in her hands catches the first light, and you understand that this is not an answer yet — it is a test.' });
  const r = await s.engine.takeTurn({ gameId: s.game.id, input: 'I ask Oda to train me' });
  assert.equal(r.status, 'committed', r.error ?? '');
  assert.match(r.text, /^The yard smells of oil and old blood\. Oda does not look up\. "Come back at dawn\. Bring water\."/);
  const narr = s.llm.callsFor('narrate');
  assert.match(narr[0]!.system, /interactive novel[\s\S]*Violence is part of this world and is shown in full/);
  assert.match(narr[0]!.user, /WORDS SPOKEN \(quote exactly\):\n- Oda Venn \(She does not look up from the blade she is oiling\.\): "Come back at dawn\. Bring water\."/);
  assert.match(narr[0]!.user, /THE READER'S CONDITION:\nCondition: fit \(100\/100\)/);

  // Two bad narrations: the turn still commits with the concise text.
  s.llm.enqueue('interpret', interp({ intents: ['speak'], target: { name: 'Oda Venn', relationHint: null }, spokenText: 'I will.' }))
    .enqueue('npc_turn', npc({ dialogue: 'We will see.' }))
    .enqueue('narrate', { prose: 'Nothing is said at all, nothing.' }, { prose: 'Still nothing is said here.' });
  const r2 = await s.engine.takeTurn({ gameId: s.game.id, input: 'I will' });
  assert.equal(r2.status, 'committed', r2.error ?? '');
  assert.match(r2.text, /Oda Venn: “We will see\.”/);
  assert.match(String((s.store.lastTurn(s.game.id)!.trace as Trace).narratorFailed), /narrate: model output rejected/);
  s.store.close();
});

test('the narrator writes the opening scene of a literary world', async () => {
  const s = start({ narrator: true });
  s.llm.enqueue('narrate', { prose: 'Grey light seeps through the canvas above your niche.' });
  assert.equal(await s.engine.openingProse(s.game.id), 'Grey light seeps through the canvas above your niche.');
  const call = s.llm.callsFor('narrate')[0]!;
  assert.match(call.user, /This is the opening of the story[\s\S]*Rhen dreams to become a warrior whose name is known across the known worlds[\s\S]*Coming up: Friday, 12 March 94, 06:00 — Caravan hiring guards/);
  s.llm.enqueue('narrate', 'not json');
  assert.equal(await s.engine.openingProse(s.game.id), null); // falls back to the plain opening
  s.store.close();
});

test('playing in another language: everything the player reads is written in it; the engine stays English', async () => {
  const store = new Store(tmpDbPath());
  const llm = new ScriptedProvider();
  const engine = new Engine(store, llm, { pack: adventurePack, rng: fixedRng(0.5), beats: true, narrator: true });
  const { game } = engine.newGame({ language: 'Brazilian Portuguese' });
  const rule = /LANGUAGE: the player plays in Brazilian Portuguese\. Write (.+?) in Brazilian Portuguese/;
  llm.enqueue('interpret', interp({ intents: ['start_conversation', 'speak'], target: { name: 'Oda Venn', relationHint: null }, channel: 'in_person', spokenText: 'Me treina.' }))
    .enqueue('npc_turn', npc({ dialogue: 'Volta amanhã cedo.' }))
    .enqueue('narrate', { prose: 'O pátio cheira a óleo. Oda não levanta os olhos: "Volta amanhã cedo."' });
  const r = await engine.takeTurn({ gameId: game.id, input: 'Peço para a Oda me treinar' });
  assert.equal(r.status, 'committed', r.error ?? '');
  assert.match(llm.callsFor('interpret')[0]!.system, rule);
  assert.match(llm.callsFor('interpret')[0]!.system.match(rule)![1]!, /narration, newSceneDescription, suggestions/);
  assert.match(llm.callsFor('npc_turn')[0]!.system.match(rule)![1]!, /dialogue, perceivable/);
  assert.match(llm.callsFor('narrate')[0]!.system.match(rule)![1]!, /the prose/);
  assert.match(llm.callsFor('narrate')[0]!.system, /PLAYER'S LANGUAGE: Brazilian Portuguese/); // in the bible, for the Director too
  // Internal instructions remain English; an English world gets no language rule at all.
  assert.match(llm.callsFor('interpret')[0]!.system, /^You interpret one player input/);
  const en = start({ narrator: true });
  en.llm.enqueue('narrate', { prose: 'Grey light.' });
  await en.engine.openingProse(en.game.id);
  assert.doesNotMatch(en.llm.callsFor('narrate')[0]!.system, /LANGUAGE:/);
  en.store.close();
  store.close();
});

test('a scene beat never blocks the turn: harmless slips are fixed, a hopeless beat is skipped', async () => {
  const s = start({ beats: true });
  const stranger = {
    name: 'Dema Rusk', age: 40, gender: 'female', role: 'caravan master', occupation: 'caravan master', background: 'Runs salt caravans into the deep desert for twenty years.',
    personality: 'Blunt, fair, counts every drop of water twice.', traits: ['blunt', 'fair'], values: ['reliability'], goals: ['Hire blades before the storm season'],
    fears: ['Losing a caravan'], location: 'Ashkar', relationshipToPlayer: 'Has never met Rhen; noticed his knife.',
  };
  // The newcomer also listed in involves (the slip from the playtest), plus casing: accepted as-is.
  s.llm.enqueue('interpret', interp({ intents: ['general_action'], minutesElapsed: 20, narration: '' }), interp({ intents: ['general_action'], minutesElapsed: 20, narration: '' }))
    .enqueue('scene_beat', { kind: 'encounter', title: 'An early hire', perceived: 'A woman with a ledger is looking over the men at the gate.', involves: ['Dema Rusk', 'oda venn'],
      newPerson: stranger, opensConversation: { name: 'Dema Rusk', channel: 'in_person', openingLine: 'You. Can you use that knife?' }, choice: 'Answer her, or keep your head down.' });
  await s.engine.takeTurn({ gameId: s.game.id, input: 'I wait at the gate' });
  const r = await s.engine.takeTurn({ gameId: s.game.id, input: 'I keep waiting' });
  assert.equal(r.status, 'committed', r.error ?? '');
  assert.equal(r.beat, 'An early hire');
  assert.equal(s.llm.callsFor('scene_beat').length, 1); // no retry needed
  assert.ok(s.char('Dema Rusk'));
  const beatEvent = s.store.listEvents(s.game.id).find((e) => e.type === 'scene_beat')!;
  assert.deepEqual(beatEvent.participants.map((p) => p.characterId).sort(), [s.char('Dema Rusk').id, s.char('Oda Venn').id].sort());

  // Two unusable proposals: the player's turn still commits, just without a beat.
  const t = start({ beats: true });
  const bad = { kind: 'encounter', title: 'Ghost', perceived: 'Someone who does not exist waves at you.', involves: ['Nobody Real'], newPerson: null, opensConversation: null, choice: 'Wave back?' };
  t.llm.enqueue('interpret', interp({ intents: ['general_action'], minutesElapsed: 20, narration: '' }), interp({ intents: ['general_action'], minutesElapsed: 20, narration: 'You wait.' }))
    .enqueue('scene_beat', bad, bad);
  await t.engine.takeTurn({ gameId: t.game.id, input: 'I wait' });
  const r2 = await t.engine.takeTurn({ gameId: t.game.id, input: 'I wait more' });
  assert.equal(r2.status, 'committed', r2.error ?? '');
  assert.equal(r2.beat, undefined);
  assert.match(String((t.store.lastTurn(t.game.id)!.trace as Trace).beatFailed), /"Nobody Real" is not an existing character/);
  s.store.close();
  t.store.close();
});

test('in Portuguese: the narrator renders the result lines (numbers checked) and writes ideas after the turn is decided', async () => {
  const store = new Store(tmpDbPath());
  const llm = new ScriptedProvider();
  const engine = new Engine(store, llm, { pack: adventurePack, rng: fixedRng(1), beats: false, narrator: true });
  const { game } = engine.newGame({ language: 'Brazilian Portuguese' });
  assert.match(formatStatusLine(store, game.id), /^── qui\., 11 de mar\., 05:40 · .* · dr 30\.00 · ❤ 100\/100 · nível 1 · ★ algumas pessoas sabem seu nome ──$/);

  const fightTurn = interp({ intents: ['general_action'], minutesElapsed: 1, narration: '', suggestions: ['Treinar sozinho'],
    actions: [fight('um bandido de beco', { threat: 2, intent: 'drive_off', witnessed: false })] });
  const prose = 'O bandido avança; a faca do seu pai encontra o braço dele.';
  const resultLines = (user: string) => {
    const out: string[] = [];
    for (const l of user.split('THE RESULT LINES (the game shows these under your passage):\n')[1]!.split('\n')) { const m = l.match(/^\d+\. (.*)$/); if (!m) break; out.push(m[1]!); }
    return out;
  };
  llm.enqueue('interpret', fightTurn)
    .enqueue('narrate',
      (req: { user: string }) => ({ prose, suggestions: ['Voltar para a alcova'], lines: resultLines(req.user).map((l) => l.replace(/\d+/g, '7')) }), // wrong numbers
      (req: { user: string }) => ({ prose, suggestions: ['Chutar a areia nos olhos dele', 'Recuar para o beco estreito'],
        // A faithful rendering: words translated, every number kept.
        lines: resultLines(req.user).map((l) => l.replace('A fight begins', 'Uma luta começa').replace('Exchange', 'Troca')) }));
  const r = await engine.takeTurn({ gameId: game.id, input: 'enfrento o bandido' });
  assert.equal(r.status, 'committed', r.error ?? '');
  assert.ok(r.text.startsWith(`${prose}\n\n⚔ Uma luta começa — um bandido de beco.\n⚔ Troca 1 · your heavy attack`), r.text);
  assert.match(r.text, /\[you 5 \(combat 2, strength \+0\.5, curved knife \+2, padded desert coat \+0\.5\) [^\]]*d20 20 → \+[\d.]+\]/);
  assert.deepEqual(r.suggestions, ['Chutar a areia nos olhos dele', 'Recuar para o beco estreito']); // the narrator's, not the interpreter's
  assert.equal(r.results[0], '⚔ A fight begins — um bandido de beco.'); // the record stays English
  const calls = llm.callsFor('narrate');
  assert.match(calls[0]!.user, /THE RESULT LINES \(the game shows these under your passage\):\n1\. ⚔ A fight begins — um bandido de beco\.\n2\. ⚔ Exchange 1/);
  assert.match(calls[0]!.system, /A fight goes exchange by exchange/);
  assert.match(calls[1]!.user, /lines\[1\] must keep every number of RESULT LINE 2 exactly/);

  // The fight goes on: finish it before moving on.
  llm.enqueue('interpret', interp({ intents: ['general_action'], minutesElapsed: 1, narration: '', actions: [move('strong')] }), interp({ intents: ['general_action'], minutesElapsed: 1, narration: '', actions: [move('strong')] }))
    .enqueue('narrate', (req: { user: string }) => ({ prose, suggestions: ['Seguir o rastro de sangue até o esconderijo dele', 'Procurar Oda e contar o que houve'], lines: resultLines(req.user) }),
      (req: { user: string }) => ({ prose, suggestions: ['Seguir o rastro de sangue até o esconderijo dele', 'Procurar Oda e contar o que houve'], lines: resultLines(req.user) }));
  await engine.takeTurn({ gameId: game.id, input: 'golpeio' });
  if (advRepo.encounter(store, game.id)) await engine.takeTurn({ gameId: game.id, input: 'golpeio' });
  assert.equal(advRepo.encounter(store, game.id), null);

  // Next turn: the previous ideas are passed so they are not repeated.
  llm.enqueue('interpret', interp({ intents: ['general_action'], minutesElapsed: 5, narration: '' }))
    .enqueue('narrate', { prose: 'Você respira fundo e limpa a lâmina no casaco.', suggestions: ['Ir até o pátio de Oda'], lines: [] });
  await engine.takeTurn({ gameId: game.id, input: 'limpo a faca' });
  assert.match(llm.callsFor('narrate').at(-1)!.user, /PREVIOUS IDEAS \(do not repeat\): Seguir o rastro de sangue até o esconderijo dele · Procurar Oda e contar o que houve/);
  // Seek is for people you can't reach yet; known people are visited.
  assert.match(llm.callsFor('interpret')[0]!.system, /seek: ONLY for a person or organisation Rhen does not yet know how to reach/);
  store.close();
});

test('an offer made in a scene beat is real: the player accepts it (not a new offer of their own); the narrator continues from its previous passage', async () => {
  const s = start({ beats: true, narrator: true });
  const quiet = () => interp({ intents: ['general_action'], minutesElapsed: 20, narration: 'You wait by the wall.' });
  s.llm.enqueue('interpret', quiet(), quiet())
    .enqueue('narrate', { prose: 'The yard is grey and cold; dust hangs in the first light.', suggestions: [], lines: [] })
    .enqueue('scene_beat', { kind: 'arrival', title: 'Kesh wants a sparring partner', perceived: 'Kesh Adar walks in with a training sword and sets fifteen drams on the low wall.',
      involves: ['Kesh Adar'], newPerson: null, opensConversation: { name: 'Kesh Adar', channel: 'in_person', openingLine: 'Three minutes with me. You get the money if you can still stand.' },
      choice: 'Take the fifteen drams and the beating, or walk away.',
      offer: { kind: 'deal', label: 'three minutes of sparring', terms: [{ key: 'price_offerer_pays', value: 15 }], description: 'Kesh pays 15 drams for three minutes of sparring' } })
    .enqueue('narrate', { prose: 'Kesh comes through the gate with a training sword. "Three minutes with me. You get the money if you can still stand."', suggestions: ['Accept the bout'], lines: [] });
  await s.engine.takeTurn({ gameId: s.game.id, input: 'I wait' });
  const r = await s.engine.takeTurn({ gameId: s.game.id, input: 'I keep waiting' });
  assert.equal(r.status, 'committed', r.error ?? '');
  assert.match(r.text, /→ Kesh Adar offers you: three minutes of sparring for dr 15\.00/);
  const offer = s.store.listOffers(s.game.id).find((o) => o.fromCharacterId === s.char('Kesh Adar').id)!;
  assert.equal(offer.status, 'pending');
  // The narrator was given its previous passage (continuity, no re-description).
  assert.match(s.llm.callsFor('narrate').at(-1)!.user, /^PREVIOUS PASSAGE \(already read — continue from it, do not repeat it\):\nThe yard is grey and cold/);

  // "I accept" → respond_to_offer on HIS offer; the briefing makes that explicit.
  s.llm.enqueue('interpret', (req: { user: string }) => {
    assert.match(req.user, new RegExp(`\\[${offer.id}\\] Offer from Kesh Adar to you: three minutes of sparring for dr 15\\.00 .*respond_to_offer with this id, not a new offer`));
    return interp({ intents: ['speak'], target: { name: 'Kesh Adar', relationHint: null }, spokenText: 'Fechado.', actions: [{ action: 'respond_to_offer', offerId: offer.id, accept: true }] });
  })
    .enqueue('npc_turn', npc({ dialogue: 'Then pick up a sword.' }))
    .enqueue('narrate', { prose: 'Kesh tosses you a training sword. "Then pick up a sword."', suggestions: [], lines: [] });
  const acc = await s.engine.takeTurn({ gameId: s.game.id, input: 'Aceito' });
  assert.equal(acc.status, 'committed', acc.error ?? '');
  assert.match(acc.text, /✓ Deal: three minutes of sparring/);
  assert.equal(s.store.getAccountOf(s.game.id, 'character', s.player.id)!.balanceCents, 4_500); // 30 + 15 from Kesh
  assert.match(s.llm.callsFor('narrate').at(-1)!.user, /THE PLAYER SAID \(do not repeat it back\): "Fechado\."/);
  s.store.close();
});

test('playtest export: what the player typed and saw, what the engine decided, rejected model output', async () => {
  const s = start({ roll: 1 });
  s.llm.enqueue('interpret', 'not json', interp({ intents: ['general_action'], minutesElapsed: 1, narration: 'Steel.', actions: [fight('a drunk dock thug', { threat: 1, intent: 'subdue' })] }));
  await s.engine.takeTurn({ gameId: s.game.id, input: 'I floor the thug' });
  const { exportPlaytest } = await import('../src/debug/export.ts');
  const md = exportPlaytest(s.store, s.game.id);
  assert.match(md, /^# Playtest — Ashkar, the pit-city of Qasr — Rhen/);
  assert.match(md, /STORY PACE: eventful/);
  assert.match(md, /\*\*Player:\*\* I floor the thug/);
  assert.match(md, /⚔ A fight begins — a drunk dock thug\.[\s\S]*⚔ Exchange 1 · your heavy attack/);
  assert.match(md, /- model calls: interpret( [\d.]+s)? ✗ output was not valid JSON · interpret#2/);
  assert.match(md, /\| interpret \| 2 \| 1 \|/);
  assert.doesNotMatch(md, /\*\*Prompt:\*\*/); // prompts only with --full
  assert.match(exportPlaytest(s.store, s.game.id, { full: true }), /\*\*Prompt:\*\*/);
  s.store.close();
});

test('people attack the player: a mortal insult gets a knife, a lethal fight can kill, and a dead player\'s story is over', async () => {
  const s = start({ roll: 0 });
  const insult = () => interp({ intents: ['start_conversation', 'speak'], target: { name: 'Kesh Adar', relationHint: null }, channel: 'in_person', spokenText: 'I slept with your wife. She says you are a coward.' });
  s.llm.enqueue('interpret', insult())
    .enqueue('npc_turn', npc({ dialogue: 'I will gut you.', perceivable: 'His training sword clatters down; a real blade comes out.', attack: { intent: 'kill', threat: 4, how: 'a curved sword, straight for the belly' } }));
  const r = await s.engine.takeTurn({ gameId: s.game.id, input: 'I tell Kesh I slept with his wife' });
  assert.equal(r.status, 'committed', r.error ?? '');
  assert.match(s.llm.callsFor('npc_turn')[0]!.system, /attack: only when physical violence NOW fits who you are and what just happened[\s\S]*A powerful person rarely brawls: they have it done/);
  // He strikes first: the player is caught on the back foot.
  assert.match(r.text, /⚔ A fight begins — Kesh Adar\.\n⚔ Exchange 1 · your guard vs Kesh Adar's heavy attack: Kesh Adar lands a heavy blow — a cut to the left arm \(−11; 89\/100\)\. \[[^\]]*tactics −1/);
  assert.equal(r.gameOver, undefined);

  // Talking while he presses the attack is just another exchange.
  s.llm.enqueue('interpret', interp({ intents: ['speak'], target: { name: 'Kesh Adar', relationHint: null }, spokenText: 'Is that all?' }))
    .enqueue('npc_turn', npc({ dialogue: 'No.', attack: { intent: 'kill', threat: 4, how: 'the point, through the ribs' } }));
  const r2 = await s.engine.takeTurn({ gameId: s.game.id, input: 'I mock him' });
  assert.match(r2.text, /⚔ Exchange 2 · your guard vs Kesh Adar's heavy attack/);

  // He finishes it.
  const texts = await fightOn(s, 'strong');
  assert.match(texts.at(-1)!, /⚔ The fight is over: ☠ Rhen is dead\./);
  const last = s.store.lastTurn(s.game.id)!;
  assert.equal(last.response!.gameOver, true);
  assert.deepEqual(last.response!.suggestions, []);
  assert.equal(s.store.getCharacter(s.player.id)!.status, 'dead');
  const after = await s.engine.takeTurn({ gameId: s.game.id, input: 'I get up' });
  assert.match(after.text, /^☠ Rhen is dead\. This story is over\./);
  s.store.close();
});

test('someone who only means to humiliate can beat you bloody but not kill you; an ambush comes as a scene beat', async () => {
  const s = start({ roll: 0 });
  for (let i = 0; i < 25 && !/fight is over/.test(s.store.lastTurn(s.game.id)?.response?.text ?? ''); i++) {
    s.llm.enqueue('interpret', interp({ intents: ['start_conversation', 'speak'], target: { name: 'Kesh Adar', relationHint: null }, channel: 'in_person', spokenText: 'Coward.' }))
      .enqueue('npc_turn', npc({ dialogue: 'On your knees.', attack: { intent: 'humiliate', threat: 4, how: 'the flat of his blade' } }));
    await s.engine.takeTurn({ gameId: s.game.id, input: 'I insult Kesh' });
  }
  assert.match(s.store.lastTurn(s.game.id)!.response!.text, /⚔ The fight is over: you are beaten/);
  assert.ok(s.me().health >= 1 && s.me().health <= 50); // humbled, then left alone
  assert.ok(s.me().injuries.every((i) => /bruise|blow/.test(i.text))); // the flat of a blade
  assert.equal(s.store.getCharacter(s.player.id)!.status, 'alive');
  s.store.close();

  const t = start({ roll: 1, beats: true });
  const thug = {
    name: 'Vorn', age: 30, gender: 'male', role: 'debt-enforcer for hire', occupation: 'enforcer', background: 'Breaks bones for whoever pays.',
    personality: 'Bored, patient and utterly brutal.', traits: ['brutal', 'patient'], values: ['coin'], goals: ['Get paid'], fears: ['Being cheated'], location: 'Ashkar',
    relationshipToPlayer: 'Paid to hurt him. Nothing personal.',
  };
  t.llm.enqueue('interpret', interp({ intents: ['general_action'], minutesElapsed: 20, narration: '' }), interp({ intents: ['general_action'], minutesElapsed: 20, narration: '' }))
    .enqueue('scene_beat', { kind: 'threat', title: 'An enforcer in the alley', perceived: 'A big man steps out of a doorway with a club.', involves: [], newPerson: thug,
      opensConversation: null, choice: 'Fight or run.', offer: null, attack: { byName: 'Vorn', intent: 'hurt', threat: 3, how: 'a club at the knees' } });
  await t.engine.takeTurn({ gameId: t.game.id, input: 'I walk home' });
  const r = await t.engine.takeTurn({ gameId: t.game.id, input: 'I keep walking' });
  assert.equal(r.status, 'committed', r.error ?? '');
  assert.match(r.text, /⚔ A fight begins — Vorn\.\n⚔ Exchange 1 · your guard vs Vorn's [a-z ]+: clean hit on Vorn/);
  // The fight holds the scene: no new beat while it lasts.
  t.llm.enqueue('interpret', interp({ intents: ['general_action'], minutesElapsed: 20, narration: '', actions: [move('quick')] }));
  const r2 = await t.engine.takeTurn({ gameId: t.game.id, input: 'I go for his knees' });
  assert.equal(r2.status, 'committed', r2.error ?? '');
  assert.equal(r2.beat, undefined);
  t.store.close();
});

test('attacking a guarded lord: the guards stand in the way, and what you did comes back to you', async () => {
  // A lord with two guards (threat 5). Roll 0.5: the guards win the exchanges — the player yields without ever reaching the lord.
  const s = start({ roll: 0.5 });
  s.llm.enqueue('interpret', interp({ intents: ['general_action'], minutesElapsed: 1, narration: '',
    actions: [fight('Lord Varr', { threat: 2, intent: 'kill', guards: { who: 'House Varr guard', count: 2, threat: 5 } })] }));
  const r = await s.engine.takeTurn({ gameId: s.game.id, input: 'I rush the lord with my knife' });
  assert.equal(r.status, 'committed', r.error ?? '');
  assert.match(r.text, /⚔ A fight begins — House Varr guard 1 \(protecting Lord Varr\), House Varr guard 2 \(protecting Lord Varr\)\./);
  assert.match(r.text, /\n   House Varr guard 2 (catches you with the edge of a heavy blow|clips you|[a-z ]+)/); // the other guard strikes while you deal with the first
  const y = await s.turn('I drop the knife and yield', { intents: ['general_action'], minutesElapsed: 1, narration: '', actions: [move('yield')] });
  assert.match(y.text, /⚔ The fight is over: you yield/);
  // The world will answer: an arrest (or worse) is scheduled within minutes.
  const due = s.store.listScheduled(s.game.id, 'pending').find((i) => i.kind === 'consequence')!;
  assert.match(String(due.payload.summary), /Rhen attacked Lord Varr and was stopped by House Varr guard in front of witnesses/);
  s.store.close();

  // Killing a known person in public: the consequence comes due; the next beat must answer it, whatever the pace.
  const t = start({ roll: 1, beats: true });
  t.llm.enqueue('interpret', interp({ intents: ['general_action'], minutesElapsed: 1, narration: '', actions: [fight('Kesh Adar')] }));
  await t.engine.takeTurn({ gameId: t.game.id, input: 'I kill Kesh in the yard' });
  await fightOn(t, 'strong');
  assert.equal(t.char('Kesh Adar').status, 'dead');
  assert.ok(t.store.listScheduled(t.game.id, 'pending').some((i) => i.kind === 'consequence' && /killed Kesh Adar \(rising pit fighter sponsored by House Varr\) in front of witnesses/.test(String(i.payload.summary))));
  const guards = { name: 'Captain Ilse Maro', age: 45, gender: 'female', role: 'captain of the House Varr watch', occupation: 'watch captain', background: 'Twenty years keeping House Varr\'s order in the lower city.',
    personality: 'Cold, procedural, merciless with killers.', traits: ['cold', 'procedural'], values: ['order'], goals: ['Hang Kesh\'s killer'], fears: ['Losing face with the house'], location: 'Ashkar',
    relationshipToPlayer: 'Hunting the man who killed Kesh Adar.' };
  t.llm.enqueue('interpret', interp({ intents: ['general_action'], minutesElapsed: 5 * 60, narration: 'You lie low.' }))
    .enqueue('scene_beat', (req: { user: string }) => {
      assert.match(req.user, /CONSEQUENCES DUE NOW — this beat MUST be the world answering this[\s\S]*- Rhen killed Kesh Adar/);
      return { kind: 'threat', title: 'The watch comes', perceived: 'Boots on the ladder. The watch captain and six spears.', involves: [], newPerson: guards,
        opensConversation: { name: 'Captain Ilse Maro', channel: 'in_person', openingLine: 'Rhen. You\'re coming with us.' }, choice: 'Surrender, or fight six spears.', offer: null, attack: null };
    });
  const r2 = await t.engine.takeTurn({ gameId: t.game.id, input: 'I hide in my niche' });
  assert.equal(r2.status, 'committed', r2.error ?? '');
  assert.equal(r2.beat, 'The watch comes');
  assert.ok(!t.store.listScheduled(t.game.id, 'pending').some((i) => i.kind === 'consequence'));
  t.store.close();
});

test('a lord has others do it: an attack by his guards is a fight with the guards', async () => {
  const s = start({ roll: 0 });
  s.llm.enqueue('interpret', interp({ intents: ['start_conversation', 'speak'], target: { name: 'Sarai Tul', relationHint: null }, channel: 'in_person', spokenText: 'Take your ledger and choke on it.' }))
    .enqueue('npc_turn', npc({ dialogue: 'Teach him some manners.', attack: { intent: 'humiliate', threat: 3, how: 'two guards with cudgels', by: 'her two guards' } }));
  const r = await s.engine.takeTurn({ gameId: s.game.id, input: 'I insult the collector' });
  assert.match(r.text, /⚔ A fight begins — her two guards \(for Sarai Tul\)\.\n⚔ Exchange 1 · your guard vs her two guards \(for Sarai Tul\)'s/);
  assert.equal(s.char('Sarai Tul').status, 'alive');
  assert.ok(s.me().health >= 1);
  s.store.close();
});

test('stealing: clean, seen without knowing it, or caught', async () => {
  const steal = { action: 'steal', what: 'a purse of drams', from: 'a spice merchant', value: 12, kind: 'money', quality: 0, difficulty: 2 };
  const clean = start({ roll: 1 });
  const r1 = await clean.turn('I lift the merchant\'s purse', { intents: ['general_action'], minutesElapsed: 5, narration: '', actions: [steal] });
  assert.match(r1.text, /🤏 You take a purse of drams from a spice merchant and slip away \(\+dr 12\.00\)\./);
  assert.ok(!clean.store.listScheduled(clean.game.id, 'pending').some((i) => i.kind === 'consequence'));
  clean.store.close();

  const seen = start({ roll: 0.5 }); // partial: looks exactly the same to the player…
  const r2 = await seen.turn('I lift the merchant\'s purse', { intents: ['general_action'], minutesElapsed: 5, narration: '', actions: [steal] });
  assert.match(r2.text, /🤏 You take a purse of drams from a spice merchant and slip away/);
  assert.doesNotMatch(r2.text, /seen|caught/i);
  // …but someone saw, and it will come back.
  const c = seen.store.listScheduled(seen.game.id, 'pending').find((i) => i.kind === 'consequence')!;
  assert.match(String(c.payload.summary), /Someone saw Rhen steal a purse of drams .* thinks they got away clean/);
  seen.store.close();

  const caught = start({ roll: 0 });
  const r3 = await caught.turn('I lift the merchant\'s purse', { intents: ['general_action'], minutesElapsed: 5, narration: '', actions: [steal] });
  assert.match(r3.text, /✋ Caught trying to steal a purse of drams from a spice merchant\./);
  assert.equal(caught.store.getAccountOf(caught.game.id, 'character', caught.player.id)!.balanceCents, 3_000);
  caught.store.close();
});

test('deception and influence are rolled; the person acts on what the game decided', async () => {
  const s = start({ roll: 1 });
  s.llm.enqueue('interpret', interp({ intents: ['start_conversation', 'speak'], target: { name: 'Sarai Tul', relationHint: null }, channel: 'in_person', spokenText: 'House Varr already forgave my debt.',
    actions: [{ action: 'deceive', target: 'Sarai Tul', claim: 'House Varr already forgave my debt', difficulty: 4 }] }))
    .enqueue('npc_turn', npc({ dialogue: 'Then I will strike your name.' }));
  const r = await s.engine.takeTurn({ gameId: s.game.id, input: 'I lie to the collector' });
  assert.match(r.text, /🎭 Deception — "House Varr already forgave my debt": Sarai Tul believes you\./);
  assert.match(lastPrompt(s.llm, 'npc_turn'), /WHAT JUST HAPPENED[^\n]*\nRhen told you: "House Varr already forgave my debt"\. You BELIEVE it\./);
  assert.match(s.llm.callsFor('interpret')[0]!.system, /deceive: the player tries to make someone present believe something false[^\n]*when they mark it \("\(bluff\)", "I lie:", "minto:", "blefo:"[^\n]*even if they don't say "I lie"/);

  const t = start({ roll: 0 });
  t.llm.enqueue('interpret', interp({ intents: ['start_conversation', 'speak'], target: { name: 'Sarai Tul', relationHint: null }, channel: 'in_person', spokenText: 'Take this and forget my name.',
    actions: [{ action: 'influence', target: 'Sarai Tul', approach: 'bribe', goal: 'strike his debt from the ledger', difficulty: 5, bribe: 10 }] }))
    .enqueue('npc_turn', npc({ dialogue: 'Ten drams? Keep walking.' }));
  const r2 = await t.engine.takeTurn({ gameId: t.game.id, input: 'I bribe her' });
  assert.match(r2.text, /🗣 Bribe Sarai Tul \(strike his debt from the ledger\): Sarai Tul is not moved\./);
  assert.equal(t.store.getAccountOf(t.game.id, 'character', t.player.id)!.balanceCents, 2_000); // the bribe is paid either way
  s.store.close();
  t.store.close();
});

test('deeds people saw come back secretly; nobody saw, nothing happens', async () => {
  const s = start();
  s.llm.enqueue('interpret', interp({ intents: ['start_conversation', 'speak'], target: { name: 'Kesh Adar', relationHint: null }, channel: 'in_person', spokenText: 'I slept with your wife.',
    deeds: [{ what: 'told Kesh Adar he had slept with his wife and called him a coward', against: 'Kesh Adar', severity: 5, tone: 'harm', exposure: 'public' }] }))
    .enqueue('npc_turn', npc({ dialogue: 'You will regret that.' }));
  const r = await s.engine.takeTurn({ gameId: s.game.id, input: 'I insult Kesh' });
  assert.doesNotMatch(r.text, /consequence|revenge/i); // the player is not told
  const c = s.store.listScheduled(s.game.id, 'pending').find((i) => i.kind === 'consequence')!;
  assert.match(String(c.payload.summary), /Rhen told Kesh Adar he had slept with his wife and called him a coward \(to Kesh Adar\) at .* — seen by Kesh Adar(, someone Rhen did not notice)?\. Someone who saw it, or was wronged, acts on it/);
  assert.match(s.llm.callsFor('interpret')[0]!.system, /deeds: socially significant things Rhen does or says THIS turn/);

  const q = start();
  await q.turn('I mutter an insult about the house', { intents: ['general_action'], minutesElapsed: 1, narration: '',
    deeds: [{ what: 'cursed House Varr under his breath', against: null, severity: 1, tone: 'harm', exposure: 'private' }] });
  assert.ok(!q.store.listScheduled(q.game.id, 'pending').some((i) => i.kind === 'consequence'));
  s.store.close();
  q.store.close();
});

test('the character sheet, XP rolls, levelling up and spending points', async () => {
  const s = start({ roll: 1 });
  const sheet = () => adventurePack.commands!.sheet!.run(s.store, s.game.id, [], 'en');
  assert.match(sheet(), /^══ RHEN — Level 1 · XP 0\/100 ══\nHealth 100\/100\n\nATTRIBUTES  strength ●●●○○   agility ●●●○○   wits ●●○○○   presence ●●○○○\nSKILLS\n  combat         ●●○○○/);
  assert.match(sheet(), /deception +●○○○○/);
  assert.match(sheet(), /AMBITION  to become a warrior whose name is known across the known worlds/);
  // Two big wins → level 2 (XP is rolled: base × 0.75–1.25).
  for (const foe of ['a pit veteran', 'a house sellsword']) {
    await s.turn(`I fight ${foe}`, { intents: ['general_action'], minutesElapsed: 1, narration: '', actions: [fight(foe, { threat: 4, intent: 'duel', witnessed: true })] });
    await fightOn(s, 'strong');
  }
  assert.equal(s.me().level, 2);
  assert.equal(s.me().points, 1);
  assert.equal(s.me().maxHealth, 105);
  assert.match(s.store.lastTurn(s.game.id)!.response!.text, /⬆ LEVEL 2! \+1 point to spend/);
  assert.equal(adventurePack.commands!.spend!.run(s.store, s.game.id, ['strength'], 'en'), 'You have 1 point; strength costs 3.');
  assert.equal(adventurePack.commands!.spend!.run(s.store, s.game.id, ['furtividade'], 'pt'), '✓ stealth → 2 · 0 points left');
  assert.match(adventurePack.commands!.sheet!.run(s.store, s.game.id, [], 'pt'), /^══ RHEN — Nível 2[\s\S]*ATRIBUTOS  força ●●●○○[\s\S]*furtividade +●●○○○/);
  s.store.close();
});

test('unseen ears: nobody in the scene, but someone may have overheard — likelier the more exposed the place', async () => {
  const deed = (exposure: 'private' | 'semi_public' | 'public') => ({ what: 'boasted of robbing a House Varr courier', against: null, severity: 5, tone: 'harm' as const, exposure });
  const heard = start({ roll: 0 }); // the overheard roll comes in under even the private chance
  await heard.turn('I boast to myself', { intents: ['general_action'], minutesElapsed: 1, narration: '', deeds: [deed('private')] });
  const c = heard.store.listScheduled(heard.game.id, 'pending').find((i) => i.kind === 'consequence')!;
  assert.match(String(c.payload.summary), /— seen by someone Rhen did not notice\./);
  heard.store.close();
  const alone = start({ roll: 0.5 }); // 0.5 ≥ 0.05 (private) — nobody heard
  await alone.turn('I boast to myself', { intents: ['general_action'], minutesElapsed: 1, narration: '', deeds: [deed('private')] });
  assert.ok(!alone.store.listScheduled(alone.game.id, 'pending').some((i) => i.kind === 'consequence'));
  alone.store.close();
  const crowd = start({ roll: 0.5 }); // 0.5 < 0.6 (public) — in a crowd, someone heard
  await crowd.turn('I boast in the market', { intents: ['general_action'], minutesElapsed: 1, narration: '', deeds: [deed('public')] });
  assert.ok(crowd.store.listScheduled(crowd.game.id, 'pending').some((i) => i.kind === 'consequence'));
  crowd.store.close();
});

test('health comes from the body: 70 + strength × 10, +5 per level; more strength, more health', () => {
  const s = start();
  assert.equal(s.me().maxHealth, 100); // Rhen, strength 3
  const p = s.me();
  advRepo.saveProfile(s.store, { ...p, points: 3 });
  assert.equal(adventurePack.commands!.spend!.run(s.store, s.game.id, ['strength'], 'en'), '✓ strength → 4 · 0 points left');
  assert.deepEqual([s.me().maxHealth, s.me().health], [110, 110]);
  s.store.close();
});

test('playtest replay: sparring with Oda leaves bruises, not surgeon-grade wounds; treatment heals; no phones; the narrator stays where the player is', async () => {
  const s = start({ roll: 0.1, narrator: true });
  const round = (n: number) => interp({ intents: ['start_conversation', 'speak'], target: { name: 'Oda Venn', relationHint: null }, channel: 'in_person', spokenText: `Round ${n}.`,
    actions: [fight('Oda Venn', { intent: 'spar', weaponName: null, style: 'defensive', move: 'quick' })] });
  for (let i = 1; i <= 3; i++) {
    s.llm.enqueue('interpret', round(i)).enqueue('npc_turn', npc({ dialogue: 'Again.' })).enqueue('narrate', { prose: 'Oda circles. "Again."', suggestions: [], lines: [] });
    const r = await s.engine.takeTurn({ gameId: s.game.id, input: `round ${i}` });
    assert.equal(r.status, 'committed', r.error ?? '');
    assert.match(r.text, new RegExp(`⚔ Exchange ${i} · your quick attack vs Oda Venn's guard: Oda Venn blocks and counters`));
    assert.match(r.text, /\[you 3 \(combat 2, strength \+0\.5, bare hands \+0, padded desert coat \+0\.5\)/); // bare hands, as the player said
    assert.doesNotMatch(r.text, /cut to|deep wound|grievous/);
  }
  assert.match(s.store.lastTurn(s.game.id)!.response!.text, /⚔ The fight is over: the sparring is over/);
  assert.ok(s.me().health >= 70, `health ${s.me().health}`); // three rounds of practice, not a knife fight
  assert.ok(s.me().injuries.every((i) => /bruise|blow/.test(i.text)));
  assert.ok(!s.store.listScheduled(s.game.id, 'pending').some((i) => i.kind === 'consequence')); // sparring answers to no one
  assert.equal(s.me().fame, 1);
  // Everyone knows who Oda is: the narrator is told her gender, the place, and not to move the player.
  const narr = s.llm.callsFor('narrate').at(-1)!;
  assert.match(narr.user, /PEOPLE HERE: Oda Venn \(pit trainer in the Cisterns quarter, female\)/);
  assert.match(narr.user, /WHERE THE READER IS AT THE END: /);
  assert.match(narr.system, /Never move the reader or let time pass beyond THE FACTS/);
  assert.match(s.llm.callsFor('interpret')[0]!.system, /if the world has none, never use phone/);
  assert.match(s.llm.callsFor('interpret')[0]!.system, /"I ask X, then I go home"\) does both this turn/);

  // A real knife cut, then a surgeon.
  s.llm.enqueue('interpret', interp({ intents: ['general_action'], minutesElapsed: 1, narration: '', actions: [fight('a knife-man in the alley', { threat: 3, intent: 'drive_off' })] }),
    interp({ intents: ['general_action'], minutesElapsed: 1, narration: '', actions: [move('yield')] }))
    .enqueue('narrate', { prose: 'Steel flashes in the dark alley.', suggestions: [], lines: [] }, { prose: 'You drop the knife; he spits and is gone.', suggestions: [], lines: [] });
  await s.engine.takeTurn({ gameId: s.game.id, input: 'I fight him off' });
  await s.engine.takeTurn({ gameId: s.game.id, input: 'I yield' });
  const hurtBefore = s.me().health;
  s.llm.enqueue('interpret', interp({ intents: ['general_action'], minutesElapsed: 60, narration: '', actions: [{ action: 'get_treatment', healer: 'the House surgeon', skill: 4, hours: 1 }] }))
    .enqueue('narrate', { prose: 'Needle and thread, and the smell of vinegar.', suggestions: [], lines: [] });
  const t = await s.engine.takeTurn({ gameId: s.game.id, input: 'the surgeon stitches me' });
  assert.equal(t.status, 'committed', t.error ?? '');
  assert.match(t.text, new RegExp(`🩹 Treated by the House surgeon: health ${hurtBefore} → ${Math.min(100, hurtBefore + 22)}`));
  assert.ok(s.me().injuries.every((i) => i.severity === 'light'));
  s.store.close();
});

test('someone named by a role gets a real name; fists bruise', async () => {
  const s = start({ roll: 0 });
  assert.match((await import('../src/engine/prompts.ts')).generateSystemPrompt({ line: 'x', rules: [], homes: 'x', background: null, violence: 'graphic', language: 'English' }),
    /If what was requested is a role or label rather than a name \("the surgeon", "o cirurgião"/);
  s.llm.enqueue('interpret', interp({ intents: ['start_conversation', 'speak'], target: { name: 'Kesh Adar', relationHint: null }, channel: 'in_person', spokenText: 'Coward.' }))
    .enqueue('npc_turn', npc({ dialogue: 'Say it again.', attack: { intent: 'hurt', threat: 3, how: 'a fist to the jaw', by: null } }));
  const r = await s.engine.takeTurn({ gameId: s.game.id, input: 'I insult Kesh' });
  assert.match(r.text, /⚔ Exchange 1 · your guard vs Kesh Adar's heavy attack: Kesh Adar lands a heavy blow — a bruise on the/);
  s.store.close();
});

test('playtest replay: at the surgeon\'s, talking to him is face to face — never a phone call', async () => {
  const s = start();
  const surgeon = {
    name: 'Nadir Hasel', age: 50, gender: 'male', role: 'cirurgião da Casa Varr', occupation: 'surgeon', background: 'Twenty years stitching pit fighters for House Varr.',
    personality: 'Dry, precise, unhurried with patients.', traits: ['precise', 'dry'], values: ['craft'], goals: ['Keep the House fighters alive'], fears: ['Losing a patient the House cares about'],
    location: 'Ashkar', relationshipToPlayer: 'A new patient on a House credit.',
  };
  // The interpreter does not say how (channel null) — the player is simply talking to the man in front of him.
  s.llm.enqueue('interpret', interp({ intents: ['start_conversation', 'speak'], target: { name: 'Cirurgião', relationHint: 'surgeon' }, channel: null, spokenText: 'When can I train again?',
    newLocation: 'House surgeon — treatment room', newSceneDescription: 'Clean instruments on a tray.' }))
    .enqueue('generate_character', surgeon)
    .enqueue('npc_turn', npc({ dialogue: 'Not for two days.' }));
  const r = await s.engine.takeTurn({ gameId: s.game.id, input: 'pergunto quando posso treinar' });
  assert.equal(r.status, 'committed', r.error ?? '');
  const scene = s.store.getScene(s.game.id);
  assert.equal(s.store.getInteraction(scene.interactionId!)!.channel, 'in_person');
  assert.match(formatStatusLine(s.store, s.game.id), /· with Nadir ──$/);
  assert.match(s.llm.callsFor('npc_turn')[0]!.system, /Never invent new facts about them \(a hidden fragment, poison/);
  s.store.close();
});

test('playtest replay: looking for "an older student" — the narrator introduces the stranger, the persuasion reaches him, `--lang pt` is Portuguese', async () => {
  const store = new Store(tmpDbPath());
  const llm = new ScriptedProvider();
  const engine = new Engine(store, llm, { pack: adventurePack, rng: fixedRng(1), beats: false, narrator: true });
  const { game } = engine.newGame({ language: 'pt' });
  assert.match(formatStatusLine(store, game.id), /^── qui\., 11 de mar\., /); // the interface is Portuguese too
  const student = {
    name: 'Tomas Venn', age: 19, gender: 'male', role: 'older student', occupation: 'student', background: 'Third year, passed admissions twice.',
    personality: 'Easy smile, books under his arm, likes to sound wise.', traits: ['friendly', 'vain'], values: ['learning'], goals: ['Pass his exams'], fears: ['Failing'],
    location: 'Ashkar', relationshipToPlayer: 'A stranger.',
  };
  llm.enqueue('interpret', interp({ intents: ['start_conversation', 'speak'], target: { name: 'um estudante mais velho', relationHint: 'someone who knows the admissions' }, channel: 'in_person',
    spokenText: 'Dizem que os Mestres adoram perguntas difíceis...',
    actions: [{ action: 'influence', target: 'o estudante mais velho', approach: 'charm', goal: 'get tips about admissions without asking', difficulty: 2, bribe: null }] }))
    .enqueue('generate_character', student)
    .enqueue('npc_turn', npc({ dialogue: 'Às vezes querem saber se você admite que não sabe.' }))
    .enqueue('narrate', (req: { user: string }) => ({ prose: 'Um rapaz de terceiro ano, livros debaixo do braço, para ao seu lado. «Às vezes querem saber se você admite que não sabe.»', suggestions: [],
      lines: [...req.user.matchAll(/^\d+\. (.*)$/gm)].map((m) => m[1]!) }));
  const r = await engine.takeTurn({ gameId: game.id, input: 'procuro alguém que dê dicas sem perguntar' });
  assert.equal(r.status, 'committed', r.error ?? '');
  assert.match(r.results.join('\n'), /🗣 Charm Tomas Venn \(get tips about admissions without asking\): Tomas Venn is won over/); // the label meant him
  const narr = llm.callsFor('narrate').at(-1)!;
  assert.match(narr.user, /MET FOR THE FIRST TIME THIS TURN \(the reader has never seen them before\):\n- Tomas Venn \(older student, male\) — Easy smile/);
  assert.match(narr.system, /Never write as if a conversation were already under way\. The reader learns their name only when it is given/);
  store.close();
});


test('playtest replay: "1 jot now, 1 when we finish" — the deal pays what it says, the rest is a promise, kept promises pay; endings are in the player\'s language', async () => {
  const s = start({ beats: true });
  const quiet = () => interp({ intents: ['general_action'], minutesElapsed: 20, narration: 'You wait.' });
  s.llm.enqueue('interpret', quiet(), quiet())
    .enqueue('scene_beat', { kind: 'opportunity', title: 'Lessa wants a lesson', perceived: 'A girl with two coins asks for an hour of training.', involves: ['Oda Venn'], newPerson: null,
      opensConversation: { name: 'Oda Venn', channel: 'in_person', openingLine: 'An hour of your time. One dram now, one when we finish.' }, choice: 'Take it or not.',
      offer: { kind: 'deal', label: 'an hour of training', terms: [{ key: 'price_offerer_pays', value: 1 }, { key: 'price_offerer_pays_later', value: 1 }], description: 'Oda pays 1 now and 1 when the hour is done' } });
  await s.engine.takeTurn({ gameId: s.game.id, input: 'I wait' });
  const r = await s.engine.takeTurn({ gameId: s.game.id, input: 'I keep waiting' });
  assert.match(r.text, /→ Oda Venn offers you: an hour of training for dr 1\.00 now \+ dr 1\.00 when done/);
  const offer = s.store.listOffers(s.game.id).find((o) => o.fromCharacterId === s.char('Oda Venn').id)!;
  s.llm.enqueue('interpret', interp({ intents: ['speak'], target: { name: 'Oda Venn', relationHint: null }, spokenText: 'Deal.', actions: [{ action: 'respond_to_offer', offerId: offer.id, accept: true }] }))
    .enqueue('npc_turn', npc({ dialogue: 'Then show me.' }));
  const acc = await s.engine.takeTurn({ gameId: s.game.id, input: 'Deal' });
  assert.match(acc.text, /✓ Deal: an hour of training — Oda Venn paid Rhen dr 1\.00/); // the ledger is in the result: the story can't contradict it
  assert.match(acc.text, /✓ Promise recorded — Oda Venn → Rhen: the rest of the payment for: an hour of training \(dr 1\.00\)/);
  assert.equal(s.store.getAccountOf(s.game.id, 'character', s.player.id)!.balanceCents, 3_100);
  const promise = s.store.listObligations(s.game.id).find((o) => o.debtorId === s.char('Oda Venn').id)!;
  s.llm.enqueue('interpret', interp({ intents: ['speak'], target: { name: 'Oda Venn', relationHint: null }, spokenText: 'Hour\'s up.' }))
    .enqueue('npc_turn', npc({ dialogue: 'Here.', changes: [{ op: 'fulfill_promise', promiseId: promise.id }], endsConversation: true }));
  const paid = await s.engine.takeTurn({ gameId: s.game.id, input: 'the hour is up' });
  assert.match(paid.text, /✓ Promise kept — Oda Venn → Rhen: .* \(dr 1\.00 paid\)/);
  assert.equal(s.store.getAccountOf(s.game.id, 'character', s.player.id)!.balanceCents, 3_200); // a kept promise of money is paid
  assert.match(paid.text, /\[The conversation has ended\.\]/);
  s.store.close();

  const pt = new Store(tmpDbPath());
  const llm = new ScriptedProvider();
  const engine = new Engine(pt, llm, { pack: adventurePack, rng: fixedRng(0.5), beats: false, narrator: false });
  const { game } = engine.newGame({ language: 'pt' });
  llm.enqueue('interpret', interp({ intents: ['start_conversation', 'speak'], target: { name: 'Oda Venn', relationHint: null }, channel: 'in_person', spokenText: 'Tchau.' }))
    .enqueue('npc_turn', npc({ dialogue: 'Vai.', endsConversation: true }));
  assert.match((await engine.takeTurn({ gameId: game.id, input: 'tchau' })).text, /\[A conversa terminou\.\]/);
  pt.close();
});

test('the game master answers out of character: from what the player knows and the rules; the story does not move', async () => {
  const store = new Store(tmpDbPath());
  const llm = new ScriptedProvider();
  const engine = new Engine(store, llm, { pack: adventurePack, rng: fixedRng(0.5), beats: false, narrator: false });
  const { game } = engine.newGame({ language: 'pt' });
  llm.enqueue('interpret', interp({ intents: ['general_action'], minutesElapsed: 2, narration: 'Você sussurra para a pedra.',
    actions: [{ action: 'attempt', feat: 'speak the name of the stone', skill: 'arcana', difficulty: 5, risk: 'none' }] }));
  await engine.takeTurn({ gameId: game.id, input: 'sussurro o nome da pedra' });
  const before = store.getGame(game.id)!;

  // "? …" goes straight to the game master.
  llm.enqueue('game_master', (req: { system: string; user: string }) => {
    assert.match(req.user, /^THE PLAYER ASKS: a pedra se desfez\?/);
    assert.match(req.user, /THE LAST MOMENTS OF PLAY \(what the player typed and read\):\n> sussurro o nome da pedra\nVocê sussurra para a pedra\.\n🎲 speak the name of the stone/);
    assert.match(req.user, /Attributes \(1–5\), level and skills/); // the character sheet
    assert.match(req.system, /HOW THE GAME WORKS:\n- The character has four attributes/);
    assert.match(req.system, /Never reveal what the character cannot know/);
    assert.match(req.system, /LANGUAGE: the player plays in Brazilian Portuguese/);
    return { answer: 'Não. A pedra continua inteira; nada visível aconteceu com ela.' };
  });
  const r = await engine.takeTurn({ gameId: game.id, input: '? a pedra se desfez?' });
  assert.equal(r.text, '🎲 Mestre do jogo: Não. A pedra continua inteira; nada visível aconteceu com ela.');
  assert.equal(llm.callsFor('interpret').length, 1); // no interpretation: it isn't a move in the story
  const after = store.getGame(game.id)!;
  assert.deepEqual([after.gameTime, after.revision], [before.gameTime, before.revision]); // nothing happened, no time passed

  // Asked inside a normal message: the interpreter recognises it and hands it over.
  llm.enqueue('interpret', interp({ intents: ['general_action'], gameMasterQuestion: 'quanto de vida eu tenho?' }))
    .enqueue('game_master', { answer: 'Você está com 100 de 100.' });
  const r2 = await engine.takeTurn({ gameId: game.id, input: 'pergunto ao narrador: quanto de vida eu tenho?' });
  assert.equal(r2.text, '🎲 Mestre do jogo: Você está com 100 de 100.');
  assert.equal(store.getGame(game.id)!.revision, before.revision);
  assert.match(llm.callsFor('interpret').at(-1)!.system, /gameMasterQuestion: when the player steps OUT of the story/);
  store.close();
});

test('recollections: the player writes the past as they play — details are free, training and old acquaintances cost, nothing makes a master', async () => {
  const s = start({ roll: 0.5 });
  const recall = (r: Record<string, unknown>) => ({ action: 'recall', memory: 'x', kind: 'detail', skill: null, acquaintance: null, conflict: null, ...r });
  const play = (actions: unknown[]) => s.turn('I remember', { intents: ['private_thought'], minutesElapsed: 0, narration: '', actions: actions as never });

  let r = await play([recall({ memory: 'My mother sang to the water-carriers at dawn' })]);
  assert.match(r.text, /🕯 Recollection: My mother sang to the water-carriers at dawn$/m); // a detail is free
  r = await play([recall({ memory: 'An old thief taught me to move without a sound', kind: 'training', skill: 'stealth' })]);
  assert.match(r.text, /🕯 Recollection: An old thief taught me to move without a sound — stealth 1 → 2 · 2 recollections left/);
  r = await play([recall({ memory: 'He taught me even more', kind: 'training', skill: 'stealth' })]);
  assert.match(r.text, /✗ a memory can teach the basics, not more — stealth is already 2\. It grows by training and use\./); // never mastery
  r = await play([recall({ memory: 'I ran errands for a fence in the Cisterns', kind: 'acquaintance', acquaintance: { name: 'Maren Dask', role: 'a fence', where: 'a back room in the Cisterns quarter' } })]);
  assert.match(r.text, /🕯 Recollection: .* — Maren Dask, a fence \(a back room in the Cisterns quarter\) — Rhen owes them something — or they will want something · 1 recollection left/);
  r = await play([recall({ memory: 'A scribe taught me letters', kind: 'training', skill: 'lore' }), recall({ memory: 'and sums', kind: 'training', skill: 'lore' })]);
  assert.match(r.text, /lore 0 → 1 · 0 recollections left/);
  assert.match(r.text, /✗ One recollection at a time\./);
  r = await play([recall({ memory: 'A hunter taught me tracking', kind: 'training', skill: 'survival' })]);
  assert.match(r.text, /✗ No recollections left \(3 used\)\. Level up to earn more — or live it now\./);
  r = await play([recall({ memory: 'My father left me a sword of House Varr steel', conflict: 'memory puts nothing in his pocket' })]);
  assert.match(r.text, /✗ That can't be part of Rhen's past: memory puts nothing in his pocket/);
  assert.deepEqual([s.me().skills.stealth!.level, s.me().skills.lore!.level, s.me().skills.survival!.level], [2, 1, 1]);
  assert.match(adventurePack.commands!.sheet!.run(s.store, s.game.id, [], 'en'), /RECOLLECTIONS  0 left[\s\S]*🕯 My mother sang[\s\S]*🕯 Maren Dask — a fence — a back room/);
  assert.match(s.llm.callsFor('interpret')[0]!.system, /recall: Rhen's player invents a piece of Rhen's PAST/);

  // Meeting her: she is who he remembered, complication included.
  s.llm.enqueue('interpret', interp({ intents: ['start_conversation', 'speak'], target: { name: 'Maren Dask', relationHint: null }, channel: 'in_person', spokenText: 'Maren.' }))
    .enqueue('generate_character', (req: { user: string }) => {
      assert.match(req.user, /What Rhen knows: a fence — a back room in the Cisterns quarter\. Knew Rhen in the past .* Rhen owes them something/);
      return { name: 'Maren Dask', age: 44, gender: 'female', role: 'fence', occupation: 'fence', background: 'Buys what the lower city steals.', personality: 'Patient, greedy, remembers every favour.',
        traits: ['patient', 'greedy'], values: ['profit'], goals: ['Collect what she is owed'], fears: ['The watch'], location: 'Ashkar', relationshipToPlayer: 'The boy who ran her errands — and still owes her.' };
    })
    .enqueue('npc_turn', npc({ dialogue: 'Well. Look who remembers me.' }));
  const meet = await s.engine.takeTurn({ gameId: s.game.id, input: 'I find Maren' });
  assert.equal(meet.status, 'committed', meet.error ?? '');
  s.store.close();
});
