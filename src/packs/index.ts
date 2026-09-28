import { adventurePack } from './adventure/index.ts';
import { openPack } from './open/index.ts';
import { startupPack } from './startup/index.ts';
import type { GamePack } from './types.ts';

/** The Game Packs this app ships with. The engine itself never imports this. */
export const PACKS: GamePack[] = [startupPack, adventurePack, openPack];

export function packById(id: string): GamePack | undefined {
  return PACKS.find((p) => p.id === id);
}
