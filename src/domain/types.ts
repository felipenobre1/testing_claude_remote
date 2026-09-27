// Canonical record types (camelCase mirrors of the SQLite rows).

export type Channel = 'phone' | 'in_person' | 'message';
export type ObserverChannel = Channel | 'self';
export type ParticipantRole = 'actor' | 'addressee' | 'mentioned';

export type EventType =
  | 'game_started'
  | 'conversation_started'
  | 'conversation_turn'
  | 'conversation_ended'
  | 'action'
  | 'private_thought';

export interface Game {
  id: string;
  title: string;
  timezone: string;
  gameTime: string;
  playerCharacterId: string;
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
  text: string; // fully composed player-facing text
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
