// Independent NPC decisions inside real turns: engine resolves, the model portrays, nothing is repaired into a yes.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DecisionState } from '../src/domain/schemas.ts';
import type { Trace } from '../src/engine/trace.ts';
import type { LLMRequest } from '../src/llm/provider.ts';
import { companyRepo } from '../src/packs/startup/company.ts';
import { fixedRng, interp, lastPrompt, MATTEO, MATTEO_KEEN, npc, openSession, seedDecisionState, SOFIA, tmpDbPath } from './helpers.ts';

const MARCO = { ...MATTEO, name: 'Marco Bellini', age: 44, role: 'owner of a café the player knows', occupation: 'Owns Bar Bellini in Città Studi',
  background: 'Runs a busy café with his business partner Giulia. Has seen three booking apps come and go.', relationshipToPlayer: 'A regular customer kid who is good with computers.' };

const MARCO_BUYER: DecisionState = {
  role: 'café owner evaluating a booking tool',
  goals: ['fewer no-shows at weekend brunch'],
  pressures: [{ text: 'busy season, little time for new tools', expiresGameTime: null }],
  alternatives: [{ text: 'keep taking bookings on the phone', strength: 0.3 }],
  limits: [{ term: 'priceMonthly', op: 'max', value: 300, note: 'what he can approve without Giulia' }],
  requiresApproval: null,
  criteria: [
    { factor: 'need', weight: 3, note: 'no-shows cost real money' },
    { factor: 'effort', weight: 2, note: 'setup must be painless' },
  ],
  baseWillingness: 45,
};

/** A new game, Grade Economy founded, and a live conversation with Marco. */
async function withMarco(opts: { rng: (seed: string) => () => number }) {
  const s = openSession(tmpDbPath(), opts);
  const { game, player } = s.engine.newGame();
  s.llm
    .enqueue('interpret', interp({
      intents: ['start_conversation', 'general_action'], target: { name: 'Marco', relationHint: 'café owner' }, channel: 'in_person',
      actions: [{ action: 'found_company', name: 'Tavolo', description: 'booking software for cafés', initialInvestment: 0 }],
    }))
    .enqueue('generate_character', MARCO)
    .enqueue('npc_turn', npc({ dialogue: 'Ciao, the usual?' }));
  const r = await s.engine.takeTurn({ gameId: game.id, input: 'I found Tavolo and walk into Bar Bellini' });
  assert.equal(r.status, 'committed', r.error ?? '');
  const marco = s.store.listCharacters(game.id).find((c) => c.name === MARCO.name)!;
  seedDecisionState(s.store, game.id, marco.id, 'purchase', MARCO_BUYER);
  return { ...s, game, player, marco };
}

const pitch = (price: number, extra = {}) => interp({
  intents: ['speak'], target: { name: 'Marco Bellini', relationHint: null }, spokenText: `Tavolo cuts no-shows. €${price} a month.`,
  actions: [{ action: 'make_offer', toCharacterName: 'Marco Bellini', kind: 'purchase', subject: 'Tavolo', label: null, terms: [{ key: 'priceMonthly', value: price }], description: 'booking tool subscription' }],
  ...extra,
});
const appraise = (need: number, effort: number) => ({ factors: [{ factor: 'need', value: need, reason: 'no-shows' }, { factor: 'effort', value: effort, reason: 'setup' }] });

test('rejection is a normal, committed outcome — nothing retries it into a yes', async () => {
  const s = await withMarco({ rng: fixedRng(0) }); // worst roll
  s.llm.enqueue('interpret', pitch(250)).enqueue('npc_appraise', appraise(0, -1))
    .enqueue('npc_turn', npc({ expressedDecision: 'reject', dialogue: 'Not for me, sorry. Too much hassle.' }));
  const r = await s.engine.takeTurn({ gameId: s.game.id, input: 'I pitch Tavolo at €250/month' });
  assert.equal(r.status, 'committed');
  assert.match(r.text, /✗ Marco Bellini said no to: Tavolo subscription at €250\.00\/month/);
  assert.equal(s.store.listOffers(s.game.id)[0]!.status, 'rejected');
  assert.equal(s.llm.callsFor('npc_turn').length, 2, 'one portrayal for this turn, no retry');
  const d = (s.store.lastTurn(s.game.id)!.trace as Trace).decision!;
  assert.equal(d.resolution.outcome, 'reject');
  s.close();
});

test('the portrayal must express the engine-resolved outcome; contradicting it commits nothing', async () => {
  const s = await withMarco({ rng: fixedRng(0) });
  const liar = npc({ expressedDecision: 'accept', dialogue: 'Deal! Sign me up!' });
  s.llm.enqueue('interpret', pitch(250)).enqueue('npc_appraise', appraise(0, -1)).enqueue('npc_turn', liar, liar);
  const r = await s.engine.takeTurn({ gameId: s.game.id, input: 'pitch' });
  assert.equal(r.status, 'failed');
  assert.match(JSON.stringify((s.store.lastTurn(s.game.id)!.trace as Trace).validation), /expressedDecision must be/);
  assert.equal(s.store.listOffers(s.game.id).length, 0);
  assert.equal(s.store.listRecurringPayments(s.game.id).length, 0);
  s.close();
});

test('above his limit: an excellent pitch yields a counter he can approve; the player can accept it', async () => {
  const s = await withMarco({ rng: fixedRng(1) }); // best roll
  s.llm.enqueue('interpret', pitch(1000)).enqueue('npc_appraise', appraise(2, 2))
    .enqueue('npc_turn', npc({ expressedDecision: 'counter', counterTerms: { terms: [{ key: 'priceMonthly', value: 250 }], note: '€250 for the first months' },
      dialogue: "I like it. But a thousand a month? No. €250 and I'll try it." }));
  const r = await s.engine.takeTurn({ gameId: s.game.id, input: 'pitch at €1000' });
  assert.equal(r.status, 'committed', r.error ?? '');
  const res = (s.store.lastTurn(s.game.id)!.trace as Trace).decision!.resolution;
  assert.ok(res.blocked.some((b) => b.outcome === 'accept'));
  assert.equal(res.outcome, 'counter');
  const counter = s.store.listOffers(s.game.id).find((o) => o.fromCharacterId === s.marco.id)!;
  assert.deepEqual(counter.terms, { priceMonthly: 250 });
  assert.match(r.text, /↩ Marco Bellini counter-offers: Tavolo subscription at €250\.00\/month/);

  // A counter above his own limit would be refused by the validator (tested via a direct second pitch below).
  s.llm.enqueue('interpret', interp({ intents: ['speak'], target: { name: 'Marco Bellini', relationHint: null }, spokenText: 'Deal at 250.',
    actions: [{ action: 'respond_to_offer', offerId: counter.id, accept: true }] }))
    .enqueue('npc_turn', npc({ dialogue: 'Bene.' }));
  const r2 = await s.engine.takeTurn({ gameId: s.game.id, input: 'I accept 250' });
  assert.equal(r2.status, 'committed', r2.error ?? '');
  assert.match(r2.text, /✓ Marco Bellini is now a paying customer of Tavolo · €250\.00\/month/);
  const tavolo = companyRepo.list(s.store, s.game.id)[0]!;
  assert.equal(s.store.getAccountOf(s.game.id, 'entity', tavolo.id)!.balanceCents, 25_000);
  s.close();
});

test('a counter that breaks the NPC\'s own limits is rejected', async () => {
  const s = await withMarco({ rng: fixedRng(1) });
  const greedy = npc({ expressedDecision: 'counter', counterTerms: { terms: [{ key: 'priceMonthly', value: 900 }], note: 'nine hundred' }, dialogue: '900?' });
  s.llm.enqueue('interpret', pitch(1000)).enqueue('npc_appraise', appraise(2, 2)).enqueue('npc_turn', greedy, greedy);
  const r = await s.engine.takeTurn({ gameId: s.game.id, input: 'pitch' });
  assert.equal(r.status, 'failed');
  assert.match(JSON.stringify((s.store.lastTurn(s.game.id)!.trace as Trace).validation), /counterTerms break your own limits/);
  s.close();
});

test('replaying the same request returns the same decision and never rolls again', async () => {
  let calls = 0;
  const counting = (_seed: string) => { calls++; return fixedRng(0.5)(); };
  const s = await withMarco({ rng: counting });
  s.llm.enqueue('interpret', pitch(200)).enqueue('npc_appraise', appraise(1, 0))
    .enqueue('npc_turn', (req: LLMRequest) => npc({ expressedDecision: req.user.match(/Outcome: (\w+)/)![1], dialogue: '…',
      counterTerms: /Outcome: counter/.test(req.user) ? { terms: [{ key: 'priceMonthly', value: 150 }], note: 'less' } : null,
      condition: /Outcome: accept_conditionally/.test(req.user) ? 'a free first month' : null }));
  const first = await s.engine.takeTurn({ gameId: s.game.id, input: 'pitch', requestId: 'pitch-1' });
  assert.equal(first.status, 'committed', first.error ?? '');
  const rollsAfterFirst = calls;
  const decisionsAfterFirst = s.store.listDecisions(s.game.id).length;
  const again = await s.engine.takeTurn({ gameId: s.game.id, input: 'pitch', requestId: 'pitch-1' });
  assert.equal(again.replayed, true);
  assert.equal(again.text, first.text);
  assert.equal(calls, rollsAfterFirst, 'no new roll');
  assert.equal(s.store.listDecisions(s.game.id).length, decisionsAfterFirst);
  s.close();
});

test('hidden criteria stay hidden: the player never sees limits, scores or rolls; other NPCs never see them', async () => {
  const s = await withMarco({ rng: fixedRng(0.5) });
  s.llm.enqueue('interpret', pitch(200)).enqueue('npc_appraise', appraise(1, 0))
    .enqueue('npc_turn', (req: LLMRequest) => npc({ expressedDecision: req.user.match(/Outcome: (\w+)/)![1], dialogue: 'Let me think.',
      counterTerms: /Outcome: counter/.test(req.user) ? { terms: [{ key: 'priceMonthly', value: 150 }], note: 'less' } : null,
      condition: /Outcome: accept_conditionally/.test(req.user) ? 'a trial' : null }));
  const r = await s.engine.takeTurn({ gameId: s.game.id, input: 'pitch' });
  assert.doesNotMatch(r.text, /score|roll|without Giulia|\b300\b/);
  // Marco's own briefing contains his private situation (he knows his own limits)...
  assert.match(lastPrompt(s.llm, 'npc_turn'), /YOUR PRIVATE SITUATION[\s\S]*priceMonthly: at most 300/);

  // ...but the player's next interpretation and another NPC's briefing do not.
  s.llm.enqueue('interpret', interp({ intents: ['start_conversation'], target: { name: 'Sofia', relationHint: 'friend' }, channel: 'phone' }))
    .enqueue('generate_character', SOFIA).enqueue('npc_turn', npc({ dialogue: 'Ciao!' }));
  await s.engine.takeTurn({ gameId: s.game.id, input: 'I call Sofia' });
  for (const prompt of [lastPrompt(s.llm, 'interpret'), lastPrompt(s.llm, 'npc_turn')]) {
    assert.doesNotMatch(prompt, /without Giulia|at most 300|no-shows cost|PRIVATE SITUATION/);
  }
  s.close();
});

test('a cofounder offer to a keen Matteo is accepted by the engine and portrayed consistently', async () => {
  const s = openSession(tmpDbPath(), { rng: fixedRng(0.5) });
  const { game } = s.engine.newGame();
  s.llm.enqueue('interpret', interp({ intents: ['start_conversation'], target: { name: 'Matteo', relationHint: 'friend' }, channel: 'phone',
    actions: [{ action: 'found_company', name: 'Grade Economy', description: 'edtech', initialInvestment: 0 }] }))
    .enqueue('generate_character', MATTEO).enqueue('npc_turn', npc());
  await s.engine.takeTurn({ gameId: game.id, input: 'call' });
  const matteo = s.store.listCharacters(game.id).find((c) => c.name === MATTEO.name)!;
  seedDecisionState(s.store, game.id, matteo.id, 'join_company', MATTEO_KEEN);
  s.llm.enqueue('interpret', interp({ intents: ['speak'], target: { name: 'Matteo Ferrari', relationHint: null }, spokenText: '40%, cofounder?',
    actions: [{ action: 'make_offer', toCharacterName: 'Matteo', kind: 'join_company', subject: 'Grade Economy', label: 'cofounder', terms: [{ key: 'equityPercent', value: 40 }], description: 'cofounder' }] }))
    .enqueue('npc_appraise', { factors: [{ factor: 'trust', value: 2, reason: 'ok' }, { factor: 'offer_quality', value: 1, reason: 'ok' }, { factor: 'confidence_in_player', value: 2, reason: 'ok' }] })
    .enqueue('npc_turn', npc({ expressedDecision: 'accept', dialogue: 'Ok. In.' }));
  const r = await s.engine.takeTurn({ gameId: game.id, input: 'offer' });
  assert.match(r.text, /✓ Matteo Ferrari joined Grade Economy as cofounder · ownership: Felipe 60\.0%, Matteo Ferrari 40\.0%/);
  s.close();
});
