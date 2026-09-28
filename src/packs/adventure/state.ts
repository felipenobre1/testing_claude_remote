import type { Store } from '../../db/store.ts';
import type { PackTurnState } from '../types.ts';

// Adventure pack state: bodies (health, injuries), skills that grow with practice, fame, and what people carry.

export const SKILLS = ['combat', 'stealth', 'survival', 'athletics', 'persuasion', 'lore'] as const;
export type Skill = (typeof SKILLS)[number];
export const MAX_LEVEL = 5;
/** Practice needed to go from `level` to the next one. */
export const practiceFor = (level: number) => (level + 1) * 3;

export interface Injury { text: string; severity: 'light' | 'serious' | 'critical' }
export interface Profile {
  characterId: string;
  gameId: string;
  health: number;
  maxHealth: number;
  injuries: Injury[];
  skills: Record<string, { level: number; practice: number }>;
  fame: number;
  deeds: string[]; // the last few things people talk about
  createdAt: string;
  updatedAt: string;
}
export interface Item {
  id: string;
  gameId: string;
  ownerId: string;
  name: string;
  kind: 'weapon' | 'armor' | 'gear' | 'valuable';
  quality: number; // 0 crude … 3 masterwork
  quantity: number;
  createdAt: string;
}

export const ADVENTURE_MIGRATIONS = [
  /* adventure v1 */ `
  CREATE TABLE adv_profiles (
    character_id TEXT PRIMARY KEY REFERENCES characters(id),
    game_id      TEXT NOT NULL REFERENCES games(id),
    health       INTEGER NOT NULL,
    max_health   INTEGER NOT NULL,
    injuries_json TEXT NOT NULL DEFAULT '[]',
    skills_json  TEXT NOT NULL DEFAULT '{}',
    fame         INTEGER NOT NULL DEFAULT 0,
    deeds_json   TEXT NOT NULL DEFAULT '[]',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE TABLE adv_items (
    id         TEXT PRIMARY KEY,
    game_id    TEXT NOT NULL REFERENCES games(id),
    owner_id   TEXT NOT NULL REFERENCES characters(id),
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('weapon', 'armor', 'gear', 'valuable')),
    quality    INTEGER NOT NULL CHECK (quality BETWEEN 0 AND 3),
    quantity   INTEGER NOT NULL CHECK (quantity > 0),
    created_at TEXT NOT NULL
  );
  `,
];

type Row = Record<string, any>;
const mapProfile = (r: Row): Profile => ({
  characterId: r.character_id, gameId: r.game_id, health: r.health, maxHealth: r.max_health, injuries: JSON.parse(r.injuries_json),
  skills: JSON.parse(r.skills_json), fame: r.fame, deeds: JSON.parse(r.deeds_json), createdAt: r.created_at, updatedAt: r.updated_at,
});
const mapItem = (r: Row): Item => ({ id: r.id, gameId: r.game_id, ownerId: r.owner_id, name: r.name, kind: r.kind, quality: r.quality, quantity: r.quantity, createdAt: r.created_at });
const profileParams = (p: Profile) => ({ ...p, injuries: JSON.stringify(p.injuries), skills: JSON.stringify(p.skills), deeds: JSON.stringify(p.deeds) });
const UPSERT_PROFILE = `INSERT INTO adv_profiles (character_id, game_id, health, max_health, injuries_json, skills_json, fame, deeds_json, created_at, updated_at)
  VALUES (:characterId, :gameId, :health, :maxHealth, :injuries, :skills, :fame, :deeds, :createdAt, :updatedAt)
  ON CONFLICT (character_id) DO UPDATE SET health = :health, max_health = :maxHealth, injuries_json = :injuries, skills_json = :skills,
    fame = :fame, deeds_json = :deeds, updated_at = :updatedAt`;
const INSERT_ITEM = `INSERT INTO adv_items (id, game_id, owner_id, name, kind, quality, quantity, created_at)
  VALUES (:id, :gameId, :ownerId, :name, :kind, :quality, :quantity, :createdAt)`;

export const advRepo = {
  profile: (store: Store, characterId: string) => { const r = store.get('SELECT * FROM adv_profiles WHERE character_id = :c', { c: characterId }); return r && mapProfile(r); },
  profiles: (store: Store, gameId: string) => store.all('SELECT * FROM adv_profiles WHERE game_id = :g', { g: gameId }).map(mapProfile),
  items: (store: Store, gameId: string) => store.all('SELECT * FROM adv_items WHERE game_id = :g ORDER BY rowid', { g: gameId }).map(mapItem),
  saveProfile: (store: Store, p: Profile) => store.run(UPSERT_PROFILE, profileParams(p)),
  insertItem: (store: Store, i: Item) => store.run(INSERT_ITEM, { ...i }),
};

/** Simulated adventure state for one turn; written at commit. */
export class AdventureState implements PackTurnState {
  readonly profiles = new Map<string, Profile>();
  readonly items = new Map<string, Item>();
  private dirtyProfiles = new Set<string>();
  private newItems: Item[] = [];
  private updatedItems = new Set<string>();
  private removedItems = new Set<string>();

  constructor(store: Store, gameId: string) {
    for (const p of advRepo.profiles(store, gameId)) this.profiles.set(p.characterId, p);
    for (const i of advRepo.items(store, gameId)) this.items.set(i.id, i);
  }

  profileOf(characterId: string, gameId: string, now: string, init?: Partial<Profile>): Profile {
    let p = this.profiles.get(characterId);
    if (!p) {
      p = { characterId, gameId, health: 100, maxHealth: 100, injuries: [], skills: {}, fame: 0, deeds: [], createdAt: now, updatedAt: now, ...init };
      this.profiles.set(characterId, p);
      this.dirtyProfiles.add(characterId);
    }
    return p;
  }
  touch(p: Profile, now: string) { p.updatedAt = now; this.dirtyProfiles.add(p.characterId); }

  itemsOf(ownerId: string) { return [...this.items.values()].filter((i) => i.ownerId === ownerId && !this.removedItems.has(i.id)); }
  findItem(ownerId: string, name: string) {
    const n = name.trim().toLowerCase();
    const mine = this.itemsOf(ownerId);
    return mine.find((i) => i.name.toLowerCase() === n) ?? mine.find((i) => i.name.toLowerCase().includes(n) || n.includes(i.name.toLowerCase()));
  }
  best(ownerId: string, kind: Item['kind']) { return this.itemsOf(ownerId).filter((i) => i.kind === kind).sort((a, b) => b.quality - a.quality)[0]; }
  addItem(i: Item) { this.items.set(i.id, i); this.newItems.push(i); }
  removeItem(i: Item, quantity = i.quantity) {
    if (quantity >= i.quantity) this.removedItems.add(i.id);
    else { i.quantity -= quantity; this.updatedItems.add(i.id); }
  }
  giveItem(i: Item, toId: string) { i.ownerId = toId; this.updatedItems.add(i.id); }

  commit(store: Store) {
    const out: { table: string; op: string; id: string; note?: string }[] = [];
    for (const id of this.dirtyProfiles) {
      const p = this.profiles.get(id)!;
      advRepo.saveProfile(store, p);
      out.push({ table: 'adv_profiles', op: 'upsert', id, note: `health ${p.health}, fame ${p.fame}` });
    }
    for (const i of this.newItems) { advRepo.insertItem(store, i); out.push({ table: 'adv_items', op: 'insert', id: i.id, note: i.name }); }
    for (const id of this.updatedItems) {
      if (this.removedItems.has(id) || this.newItems.some((x) => x.id === id)) continue;
      const i = this.items.get(id)!;
      store.run('UPDATE adv_items SET owner_id = :ownerId, quantity = :quantity WHERE id = :id', { id, ownerId: i.ownerId, quantity: i.quantity });
      out.push({ table: 'adv_items', op: 'update', id });
    }
    for (const id of this.removedItems) {
      store.run('DELETE FROM adv_items WHERE id = :id', { id });
      out.push({ table: 'adv_items', op: 'delete', id });
    }
    return out;
  }
}

export const FAME_TIERS: [number, string][] = [
  [0, 'unknown'], [1, 'a few people know your name'], [3, 'known around here'], [6, 'known in the region'],
  [10, 'famous across the land'], [15, 'a legend across the known worlds'],
];
export const fameLabel = (fame: number) => [...FAME_TIERS].reverse().find(([min]) => fame >= min)![1];
