import type { z } from 'zod';
import {
  ALLOWED_OPS, CreateMemoryOpSchema, UpdateRelationshipOpSchema, UpsertKnowledgeOpSchema,
  type CharacterProposal,
} from '../domain/schemas.ts';
import type { Character } from '../domain/types.ts';

// The model proposes; this module decides. Anything not explicitly allowed is rejected.

export type AcceptedChange =
  | { op: 'create_memory'; ownerId: string; summary: string; importance: number; emotionalWeight: number; subjectIds: string[]; notes: string[] }
  | { op: 'upsert_knowledge'; ownerId: string; topic: string; belief: string; confidence: number; sourceKind: 'told' | 'observed' | 'inferred'; aboutCharacterId: string | null; notes: string[] }
  | { op: 'update_relationship'; fromId: string; toId: string; summary: string; notes: string[] };

export interface Rejection {
  index: number;
  proposal: unknown;
  reason: string;
}

export interface ValidationContext {
  npc: Character;
  observerIds: string[]; // who perceived the exchange these changes come from
  findCharacter: (name: string) => Character | undefined;
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
  const requested = requestedName.trim().toLowerCase().replace(/^my\s+/, '');
  if (!RELATION_LABELS.has(requested) && first(p.name) !== first(requestedName)) {
    reasons.push(`name "${p.name}" does not match the requested person "${requestedName}"`);
  }
  if (existing.some((c) => c.name.toLowerCase() === p.name.trim().toLowerCase())) {
    reasons.push(`a character named "${p.name}" already exists`);
  }
  return reasons;
}
