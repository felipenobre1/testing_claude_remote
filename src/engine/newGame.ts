import type { Store } from '../db/store.ts';
import type { Character, Game } from '../domain/types.ts';
import { formatGameTime, newId } from './util.ts';

export interface NewGameOptions {
  playerName?: string;
  now?: string;
}

export const START_TIME = '2026-09-27T09:14'; // Sunday, Europe/Rome
export const TIMEZONE = 'Europe/Rome';
export const STARTING_CASH_CENTS = 250_000;

/** Creates a game containing only the player, the player's canonical facts and the opening scene. */
export function createGame(store: Store, opts: NewGameOptions = {}): { game: Game; player: Character } {
  const now = opts.now ?? new Date().toISOString();
  const gameId = newId('game');
  const player: Character = {
    id: newId('chr'),
    gameId,
    isPlayer: true,
    name: opts.playerName ?? 'Felipe',
    age: 18,
    gender: null,
    role: 'player',
    occupation: 'Recent liceo graduate, not enrolled anywhere yet',
    background:
      'Born and raised in Milan. Just finished liceo scientifico. Still lives at home with parents. ' +
      'Self-taught programmer who has built small web apps and scripts. No company yet and little business experience.',
    personality: 'Shaped by the player through play.',
    traits: ['technical', 'ambitious'],
    values: [],
    goals: ['Build a startup'],
    fears: [],
    location: 'Milan (family apartment)',
    origin: 'seed',
    createdAt: now,
    updatedAt: now,
  };
  const game: Game = {
    id: gameId,
    title: `Startup — Milan (${player.name})`,
    timezone: TIMEZONE,
    gameTime: START_TIME,
    playerCharacterId: player.id,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };

  store.tx(() => {
    store.insertGame(game);
    store.insertCharacter(player);
    store.insertFact({ id: newId('fact'), gameId, subject: player.id, predicate: 'housing', value: 'lives with parents', createdAt: now, updatedAt: now });
    // Money is canonical state in the ledger, never a free-text fact.
    store.insertAccount({ id: newId('acct'), gameId, ownerKind: 'character', ownerId: player.id, balanceCents: STARTING_CASH_CENTS, createdAt: now, updatedAt: now });
    store.insertScene({
      id: newId('scn'),
      gameId,
      location: 'Home — bedroom in the family apartment, Milan',
      description: 'Sunday morning. Laptop open on the desk, phone beside it.',
      activeCharacterIds: [player.id],
      interactionId: null,
      updatedAt: now,
    });
  });
  return { game, player };
}

export function openingText(game: Game): string {
  return [
    `Milan — ${formatGameTime(game.gameTime)}`,
    '',
    "You're eighteen and still living with your parents.",
    "You've got €2,500 in your bank account, a laptop, and enough programming experience to build things yourself.",
    "For months you've been thinking about starting a company. You don't have an idea yet.",
    'No investors. No employees. No customers.',
    'Your phone is beside you.',
    '',
    'What do you do?',
  ].join('\n');
}
