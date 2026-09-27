import { COMPUTED_FACTORS, OUTCOMES, type Appraisal, type DecisionState, type Factor, type Outcome } from '../domain/schemas.ts';

// ============================================================================
// Decision Resolution Engine (generic).
//
// The model portrays people; it does not judge whether the player succeeds.
// A meaningful decision is resolved here from:
//   hard limits        → which outcomes are possible at all
//   weighted factors   → how THIS actor's own criteria see the option
//   a bounded roll     → uncertainty, never enough to make an impossible or terrible option succeed
// Nothing here knows what the option is (a purchase, an alliance, a duel): only numeric terms,
// the actor's limits on those terms, and factor values.
// ============================================================================

/** What is being decided, in generic form. */
export interface DecisionOption {
  kind: string; // pack-defined, e.g. "purchase", "grant_passage"
  terms: Record<string, number>; // pack-defined numeric terms, e.g. { priceMonthly: 1000 }
}

/** Best → worst. Blocked outcomes are skipped downwards. */
export const LADDER: Outcome[] = [...OUTCOMES];
const BANDS: [number, Outcome][] = [
  [75, 'accept'], [63, 'accept_conditionally'], [52, 'counter'], [42, 'request_more_information'], [32, 'delay'], [15, 'reject'], [0, 'disengage'],
];
export const POSITIVE: Outcome[] = ['accept', 'accept_conditionally'];
export const NEGATIVE: Outcome[] = ['reject', 'disengage'];

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
  limitNotes: string[];
  /** A counter this actor could live with: each violated limit moved to its bound. */
  counterTerms: Record<string, number> | null;
}

const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)));

/** Hard limits decide which outcomes exist. Nothing downstream can re-enable a blocked outcome. */
export function applyLimits(state: DecisionState, option: DecisionOption) {
  const blocked: Resolution['blocked'] = [];
  const notes: string[] = [];
  const counter: Record<string, number> = { ...option.terms };
  let violated = false;
  const noYes = (reason: string) => {
    notes.push(reason);
    for (const o of POSITIVE) if (!blocked.some((b) => b.outcome === o)) blocked.push({ outcome: o, reason });
  };
  for (const l of state.limits) {
    const v = option.terms[l.term];
    if (v === undefined) continue; // limit on a term this option doesn't have
    if ((l.op === 'max' && v > l.value) || (l.op === 'min' && v < l.value)) {
      violated = true;
      counter[l.term] = l.value;
      noYes(`${l.term} ${l.op === 'max' ? 'above' : 'below'} what they can accept${l.note ? ` (${l.note})` : ''}`);
    }
  }
  if (state.requiresApproval) noYes(`they cannot give a final yes alone (needs ${state.requiresApproval})`);
  return { blocked, notes, escalate: Boolean(state.requiresApproval), counterTerms: violated ? counter : null };
}

/** Computed factors come from canonical numbers, never from the model. */
function computeFactor(factor: Factor, state: DecisionState, option: DecisionOption): { value: number; reason: string } | null {
  if (factor === 'alternatives') {
    const best = Math.max(0, ...state.alternatives.map((a) => a.strength));
    const top = state.alternatives.find((a) => a.strength === best);
    return { value: -Math.round(best * 2), reason: top ? `alternative: ${top.text}` : 'no real alternative' };
  }
  if (factor === 'terms_fit') {
    const scores: number[] = [];
    for (const l of state.limits) {
      const v = option.terms[l.term];
      if (v === undefined || l.value === 0) continue;
      const r = v / l.value;
      scores.push(l.op === 'max'
        ? (r <= 0.5 ? 2 : r <= 0.8 ? 1 : r <= 1 ? 0 : r <= 1.5 ? -1 : -2)
        : (r >= 1.5 ? 2 : r >= 1 ? 1 : r >= 0.5 ? -1 : -2));
    }
    if (!scores.length) return null;
    const value = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    return { value, reason: value > 0 ? 'the terms fit comfortably' : value === 0 ? 'the terms are at the edge of acceptable' : 'the terms do not fit' };
  }
  return null;
}

export function scoreToOutcome(score: number): Outcome {
  return BANDS.find(([min]) => score >= min)![1];
}

export function resolveDecision(input: { state: DecisionState; option: DecisionOption; appraisal: Appraisal; rng: () => number; seed: string }): Resolution {
  const { state, option, appraisal } = input;
  const hard = applyLimits(state, option);
  const candidates = LADDER.filter((o) => !hard.blocked.some((b) => b.outcome === o) && (o !== 'escalate_to_decision_maker' || hard.escalate));

  // Only this actor's criteria count: eloquence on a factor they don't care about earns nothing.
  const criteria = [...state.criteria];
  if (state.alternatives.length && !criteria.some((c) => c.factor === 'alternatives')) criteria.push({ factor: 'alternatives', weight: 2, note: 'what happens if they say no' });
  if (state.limits.length && !criteria.some((c) => c.factor === 'terms_fit')) criteria.push({ factor: 'terms_fit', weight: 2, note: 'how the terms fit their limits' });
  const factors: FactorResult[] = criteria.filter((c) => c.weight > 0).map((c) => {
    if (COMPUTED_FACTORS.includes(c.factor)) {
      const r = computeFactor(c.factor, state, option) ?? { value: 0, reason: 'not applicable' };
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
    finalScore, reasons: [...reasons, ...hard.notes.map((n) => `limit: ${n}`)], limitNotes: hard.notes, counterTerms: hard.counterTerms,
  };
}

/** How long before the actor reconsiders an open option (game minutes). null = can revisit on the next interaction. */
export function reconsiderAfterMinutes(outcome: Outcome): number | null {
  switch (outcome) {
    case 'delay': return 2 * 1440;
    case 'escalate_to_decision_maker': return 3 * 1440;
    default: return null;
  }
}

export const MAX_ATTEMPTS = 3; // after this many open-ended outcomes, the actor stops considering the same option
