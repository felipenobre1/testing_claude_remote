// The world moves without the player: world turns, story threads, the Story Director, information delivery.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DecisionState, DirectorProposal } from '../src/domain/schemas.ts';
import type { Trace } from '../src/engine/trace.ts';
import { newId } from '../src/engine/util.ts';
import type { LLMRequest } from '../src/llm/provider.ts';
import { fixedRng, interp, lastPrompt, MATTEO, MATTEO_KEEN, npc, openSession, seedDecisionState, tmpDbPath } from './helpers.ts';

const NOTHING: DirectorProposal = { newThreads: [], escalations: [] };
const idle = (minutes: number) => interp({ intents: ['general_action'], minutesElapsed: minutes, narration: 'You keep coding.' });

const MATTEO_CAREER = {
  role: 'engineering student with a paid internship offer', goals: ['earn money', 'graduate on time'],
  pressures: [{ text: 'rent share due every month', expiresInDays: null }],
  alternatives: [{ text: 'turn it down and keep weekends free for Grade Economy', strength: 0.3 }],
  limits: [], requiresApproval: null,
  criteria: [{ factor: 'need' as const, weight: 3, note: 'needs income' }, { factor: 'relationship' as const, weight: 1, note: 'loyal to Felipe' }],
  baseWillingness: 60,
};

/** Game with Matteo as cofounder (a real, observed event the Director can build on). */
async function cofoundedWithMatteo(opts: { director: boolean }) {
  const s = openSession(tmpDbPath(), { rng: fixedRng(0.5), director: opts.director });
  const { game, player } = s.engine.newGame();
  s.llm.enqueue('interpret', interp({ intents: ['start_conversation'], target: { name: 'Matteo', relationHint: 'friend' }, channel: 'phone',
    actions: [{ action: 'found_company', name: 'Grade Economy', description: 'edtech', initialInvestment: 0 }] }))
    .enqueue('generate_character', MATTEO).enqueue('npc_turn', npc());
  await s.engine.takeTurn({ gameId: game.id, input: 'call Matteo' });
  const matteo = s.store.listCharacters(game.id).find((c) => c.name === MATTEO.name)!;
  seedDecisionState(s.store, game.id, matteo.id, 'join_company', MATTEO_KEEN);
  s.llm.enqueue('interpret', interp({ intents: ['speak', 'end_conversation'], target: { name: 'Matteo Ferrari', relationHint: null }, spokenText: 'Cofounder, 40%?',
    actions: [{ action: 'make_offer', toCharacterName: 'Matteo', kind: 'join_company', subject: 'Grade Economy', label: 'cofounder', terms: [{ key: 'equityPercent', value: 40 }], description: 'cofounder' }] }))
    .enqueue('npc_appraise', { factors: [{ factor: 'trust', value: 2, reason: 'old friend' }, { factor: 'offer_quality', value: 1, reason: 'fair' }, { factor: 'confidence_in_player', value: 2, reason: 'codes well' }] })
    .enqueue('npc_turn', npc({ expressedDecision: 'accept', dialogue: "I'm in." }));
  const r = await s.engine.takeTurn({ gameId: game.id, input: 'offer 40%' });
  assert.match(r.text, /joined Grade Economy/);
  return { ...s, game, player, matteo };
}

test('Story Director: situations must grow out of real events; a hidden career thread resolves while the player ignores it', async () => {
  const s = await cofoundedWithMatteo({ director: true });
  const gameId = s.game.id;

  // Day 2: the Director reviews the world. One proposal cites a real event, one cites nothing real.
  s.llm.enqueue('interpret', idle(1440)).enqueue('director', (req: LLMRequest): DirectorProposal => {
    const joined = req.user.match(/\[(evt_\w+)\] \S+ decision: Matteo Ferrari responded/)![1]!;
    return {
      newThreads: [
        {
          title: 'Matteo weighing an internship offer', summary: 'A consultancy offered Matteo a paid internship, 30 hours a week, starting soon.',
          causeEventIds: [joined], participantNames: ['Matteo Ferrari'], urgency: 30, visibility: 'hidden',
          resolution: {
            actorName: 'Matteo Ferrari', domain: 'career', option: 'take the paid internship (30h/week)',
            factors: [{ factor: 'need', value: 2, reason: 'needs the money' }, { factor: 'relationship', value: -1, reason: 'feels bad about Felipe' }],
            ifAccepted: { summary: 'Matteo accepted the internship; Grade Economy only gets his weekends now.', messageToPlayer: 'Hey. I took the internship. Still in, but only weekends from now on.', newPressure: 'works 30h/week at an internship' },
            ifRejected: { summary: 'Matteo turned the internship down to stay on Grade Economy.', messageToPlayer: null, newPressure: 'short of money' },
          },
          decisionState: MATTEO_CAREER,
        },
        {
          title: 'A rival launches', summary: 'A rival app launches in Milan.', causeEventIds: ['evt_made_up'], participantNames: ['Matteo Ferrari'], urgency: 10, visibility: 'public',
          resolution: { actorName: 'Matteo Ferrari', domain: 'career', option: 'join the rival instead', factors: [],
            ifAccepted: { summary: 'Matteo joins the rival.', messageToPlayer: null, newPressure: null }, ifRejected: { summary: 'Matteo stays.', messageToPlayer: null, newPressure: null } },
          decisionState: null,
        },
      ],
      escalations: [],
    };
  });
  const day2 = await s.engine.takeTurn({ gameId, input: 'I code all day' });
  assert.equal(day2.status, 'committed', day2.error ?? '');
  const director = (s.store.lastTurn(gameId)!.trace as Trace).world!.director!;
  assert.equal(director.accepted.length, 1);
  assert.match(director.rejected[0]!.reason, /cites events that do not exist: evt_made_up/);
  const [thread] = s.store.listThreads(gameId);
  assert.equal(thread!.visibility, 'hidden');
  const started = s.store.listEvents(gameId).find((e) => e.type === 'thread_started')!;
  assert.deepEqual(started.observers.map((o) => o.characterId), [s.matteo.id], 'only Matteo knows his own situation');
  assert.doesNotMatch(day2.text, /internship/i);

  // Matteo's own briefing now includes the situation he is living through.
  s.llm.enqueue('interpret', interp({ intents: ['start_conversation', 'speak'], target: { name: 'Matteo Ferrari', relationHint: null }, channel: 'message', spokenText: 'how is it going?' }))
    .enqueue('npc_turn', npc({ dialogue: 'busy week' }));
  await s.engine.takeTurn({ gameId, input: 'text Matteo' });
  assert.match(lastPrompt(s.llm, 'npc_turn'), /SITUATIONS IN YOUR LIFE\n\[thr_\w+\] Matteo weighing an internship offer/);

  // The player ignores it. Three-day blocks of work; the Director reviews each morning and adds nothing.
  s.llm.enqueue('interpret', idle(4320)).enqueue('director', NOTHING);
  const block1 = await s.engine.takeTurn({ gameId, input: 'three days of coding' });
  assert.equal(block1.status, 'committed', block1.error ?? '');
  assert.equal(s.store.getThread(thread!.id)!.status, 'resolved', 'the world moved without the player');
  const resolved = s.store.listEvents(gameId).find((e) => e.type === 'thread_resolved')!;
  assert.match(resolved.summary, /accepted the internship/);
  assert.ok(!resolved.observers.some((o) => o.characterId === s.player.id), 'the player did not witness it');
  assert.doesNotMatch(block1.text, /internship/i);
  // The outcome now shapes Matteo's future decisions about Grade Economy.
  assert.ok(s.store.getDecisionState(s.matteo.id, 'join_company')!.pressures.some((p) => /30h\/week/.test(p.text)));

  // The player finds out only when Matteo tells them.
  s.llm.enqueue('interpret', idle(4320)).enqueue('director', NOTHING);
  const block2 = await s.engine.takeTurn({ gameId, input: 'three more days' });
  assert.doesNotMatch(lastPrompt(s.llm, 'interpret'), /internship/i, 'not known before the message arrives');
  assert.match(block2.text, /📱 .* — Matteo Ferrari: “Hey\. I took the internship\. Still in, but only weekends from now on\.”/);
  s.llm.enqueue('interpret', idle(10));
  await s.engine.takeTurn({ gameId, input: 'I read the message again' });
  assert.match(lastPrompt(s.llm, 'interpret'), /RECENT MESSAGES AND NEWS:\n[^]*?I took the internship/);
  s.close();
});

test('world turn: advancing three days delivers what was scheduled within them — and nothing later', async () => {
  const s = await cofoundedWithMatteo({ director: false });
  const now = s.store.getGame(s.game.id)!.gameTime;
  const at = (days: number) => new Date(new Date(`${now}:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 16);
  for (const [days, text] of [[2, 'saw your prototype, not bad'], [5, 'call me when you can']] as const) {
    s.store.insertScheduled({ id: newId('sch'), gameId: s.game.id, dueGameTime: at(days), kind: 'message', payload: { fromId: s.matteo.id, text },
      threadId: null, status: 'pending', createdGameTime: now, createdAt: new Date().toISOString() });
  }
  s.llm.enqueue('interpret', idle(1440));
  const oneDay = await s.engine.takeTurn({ gameId: s.game.id, input: 'one day' });
  assert.doesNotMatch(oneDay.text, /📱/);
  s.llm.enqueue('interpret', idle(3 * 1440));
  const threeDays = await s.engine.takeTurn({ gameId: s.game.id, input: 'three days' });
  assert.match(threeDays.text, /📱 .*saw your prototype, not bad/);
  assert.doesNotMatch(threeDays.text, /call me when you can/);
  assert.equal(s.store.listScheduled(s.game.id, 'pending').length, 1);
  s.close();
});

test('people get back to you: a delayed decision is revisited by the world turn and reaches the player as a message', async () => {
  const s = openSession(tmpDbPath(), { rng: fixedRng(0.5) });
  const { game } = s.engine.newGame();
  const buyer: DecisionState = {
    role: 'café owner', goals: ['fewer no-shows'], pressures: [], alternatives: [{ text: 'paper diary', strength: 0.3 }],
    limits: [{ term: 'priceMonthly', op: 'max', value: 300, note: 'budget' }], requiresApproval: null,
    criteria: [{ factor: 'need', weight: 3, note: 'no-shows' }, { factor: 'effort', weight: 2, note: 'setup' }], baseWillingness: 45,
  };
  s.llm.enqueue('interpret', interp({ intents: ['start_conversation'], target: { name: 'Marco', relationHint: 'café owner' }, channel: 'in_person',
    actions: [{ action: 'found_company', name: 'Tavolo', description: 'bookings', initialInvestment: 0 }] }))
    .enqueue('generate_character', { ...MATTEO, name: 'Marco Bellini' }).enqueue('npc_turn', npc());
  await s.engine.takeTurn({ gameId: game.id, input: 'visit Marco' });
  const marco = s.store.listCharacters(game.id).find((c) => c.name === 'Marco Bellini')!;
  seedDecisionState(s.store, game.id, marco.id, 'purchase', buyer);
  s.llm.enqueue('interpret', interp({ intents: ['speak'], target: { name: 'Marco Bellini', relationHint: null }, spokenText: '€200 a month.',
    actions: [{ action: 'make_offer', toCharacterName: 'Marco', kind: 'purchase', subject: 'Tavolo', label: null, terms: [{ key: 'priceMonthly', value: 200 }], description: 'subscription' }] }))
    .enqueue('npc_appraise', { factors: [{ factor: 'need', value: 0, reason: 'some no-shows' }, { factor: 'effort', value: -1, reason: 'unsure about setup' }] })
    .enqueue('npc_turn', npc({ expressedDecision: 'delay', dialogue: 'Let me think about it.' }));
  const r = await s.engine.takeTurn({ gameId: game.id, input: 'pitch' });
  assert.match(r.text, /… No decision yet from Marco Bellini\./);

  s.llm.enqueue('interpret', idle(3 * 1440));
  const later = await s.engine.takeTurn({ gameId: game.id, input: 'I wait three days' });
  assert.match(later.text, /📱 .* — Marco Bellini: “Still thinking\. Give me a few more days\.”/);
  assert.equal(s.store.listDecisions(game.id).length, 2);
  assert.equal(s.store.listOffers(game.id)[0]!.attempts, 2);
  s.close();
});
