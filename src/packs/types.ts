import type { z } from 'zod';
import type { Store } from '../db/store.ts';
import type { Migration } from '../db/migrations.ts';
import type { Offer } from '../domain/types.ts';
import type { WorldDraft } from '../domain/world.ts';
import type { WorldPlanner } from '../engine/planner.ts';

// ============================================================================
// Game Pack contract: the boundary between the Living Story Engine and a world.
//
// The engine owns people (characters, relationships, memory, knowledge), history (events,
// observers), time, resources, offers, promises, decisions, world turns, story threads and the
// Story Director. A pack defines what kind of world they live in: its setting, starting state,
// the kinds of offers people make, pack-specific actions and state, and prompt flavour.
// ============================================================================

/** A kind of offer one character can make to another in this world (e.g. "purchase", "grant_passage"). */
export interface OfferKindDef {
  kind: string;
  /** For prompts: what it means and which terms it uses. */
  summary: string;
  terms: { key: string; description: string; required: boolean }[];
  /** Extra checks on term values (ranges etc.); returns a model error or null. */
  validateTerms?(terms: Record<string, number>): string | null;
  /** The subject the offer is about (e.g. a company). Returns its reference, or a game-outcome rejection / model error. */
  resolveSubject(api: WorldPlanner, subject: string | null, toId: string): { subjectRef: string | null } | { reject: string } | { modelError: string };
  describe(api: WorldPlanner, offer: Offer): string;
  /** Deterministic consequences once accepted (by either side). */
  execute(api: WorldPlanner, offer: Offer): void;
  /** Extra lines the recipient sees about the subject (e.g. the company as presented). */
  context?(api: WorldPlanner, offer: Offer): string[];
}

/** A pack-specific player action with deterministic mechanics. */
export interface PackAction {
  name: string;
  schema: z.ZodObject; // strict object with `action: z.literal(name)`
  /** For the interpreter prompt. */
  doc: string;
  /** Returns a model error (malformed/unknown references) or null; game outcomes are reported via the planner. */
  handle(api: WorldPlanner, action: Record<string, unknown>): string | null;
}

export interface GamePack {
  id: string;
  name: string;
  /** Default currency (a world may set its own at creation). */
  currency: { code: string; symbol: string };
  migrations: Migration[];
  /** Guidance for the World Creation Copilot. The world itself is designed with the player and lives in the WorldSeed. */
  worldCreation: {
    /** What this pack simulates, in one line (shown when choosing a pack). */
    summary: string;
    /** What matters when setting up a world for this pack, and what can safely wait. */
    guidance: string;
    /** A complete example draft (also used for quick start). */
    template: WorldDraft;
  };
  offerKinds: OfferKindDef[];
  /** Pack-defined owners of resources (companies, guilds, houses): lookup by name and control. */
  entities: {
    find(api: WorldPlanner, name: string): { id: string; name: string } | undefined;
    name(api: WorldPlanner, id: string): string;
    controlledBy(api: WorldPlanner, entityId: string, characterId: string): boolean;
  };
  actions: PackAction[];
  /** Per-turn simulated pack state (e.g. companies and ownership), created from the store. */
  createTurnState(store: Store, gameId: string): PackTurnState;
  /** Extra briefing lines: what the player / this NPC can see of pack state. Perspective rules apply. */
  briefing: { player(api: WorldPlanner): string[]; npc(api: WorldPlanner, npcId: string): string[] };
  statusParts(store: Store, gameId: string, playerId: string): string[];
  prompts: {
    /** How to express this pack's actions (appended to the interpreter's action docs). */
    interpretActions: string;
    /** World background for the Story Director (what kinds of developments are plausible here). */
    director: string;
  };
  inspect?(store: Store, gameId: string): string;
  /** Name of a pack entity from committed state (for debug views). */
  entityLabel?(store: Store, id: string): string;
}

/** Pack state for one turn: read by briefings, changed by actions, written at commit. */
export interface PackTurnState {
  /** Writes the pack's pending changes inside the engine's commit transaction. */
  commit(store: Store): { table: string; op: string; id: string; note?: string }[];
}
