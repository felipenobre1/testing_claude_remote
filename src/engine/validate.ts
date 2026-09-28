import type { z } from 'zod';
import {
  ALLOWED_OPS, CreateMemoryOpSchema, NpcFulfillOpSchema, NpcPromiseOpSchema, ThreadSignalOpSchema, UpdateRelationshipOpSchema, UpsertKnowledgeOpSchema,
  type DecisionState, type NpcTurnEnvelope,
  type CharacterProposal,
} from '../domain/schemas.ts';
import type { Character, Obligation, Offer, StoryThread } from '../domain/types.ts';
import { applyLimits, type Resolution } from './decision.ts';

// The model proposes; this module decides. Anything not explicitly allowed is rejected.

export type AcceptedChange =
  | { op: 'create_memory'; ownerId: string; summary: string; importance: number; emotionalWeight: number; subjectIds: string[]; notes: string[] }
  | { op: 'upsert_knowledge'; ownerId: string; topic: string; belief: string; confidence: number; sourceKind: 'told' | 'observed' | 'inferred'; aboutCharacterId: string | null; notes: string[] }
  | { op: 'update_relationship'; fromId: string; toId: string; summary: string; notes: string[] }
  | { op: 'make_promise'; ownerId: string; toId: string; description: string; dueInDays: number | null; notes: string[] }
  | { op: 'fulfill_promise'; ownerId: string; promiseId: string; notes: string[] }
  | { op: 'thread_signal'; ownerId: string; threadId: string; factor: string; value: number; reason: string; notes: string[] };

export interface Rejection {
  index: number;
  proposal: unknown;
  reason: string;
}

export interface ValidationContext {
  npc: Character;
  observerIds: string[]; // who perceived the exchange these changes come from
  findCharacter: (name: string) => Character | undefined;
  partnerId?: string; // who the NPC is talking to (creditor of NPC promises)
  obligation?: (id: string) => Obligation | undefined;
  thread?: (id: string) => StoryThread | undefined;
}

/** Operations the model is known to reach for that are never allowed through conversation. */
const FORBIDDEN_OPS: Record<string, string> = {
  update_fact: 'Facts are canonical world truth and cannot be changed by conversation',
  create_fact: 'Facts are canonical world truth and cannot be created by conversation',
  delete_fact: 'Facts are canonical world truth and cannot be deleted by conversation',
  set_cash: 'Money is canonical state and cannot be changed by conversation',
  update_character: 'Character identity is immutable after creation',
  update_personality: 'Character identity is immutable after creation',
  create_character: 'Characters are only created by the backend when a new person is referenced',
  respond_to_offer: 'Offers are resolved by the decision engine; express the resolved outcome in expressedDecision instead',
  accept_offer: 'Offers are resolved by the decision engine; express the resolved outcome in expressedDecision instead',
};

const zodReason = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');

export function validateChanges(raw: unknown[], ctx: ValidationContext): { accepted: AcceptedChange[]; rejected: Rejection[] } {
  const accepted: AcceptedChange[] = [];
  const rejected: Rejection[] = [];
  const seen = new Set<string>();
  const ownerId = ctx.npc.id;

  raw.forEach((proposal, index) => {
    const reject = (reason: string) => rejected.push({ index, proposal, reason });
    if (!proposal || typeof proposal !== 'object' || typeof (proposal as { op?: unknown }).op !== 'string') {
      return reject('not an operation object with a string "op"');
    }
    const op = (proposal as { op: string }).op;
    if (FORBIDDEN_OPS[op]) return reject(`forbidden operation "${op}": ${FORBIDDEN_OPS[op]}`);
    if (!(ALLOWED_OPS as readonly string[]).includes(op)) return reject(`unsupported operation "${op}" (allowed: ${ALLOWED_OPS.join(', ')})`);
    if (!ctx.observerIds.includes(ownerId)) return reject(`${ctx.npc.name} did not observe this exchange`);

    if (op === 'create_memory') {
      const r = CreateMemoryOpSchema.safeParse(proposal);
      if (!r.success) return reject(`invalid create_memory: ${zodReason(r.error)}`);
      const key = `mem:${r.data.summary.trim().toLowerCase()}`;
      if (seen.has(key)) return reject('duplicate memory in the same turn');
      seen.add(key);
      const notes: string[] = [];
      const subjectIds: string[] = [];
      for (const name of r.data.aboutCharacterNames) {
        const c = ctx.findCharacter(name);
        if (c) subjectIds.push(c.id);
        else notes.push(`unknown subject "${name}" not linked`);
      }
      accepted.push({ op: 'create_memory', ownerId, summary: r.data.summary, importance: r.data.importance, emotionalWeight: r.data.emotionalWeight, subjectIds: [...new Set(subjectIds)], notes });
    } else if (op === 'upsert_knowledge') {
      const r = UpsertKnowledgeOpSchema.safeParse(proposal);
      if (!r.success) return reject(`invalid upsert_knowledge: ${zodReason(r.error)}`);
      const key = `know:${r.data.topic}`;
      if (seen.has(key)) return reject(`duplicate knowledge topic "${r.data.topic}" in the same turn`);
      seen.add(key);
      const notes: string[] = [];
      let aboutCharacterId: string | null = null;
      if (r.data.aboutCharacterName) {
        const c = ctx.findCharacter(r.data.aboutCharacterName);
        if (c) aboutCharacterId = c.id;
        else notes.push(`unknown subject "${r.data.aboutCharacterName}" not linked`);
      }
      accepted.push({ op: 'upsert_knowledge', ownerId, topic: r.data.topic, belief: r.data.belief, confidence: r.data.confidence, sourceKind: r.data.sourceKind, aboutCharacterId, notes });
    } else if (op === 'make_promise') {
      const r = NpcPromiseOpSchema.safeParse(proposal);
      if (!r.success) return reject(`invalid make_promise: ${zodReason(r.error)}`);
      if (!ctx.partnerId) return reject('make_promise: nobody to promise to');
      if (r.data.amount !== null && r.data.amount > 0) return reject('make_promise: NPC money promises are not supported yet (promise help, work or time instead)');
      if (r.data.dueInDays !== null && (r.data.dueInDays < 0 || r.data.dueInDays > 3650)) return reject('make_promise: dueInDays must be between 0 and 3650');
      accepted.push({ op: 'make_promise', ownerId, toId: ctx.partnerId, description: r.data.description, dueInDays: r.data.dueInDays, notes: [] });
    } else if (op === 'thread_signal') {
      const r = ThreadSignalOpSchema.safeParse(proposal);
      if (!r.success) return reject(`invalid thread_signal: ${zodReason(r.error)}`);
      const t = ctx.thread?.(r.data.threadId);
      if (!t || !t.participantIds.includes(ownerId) || t.status === 'resolved') return reject(`${ctx.npc.name} is not part of an open situation ${r.data.threadId}`);
      if (t.resolution.actorId !== ownerId) return reject('only the person deciding a situation can shift how they weigh it');
      accepted.push({ op: 'thread_signal', ownerId, threadId: t.id, factor: r.data.factor, value: r.data.value, reason: r.data.reason, notes: [] });
    } else if (op === 'fulfill_promise') {
      const r = NpcFulfillOpSchema.safeParse(proposal);
      if (!r.success) return reject(`invalid fulfill_promise: ${zodReason(r.error)}`);
      const o = ctx.obligation?.(r.data.promiseId);
      if (!o || o.debtorId !== ownerId) return reject(`no promise ${r.data.promiseId} made by ${ctx.npc.name}`);
      if (o.status !== 'open') return reject(`promise ${r.data.promiseId} is already ${o.status}`);
      accepted.push({ op: 'fulfill_promise', ownerId, promiseId: o.id, notes: [] });
    } else {
      const r = UpdateRelationshipOpSchema.safeParse(proposal);
      if (!r.success) return reject(`invalid update_relationship: ${zodReason(r.error)}`);
      const toward = ctx.findCharacter(r.data.towardCharacterName);
      if (!toward) return reject(`update_relationship toward unknown character "${r.data.towardCharacterName}"`);
      if (toward.id === ownerId) return reject('a character cannot have a relationship with themselves');
      const key = `rel:${toward.id}`;
      if (seen.has(key)) return reject(`duplicate relationship update toward ${toward.name}`);
      seen.add(key);
      accepted.push({ op: 'update_relationship', fromId: ownerId, toId: toward.id, summary: r.data.summary, notes: [] });
    }
  });
  return { accepted, rejected };
}

const RELATION_LABELS = new Set([
  'mom', 'mum', 'mother', 'mamma', 'mama', 'dad', 'father', 'papà', 'papa', 'brother', 'sister', 'fratello', 'sorella',
  'grandma', 'grandpa', 'nonna', 'nonno', 'uncle', 'aunt', 'zio', 'zia', 'cousin', 'cugino', 'cugina',
]);

/** Backend checks on a generated character, beyond the schema. Returns rejection reasons (empty = ok). */
export function validateCharacterProposal(p: CharacterProposal, requestedName: string, existing: Character[]): string[] {
  const reasons: string[] = [];
  const first = (s: string) => s.trim().split(/\s+/)[0]!.toLowerCase();
  const requested = requestedName.trim().toLowerCase().replace(/^(my|the|a|an|o|a|os|as|um|uma|meu|minha|il|la|lo|el)\s+/, '');
  // A role or label ("the surgeon", "o cirurgião", "Mom") gets a real name; the label must then be part of their role.
  const isLabel = RELATION_LABELS.has(requested) || /^[a-zà-ÿ]/.test(requestedName.trim())
    || `${p.role} ${p.occupation ?? ''}`.toLowerCase().includes(requested);
  if (!isLabel && first(p.name) !== first(requestedName)) {
    reasons.push(`name "${p.name}" does not match the requested person "${requestedName}"`);
  }
  if (existing.some((c) => c.name.toLowerCase() === p.name.trim().toLowerCase())) {
    reasons.push(`a character named "${p.name}" already exists`);
  }
  return reasons;
}

/**
 * The portrayal must express exactly the engine-resolved outcome (or none when there was no decision).
 * A counter must be something this character could actually accept under their own hard constraints.
 * Returns problems plus the counter terms (in cents) to execute.
 */
export function validatePortrayal(
  out: NpcTurnEnvelope, decision: { offer: Offer; state: DecisionState; resolution: Resolution } | null,
): { problems: string[]; counter: Record<string, number> | null } {
  if (!decision) {
    const problems = [];
    if (out.expressedDecision !== null) problems.push('expressedDecision must be null: there is no decision to make this turn');
    if (out.counterTerms !== null) problems.push('counterTerms must be null: there is no decision to make this turn');
    return { problems, counter: null };
  }
  const { offer, state, resolution } = decision;
  const problems: string[] = [];
  if (out.expressedDecision !== resolution.outcome) {
    problems.push(`expressedDecision must be "${resolution.outcome}" (the decision is already settled; express it, don't change it)`);
  }
  if (resolution.outcome === 'accept_conditionally' && !out.condition) problems.push('accept_conditionally needs the condition you are setting');
  if (resolution.outcome !== 'counter') return { problems, counter: null };
  if (!out.counterTerms || !out.counterTerms.terms.length) return { problems: [...problems, 'a counter needs counterTerms with the terms you change'], counter: null };
  const counter: Record<string, number> = { ...offer.terms };
  for (const t of out.counterTerms.terms) {
    if (!(t.key in offer.terms) && !state.limits.some((l) => l.term === t.key)) problems.push(`counterTerms: "${t.key}" is not a term of this offer`);
    counter[t.key] = t.value;
  }
  if (JSON.stringify(counter) === JSON.stringify(offer.terms)) problems.push('counterTerms must change something about the offer');
  // A counter must satisfy the actor's own limits (approval may still be needed afterwards).
  const still = applyLimits({ ...state, requiresApproval: null }, { kind: offer.kind, terms: counter });
  if (still.blocked.length) problems.push(`counterTerms break your own limits: ${still.notes.join('; ')}`);
  return { problems, counter: problems.length ? null : counter };
}

/** Sanity checks on a model-proposed decision state beyond the schema. */
export function decisionStateProblems(p: { criteria: { factor: string }[]; limits: { term: string; op: string; value: number }[] }): string[] {
  const problems: string[] = [];
  const f = p.criteria.map((c) => c.factor);
  if (new Set(f).size !== f.length) problems.push('each factor may appear only once in criteria');
  const k = p.limits.map((c) => `${c.term}:${c.op}`);
  if (new Set(k).size !== k.length) problems.push('each limit (term + op) may appear only once');
  for (const l of p.limits) if (l.value < 0) problems.push(`limit on ${l.term} must be non-negative`);
  return problems;
}
