// The Adventure pack and the storyteller: fights, wounds, death, skills, gear, fame;
// scene beats that bring the world to the player; a narrator that writes decided turns as prose.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db/store.ts';
import type { Trace } from '../src/engine/trace.ts';
import { Engine } from '../src/engine/turn.ts';
import { formatStatusLine } from '../src/debug/inspect.ts';
import { ScriptedProvider } from '../src/llm/scripted.ts';
import { adventurePack } from '../src/packs/adventure/index.ts';
import { advRepo } from '../src/packs/adventure/state.ts';
import { fixedRng, interp, lastPrompt, npc, tmpDbPath } from './helpers.ts';

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
  ({ action: 'fight', opponent, threat: 3, intent: 'kill', weaponName: 'curved knife', witnessed: true, ...extra });

test('the example world: a fighter with skills, gear, fame, a debt and people who matter', () => {
  const s = start();
  assert.match(s.opening, /^Ashkar, the pit-city of Qasr — Thursday, 11 March 94, 05:40/);
  assert.match(s.opening, /Your share of the water tithe is due within days/);
  const p = s.me();
  assert.deepEqual([p.health, p.skills.combat!.level, p.skills.athletics!.level, p.fame], [100, 2, 2, 1]);
  assert.deepEqual(advRepo.items(s.store, s.game.id).map((i) => `${i.name}/${i.kind}/${i.quality}`), ['curved knife/weapon/1', 'padded desert coat/armor/0']);
  assert.deepEqual(s.store.listCharacters(s.game.id).map((c) => c.name).sort(), ['Kesh Adar', 'Oda Venn', 'Rhen', 'Sarai Tul']);
  assert.match(formatStatusLine(s.store, s.game.id), /❤ 100\/100 · ⚔ combat 2 · ★ a few people know your name/);
  s.store.close();
});

test('fights are decided by the engine: skill, gear, a bounded roll; a killed person is dead for good', async () => {
  // Roll 1 (+5): 2 combat + knife 2 + coat 0.5 vs Kesh 3 + 1.5 → margin +5 → decisive.
  const s = start({ roll: 1 });
  const r = await s.turn('I draw my knife and go for Kesh\'s throat', { intents: ['general_action'], minutesElapsed: 2, narration: 'Steel.',
    actions: [fight('Kesh Adar')] });
  assert.match(r.text, /⚔ Fight — Kesh Adar: decisive victory\. Kesh Adar is dead\. You took a cut to the leg \(−6; 94\/100\)\. · fame \+2 \(known around here\)/);
  assert.deepEqual(s.me().skills.combat, { level: 2, practice: 2 }); // practice toward level 3
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
  s.store.close();
});

test('losing hurts, and the player is never killed by a single roll', async () => {
  const s = start({ roll: 0 }); // roll −5 and minimum damage rolls
  const r = await s.turn('I pick a fight with the house guards', { intents: ['general_action'], minutesElapsed: 2, narration: '',
    actions: [fight('three house guards in lamellar armour', { threat: 5, intent: 'drive_off' })] });
  assert.match(r.text, /⚔ Fight — three house guards in lamellar armour: crushing defeat\. Three house guards in lamellar armour beats you down completely — you are at their mercy\. You took a grievous wound to the left arm \(−40; 60\/100\)\./);
  for (let i = 0; i < 3; i++) {
    await s.turn('again', { intents: ['general_action'], minutesElapsed: 2, narration: '', actions: [fight('three house guards in lamellar armour', { threat: 5, intent: 'drive_off', witnessed: false })] });
  }
  assert.equal(s.me().health, 1);
  assert.match(formatStatusLine(s.store, s.game.id), /❤ 1\/100/);
  s.store.close();
});

test('whoever is in the scene witnesses the fight: the NPC\'s reaction must be consistent with what the engine decided', async () => {
  const s = start({ roll: 1 });
  s.llm.enqueue('interpret', interp({ intents: ['start_conversation', 'speak'], target: { name: 'Oda Venn', relationHint: null }, channel: 'in_person', spokenText: 'Watch this.',
    actions: [fight('a drunk dock thug', { threat: 1, intent: 'subdue' })] }))
    .enqueue('npc_turn', npc({ dialogue: 'Not bad. Come at dawn.' }));
  await s.engine.takeTurn({ gameId: s.game.id, input: 'I floor a thug in front of Oda' });
  assert.match(lastPrompt(s.llm, 'npc_turn'), /WHAT JUST HAPPENED \(decided by the game — your reaction must be consistent with it\)\nRhen fought a drunk dock thug \(subdue, with curved knife\): decisive victory; a drunk dock thug is beaten and at your mercy/);
  assert.match(lastPrompt(s.llm, 'npc_turn'), /What people say about Rhen: a few people know your name — beat a drunk dock thug in front of witnesses/);
  s.store.close();
});

test('feats, rest, training and gear', async () => {
  const s = start({ roll: 0.5 });
  const climb = await s.turn('I climb the cistern wall', { intents: ['general_action'], minutesElapsed: 10, narration: '',
    actions: [{ action: 'attempt', feat: 'climb the cistern wall at night', skill: 'athletics', difficulty: 2, risk: 'injury' }] });
  assert.match(climb.text, /🎲 climb the cistern wall at night \(athletics, difficulty 2\): partly — it works, but not cleanly\. You took a cut to the/);
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
