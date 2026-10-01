import { z } from 'zod';

// Everything the model returns is parsed through these schemas before the backend looks at it.
// The same schemas are converted to JSON Schema for provider-side structured output
// (see toWireSchema); range/length constraints are enforced here, client-side.
//
// This file is ENGINE-level: nothing here is specific to a game pack. Packs add their own
// player actions (see packs/types.ts) and define what kinds of offers exist.

export const INTENTS = ['start_conversation', 'speak', 'private_thought', 'end_conversation', 'general_action'] as const;

// ---- Generic player actions with deterministic mechanics (resources, offers, promises). ----
// Every field is required (nullable where optional) so the schemas work in strict structured output.
// Amounts are in the pack's currency (major units).
const TermSchema = z.strictObject({ key: z.string().min(1).max(40), value: z.number() });
export const CORE_ACTIONS = [
  z.strictObject({ action: z.literal('pay'), amount: z.number(), description: z.string().min(2).max(200), fromEntityName: z.string().nullable(), recurringMonthly: z.boolean() }),
  z.strictObject({ action: z.literal('give_money'), toCharacterName: z.string(), amount: z.number(), description: z.string().max(200) }),
  z.strictObject({
    action: z.literal('make_offer'), toCharacterName: z.string(), kind: z.string().min(2).max(40), subject: z.string().max(120).nullable(),
    label: z.string().max(80).nullable(), terms: z.array(TermSchema).max(8), description: z.string().min(3).max(300),
  }),
  z.strictObject({ action: z.literal('respond_to_offer'), offerId: z.string(), accept: z.boolean() }),
  z.strictObject({ action: z.literal('make_promise'), toCharacterName: z.string(), description: z.string().min(3).max(300), amount: z.number().nullable(), dueInDays: z.number().nullable() }),
  z.strictObject({ action: z.literal('fulfill_promise'), promiseId: z.string() }),
  z.strictObject({
    action: z.literal('seek'), target: z.string().min(2).max(160), approach: z.string().min(2).max(200), hours: z.number(),
    ifPerson: z.strictObject({ name: z.string().min(2).max(80), role: z.string().min(2).max(120), channel: z.string().min(2).max(120) }).nullable(),
    ifChannel: z.string().max(160).nullable(),
  }),
  z.strictObject({
    action: z.literal('recall'), memory: z.string().min(3).max(400), kind: z.enum(['detail', 'knowledge', 'training', 'acquaintance']),
    skill: z.string().max(40).nullable(), // training: which skill it is
    acquaintance: z.strictObject({ name: z.string().min(2).max(80), role: z.string().min(2).max(120), where: z.string().min(2).max(160) }).nullable(),
    conflict: z.string().max(300).nullable(), // what it contradicts, or why it can't be — then it doesn't become true
  }),
  z.strictObject({ action: z.literal('research'), topic: z.string().min(2).max(120), findings: z.array(z.string().min(3).max(300)).min(1).max(5) }),
] as const;
type CoreAction = z.infer<(typeof CORE_ACTIONS)[number]>;
/** A pack action: an object with a literal `action` discriminator. */
export type PackActionValue = { action: string } & Record<string, unknown>;
export type PlayerAction = CoreAction | PackActionValue;

const interpretFields = {
  intents: z.array(z.enum(INTENTS)).min(1),
  target: z.object({ name: z.string().min(1).max(80), relationHint: z.string().max(80).nullable() }).nullable(),
  channel: z.enum(['phone', 'in_person', 'message']).nullable(),
  spokenText: z.string().max(2000).nullable(),
  visibleAction: z.string().max(600).nullable(),
  privateThought: z.string().max(1000).nullable(),
  newLocation: z.string().min(2).max(160).nullable(),
  newSceneDescription: z.string().max(400).nullable(), // what the new location looks like; required when newLocation is set
  safety: z.enum(['none', 'self_harm', 'serious_violence']),
  minutesElapsed: z.number().int().min(0).max(10080), // up to a week of focused work / waiting
  narration: z.string().max(1500),
  clarificationQuestion: z.string().max(400).nullable(),
  /** The player stepped out of the story to ask the game master something (rules, what they perceive or know). Nothing else happens. */
  gameMasterQuestion: z.string().max(600).nullable(),
  suggestions: z.array(z.string().min(3).max(160)).max(3),
  /** Socially significant things the player did this turn that people may remember and act on later. */
  deeds: z.array(z.object({
    what: z.string().min(3).max(200), against: z.string().max(80).nullable(), severity: z.number().int().min(1).max(5),
    tone: z.enum(['harm', 'kindness']), exposure: z.enum(['private', 'semi_public', 'public']),
  })).max(3),
};

/** Call 1 — player perspective. The action union = core actions + the pack's actions. */
export function interpretSchemaFor(packActions: readonly z.ZodObject[]) {
  const all = [...CORE_ACTIONS, ...packActions] as unknown as [z.ZodObject, z.ZodObject, ...z.ZodObject[]];
  return z.object({ ...interpretFields, actions: z.array(z.discriminatedUnion('action', all)).max(6) });
}
export const InterpretResultSchema = interpretSchemaFor([]);

/** The game master's out-of-character answer to the player. */
export const GameMasterAnswerSchema = z.object({ answer: z.string().min(1).max(1500) });
export type InterpretResult = Omit<z.infer<typeof InterpretResultSchema>, 'actions'> & { actions: PlayerAction[] };

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
// Promises with deterministic consequences. Offers are NOT decided here (see the Decision Resolution Engine).
export const NpcPromiseOpSchema = z.strictObject({
  op: z.literal('make_promise'), description: z.string().min(3).max(300), amount: z.number().nullable(), dueInDays: z.number().nullable(),
});
export const NpcFulfillOpSchema = z.strictObject({ op: z.literal('fulfill_promise'), promiseId: z.string() });

// ---- Independent decisions (generic) ----

export const OUTCOMES = [
  'accept', 'accept_conditionally', 'escalate_to_decision_maker', 'counter', 'request_more_information', 'delay', 'reject', 'disengage',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Generic factors a decision can weigh. Which ones matter (and how much) is per actor. */
export const FACTORS = [
  'need', 'urgency', 'trust', 'perceived_value', 'risk', 'switching_cost', 'effort', 'timing', 'offer_quality',
  'credibility', 'relationship', 'confidence_in_player', 'terms_fit', 'alternatives',
] as const;
export type Factor = (typeof FACTORS)[number];
/** Computed by the engine from canonical numbers, never assessed by the model. */
export const COMPUTED_FACTORS: Factor[] = ['terms_fit', 'alternatives'];

/** An actor's mind changing about a situation they are part of (see Story Threads). */
export const ThreadSignalOpSchema = z.strictObject({
  op: z.literal('thread_signal'), threadId: z.string(), factor: z.enum(FACTORS), value: z.number().int().min(-2).max(2), reason: z.string().min(2).max(200),
});

export const ChangeOpSchema = z.discriminatedUnion('op', [
  CreateMemoryOpSchema, UpsertKnowledgeOpSchema, UpdateRelationshipOpSchema, NpcPromiseOpSchema, NpcFulfillOpSchema, ThreadSignalOpSchema,
]);
export type ChangeOp = z.infer<typeof ChangeOpSchema>;
export const ALLOWED_OPS = ['create_memory', 'upsert_knowledge', 'update_relationship', 'make_promise', 'fulfill_promise', 'thread_signal'] as const;

const decisionStateFields = {
  role: z.string().min(2).max(160), // their position in this decision
  goals: z.array(z.string().min(2).max(200)).min(1).max(5),
  alternatives: z.array(z.strictObject({ text: z.string().min(2).max(200), strength: z.number().min(0).max(1) })).max(4),
  /** Hard limits on the option's numeric terms (pack-defined term keys). */
  limits: z.array(z.strictObject({ term: z.string().min(1).max(40), op: z.enum(['max', 'min']), value: z.number(), note: z.string().max(200) })).max(5),
  /** Who must approve before a final yes (a partner, a council, parents) — null if they decide alone. */
  requiresApproval: z.string().max(120).nullable(),
  criteria: z.array(z.strictObject({ factor: z.enum(FACTORS), weight: z.number().min(0).max(3), note: z.string().max(200) })).min(1).max(8),
  baseWillingness: z.number().min(0).max(100),
};
/** Stored, canonical, hidden from the player. */
export const DecisionStateSchema = z.object({
  ...decisionStateFields,
  pressures: z.array(z.strictObject({ text: z.string().min(2).max(200), expiresGameTime: z.string().nullable() })).max(5),
});
export type DecisionState = z.infer<typeof DecisionStateSchema>;
/** What the model proposes when an actor first faces a kind of decision. */
export const DecisionStateProposalSchema = z.object({
  ...decisionStateFields,
  pressures: z.array(z.strictObject({ text: z.string().min(2).max(200), expiresInDays: z.number().nullable() })).max(4),
});
export type DecisionStateProposal = z.infer<typeof DecisionStateProposalSchema>;

/** The model assesses factors from the actor's perspective; the engine decides. */
export const AppraisalSchema = z.object({
  factors: z.array(z.strictObject({ factor: z.enum(FACTORS), value: z.number().int().min(-2).max(2), reason: z.string().min(2).max(200) })).max(14),
});
export type Appraisal = z.infer<typeof AppraisalSchema>;

const npcTurnFields = {
  expressedDecision: z.enum(OUTCOMES).nullable(), // must equal the engine-resolved outcome when there is one, else null
  counterTerms: z.strictObject({ terms: z.array(TermSchema).max(8), note: z.string().max(300) }).nullable(), // required when expressing a counter
  condition: z.string().max(300).nullable(), // required when accepting conditionally
  dialogue: z.string().max(3000),
  perceivable: z.string().max(600),
  endsConversation: z.boolean(),
  eventSummary: z.string().min(3).max(400),
  importance: z.number().int().min(1).max(5),
  mentionedCharacterNames: z.array(z.string().max(80)).max(10),
  minutesElapsed: z.number().int().min(0).max(60),
};
/** The NPC physically attacks the player now. The game decides how it goes. */
export const NpcAttackSchema = z.object({
  intent: z.enum(['kill', 'hurt', 'humiliate', 'drive_off']), threat: z.number().int().min(1).max(5), how: z.string().min(3).max(200),
  by: z.string().max(120).nullable(), // others acting for them ("his three guards"); null = they attack themselves
});
export const NpcTurnWireSchema = z.object({ ...npcTurnFields, attack: NpcAttackSchema.nullable(), changes: z.array(ChangeOpSchema) });
/** Parsing schema: envelope strictly, changes loosely — each change is validated individually by the validator. */
export const NpcTurnEnvelopeSchema = z.object({ ...npcTurnFields, attack: NpcAttackSchema.extend({ by: NpcAttackSchema.shape.by.default(null) }).nullable().default(null), changes: z.array(z.unknown()) });
export type NpcTurnEnvelope = z.infer<typeof NpcTurnEnvelopeSchema>;

// ---- Story Director (world-level; sees world truth, proposes; the engine validates) ----

export const DirectorProposalSchema = z.object({
  newThreads: z.array(z.strictObject({
    title: z.string().min(3).max(120),
    summary: z.string().min(10).max(600),
    causeEventIds: z.array(z.string()).min(1).max(6), // must be real events: no drama from nowhere
    participantNames: z.array(z.string()).min(1).max(6),
    urgency: z.number().int().min(1).max(40), // momentum gained per day
    visibility: z.enum(['hidden', 'participants', 'public']),
    resolution: z.strictObject({
      actorName: z.string(), // who eventually decides
      domain: z.string().min(2).max(40), // decision domain for their decision state, e.g. "career"
      option: z.string().min(3).max(300), // what they are weighing
      factors: z.array(z.strictObject({ factor: z.enum(FACTORS), value: z.number().int().min(-2).max(2), reason: z.string().max(200) })).max(8),
      ifAccepted: z.strictObject({ summary: z.string().min(3).max(300), messageToPlayer: z.string().max(400).nullable(), newPressure: z.string().max(200).nullable() }),
      ifRejected: z.strictObject({ summary: z.string().min(3).max(300), messageToPlayer: z.string().max(400).nullable(), newPressure: z.string().max(200).nullable() }),
    }),
    decisionState: DecisionStateProposalSchema.nullable(), // required if the actor has no state for this domain yet
  })).max(2),
  escalations: z.array(z.strictObject({
    threadId: z.string(), momentumDelta: z.number().int().min(-30).max(30), causeEventIds: z.array(z.string()).min(1).max(6), reason: z.string().max(300),
  })).max(4),
});
export type DirectorProposal = z.infer<typeof DirectorProposalSchema>;

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
