// Milestone 1 end-to-end scenario with the deterministic ScriptedProvider.
// Session 1 and session 2 use separate Store/Engine/provider instances on the same SQLite file.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retrieveNpcPerspective, renderNpcBriefing } from '../src/engine/context.ts';
import type { Trace } from '../src/engine/trace.ts';
import { interp, lastPrompt, MATTEO, npc, openSession, SOFIA, tmpDbPath } from './helpers.ts';

const SECRET = "I've actually got €2,500 saved, but don't tell anyone. My parents think I only have €500.";
const MEMORY = 'Felipe trusted me with a secret: Felipe really has €2,500 saved, while Felipe\'s parents think it is €500.';
const BELIEF = 'Felipe told me they have €2,500 saved; their parents believe it is €500. Asked me not to tell anyone.';
const REL_AFTER = 'Old friend from liceo. Felipe just trusted me with a money secret — that means a lot. Still a bit of a dreamer.';

test('Milestone 1: persistent Matteo across sessions with knowledge boundaries', async (t) => {
  const path = tmpDbPath();
  let gameId = '';
  let playerId = '';
  let matteoId = '';
  let matteoSnapshot: unknown;

  // ------------------------------------------------------------------ session 1
  const s1 = openSession(path);

  await t.test('new game: only the player exists, in Milan on Sunday 27 September 2026, with €2,500', () => {
    const { game, player, opening } = s1.engine.newGame();
    gameId = game.id;
    playerId = player.id;
    assert.equal(game.gameTime, '2026-09-27T09:14');
    assert.equal(game.timezone, 'Europe/Rome');
    assert.match(opening, /Sunday, 27 September 2026, 09:14/);
    assert.equal(s1.store.listCharacters(gameId).length, 1);
    assert.equal(s1.store.getAccountOf(gameId, 'character', playerId)!.balanceCents, 250_000);
  });

  await t.test('"I grab a Coke, go onto the balcony and call my friend Matteo" creates Matteo', async () => {
    s1.llm
      .enqueue('interpret', interp({
        intents: ['general_action', 'start_conversation'],
        target: { name: 'Matteo', relationHint: 'friend' },
        channel: 'phone',
        visibleAction: 'grabs a Coke from the fridge and steps out onto the balcony',
        newLocation: 'Home — balcony',
        minutesElapsed: 3,
        narration: 'You grab a Coke from the fridge and step out onto the balcony. The phone rings twice.',
      }))
      .enqueue('generate_character', MATTEO)
      .enqueue('npc_turn', npc({ dialogue: 'Pronto? Felipe! Bit early for a Sunday, no?', perceivable: 'He sounds half asleep.', eventSummary: 'Felipe called Matteo on a Sunday morning.' }));

    const r = await s1.engine.takeTurn({ gameId, input: 'I grab a Coke, go onto the balcony and call my friend Matteo.' });
    assert.equal(r.status, 'committed', r.error ?? '');
    assert.equal(r.npc?.name, 'Matteo Ferrari');
    assert.equal(r.npc?.isNew, true);
    assert.match(r.text, /Pronto\? Felipe!/);

    const matteo = s1.store.listCharacters(gameId).find((c) => !c.isPlayer)!;
    matteoId = matteo.id;
    assert.equal(matteo.origin, 'generated');
    assert.equal(s1.store.getRelationship(matteoId, playerId)!.source, 'backstory');
    assert.equal(s1.store.listMemoriesOwnedBy(matteoId).length, 0, 'no fabricated episodic memories at creation');

    // Generation saw only the player's public profile, never canonical facts like cash.
    assert.doesNotMatch(lastPrompt(s1.llm, 'generate_character'), /2[.,]?500|cash/i);
    // Over the phone Matteo cannot see the Coke or the balcony.
    assert.doesNotMatch(lastPrompt(s1.llm, 'npc_turn'), /Coke|balcony/i);
    assert.equal(s1.store.getScene(gameId).location, 'Home — balcony');
    assert.equal(r.gameTime, '2026-09-27T09:18');
  });

  await t.test('Felipe confides the €2,500 secret: Matteo learns it, remembers it, and the relationship shifts', async () => {
    s1.llm
      .enqueue('interpret', interp({ intents: ['speak'], target: { name: 'Matteo Ferrari', relationHint: null }, spokenText: SECRET }))
      .enqueue('npc_turn', npc({
        dialogue: "Wait, seriously? Two and a half grand? Relax, my lips are sealed.",
        eventSummary: 'Felipe told Matteo about having €2,500 saved and asked Matteo to keep it secret.',
        importance: 4,
        changes: [
          { op: 'create_memory', summary: MEMORY, importance: 4, emotionalWeight: 2, aboutCharacterNames: ['Felipe'] },
          { op: 'upsert_knowledge', topic: 'felipe.savings', belief: BELIEF, confidence: 0.9, sourceKind: 'told', aboutCharacterName: 'Felipe' },
          { op: 'update_relationship', towardCharacterName: 'Felipe', summary: REL_AFTER },
        ],
      }));
    const r = await s1.engine.takeTurn({ gameId, input: SECRET });
    assert.equal(r.status, 'committed', r.error ?? '');

    const [mem] = s1.store.listMemoriesOwnedBy(matteoId);
    assert.equal(mem!.summary, MEMORY);
    assert.deepEqual(mem!.subjectIds, [playerId]);
    const k = s1.store.getKnowledge(matteoId, 'felipe.savings')!;
    assert.equal(k.belief, BELIEF);
    assert.match(k.source, /told by Felipe/);
    const rel = s1.store.getRelationship(matteoId, playerId)!;
    assert.equal(rel.summary, REL_AFTER);
    assert.equal(rel.source, 'gameplay');
  });

  await t.test('private thoughts never reach Matteo', async () => {
    s1.llm
      .enqueue('interpret', interp({
        intents: ['private_thought', 'speak'], target: { name: 'Matteo Ferrari', relationHint: null },
        privateThought: 'I plan to betray Matteo one day.', spokenText: "Anyway, how's uni going?",
      }))
      .enqueue('npc_turn', npc({ dialogue: 'Brutal. Analisi 1 is killing me.' }));
    const r = await s1.engine.takeTurn({ gameId, input: "I think: I plan to betray Matteo one day. I say: anyway, how's uni going?" });
    assert.equal(r.status, 'committed', r.error ?? '');
    assert.doesNotMatch(lastPrompt(s1.llm, 'npc_turn'), /betray/i);

    const thought = s1.store.listEvents(gameId).find((e) => e.type === 'private_thought')!;
    assert.deepEqual(thought.observers, [{ characterId: playerId, channel: 'self' }]);
    assert.ok(!s1.store.listEventsObservedBy(matteoId).some((e) => /betray/i.test(JSON.stringify(e))));
  });

  await t.test('a lie becomes Matteo\'s belief about a claim, never canonical truth', async () => {
    s1.llm
      .enqueue('interpret', interp({ intents: ['speak'], target: { name: 'Matteo Ferrari', relationHint: null }, spokenText: 'Actually I lied. I have €10,000.' }))
      .enqueue('npc_turn', npc({
        dialogue: 'Ten thousand? Five minutes ago it was two and a half. Which one is it?',
        eventSummary: 'Felipe claimed to have €10,000, contradicting the earlier €2,500.',
        importance: 3,
        changes: [{
          op: 'upsert_knowledge', topic: 'felipe.savings', confidence: 0.4, sourceKind: 'told', aboutCharacterName: 'Felipe',
          belief: 'Felipe first said €2,500 saved (secret), then claimed €10,000. Not sure which is true.',
        }],
      }));
    const r = await s1.engine.takeTurn({ gameId, input: 'I tell him: actually I lied, I have €10,000.' });
    assert.equal(r.status, 'committed', r.error ?? '');
    // The npc prompt showed Matteo his existing belief under the same topic, so he could update it.
    assert.match(lastPrompt(s1.llm, 'npc_turn'), /felipe\.savings: Felipe told me they have €2,500/);

    assert.equal(s1.store.getAccountOf(gameId, 'character', playerId)!.balanceCents, 250_000, 'canonical cash unchanged');
    const beliefs = s1.store.listKnowledgeOf(matteoId);
    assert.equal(beliefs.length, 1, 'same topic updated, not duplicated');
    assert.match(beliefs[0]!.belief, /€10,000/);
  });

  await t.test('player hangs up; the session ends', async () => {
    s1.llm
      .enqueue('interpret', interp({ intents: ['speak', 'end_conversation'], target: { name: 'Matteo Ferrari', relationHint: null }, spokenText: 'Ok, gotta go. Talk later!' }))
      .enqueue('npc_turn', npc({ dialogue: 'Ciao, genio.' }));
    const r = await s1.engine.takeTurn({ gameId, input: "Ok gotta go, talk later. I hang up." });
    assert.equal(r.status, 'committed', r.error ?? '');
    assert.equal(r.conversationEnded, true);
    assert.equal(s1.store.getScene(gameId).interactionId, null);
    matteoSnapshot = s1.store.getCharacter(matteoId);
    assert.equal(s1.llm.pending(), 0);
    s1.close();
  });

  // ------------------------------------------------------------------ session 2
  const s2 = openSession(path);

  await t.test('session 2: Matteo is loaded, not regenerated, with identical identity', async () => {
    assert.deepEqual(s2.store.getCharacter(matteoId), matteoSnapshot);
    s2.llm
      .enqueue('interpret', interp({ intents: ['start_conversation'], target: { name: 'Matteo Ferrari', relationHint: 'friend' }, channel: 'phone' }))
      .enqueue('npc_turn', npc({ dialogue: 'Oh, the millionaire. What now?' }));
    const r = await s2.engine.takeTurn({ gameId, input: 'I call Matteo again.' });
    assert.equal(r.status, 'committed', r.error ?? '');
    assert.equal(r.npc?.characterId, matteoId);
    assert.equal(r.npc?.isNew, false);
    assert.equal(s2.llm.callsFor('generate_character').length, 0);
    assert.equal(s2.store.listCharacters(gameId).length, 2);
  });

  await t.test('session 2: Matteo\'s context carries his memory, belief and relationship — and nothing private', async () => {
    s2.llm
      .enqueue('interpret', interp({ intents: ['speak'], target: { name: 'Matteo Ferrari', relationHint: null }, spokenText: 'Do you remember what I told you this morning about my savings?' }))
      .enqueue('npc_turn', npc({ dialogue: "Of course. Two and a half grand, then ten. I'm still waiting to know which." }));
    const r = await s2.engine.takeTurn({ gameId, input: 'Do you remember what I told you this morning about my savings?' });
    assert.equal(r.status, 'committed', r.error ?? '');

    const prompt = lastPrompt(s2.llm, 'npc_turn');
    assert.ok(prompt.includes(MEMORY), 'memory retrieved');
    assert.match(prompt, /felipe\.savings: Felipe first said €2,500 saved \(secret\), then claimed €10,000/);
    assert.ok(prompt.includes(REL_AFTER), 'relationship retrieved');
    assert.doesNotMatch(prompt, /betray/i);
    assert.doesNotMatch(prompt, /Coke|balcony/i);

    const trace = s2.store.lastTurn(gameId)!.trace as Trace;
    const memId = s2.store.listMemoriesOwnedBy(matteoId)[0]!.id;
    assert.ok(trace.retrieval!.memories.some((m) => m.id === memId), 'trace records retrieved memory id');
  });

  await t.test('another NPC (Sofia) does not magically know Matteo\'s private information', async () => {
    s2.llm
      .enqueue('interpret', interp({
        intents: ['end_conversation', 'start_conversation'], target: { name: 'Sofia', relationHint: 'friend' }, channel: 'phone',
        narration: 'You hang up on Matteo and dial Sofia.',
      }))
      .enqueue('generate_character', SOFIA)
      .enqueue('npc_turn', npc({ dialogue: 'Felipe! Ciao. What is it?' }))
      .enqueue('interpret', interp({ intents: ['speak'], target: { name: 'Sofia Conti', relationHint: null }, spokenText: 'Random question: do you know how much money I have saved?' }))
      .enqueue('npc_turn', npc({ dialogue: 'No idea. Why would I?' }));

    const r1 = await s2.engine.takeTurn({ gameId, input: 'I hang up and call my friend Sofia.' });
    assert.equal(r1.status, 'committed', r1.error ?? '');
    const sofia = s2.store.listCharacters(gameId).find((c) => c.name === 'Sofia Conti')!;
    const matteoCall = s2.store.listEvents(gameId).filter((e) => e.type === 'conversation_ended').at(-1)!;
    assert.ok(matteoCall.observers.every((o) => o.characterId !== sofia.id));
    assert.equal(s2.store.getScene(gameId).interactionId !== null, true, 'the new call with Sofia is open');

    const r2 = await s2.engine.takeTurn({ gameId, input: 'Do you know how much money I have saved?' });
    assert.equal(r2.status, 'committed', r2.error ?? '');

    for (const call of s2.llm.calls.filter((c) => c.task !== 'interpret').slice(-3)) {
      assert.doesNotMatch(call.user, /2[.,]?500|10[.,]?000|savings\b.*€|secret|trusted me/i, `${call.task} prompt leaks`);
    }
    assert.equal(s2.store.listKnowledgeOf(sofia.id).length, 0);
    assert.equal(s2.store.listMemoriesOwnedBy(sofia.id).length, 0);
    assert.ok(!s2.store.listEventsObservedBy(sofia.id).some((e) => /2,500|10,000/.test(JSON.stringify(e))));

    // Independently rebuilt Sofia context contains none of it either.
    const player = s2.store.getCharacter(playerId)!;
    const input = { npcId: sofia.id, partner: player, channel: 'phone' as const, interactionId: null, pendingLines: [], gameTime: '2026-09-27T10:00', sceneLocation: 'x' };
    assert.doesNotMatch(renderNpcBriefing(retrieveNpcPerspective(s2.store, input), input), /2[.,]?500|€/);
    s2.close();
  });
});
