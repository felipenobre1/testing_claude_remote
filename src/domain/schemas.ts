import { z } from 'zod';

// Everything the model returns is parsed through these schemas before the backend looks at it.
// The same schemas are converted to JSON Schema for provider-side structured output
// (see toWireSchema); range/length constraints are enforced here, client-side.

export const INTENTS = ['start_conversation', 'speak', 'private_thought', 'end_conversation', 'general_action'] as const;

/** Call 1 — player perspective: split raw input into observable / private parts. */
export const InterpretResultSchema = z.object({
  intents: z.array(z.enum(INTENTS)).min(1),
  target: z
    .object({
      name: z.string().min(1).max(80),
      relationHint: z.string().max(80).nullable(),
    })
    .nullable(),
  channel: z.enum(['phone', 'in_person', 'message']).nullable(),
  spokenText: z.string().max(2000).nullable(),
  visibleAction: z.string().max(600).nullable(),
  privateThought: z.string().max(1000).nullable(),
  newLocation: z.string().min(2).max(160).nullable(),
  newSceneDescription: z.string().max(400).nullable(), // what the new location looks like; required when newLocation is set
  safety: z.enum(['none', 'self_harm', 'serious_violence']),
  minutesElapsed: z.number().int().min(0).max(120),
  narration: z.string().max(1500),
  clarificationQuestion: z.string().max(400).nullable(),
});
export type InterpretResult = z.infer<typeof InterpretResultSchema>;

/** Character generation — only when a referenced person does not exist yet. */
export const CharacterProposalSchema = z.object({
  name: z.string().min(1).max(80),
  age: z.number().int().min(5).max(100),
  gender: z.string().max(40).nullable(),
  role: z.string().min(2).max(80),
  occupation: z.string().max(120).nullable(),
  background: z.string().min(20).max(1200),
  personality: z.string().min(20).max(800),
  traits: z.array(z.string().min(1).max(60)).min(2).max(8),
  values: z.array(z.string().min(1).max(80)).min(1).max(6),
  goals: z.array(z.string().min(1).max(160)).min(1).max(6),
  fears: z.array(z.string().min(1).max(160)).min(1).max(6),
  location: z.string().min(2).max(160),
  relationshipToPlayer: z.string().min(10).max(800),
});
export type CharacterProposal = z.infer<typeof CharacterProposalSchema>;

// ---- Allowlisted state-change operations an NPC turn may propose (owner is always that NPC). ----

export const CreateMemoryOpSchema = z.strictObject({
  op: z.literal('create_memory'),
  summary: z.string().min(3).max(400),
  importance: z.number().int().min(1).max(5),
  emotionalWeight: z.number().int().min(-5).max(5),
  aboutCharacterNames: z.array(z.string().max(80)).max(6),
});
export const UpsertKnowledgeOpSchema = z.strictObject({
  op: z.literal('upsert_knowledge'),
  topic: z.string().regex(/^[a-z0-9][a-z0-9_.-]{1,59}$/, 'topic must be a short lowercase key like "felipe.savings"'),
  belief: z.string().min(3).max(400),
  confidence: z.number().min(0).max(1),
  sourceKind: z.enum(['told', 'observed', 'inferred']),
  aboutCharacterName: z.string().max(80).nullable(),
});
export const UpdateRelationshipOpSchema = z.strictObject({
  op: z.literal('update_relationship'),
  towardCharacterName: z.string().min(1).max(80),
  summary: z.string().min(10).max(800),
});

export const ChangeOpSchema = z.discriminatedUnion('op', [CreateMemoryOpSchema, UpsertKnowledgeOpSchema, UpdateRelationshipOpSchema]);
export type ChangeOp = z.infer<typeof ChangeOpSchema>;
export const ALLOWED_OPS = ['create_memory', 'upsert_knowledge', 'update_relationship'] as const;

/** Call 2 — NPC perspective. `changes` is what the schema asks the model for. */
const npcTurnFields = {
  dialogue: z.string().max(3000),
  perceivable: z.string().max(600),
  endsConversation: z.boolean(),
  eventSummary: z.string().min(3).max(400),
  importance: z.number().int().min(1).max(5),
  mentionedCharacterNames: z.array(z.string().max(80)).max(10),
  minutesElapsed: z.number().int().min(0).max(60),
};
export const NpcTurnWireSchema = z.object({ ...npcTurnFields, changes: z.array(ChangeOpSchema) });
/** Parsing schema: envelope strictly, changes loosely — each change is validated individually by the validator. */
export const NpcTurnEnvelopeSchema = z.object({ ...npcTurnFields, changes: z.array(z.unknown()) });
export type NpcTurnEnvelope = z.infer<typeof NpcTurnEnvelopeSchema>;

// ---- JSON Schema for provider structured output ----

const UNSUPPORTED_KEYS = new Set([
  '$schema', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minItems', 'maxItems', 'pattern', 'format', 'default',
]);

/**
 * Converts a zod schema to a strict-mode-friendly JSON Schema:
 * every object closed and fully required, oneOf→anyOf, const→enum, and
 * constraints the providers do not reliably support stripped (zod re-checks them on parse).
 */
export function toWireSchema(schema: z.ZodType): Record<string, unknown> {
  return clean(z.toJSONSchema(schema, { target: 'draft-7' })) as Record<string, unknown>;
}
function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED_KEYS.has(k)) continue;
    if (k === 'oneOf') out.anyOf = clean(v);
    else if (k === 'const') out.enum = [v];
    else out[k] = clean(v);
  }
  if (out.type === 'object' && out.properties) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as object);
  }
  return out;
}
