import { z } from 'zod';

// ============================================================================
// World creation (engine-level, pack-agnostic).
//
//   WorldDraft  — editable, collaborative design built through conversation. Not canonical.
//   WorldSeed   — the approved starting specification AND design contract of one game. Immutable.
//   Game state  — what actually happens after play begins (characters, events, …).
// ============================================================================

export const CANON_POLICIES = [
  'background_only', // existing canon/history is inspiration only
  'history_continues_unless_changed', // established history proceeds unless the story changes it
  'alternate_from_start', // an alternate timeline from the moment play begins
  'original_world', // a custom world with no external canon
] as const;
export type CanonPolicy = (typeof CANON_POLICIES)[number];

/** How hard the world pushes the story at the player: quiet (waits for them), steady, eventful (keeps forcing choices). */
export const PACES = ['quiet', 'steady', 'eventful'] as const;
/** How violence is portrayed: not at all, non-graphic (happens, not dwelt on), graphic (shown in full). */
export const VIOLENCE = ['none', 'non_graphic', 'graphic'] as const;
/** concise = short game-like text; literary = a narrator writes each turn like a novel. */
export const NARRATION = ['concise', 'literary'] as const;

const text = (max: number) => z.string().max(max);
const opt = (max: number) => z.string().max(max).nullable();

/** A person who already exists when the story starts. Only those the opening needs. */
const DraftActorSchema = z.strictObject({
  name: z.string().min(1).max(80),
  age: z.number().int().min(1).max(120).nullable(),
  gender: opt(40), // so everyone refers to them the same way
  role: text(120), // their place in the world
  description: text(600), // who they are
  personality: opt(400),
  goals: z.array(text(200)).max(4),
  relationshipToPlayer: opt(400), // how THEY see the player, if they know them
});

/** A situation already in motion at the start. Conditions only — it has no outcome. */
const DraftSituationSchema = z.strictObject({
  title: z.string().min(3).max(120),
  summary: z.string().min(10).max(600),
  involves: z.array(z.string().max(80)).max(6), // actor names, or "player"
});

/** Something the player character has made or owns at the start, with its state (e.g. a product, a boat, a shop). */
const DraftAssetSchema = z.strictObject({
  name: z.string().min(1).max(80),
  kind: text(40), // one of the pack's asset kinds when it has them (e.g. "product"), else free text
  description: text(400),
  url: opt(300), // a real web address, if it has one (people in the world can open it)
  state: opt(40), // e.g. "mvp"
  metrics: z.array(z.strictObject({ key: text(40), value: z.number() })).max(6),
  monthlyCosts: z.array(z.strictObject({ label: text(120), amount: z.number() })).max(6), // what keeping it running costs
  knownIssues: z.array(text(200)).max(5),
});

/** A concrete opportunity already on the horizon: an event, a deadline to apply, a place to be. Nobody has to attend. */
const DraftLeadSchema = z.strictObject({
  title: z.string().min(3).max(120),
  description: text(400),
  when: opt(16), // 'YYYY-MM-DDTHH:MM' or null for an open lead without a date
  location: opt(160),
  cost: z.number().nullable(), // entry price, if any
  repeatsWeekly: z.boolean(),
});

const MoneyLineSchema = z.strictObject({ label: text(120), amount: z.number() });

export const WorldDraftSchema = z.object({
  packId: opt(40), // which game pack runs this world (mechanics); chosen with the player
  premise: opt(600), // the story/world in one or two sentences
  sourceWorld: opt(120), // "the real world", "Dune", null = original
  canonPolicy: z.enum(CANON_POLICIES).nullable(),
  startingStage: opt(40), // how far along the player's journey is at the start (the pack lists stages)
  setting: z.strictObject({
    place: opt(160),
    era: opt(160),
    startDate: opt(16), // local wall time 'YYYY-MM-DDTHH:MM' (any calendar mapped to this form)
    timezone: opt(60),
    description: opt(800),
  }),
  style: z.strictObject({
    tone: opt(200),
    realism: opt(200),
    difficulty: opt(200),
    narrativeStyle: opt(200),
    playerSignificance: opt(200), // e.g. "starts insignificant; no chosen one"
    pace: z.enum(PACES).nullable(),
    violence: z.enum(VIOLENCE).nullable(),
    narration: z.enum(NARRATION).nullable(),
    language: opt(40), // the language the player plays in (e.g. "Brazilian Portuguese"); the engine itself stays in English
  }),
  designPrinciples: z.array(text(240)).max(10), // e.g. "do not manufacture destiny around the player"
  worldRules: z.array(text(240)).max(10), // physics, technology or magic, institutions
  player: z.strictObject({
    name: opt(80),
    age: z.number().int().min(1).max(120).nullable(),
    gender: opt(40),
    occupation: opt(160),
    background: opt(1200),
    personality: opt(400),
    skills: z.array(text(120)).max(8),
    goals: z.array(text(200)).max(5),
    fears: z.array(text(200)).max(5),
    ambition: opt(300), // what they dream of becoming — the story pushes toward (and against) it
    attributes: z.array(z.strictObject({ key: text(40), value: z.number() })).max(10), // numeric traits a pack reads (e.g. combat 2)
    location: opt(160), // where they live
    circumstances: z.array(text(200)).max(6), // canonical facts about their situation ("lives with parents")
    startingMoney: z.number().nullable(), // in the world's currency (major units)
    currency: z.strictObject({ code: text(10), symbol: text(4) }).nullable(),
    possessions: z.array(text(160)).max(8),
    knowledge: z.array(text(240)).max(8), // what the player character knows at the start
    assets: z.array(DraftAssetSchema).max(4), // what they have already made or own — the starting point of their journey
  }),
  /** Approximate prices of this world (fixed at creation, extended in play) and the player's running costs and income. */
  economy: z.strictObject({
    priceList: z.array(z.strictObject({ item: text(120), price: z.number() })).max(30),
    livingCosts: z.array(MoneyLineSchema).max(8), // monthly, e.g. phone, transport, "daily life"
    income: z.array(MoneyLineSchema).max(4), // monthly, e.g. pocket money
  }),
  openLeads: z.array(DraftLeadSchema).max(6),
  locations: z.array(z.strictObject({ name: text(120), description: text(400) })).max(6),
  factions: z.array(z.strictObject({ name: text(120), description: text(400) })).max(6),
  actors: z.array(DraftActorSchema).max(6),
  historicalContext: opt(1200),
  currentSituation: opt(1200),
  initialPressures: z.array(text(240)).max(6),
  initialSituations: z.array(DraftSituationSchema).max(4),
  startingScene: z.strictObject({ location: opt(160), description: opt(600) }),
  unresolvedQuestions: z.array(text(240)).max(8),
  contradictions: z.array(text(300)).max(6), // incompatible requirements still to be resolved
});
export type WorldDraft = z.infer<typeof WorldDraftSchema>;

export const EMPTY_DRAFT: WorldDraft = {
  packId: null, premise: null, sourceWorld: null, canonPolicy: null, startingStage: null,
  setting: { place: null, era: null, startDate: null, timezone: null, description: null },
  style: { tone: null, realism: null, difficulty: null, narrativeStyle: null, playerSignificance: null, pace: null, violence: null, narration: null, language: null },
  designPrinciples: [], worldRules: [],
  player: { name: null, age: null, gender: null, occupation: null, background: null, personality: null, skills: [], goals: [], fears: [], ambition: null, attributes: [], location: null,
    circumstances: [], startingMoney: null, currency: null, possessions: [], knowledge: [], assets: [] },
  economy: { priceList: [], livingCosts: [], income: [] }, openLeads: [],
  locations: [], factions: [], actors: [], historicalContext: null, currentSituation: null, initialPressures: [], initialSituations: [],
  startingScene: { location: null, description: null }, unresolvedQuestions: [], contradictions: [],
};

export const COPILOT_INTENTS = ['discuss', 'summarize', 'request_finalize', 'confirm_finalize', 'abandon'] as const;

const DRAFT_KEYS = Object.keys(WorldDraftSchema.shape) as (keyof WorldDraft)[];

/**
 * The draft's sections, each either its complete new value or null = unchanged. Typed like the draft itself,
 * so structured output guarantees the shape; the model only writes the sections that change.
 * (Fields that are already nullable are not wrapped twice; to clear one, list it in `reset`.)
 */
export const DraftChangesSchema = z.object(
  Object.fromEntries(DRAFT_KEYS.map((k) => { const f = WorldDraftSchema.shape[k] as z.ZodType; return [k, f.safeParse(null).success ? f : f.nullable()]; })) as { [K in keyof WorldDraft]: z.ZodNullable<z.ZodType<WorldDraft[K]>> },
);
export type DraftChanges = { [K in keyof WorldDraft]: WorldDraft[K] | null };

/** One Copilot turn: its reply, the changed sections of the draft, and what the player wants now. */
export const CopilotTurnSchema = z.object({
  reply: z.string().min(1).max(4000),
  changes: DraftChangesSchema,
  /** Sections to clear back to empty (e.g. the player says "forget the family" → "actors"). */
  reset: z.array(z.enum(DRAFT_KEYS as [keyof WorldDraft, ...(keyof WorldDraft)[]])).max(DRAFT_KEYS.length),
  intent: z.enum(COPILOT_INTENTS),
  /** For confirm_finalize / abandon: the player's own words expressing it (checked against their message). */
  approvalQuote: z.string().max(300).nullable(),
});
export type CopilotTurn = z.infer<typeof CopilotTurnSchema>;

/** No changes (every section null). */
export const NO_CHANGES = Object.fromEntries(DRAFT_KEYS.map((k) => [k, null])) as DraftChanges;

/** Applies a Copilot turn's changes to a draft. Sections are replaced whole; reset sections return to empty. */
export function applyDraftChanges(current: WorldDraft, changes: Partial<DraftChanges>, reset: readonly (keyof WorldDraft)[] = []): WorldDraft {
  const next = structuredClone(current) as Record<string, unknown>;
  for (const k of reset) next[k] = structuredClone(EMPTY_DRAFT[k]);
  for (const k of DRAFT_KEYS) if (changes[k] !== null && changes[k] !== undefined) next[k] = changes[k];
  return WorldDraftSchema.parse(next);
}

/** The approved design contract of a game. Written once at finalization, never rewritten. */
export interface WorldSeed {
  gameId: string;
  draftId: string | null;
  packId: string;
  createdAt: string;
  premise: string;
  startingStage: string | null;
  world: {
    sourceWorld: string | null;
    canonPolicy: CanonPolicy;
    place: string;
    era: string;
    startDate: string;
    timezone: string;
    description: string;
    rules: string[];
    historicalContext: string | null;
    currentSituation: string;
    locations: { name: string; description: string }[];
    factions: { name: string; description: string }[];
  };
  style: {
    tone: string;
    realism: string;
    difficulty: string | null;
    narrativeStyle: string | null;
    playerSignificance: string;
    designPrinciples: string[];
    pace: (typeof PACES)[number];
    violence: (typeof VIOLENCE)[number];
    narration: (typeof NARRATION)[number];
    language?: string; // absent in seeds created before languages existed = English
  };
  player: WorldDraft['player'] & { name: string; age: number; background: string };
  actors: WorldDraft['actors'];
  initialPressures: string[];
  initialSituations: WorldDraft['initialSituations']; // conditions only
  economy: WorldDraft['economy'];
  openLeads: WorldDraft['openLeads'];
  startingScene: { location: string; description: string };
}
