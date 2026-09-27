import { COMPUTED_FACTORS, OUTCOMES, type Appraisal, type DecisionState, type Factor, type Outcome } from '../domain/schemas.ts';
import type { Offer } from '../domain/types.ts';

// ============================================================================
// Decision Resolution Engine.
//
// The model portrays people; it does not judge whether the player succeeds.
// For a meaningful decision (an offer), the outcome is resolved here from:
//   hard constraints   → which outcomes are possible at all
//   weighted factors   → how the character's own criteria see this offer
//   a bounded roll     → uncertainty, never enough to make an impossible or terrible offer succeed
// The model then expresses the resolved outcome in character.
// ============================================================================

/** Best → worst. Blocked outcomes are skipped downwards. */
export const LADDER: Outcome[] = [...OUTCOMES];

/** Score bands (after the roll) → the outcome the character leans to before constraints. */
const BANDS: [number, Outcome][] = [
  [75, 'accept'], [63, 'accept_conditionally'], [52, 'counter'], [42, 'request_more_information'], [32, 'delay'], [15, 'reject'], [0, 'disengage'],
];

export const ROLL_RANGE = 10; // the roll moves the score by at most ±10 points (of 100)
const POINTS_PER_UNIT = 4; // weight (0–3) × value (−2…+2) × 4 → at most ±24 per factor

export interface FactorResult {
  factor: Factor;
  weight: number;
  value: number;
  contribution: number;
  source: 'appraisal' | 'computed' | 'missing';
  reason: string;
}

export interface CounterLimits {
  maxPriceMonthlyCents?: number;
  maxAmountCents?: number;
  minAmountCents?: number;
  minSalaryMonthlyCents?: number;
  minEquityPercent?: number;
}

export interface Resolution {
  outcome: Outcome;
  scoreOutcome: Outcome;
  candidates: Outcome[];
  blocked: { outcome: Outcome; reason: string }[];
  factors: FactorResult[];
  base: number;
  weighted: number;
  preRoll: number;
  seed: string;
  roll: number;
  finalScore: number;
  reasons: string[];
  constraintNotes: string[];
  counterLimits: CounterLimits;
}

const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)));

// ---- deterministic randomness ----
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
/** mulberry32 seeded by a string. Same seed ⇒ same sequence. */
export function seededRng(seed: string): () => number {
  let a = hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function constraint(state: DecisionState, kind: string) {
  return state.hardConstraints.find((c) => c.kind === kind);
}

/** Hard constraints decide which outcomes exist. Nothing downstream can re-enable a blocked outcome. */
export function applyHardConstraints(state: DecisionState, offer: Offer): { blocked: Resolution['blocked']; notes: string[]; limits: CounterLimits; escalate: boolean } {
  const blocked: Resolution['blocked'] = [];
  const notes: string[] = [];
  const limits: CounterLimits = {};
  const noYes = (reason: string) => {
    notes.push(reason);
    for (const o of ['accept', 'accept_conditionally'] as Outcome[]) if (!blocked.some((b) => b.outcome === o)) blocked.push({ outcome: o, reason });
  };
  const t = offer.terms;
  const maxMonthly = constraint(state, 'max_monthly_spend_eur');
  if (maxMonthly?.value != null && offer.kind === 'purchase') {
    limits.maxPriceMonthlyCents = Math.round(maxMonthly.value * 100);
    if ((t.priceMonthlyCents ?? 0) > limits.maxPriceMonthlyCents) noYes(`price is above what they can approve per month (${maxMonthly.note || `max €${maxMonthly.value}`})`);
  }
  const maxOnce = constraint(state, 'max_one_off_spend_eur');
  if (maxOnce?.value != null && offer.kind === 'investment') {
    limits.maxAmountCents = Math.round(maxOnce.value * 100);
    if ((t.amountCents ?? 0) > limits.maxAmountCents) noYes(`amount is above their maximum (${maxOnce.note || `max €${maxOnce.value}`})`);
  }
  const minOnce = constraint(state, 'min_one_off_spend_eur');
  if (minOnce?.value != null && offer.kind === 'investment') {
    limits.minAmountCents = Math.round(minOnce.value * 100);
    if ((t.amountCents ?? 0) < limits.minAmountCents) noYes(`amount is below their minimum (${minOnce.note || `min €${minOnce.value}`})`);
  }
  const minIncome = constraint(state, 'min_monthly_income_eur');
  if (minIncome?.value != null && (offer.kind === 'join_company' || offer.kind === 'hire')) {
    limits.minSalaryMonthlyCents = Math.round(minIncome.value * 100);
    if ((t.salaryMonthlyCents ?? 0) < limits.minSalaryMonthlyCents) noYes(`the offer doesn't cover the income they need (${minIncome.note || `min €${minIncome.value}/month`})`);
  }
  const minEquity = constraint(state, 'min_equity_percent');
  if (minEquity?.value != null && (offer.kind === 'join_company' || offer.kind === 'investment')) {
    limits.minEquityPercent = minEquity.value;
    if ((t.equityPercent ?? 0) < minEquity.value) noYes(`the stake is below what they would accept (${minEquity.note || `min ${minEquity.value}%`})`);
  }
  const approval = constraint(state, 'requires_approval');
  if (approval) noYes(`they cannot say a final yes alone (${approval.note || 'needs approval'})`);
  return { blocked, notes, limits, escalate: Boolean(approval) };
}

/** Factors the engine computes from canonical numbers. */
function computeFactor(factor: Factor, state: DecisionState, offer: Offer): { value: number; reason: string } | null {
  const t = offer.terms;
  if (factor === 'alternatives') {
    const best = Math.max(0, ...state.alternatives.map((a) => a.strength));
    const top = state.alternatives.find((a) => a.strength === best);
    return { value: -Math.round(best * 2), reason: top ? `alternative: ${top.text}` : 'no real alternative' };
  }
  if (factor === 'price_fit') {
    const ratioScore = (r: number) => (r <= 0.5 ? 2 : r <= 0.8 ? 1 : r <= 1 ? 0 : r <= 1.5 ? -1 : -2);
    const maxMonthly = constraint(state, 'max_monthly_spend_eur');
    if (offer.kind === 'purchase' && maxMonthly?.value && t.priceMonthlyCents) {
      const v = ratioScore(t.priceMonthlyCents / (maxMonthly.value * 100));
      return { value: v, reason: v >= 1 ? 'price is comfortable' : v === 0 ? 'price is at the limit' : 'price feels high' };
    }
    const minIncome = constraint(state, 'min_monthly_income_eur');
    if ((offer.kind === 'hire' || offer.kind === 'join_company') && minIncome?.value) {
      const r = (t.salaryMonthlyCents ?? 0) / (minIncome.value * 100);
      const v = r >= 1.5 ? 2 : r >= 1 ? 1 : r >= 0.5 ? -1 : -2;
      return { value: v, reason: v > 0 ? 'the pay covers their needs' : 'the pay does not cover their needs' };
    }
    if (offer.kind === 'investment') {
      const lo = constraint(state, 'min_one_off_spend_eur')?.value ?? 0;
      const hi = constraint(state, 'max_one_off_spend_eur')?.value ?? Infinity;
      const amt = (t.amountCents ?? 0) / 100;
      const v = amt >= lo && amt <= hi ? 1 : -2;
      return { value: v, reason: v > 0 ? 'the round fits their cheque size' : 'the round does not fit their cheque size' };
    }
    return null;
  }
  return null;
}

export function scoreToOutcome(score: number): Outcome {
  return BANDS.find(([min]) => score >= min)![1];
}

export function resolveDecision(input: { state: DecisionState; offer: Offer; appraisal: Appraisal; rng: () => number; seed: string }): Resolution {
  const { state, offer, appraisal } = input;
  const hard = applyHardConstraints(state, offer);
  const candidates = LADDER.filter((o) => !hard.blocked.some((b) => b.outcome === o) && (o !== 'escalate_to_decision_maker' || hard.escalate));

  // Only this character's criteria count. Eloquence on a factor they don't care about earns nothing.
  const criteria = [...state.criteria];
  if (state.alternatives.length && !criteria.some((c) => c.factor === 'alternatives')) criteria.push({ factor: 'alternatives', weight: 2, note: 'what happens if they say no' });
  const factors: FactorResult[] = criteria.filter((c) => c.weight > 0).map((c) => {
    if (COMPUTED_FACTORS.includes(c.factor)) {
      const r = computeFactor(c.factor, state, offer) ?? { value: 0, reason: 'not applicable' };
      return { factor: c.factor, weight: c.weight, value: r.value, contribution: c.weight * r.value * POINTS_PER_UNIT, source: 'computed' as const, reason: r.reason };
    }
    const a = appraisal.factors.find((f) => f.factor === c.factor);
    if (!a) return { factor: c.factor, weight: c.weight, value: 0, contribution: 0, source: 'missing' as const, reason: 'not assessed' };
    return { factor: c.factor, weight: c.weight, value: a.value, contribution: c.weight * a.value * POINTS_PER_UNIT, source: 'appraisal' as const, reason: a.reason };
  });

  const weighted = factors.reduce((n, f) => n + f.contribution, 0);
  const preRoll = clamp(state.baseWillingness + weighted);
  const roll = Math.round((input.rng() * 2 - 1) * ROLL_RANGE);
  const finalScore = clamp(preRoll + roll);
  const scoreOutcome = scoreToOutcome(finalScore);
  const outcome = LADDER.slice(LADDER.indexOf(scoreOutcome)).find((o) => candidates.includes(o)) ?? 'reject';

  const reasons = [...factors]
    .filter((f) => f.contribution !== 0)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 3)
    .map((f) => `${f.contribution > 0 ? '+' : '−'} ${f.reason}`);
  return {
    outcome, scoreOutcome, candidates, blocked: hard.blocked, factors, base: state.baseWillingness, weighted, preRoll, seed: input.seed, roll,
    finalScore, reasons: [...reasons, ...hard.notes.map((n) => `constraint: ${n}`)], constraintNotes: hard.notes, counterLimits: hard.limits,
  };
}

/** How long before the character reconsiders a still-open offer (game minutes). null = can revisit next turn. */
export function reconsiderAfterMinutes(outcome: Outcome): number | null {
  switch (outcome) {
    case 'delay': return 2 * 1440;
    case 'escalate_to_decision_maker': return 3 * 1440;
    case 'request_more_information': return null;
    default: return null;
  }
}

export const MAX_ATTEMPTS = 3; // after this many open-ended outcomes, the character stops considering the same offer
