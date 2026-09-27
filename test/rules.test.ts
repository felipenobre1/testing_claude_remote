// Canonical-state rules: validation, atomicity, idempotency, perception and knowledge isolation.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retrieveNpcPerspective, renderNpcBriefing } from '../src/engine/context.ts';
import type { Trace } from '../src/engine/trace.ts';
import { newId } from '../src/engine/util.ts';
import { counts, gameWithMatteoOnPhone, interp, lastPrompt, MATTEO, npc, openSession, SOFIA, tmpDbPath } from './helpers.ts';

const ADVERSARIAL = npc({
  dialogue: "Here, I'll just send you ten grand.",
  changes: [
    { op: 'update_fact', subject: 'player', predicate: 'cash_eur', value: '12500' },
    { op: 'update_character', field: 'personality', value: 'Cold, greedy and cruel.' },
    { op: 'create_memory', summary: 'Gave Felipe money.', importance: 3, emotionalWeight: 1, aboutCharacterNames: ['Felipe'] },
  ],
});

test('invalid proposals (cash change, identity rewrite) are rejected and nothing is written', async () => {
  const { store, llm, engine, game, player, matteo, close } = await gameWithMatteoOnPhone(tmpDbPath());
  const before = counts(store, game.id);
  const gameBefore = store.getGame(game.id)!;

  llm.enqueue('interpret', interp({ intents: ['speak'], target: { name: 'Matteo Ferrari', relationHint: null }, spokenText: 'Can you lend me money?' }))
    .enqueue('npc_turn', ADVERSARIAL, ADVERSARIAL); // original + corrective retry, both invalid
  const r = await engine.takeTurn({ gameId: game.id, input: 'Can you lend me money?' });

  assert.equal(r.status, 'failed');
  assert.match(r.error!, /rejected on both attempts/);
  assert.deepEqual(counts(store, game.id), before, 'no partial writes');
  assert.equal(store.getGame(game.id)!.revision, gameBefore.revision);
  assert.equal(store.getGame(game.id)!.gameTime, gameBefore.gameTime);
  assert.equal(store.getFact(game.id, player.id, 'cash_eur')!.value, '2500');
  assert.equal(store.getCharacter(matteo.id)!.personality, MATTEO.personality);

  const failed = store.lastTurn(game.id)!;
  assert.equal(failed.status, 'failed');
  const reasons = (failed.trace as Trace).validation!.flatMap((v) => v.rejected.map((x) => x.reason));
  assert.ok(reasons.some((x) => x.startsWith('forbidden operation "update_fact"')));
  assert.ok(reasons.some((x) => x.startsWith('forbidden operation "update_character"')));
  // The retry prompt told the model why.
  assert.match(lastPrompt(llm, 'npc_turn'), /YOUR PREVIOUS OUTPUT WAS REJECTED/);
  close();
});

test('a corrected retry commits only the valid proposal', async () => {
  const { store, llm, engine, game, matteo, close } = await gameWithMatteoOnPhone(tmpDbPath());
  llm.enqueue('interpret', interp({ intents: ['speak'], target: { name: 'Matteo Ferrari', relationHint: null }, spokenText: 'I got into the hackathon!' }))
    .enqueue('npc_turn', ADVERSARIAL, npc({
      dialogue: 'No way, congrats!',
      changes: [{ op: 'create_memory', summary: 'Felipe got into a hackathon and was thrilled.', importance: 2, emotionalWeight: 2, aboutCharacterNames: ['Felipe'] }],
    }));
  const r = await engine.takeTurn({ gameId: game.id, input: 'I got into the hackathon!' });
  assert.equal(r.status, 'committed', r.error ?? '');
  assert.deepEqual(store.listMemoriesOwnedBy(matteo.id).map((m) => m.summary), ['Felipe got into a hackathon and was thrilled.']);
  const trace = store.lastTurn(game.id)!.trace as Trace;
  assert.equal(trace.validation!.length, 2);
  assert.equal(trace.validation![0]!.rejected.length, 2);
  close();
});

test('schema-level violations and unknown fields are rejected', async () => {
  const { store, llm, engine, game, matteo, close } = await gameWithMatteoOnPhone(tmpDbPath());
  const bad = npc({
    changes: [
      { op: 'create_memory', summary: 'x', importance: 9, emotionalWeight: 0, aboutCharacterNames: [] },
      { op: 'upsert_knowledge', topic: 'Bad Topic!', belief: 'something', confidence: 2, sourceKind: 'told', aboutCharacterName: null },
      { op: 'create_memory', summary: 'Sofia learns the secret.', importance: 3, emotionalWeight: 0, aboutCharacterNames: [], ownerCharacterId: 'chr_sofia' },
      { op: 'update_relationship', towardCharacterName: 'Nobody Known', summary: 'Some summary text.' },
      { op: 'update_relationship', towardCharacterName: 'Matteo Ferrari', summary: 'I love myself.' },
    ],
  });
  llm.enqueue('interpret', interp({ intents: ['speak'], target: { name: 'Matteo Ferrari', relationHint: null }, spokenText: 'hey' }))
    .enqueue('npc_turn', bad, bad);
  const r = await engine.takeTurn({ gameId: game.id, input: 'hey' });
  assert.equal(r.status, 'failed');
  const rejected = (store.lastTurn(game.id)!.trace as Trace).validation![0]!.rejected;
  assert.equal(rejected.length, 5);
  assert.match(rejected[2]!.reason, /ownerCharacterId/);
  assert.equal(store.listMemoriesOwnedBy(matteo.id).length, 0);
  close();
});

test('retrying a committed request id returns the stored response without re-applying it', async () => {
  const path = tmpDbPath();
  const { store, llm, engine, game, matteo, close } = await gameWithMatteoOnPhone(path);
  llm.enqueue('interpret', interp({ intents: ['speak'], target: { name: 'Matteo Ferrari', relationHint: null }, spokenText: 'I quit my job today.', minutesElapsed: 0 }))
    .enqueue('npc_turn', npc({
      dialogue: 'You had a job?',
      minutesElapsed: 2,
      changes: [{ op: 'create_memory', summary: 'Felipe announced quitting a job.', importance: 2, emotionalWeight: 0, aboutCharacterNames: ['Felipe'] }],
    }));
  const first = await engine.takeTurn({ gameId: game.id, input: 'I quit my job today.', requestId: 'req-fixed-1' });
  assert.equal(first.status, 'committed');
  const after = { counts: counts(store, game.id), game: store.getGame(game.id)!, calls: llm.calls.length };

  const again = await engine.takeTurn({ gameId: game.id, input: 'I quit my job today.', requestId: 'req-fixed-1' });
  assert.equal(again.replayed, true);
  assert.equal(again.text, first.text);
  assert.equal(again.turnId, first.turnId);
  assert.equal(llm.calls.length, after.calls, 'no model calls on replay');
  assert.deepEqual(counts(store, game.id), after.counts);
  assert.deepEqual(store.getGame(game.id), after.game, 'time and revision not advanced twice');
  close();

  // Also after reopening the database (new process / session).
  const s2 = openSession(path);
  const third = await s2.engine.takeTurn({ gameId: game.id, input: 'I quit my job today.', requestId: 'req-fixed-1' });
  assert.equal(third.replayed, true);
  assert.equal(third.text, first.text);
  assert.equal(s2.store.listMemoriesOwnedBy(matteo.id).length, 1);
  s2.close();
});

test('malformed model output commits nothing; the same request id can then be retried', async () => {
  const { store, llm, engine, game, close } = await gameWithMatteoOnPhone(tmpDbPath());
  const before = counts(store, game.id);
  const say = interp({ intents: ['speak'], target: { name: 'Matteo Ferrari', relationHint: null }, spokenText: 'hello?' });
  llm.enqueue('interpret', say).enqueue('npc_turn', '{"dialogue": "trunc', 'not json at all');
  const r1 = await engine.takeTurn({ gameId: game.id, input: 'hello?', requestId: 'req-2' });
  assert.equal(r1.status, 'failed');
  assert.deepEqual(counts(store, game.id), before);

  llm.enqueue('interpret', say).enqueue('npc_turn', npc({ dialogue: 'Yeah, sorry, bad signal.' }));
  const r2 = await engine.takeTurn({ gameId: game.id, input: 'hello?', requestId: 'req-2' });
  assert.equal(r2.status, 'committed', r2.error ?? '');
  assert.equal(r2.replayed, undefined);
  close();
});

test('a concurrent write during the model call aborts the commit (revision check)', async () => {
  const { store, llm, engine, game, close } = await gameWithMatteoOnPhone(tmpDbPath());
  const before = counts(store, game.id);
  llm.enqueue('interpret', interp({ intents: ['speak'], target: { name: 'Matteo Ferrari', relationHint: null }, spokenText: 'yo' }))
    .enqueue('npc_turn', () => {
      const g = store.getGame(game.id)!; // simulate another writer committing meanwhile
      store.advanceGame(g.id, g.gameTime, g.revision + 1, new Date().toISOString());
      return npc({ dialogue: 'yo' });
    });
  const r = await engine.takeTurn({ gameId: game.id, input: 'yo' });
  assert.equal(r.status, 'failed');
  assert.match(r.error!, /RevisionConflict|game changed/);
  assert.deepEqual(counts(store, game.id), before);
  close();
});

test('being mentioned in an event is not perceiving it', async () => {
  const { store, llm, engine, game, player, matteo, close } = await gameWithMatteoOnPhone(tmpDbPath());
  // Create Sofia through play, then go back to Matteo and talk about her.
  llm.enqueue('interpret', interp({ intents: ['start_conversation'], target: { name: 'Sofia', relationHint: 'friend' }, channel: 'phone' }))
    .enqueue('generate_character', SOFIA)
    .enqueue('npc_turn', npc({ dialogue: 'Ciao Felipe.' }))
    .enqueue('interpret', interp({ intents: ['start_conversation', 'speak'], target: { name: 'Matteo Ferrari', relationHint: null }, channel: 'phone', spokenText: 'Between us: Sofia is planning to leave Milan.' }))
    .enqueue('npc_turn', npc({
      dialogue: 'Sofia? Really?',
      eventSummary: 'Felipe told Matteo that Sofia is planning to leave Milan.',
      importance: 3,
      mentionedCharacterNames: ['Sofia'],
      changes: [{ op: 'upsert_knowledge', topic: 'sofia.plans', belief: 'Felipe says Sofia is planning to leave Milan.', confidence: 0.7, sourceKind: 'told', aboutCharacterName: 'Sofia' }],
    }));
  assert.equal((await engine.takeTurn({ gameId: game.id, input: 'I call Sofia.' })).status, 'committed');
  assert.equal((await engine.takeTurn({ gameId: game.id, input: 'I call Matteo back and tell him Sofia is planning to leave Milan.' })).status, 'committed');

  const sofia = store.listCharacters(game.id).find((c) => c.name === 'Sofia Conti')!;
  const told = store.listEvents(game.id).find((e) => /leave Milan/.test(e.summary))!;
  assert.ok(told.participants.some((p) => p.characterId === sofia.id && p.role === 'mentioned'));
  assert.deepEqual(told.observers.map((o) => o.characterId).sort(), [player.id, matteo.id].sort());
  assert.ok(!store.listEventsObservedBy(sofia.id).some((e) => e.id === told.id));
  assert.equal(store.listKnowledgeOf(sofia.id).length, 0);
  assert.equal(store.getKnowledge(matteo.id, 'sofia.plans')!.aboutCharacterId, sofia.id);
  close();
});

test('the context builder never reads Facts or other characters\' knowledge', async () => {
  const { store, game, player, matteo, close } = await gameWithMatteoOnPhone(tmpDbPath());
  const now = new Date().toISOString();
  // Objective truth + the player's own knowledge of it. Matteo was never told.
  store.insertFact({ id: newId('fact'), gameId: game.id, subject: 'sofia', predicate: 'plans_to_leave_company', value: 'true', createdAt: now, updatedAt: now });
  store.upsertKnowledge({
    id: newId('know'), gameId: game.id, characterId: player.id, topic: 'sofia.leaving', belief: 'Sofia is planning to leave the company.',
    confidence: 1, aboutCharacterId: null, factId: null, source: 'fixture', sourceEventId: null, gameTime: game.gameTime, createdAt: now, updatedAt: now,
  });
  const input = { npcId: matteo.id, partner: player, channel: 'phone' as const, interactionId: store.getScene(game.id).interactionId,
    pendingLines: [{ speakerId: player.id, speakerName: player.name, text: 'What do you think about Sofia and the company?' }],
    gameTime: game.gameTime, sceneLocation: 'x' };
  const briefing = renderNpcBriefing(retrieveNpcPerspective(store, input), input);
  assert.doesNotMatch(briefing, /plans_to_leave|leave the company|cash_eur|2500|2,500/);
  close();
});

test('ambiguous references ask for clarification without changing state', async () => {
  const { store, llm, engine, game, close } = await gameWithMatteoOnPhone(tmpDbPath());
  llm.enqueue('interpret', interp({ intents: ['start_conversation'], target: { name: 'Marco', relationHint: 'classmate' }, channel: 'phone' }))
    .enqueue('generate_character', { ...MATTEO, name: 'Marco Bianchi' })
    .enqueue('npc_turn', npc())
    .enqueue('interpret', interp({ intents: ['start_conversation'], target: { name: 'Marco Rossi', relationHint: 'cousin' }, channel: 'phone' }))
    .enqueue('generate_character', { ...MATTEO, name: 'Marco Rossi' })
    .enqueue('npc_turn', npc());
  assert.equal((await engine.takeTurn({ gameId: game.id, input: 'I call my classmate Marco.' })).status, 'committed');
  assert.equal((await engine.takeTurn({ gameId: game.id, input: 'I call my cousin Marco Rossi.' })).status, 'committed');
  const before = counts(store, game.id);
  const revision = store.getGame(game.id)!.revision;

  llm.enqueue('interpret', interp({ intents: ['start_conversation'], target: { name: 'Marco', relationHint: null }, channel: 'phone' }));
  const r = await engine.takeTurn({ gameId: game.id, input: 'I call Marco.' });
  assert.equal(r.status, 'clarification');
  assert.match(r.text, /Marco Bianchi or Marco Rossi/);
  assert.deepEqual(counts(store, game.id), before);
  assert.equal(store.getGame(game.id)!.revision, revision);
  close();
});

test('a generated character must match the requested name', async () => {
  const s = openSession(tmpDbPath());
  const { game } = s.engine.newGame();
  s.llm.enqueue('interpret', interp({ intents: ['start_conversation'], target: { name: 'Matteo', relationHint: 'friend' }, channel: 'phone' }))
    .enqueue('generate_character', { ...MATTEO, name: 'Luca Neri' }, MATTEO)
    .enqueue('npc_turn', npc());
  const r = await s.engine.takeTurn({ gameId: game.id, input: 'I call my friend Matteo.' });
  assert.equal(r.status, 'committed', r.error ?? '');
  assert.deepEqual(s.store.listCharacters(game.id).map((c) => c.name).sort(), ['Felipe', 'Matteo Ferrari']);
  const trace = s.store.lastTurn(game.id)!.trace as Trace;
  assert.match(trace.llmCalls.find((c) => c.task === 'generate_character')!.problems[0]!, /does not match/);
  s.close();
});

test('an in-person visible action is perceived by the person present', async () => {
  const s = openSession(tmpDbPath());
  const { game } = s.engine.newGame();
  s.llm.enqueue('interpret', interp({
    intents: ['start_conversation', 'general_action', 'speak'], target: { name: 'Matteo', relationHint: 'friend' }, channel: 'in_person',
    newLocation: 'Bar in Piazza Leonardo da Vinci', visibleAction: 'slides a printed business plan across the table', spokenText: 'Read this.',
  }))
    .enqueue('generate_character', MATTEO)
    .enqueue('npc_turn', npc({ dialogue: 'A business plan? You?' }));
  const r = await s.engine.takeTurn({ gameId: game.id, input: 'I meet Matteo at the bar, slide a printed business plan over and say "read this".' });
  assert.equal(r.status, 'committed', r.error ?? '');
  const prompt = lastPrompt(s.llm, 'npc_turn');
  assert.match(prompt, /\[Felipe meets Matteo Ferrari\.\]\n\[Felipe slides a printed business plan across the table\]\nFelipe: Read this\./);
  assert.match(prompt, /You are with Felipe in person/);
  s.close();
});

test('a person who is only mentioned, not contacted, is not created', async () => {
  const s = openSession(tmpDbPath());
  const { game } = s.engine.newGame();
  s.llm.enqueue('interpret', interp({
    intents: ['private_thought'], target: { name: 'Giulia', relationHint: 'ex-girlfriend' }, privateThought: 'I wonder whether Giulia would like my idea.',
  }));
  const r = await s.engine.takeTurn({ gameId: game.id, input: 'I wonder whether Giulia would like my idea.' });
  assert.equal(r.status, 'committed', r.error ?? '');
  assert.equal(s.llm.callsFor('generate_character').length, 0);
  assert.equal(s.store.listCharacters(game.id).length, 1);
  s.close();
});

test('moving somewhere replaces the scene description instead of inheriting the old room', async () => {
  const s = openSession(tmpDbPath());
  const { game } = s.engine.newGame();
  s.llm.enqueue('interpret', interp({
    intents: ['general_action'], newLocation: 'Home — kitchen', newSceneDescription: 'A small kitchen; coffee cups in the sink.',
    visibleAction: 'walks to the kitchen', narration: 'You walk to the kitchen.', minutesElapsed: 1,
  }));
  await s.engine.takeTurn({ gameId: game.id, input: 'I go to the kitchen' });
  const scene = s.store.getScene(game.id);
  assert.equal(scene.location, 'Home — kitchen');
  assert.equal(scene.description, 'A small kitchen; coffee cups in the sink.');
  assert.doesNotMatch(scene.description, /Laptop/);
  s.close();
});

test('self-harm is never simulated: the story pauses with support info and nothing changes', async () => {
  const { store, llm, engine, game, close } = await gameWithMatteoOnPhone(tmpDbPath());
  const before = counts(store, game.id);
  const revision = store.getGame(game.id)!.revision;
  llm.enqueue('interpret', interp({ intents: ['general_action'], safety: 'self_harm', narration: 'graphic text that must not be shown' }));
  const r = await engine.takeTurn({ gameId: game.id, input: '(self-harm attempt)' });
  assert.equal(r.status, 'clarification');
  assert.match(r.text, /Pausing the story/);
  assert.match(r.text, /Telefono Amico/);
  assert.doesNotMatch(r.text, /graphic text/);
  assert.equal(llm.callsFor('npc_turn').length, 1, 'no NPC call for this turn');
  assert.deepEqual(counts(store, game.id), before);
  assert.equal(store.getGame(game.id)!.revision, revision);
  close();
});
