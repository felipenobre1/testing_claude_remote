import type { Store } from '../db/store.ts';
import type { Character, Game } from '../domain/types.ts';
import { newId } from './util.ts';

// Generic world seeding. A game pack decides who the player is and where the story starts.

export interface WorldSeed {
  title: string;
  timezone: string;
  startTime: string; // local wall time 'YYYY-MM-DDTHH:MM'
  player: Omit<Character, 'id' | 'gameId' | 'isPlayer' | 'origin' | 'createdAt' | 'updatedAt'>;
  facts: { predicate: string; value: string }[]; // canonical facts about the player
  startingCashCents: number;
  scene: { location: string; description: string };
  firstDirectorReview?: string; // game time of the first Story Director review (if the director runs)
}

/** Creates a game containing only the player, their canonical facts, their account and the opening scene. */
export function seedWorld(store: Store, seed: WorldSeed, now: string): { game: Game; player: Character } {
  const gameId = newId('game');
  const player: Character = { ...seed.player, id: newId('chr'), gameId, isPlayer: true, origin: 'seed', createdAt: now, updatedAt: now };
  const game: Game = {
    id: gameId, title: seed.title, timezone: seed.timezone, gameTime: seed.startTime, playerCharacterId: player.id, revision: 0, createdAt: now, updatedAt: now,
  };
  store.tx(() => {
    store.insertGame(game);
    store.insertCharacter(player);
    for (const f of seed.facts) store.insertFact({ id: newId('fact'), gameId, subject: player.id, predicate: f.predicate, value: f.value, createdAt: now, updatedAt: now });
    // Money is canonical state in the ledger, never a free-text fact.
    store.insertAccount({ id: newId('acct'), gameId, ownerKind: 'character', ownerId: player.id, balanceCents: seed.startingCashCents, createdAt: now, updatedAt: now });
    store.insertScene({
      id: newId('scn'), gameId, location: seed.scene.location, description: seed.scene.description,
      activeCharacterIds: [player.id], interactionId: null, updatedAt: now,
    });
  });
  return { game, player };
}
