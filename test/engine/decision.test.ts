// The Decision Resolution Engine in isolation: generic inputs, deterministic with a seed.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import type { Appraisal, DecisionState } from '../../src/domain/schemas.ts';
import { POSITIVE, resolveDecision, ROLL_RANGE, type DecisionOption } from '../../src/engine/decision.ts';
import { seededRng } from '../../src/engine/random.ts';

const fixed = (x: number) => () => x;
const rolls = Array.from({ length: 21 }, (_, i) => i / 20); // 0, 0.05, …, 1 → roll −10 … +10

const customer = (over: Partial<DecisionState> = {}): DecisionState => ({
  role: 'café owner evaluating a booking tool',
  goals: ['fewer no-shows'],
  pressures: [],
  alternatives: [{ text: 'keep using the paper diary', strength: 0.3 }],
  limits: [{ term: 'priceMonthly', op: 'max', value: 300, note: 'can approve up to €300/month alone' }],
  requiresApproval: null,
  criteria: [
    { factor: 'need', weight: 3, note: 'no-shows cost real money' },
    { factor: 'trust', weight: 2, note: 'does not know the founder' },
    { factor: 'effort', weight: 2, note: 'worried setup will be a pain' },
  ],
  baseWillingness: 45,
  ...over,
});
const appraisal = (need: number, trust: number, effort: number): Appraisal => ({ factors: [
  { factor: 'need', value: need, reason: 'need' }, { factor: 'trust', value: trust, reason: 'trust' }, { factor: 'effort', value: effort, reason: 'effort' },
] });
const purchase = (priceMonthly: number): DecisionOption => ({ kind: 'purchase', terms: { priceMonthly } });

test('hard limit: €1,000/month against a €300 approval limit is never accepted, whatever the roll', () => {
  for (const x of rolls) {
    const r = resolveDecision({ state: customer(), option: purchase(1000), appraisal: appraisal(2, 2, 2), rng: fixed(x), seed: 's' });
    assert.ok(!POSITIVE.includes(r.outcome), `roll ${x} → ${r.outcome}`);
    assert.ok(r.blocked.some((b) => b.outcome === 'accept'));
  }
  // An excellent pitch still leads somewhere real: a counter at a price they can approve.
  const best = resolveDecision({ state: customer(), option: purchase(1000), appraisal: appraisal(2, 2, 2), rng: fixed(1), seed: 's' });
  assert.equal(best.outcome, 'counter');
  assert.deepEqual(best.counterTerms, { priceMonthly: 300 });
});

test('lacking authority: a liked offer escalates to the decision maker instead of being accepted', () => {
  const r = resolveDecision({ state: customer({ requiresApproval: 'business partner' }), option: purchase(200), appraisal: appraisal(2, 2, 2), rng: fixed(0.5), seed: 's' });
  assert.equal(r.outcome, 'escalate_to_decision_maker');
});

test('strong situation: fit, urgency, fair price and trust progress positively on most seeds', () => {
  const state = customer({ criteria: [...customer().criteria, { factor: 'urgency', weight: 2, note: 'losing money weekly' }], baseWillingness: 50 });
  const a: Appraisal = { factors: [...appraisal(2, 2, 1).factors, { factor: 'urgency', value: 2, reason: 'urgent' }] };
  const outcomes = Array.from({ length: 100 }, (_, i) => resolveDecision({ state, option: purchase(150), appraisal: a, rng: seededRng(`seed-${i}`), seed: `seed-${i}` }).outcome);
  const positive = outcomes.filter((o) => ['accept', 'accept_conditionally', 'counter', 'escalate_to_decision_maker'].includes(o)).length;
  assert.ok(positive >= 90, `${positive}/100 positive`);
});

test('bad situation: no pain, expensive, strong alternative, low trust — a lucky roll never makes it a purchase', () => {
  const state = customer({ alternatives: [{ text: 'already happy with a competitor', strength: 0.9 }], baseWillingness: 25 });
  for (const x of rolls) {
    const r = resolveDecision({ state, option: purchase(290), appraisal: appraisal(-2, -1, 0), rng: fixed(x), seed: 's' });
    assert.ok(!POSITIVE.includes(r.outcome) && r.outcome !== 'counter', `roll ${x} → ${r.outcome}`);
  }
});

test('soft preference: convincingly showing low setup effort improves the decision (same seed)', () => {
  const worried = resolveDecision({ state: customer(), option: purchase(200), appraisal: appraisal(1, 0, -2), rng: fixed(0.5), seed: 's' });
  const shown = resolveDecision({ state: customer(), option: purchase(200), appraisal: appraisal(1, 0, 2), rng: fixed(0.5), seed: 's' });
  assert.ok(shown.finalScore > worried.finalScore);
  assert.equal(shown.finalScore - worried.finalScore, 2 * 4 * 4); // weight 2 × Δvalue 4 × 4 points
});

test('eloquence on a factor they do not care about earns nothing', () => {
  const base = resolveDecision({ state: customer(), option: purchase(200), appraisal: appraisal(1, 0, 0), rng: fixed(0.5), seed: 's' });
  const flattered = resolveDecision({ state: customer(), option: purchase(200),
    appraisal: { factors: [...appraisal(1, 0, 0).factors, { factor: 'credibility', value: 2, reason: 'amazing pitch' }] }, rng: fixed(0.5), seed: 's' });
  assert.equal(flattered.finalScore, base.finalScore);
});

test('cofounder with a good alternative: a weak unpaid offer is never simply accepted', () => {
  const matteo: DecisionState = {
    role: 'engineering student offered a cofounder role', goals: ['graduate', 'earn some money'], pressures: [{ text: 'parents want him to graduate', expiresGameTime: null }],
    alternatives: [{ text: 'a paid internship offer at a big consultancy', strength: 0.9 }],
    limits: [{ term: 'salaryMonthly', op: 'min', value: 400, note: 'needs income for rent share' }],
    requiresApproval: null,
    criteria: [{ factor: 'trust', weight: 2, note: 'old friend' }, { factor: 'offer_quality', weight: 2, note: 'is the stake worth it' }],
    baseWillingness: 45,
  };
  for (const x of rolls) {
    const r = resolveDecision({ state: matteo, option: { kind: 'join_company', terms: { equityPercent: 20, salaryMonthly: 0 } },
      appraisal: { factors: [{ factor: 'trust', value: 2, reason: 'friend' }, { factor: 'offer_quality', value: -1, reason: 'drop out for 20% and no pay' }] }, rng: fixed(x), seed: 's' });
    assert.ok(!POSITIVE.includes(r.outcome), `roll ${x} → ${r.outcome}`);
  }
});

test('seeded: the same seed gives the same decision; the roll is bounded', () => {
  const run = (seed: string) => resolveDecision({ state: customer(), option: purchase(200), appraisal: appraisal(1, 1, 0), rng: seededRng(seed), seed });
  assert.deepEqual(run('game:req-1:offer:1'), run('game:req-1:offer:1'));
  for (let i = 0; i < 200; i++) assert.ok(Math.abs(run(`s${i}`).roll) <= ROLL_RANGE);
});

test('decision reuse: a non-startup decision (a lord granting passage) runs through the same engine', () => {
  const lord: DecisionState = {
    role: 'border lord asked to let a caravan through', goals: ['keep the pass safe', 'fill the treasury'], pressures: [{ text: 'bandit raids this season', expiresGameTime: null }],
    alternatives: [{ text: 'close the pass until spring', strength: 0.4 }],
    limits: [{ term: 'toll', op: 'min', value: 50, note: 'the council set a minimum toll' }],
    requiresApproval: null,
    criteria: [{ factor: 'trust', weight: 2, note: 'does not know the merchant' }, { factor: 'risk', weight: 3, note: 'raids' }],
    baseWillingness: 50,
  };
  const ask = (toll: number) => resolveDecision({ state: lord, option: { kind: 'grant_passage', terms: { toll } },
    appraisal: { factors: [{ factor: 'trust', value: 1, reason: 'sealed letter' }, { factor: 'risk', value: 1, reason: 'armed escort' }] }, rng: fixed(0.5), seed: 's' });
  assert.ok(!POSITIVE.includes(ask(20).outcome));
  assert.deepEqual(ask(20).counterTerms, { toll: 50 });
  assert.equal(ask(80).outcome, 'accept');
});

test('the core engine contains no pack vocabulary', () => {
  const banned = /\b(startup|investor|customer|cap table|equity|company|companies|revenue|founder|mana|kingdom|spice|guild|army)\b/i;
  for (const f of readdirSync('src/engine')) {
    const text = readFileSync(`src/engine/${f}`, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const hit = text.match(banned);
    assert.equal(hit, null, `src/engine/${f} mentions "${hit?.[0]}"`);
  }
});
