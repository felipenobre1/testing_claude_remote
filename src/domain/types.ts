// Canonical record types (camelCase mirrors of the SQLite rows).

export type Channel = 'phone' | 'in_person' | 'message';
export type ObserverChannel = Channel | 'self';
export type ParticipantRole = 'actor' | 'addressee' | 'mentioned';

/** Engine event types. Game packs may add their own (e.g. "company_founded"). */
export type CoreEventType =
  | 'game_started'
  | 'conversation_started'
  | 'conversation_turn'
  | 'conversation_ended'
  | 'action'
  | 'private_thought'
  | 'link_shared'
  | 'money'
  | 'offer_made'
  | 'offer_resolved'
  | 'decision'
  | 'promise_made'
  | 'promise_fulfilled'
  | 'promise_overdue'
  | 'message'
  | 'thread_started'
  | 'thread_development'
  | 'thread_resolved'
  | 'world'
  | 'time_passed';
export type EventType = CoreEventType | (string & {});

export interface Game {
  id: string;
  title: string;
  timezone: string;
  gameTime: string;
  playerCharacterId: string;
  packId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface Character {
  id: string;
  gameId: string;
  isPlayer: boolean;
  name: string;
  age: number;
  gender: string | null;
  role: string;
  occupation: string | null;
  background: string;
  personality: string;
  traits: string[];
  values: string[];
  goals: string[];
  fears: string[];
  location: string;
  origin: 'seed' | 'generated';
  /** Alive unless the story killed them. The dead stay dead. */
  status?: 'alive' | 'dead' | 'missing';
  createdAt: string;
  updatedAt: string;
}

export interface Relationship {
  id: string;
  gameId: string;
  fromCharacterId: string;
  toCharacterId: string;
  summary: string;
  source: 'backstory' | 'gameplay';
  sourceEventId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Fact {
  id: string;
  gameId: string;
  subject: string;
  predicate: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

export interface Interaction {
  id: string;
  gameId: string;
  channel: Channel;
  participantIds: string[];
  startedGameTime: string;
  endedGameTime: string | null;
  createdAt: string;
}

export interface TranscriptLine {
  speakerId: string | null; // null = stage direction ("Felipe calls Matteo.")
  speakerName: string | null;
  text: string;
}

export interface GameEvent {
  id: string;
  gameId: string;
  turnId: string | null;
  interactionId: string | null;
  gameTime: string;
  type: EventType;
  summary: string;
  transcript: TranscriptLine[];
  importance: number;
  location: string | null;
  createdAt: string;
  participants: { characterId: string; role: ParticipantRole }[];
  observers: { characterId: string; channel: ObserverChannel }[];
}

export interface Memory {
  id: string;
  gameId: string;
  ownerCharacterId: string;
  summary: string;
  importance: number;
  emotionalWeight: number | null;
  source: 'gameplay' | 'backstory';
  sourceEventId: string | null;
  gameTime: string;
  createdAt: string;
  subjectIds: string[];
}

export interface Knowledge {
  id: string;
  gameId: string;
  characterId: string;
  topic: string;
  belief: string;
  confidence: number;
  aboutCharacterId: string | null;
  factId: string | null;
  source: string;
  sourceEventId: string | null;
  gameTime: string;
  createdAt: string;
  updatedAt: string;
}

// ---- Resources, offers, obligations (generic; the pack sets currency and entity types) ----

export interface Account {
  id: string;
  gameId: string;
  ownerKind: 'character' | 'entity'; // entity = a pack-defined owner (company, guild, noble house…)
  ownerId: string;
  balanceCents: number;
  createdAt: string;
  updatedAt: string;
}

export interface Transaction {
  id: string;
  gameId: string;
  turnId: string | null;
  fromAccountId: string | null; // null = outside world
  toAccountId: string | null;
  amountCents: number;
  description: string;
  category: string;
  gameTime: string;
  createdAt: string;
}

/** Something one character proposes to another. Kinds and terms are defined by the game pack. */
export interface Offer {
  id: string;
  gameId: string;
  kind: string;
  fromCharacterId: string;
  toCharacterId: string;
  subjectRef: string | null; // pack-interpreted (e.g. a company id)
  label: string | null; // role / title / what exactly
  terms: Record<string, number>;
  description: string;
  status: 'pending' | 'accepted' | 'rejected' | 'countered' | 'withdrawn';
  parentOfferId: string | null;
  attempts: number;
  lastOutcome: string | null;
  nextDecisionAfter: string | null;
  lastAppraisal: unknown | null; // reused when the world turn revisits a deferred decision
  createdGameTime: string;
  resolvedGameTime: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Obligation {
  id: string;
  gameId: string;
  debtorId: string;
  creditorId: string;
  description: string;
  amountCents: number | null;
  dueGameTime: string | null;
  status: 'open' | 'fulfilled' | 'cancelled';
  overdueNotified: boolean;
  createdGameTime: string;
  resolvedGameTime: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecurringPayment {
  id: string;
  gameId: string;
  fromAccountId: string | null; // null = outside world pays (e.g. a customer)
  toAccountId: string | null; // null = outside world receives (e.g. hosting)
  description: string;
  amountCents: number;
  nextDueGameTime: string;
  active: boolean;
  createdAt: string;
}

export interface DecisionRecord {
  id: string;
  gameId: string;
  turnId: string;
  offerId: string | null;
  threadId: string | null;
  domain: string;
  characterId: string;
  outcome: string;
  finalScore: number;
  roll: number;
  seed: string;
  reasons: string[];
  detail: unknown;
  gameTime: string;
  createdAt: string;
}

// ---- Living world: story threads and scheduled developments ----

/** A persistent developing situation in the world (not a quest). */
export interface StoryThread {
  id: string;
  gameId: string;
  title: string;
  summary: string;
  status: 'emerging' | 'active' | 'resolved' | 'dormant';
  momentum: number; // 0–100; resolves at 100
  urgency: number; // momentum gained per day (before the roll)
  visibility: 'hidden' | 'participants' | 'public';
  participantIds: string[];
  causeEventIds: string[];
  resolution: ThreadResolution;
  outcome: string | null;
  createdGameTime: string;
  updatedGameTime: string;
  resolvedGameTime: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadResolution {
  actorId: string;
  domain: string;
  option: string;
  factors: { factor: string; value: number; reason: string }[];
  ifAccepted: { summary: string; messageToPlayer: string | null; newPressure: string | null };
  ifRejected: { summary: string; messageToPlayer: string | null; newPressure: string | null };
}

/** Something the world will do at a given time (engine- or pack-defined kind). */
export interface ScheduledItem {
  id: string;
  gameId: string;
  dueGameTime: string;
  kind: string; // "message", "director_review", …
  payload: Record<string, unknown>;
  threadId: string | null;
  status: 'pending' | 'done' | 'cancelled';
  createdGameTime: string;
  createdAt: string;
}

/** Snapshot of a real web page as it was when a character opened it. */
export interface WebDocument {
  id: string;
  gameId: string;
  url: string;
  finalUrl: string;
  status: 'ok' | 'error';
  title: string | null;
  text: string;
  error: string | null;
  fetchedAt: string;
  gameTime: string;
  createdAt: string;
}

export interface Scene {
  id: string;
  gameId: string;
  location: string;
  description: string;
  activeCharacterIds: string[];
  interactionId: string | null;
  updatedAt: string;
}

export type TurnStatus = 'committed' | 'clarification' | 'failed';

export interface TurnResponse {
  requestId: string;
  turnId: string;
  status: TurnStatus;
  gameTime: string;
  narration: string;
  npc: { characterId: string; name: string; dialogue: string; perceivable: string; isNew: boolean } | null;
  conversationEnded: boolean;
  clarificationQuestion: string | null;
  error: string | null;
  results: string[]; // deterministic outcomes: payments, company changes, offers, promises, time effects
  text: string; // fully composed player-facing text
  /** Ideas for what the player could do next (grounded in their situation; never outcomes). */
  suggestions?: string[];
  /** Title of the scene beat that came to the player this turn, if any. */
  beat?: string;
  replayed?: boolean;
}

export interface TurnRow {
  id: string;
  gameId: string;
  requestId: string;
  seq: number;
  status: TurnStatus;
  baseRevision: number;
  committedRevision: number | null;
  playerInput: string;
  response: TurnResponse | null;
  trace: unknown;
  createdAt: string;
}
