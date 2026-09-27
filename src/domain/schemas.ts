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
  actions: z.array(z.lazy(() => PlayerActionSchema)).max(6), // deterministic mechanics the player performs this turn
  minutesElapsed: z.number().int().min(0).max(10080), // up to a week of focused work / waiting
  narration: z.string().max(1500),
  clarificationQuestion: z.string().max(400).nullable(),
});
export type InterpretResult = z.infer<typeof InterpretResultSchema>;

// ---- Player actions with deterministic mechanics (money, company, equity, promises). ----
// Every field is required (nullable where optional) so the schema works in strict structured output.
export const PlayerActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('pay'), amountEur: z.number(), description: z.string().min(2).max(200), fromCompanyName: z.string().nullable(), recurringMonthly: z.boolean() }),
  z.strictObject({ action: z.literal('give_money'), toCharacterName: z.string(), amountEur: z.number(), description: z.string().max(200) }),
  z.strictObject({ action: z.literal('found_company'), name: z.string().min(2).max(80), description: z.string().min(3).max(400), initialInvestmentEur: z.number() }),
  z.strictObject({ action: z.literal('invest_in_company'), companyName: z.string(), amountEur: z.number() }),
  z.strictObject({
    action: z.literal('make_offer'), toCharacterName: z.string(), kind: z.enum(['join_company', 'hire', 'purchase', 'investment']), companyName: z.string(),
    equityPercent: z.number().nullable(), salaryMonthlyEur: z.number().nullable(), priceMonthlyEur: z.number().nullable(), amountEur: z.number().nullable(),
    role: z.string().max(80).nullable(), description: z.string().min(3).max(300),
  }),
  z.strictObject({ action: z.literal('respond_to_offer'), offerId: z.string(), accept: z.boolean() }),
  z.strictObject({ action: z.literal('make_promise'), toCharacterName: z.string(), description: z.string().min(3).max(300), amountEur: z.number().nullable(), dueInDays: z.number().nullable() }),
  z.strictObject({ action: z.literal('fulfill_promise'), promiseId: z.string() }),
  z.strictObject({ action: z.literal('advance_product'), companyName: z.string(), stage: z.enum(['prototype', 'mvp', 'launched']) }),
]);
export type PlayerAction = z.infer<typeof PlayerActionSchema>;

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

// Promises with deterministic consequences (executed by the economy engine).
// NPCs do NOT decide offers here: offers are resolved by the Decision Resolution Engine (engine/decision.ts).
export const NpcPromiseOpSchema = z.strictObject({
  op: z.literal('make_promise'), description: z.string().min(3).max(300), amountEur: z.number().nullable(), dueInDays: z.number().nullable(),
});
export const NpcFulfillOpSchema = z.strictObject({ op: z.literal('fulfill_promise'), promiseId: z.string() });

export const ChangeOpSchema = z.discriminatedUnion('op', [
  CreateMemoryOpSchema, UpsertKnowledgeOpSchema, UpdateRelationshipOpSchema, NpcPromiseOpSchema, NpcFulfillOpSchema,
]);
export type ChangeOp = z.infer<typeof ChangeOpSchema>;
export const ALLOWED_OPS = ['create_memory', 'upsert_knowledge', 'update_relationship', 'make_promise', 'fulfill_promise'] as const;

// ---- Independent NPC decisions ----

export const OUTCOMES = [
  'accept', 'accept_conditionally', 'escalate_to_decision_maker', 'counter', 'request_more_information', 'delay', 'reject', 'disengage',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Generic factors a decision can weigh. Which ones matter (and how much) is per character. */
export const FACTORS = [
  'need', 'urgency', 'trust', 'perceived_value', 'risk', 'switching_cost', 'implementation_effort', 'timing', 'offer_quality',
  'credibility', 'relationship', 'confidence_in_player', 'price_fit', 'alternatives',
] as const;
export type Factor = (typeof FACTORS)[number];
/** Computed by the engine from canonical numbers, never assessed by the model. */
export const COMPUTED_FACTORS: Factor[] = ['price_fit', 'alternatives'];

export const CONSTRAINT_KINDS = [
  'max_monthly_spend_eur', // can personally approve at most this per month
  'max_one_off_spend_eur', // e.g. an investor's maximum cheque
  'min_one_off_spend_eur', // e.g. an investor's minimum cheque
  'min_monthly_income_eur', // needs at least this income to take a job/cofounder role
  'min_equity_percent', // wants at least this stake
  'requires_approval', // cannot say a final yes alone (partner, manager, parents, committee)
] as const;
// Temporary circumstances (exams, a family issue, busy season) are pressures with an expiry, not constraints.

const decisionStateFields = {
  role: z.string().min(2).max(120), // their position in this decision: "café owner evaluating software", "student offered a cofounder role"
  goals: z.array(z.string().min(2).max(200)).min(1).max(5),
  alternatives: z.array(z.strictObject({ text: z.string().min(2).max(200), strength: z.number().min(0).max(1) })).max(4),
  hardConstraints: z.array(z.strictObject({ kind: z.enum(CONSTRAINT_KINDS), value: z.number().nullable(), note: z.string().max(200) })).max(5),
  criteria: z.array(z.strictObject({ factor: z.enum(FACTORS), weight: z.number().min(0).max(3), note: z.string().max(200) })).min(1).max(8),
  baseWillingness: z.number().min(0).max(100),
};
/** Stored, canonical, hidden from the player. */
export const DecisionStateSchema = z.object({
  ...decisionStateFields,
  pressures: z.array(z.strictObject({ text: z.string().min(2).max(200), expiresGameTime: z.string().nullable() })).max(4),
});
export type DecisionState = z.infer<typeof DecisionStateSchema>;
/** What the model proposes when a character first faces a kind of decision. */
export const DecisionStateProposalSchema = z.object({
  ...decisionStateFields,
  pressures: z.array(z.strictObject({ text: z.string().min(2).max(200), expiresInDays: z.number().nullable() })).max(4),
});
export type DecisionStateProposal = z.infer<typeof DecisionStateProposalSchema>;

/** The model assesses factors from the NPC's perspective; the engine decides. */
export const AppraisalSchema = z.object({
  factors: z.array(z.strictObject({ factor: z.enum(FACTORS), value: z.number().int().min(-2).max(2), reason: z.string().min(2).max(200) })).max(14),
});
export type Appraisal = z.infer<typeof AppraisalSchema>;

export const CounterTermsSchema = z.strictObject({
  equityPercent: z.number().nullable(), salaryMonthlyEur: z.number().nullable(), priceMonthlyEur: z.number().nullable(),
  amountEur: z.number().nullable(), note: z.string().max(300),
});

/** Call 2 — NPC perspective. `changes` is what the schema asks the model for. */
const npcTurnFields = {
  expressedDecision: z.enum(OUTCOMES).nullable(), // must equal the engine-resolved outcome when there is one, else null
  counterTerms: CounterTermsSchema.nullable(), // required when expressing a counter
  condition: z.string().max(300).nullable(), // required when accepting conditionally
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
