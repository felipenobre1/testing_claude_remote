import type { Store } from '../../db/store.ts';
import type { PackTurnState } from '../types.ts';

// Adventure pack state: bodies (health, injuries), skills that grow with practice, fame, and what people carry.

export const SKILLS = ['combat', 'stealth', 'athletics', 'survival', 'perception', 'persuasion', 'deception', 'lore', 'arcana', 'performance'] as const;
export type Skill = (typeof SKILLS)[number];
export const ATTRIBUTES = ['strength', 'agility', 'wits', 'presence'] as const;
export type Attribute = (typeof ATTRIBUTES)[number];
/** Which attribute backs each skill. */
export const SKILL_ATTR: Record<Skill, Attribute> = {
  combat: 'strength', stealth: 'agility', athletics: 'agility', survival: 'wits', perception: 'wits', persuasion: 'presence', deception: 'presence', lore: 'wits',
  arcana: 'wits', performance: 'presence',
};

// ---- fights that last several exchanges ----
export const MOVES = ['strong', 'quick', 'defend', 'feint', 'grapple', 'ground'] as const;
export type Move = (typeof MOVES)[number];
export type FoeIntent = 'kill' | 'hurt' | 'humiliate' | 'drive_off' | 'spar';
export interface Combatant {
  characterId: string | null; // a known person, or null for an unnamed group ("two dock thugs")
  name: string;
  threat: number; // 1–5
  health: number;
  maxHealth: number;
  stamina: number; // 0–100
  advantage: number; // 0–3, momentum from winning exchanges
  style: 'aggressive' | 'defensive' | 'tricky' | 'brute' | 'fearful';
  weapon?: string | null; // what they fight with; null = bare hands
  intent: FoeIntent;
  blunt: boolean; // fists/clubs/training weapons: bruises, not cuts
  status: 'fighting' | 'down' | 'yielded' | 'fled' | 'dead';
  protects: string | null; // the person these guards stand in front of
}
export interface Encounter {
  kind: 'fight' | 'spar';
  aggressor: 'player' | 'npc';
  playerIntent: 'kill' | 'subdue' | 'drive_off' | 'defend' | 'duel' | 'spar';
  target: string | null; // who the player is really after (behind the guards)
  exchanges: number;
  playerStamina: number;
  playerAdvantage: number;
  witnessed: boolean;
  weaponName: string | null;
  opponents: Combatant[];
  location: string;
  startedGameTime: string; lastTurnId: string | null;
}
export const MAX_LEVEL = 5;
/** XP needed to go from character level n to n+1. */
export const xpForNext = (level: number) => 100 * level;
export const DEFAULT_ATTRIBUTES: Record<Attribute, number> = { strength: 2, agility: 2, wits: 2, presence: 2 };
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
  attributes: Record<string, number>; // strength, agility, wits, presence (1–5)
  xp: number; // toward the next level
  level: number; // character level
  points: number; // unspent points (skill = 1, attribute = 3)
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
  /* adventure v2 — the character sheet: attributes, XP, level, unspent points; new skills live in skills_json */ `
  ALTER TABLE adv_profiles ADD COLUMN attributes_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE adv_profiles ADD COLUMN xp INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE adv_profiles ADD COLUMN level INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE adv_profiles ADD COLUMN points INTEGER NOT NULL DEFAULT 0;
  `,
  /* adventure v3 — a fight in progress lasts several exchanges (one per game) */ `
  CREATE TABLE adv_encounters (
    game_id    TEXT PRIMARY KEY REFERENCES games(id),
    json       TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
];

type Row = Record<string, any>;
const mapProfile = (r: Row): Profile => ({
  characterId: r.character_id, gameId: r.game_id, health: r.health, maxHealth: r.max_health, injuries: JSON.parse(r.injuries_json),
  skills: JSON.parse(r.skills_json), fame: r.fame, deeds: JSON.parse(r.deeds_json), createdAt: r.created_at, updatedAt: r.updated_at,
  attributes: { ...DEFAULT_ATTRIBUTES, ...JSON.parse(r.attributes_json ?? '{}') }, xp: r.xp ?? 0, level: r.level ?? 1, points: r.points ?? 0,
});
const mapItem = (r: Row): Item => ({ id: r.id, gameId: r.game_id, ownerId: r.owner_id, name: r.name, kind: r.kind, quality: r.quality, quantity: r.quantity, createdAt: r.created_at });
const profileParams = (p: Profile) => ({ ...p, injuries: JSON.stringify(p.injuries), skills: JSON.stringify(p.skills), deeds: JSON.stringify(p.deeds), attributes: JSON.stringify(p.attributes) });
const UPSERT_PROFILE = `INSERT INTO adv_profiles (character_id, game_id, health, max_health, injuries_json, skills_json, fame, deeds_json, attributes_json, xp, level, points, created_at, updated_at)
  VALUES (:characterId, :gameId, :health, :maxHealth, :injuries, :skills, :fame, :deeds, :attributes, :xp, :level, :points, :createdAt, :updatedAt)
  ON CONFLICT (character_id) DO UPDATE SET health = :health, max_health = :maxHealth, injuries_json = :injuries, skills_json = :skills,
    fame = :fame, deeds_json = :deeds, attributes_json = :attributes, xp = :xp, level = :level, points = :points, updated_at = :updatedAt`;
const INSERT_ITEM = `INSERT INTO adv_items (id, game_id, owner_id, name, kind, quality, quantity, created_at)
  VALUES (:id, :gameId, :ownerId, :name, :kind, :quality, :quantity, :createdAt)`;

export const advRepo = {
  profile: (store: Store, characterId: string) => { const r = store.get('SELECT * FROM adv_profiles WHERE character_id = :c', { c: characterId }); return r && mapProfile(r); },
  profiles: (store: Store, gameId: string) => store.all('SELECT * FROM adv_profiles WHERE game_id = :g', { g: gameId }).map(mapProfile),
  encounter: (store: Store, gameId: string): Encounter | null => { const r = store.get('SELECT json FROM adv_encounters WHERE game_id = :g', { g: gameId }); return r ? JSON.parse(r.json) : null; },
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
  /** The fight in progress, if any (null when none). */
  encounter: Encounter | null;
  private encounterDirty = false;
  private readonly gameId: string;

  constructor(store: Store, gameId: string) {
    this.gameId = gameId;
    for (const p of advRepo.profiles(store, gameId)) this.profiles.set(p.characterId, p);
    for (const i of advRepo.items(store, gameId)) this.items.set(i.id, i);
    this.encounter = advRepo.encounter(store, gameId);
  }
  setEncounter(e: Encounter | null) { this.encounter = e; this.encounterDirty = true; }

  profileOf(characterId: string, gameId: string, now: string, init?: Partial<Profile>): Profile {
    let p = this.profiles.get(characterId);
    if (!p) {
      p = { characterId, gameId, health: 100, maxHealth: 100, injuries: [], skills: {}, fame: 0, deeds: [], attributes: { ...DEFAULT_ATTRIBUTES }, xp: 0, level: 1, points: 0,
        createdAt: now, updatedAt: now, ...init };
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
    if (this.encounterDirty) {
      if (this.encounter) {
        store.run(`INSERT INTO adv_encounters (game_id, json, updated_at) VALUES (:g, :j, :t) ON CONFLICT (game_id) DO UPDATE SET json = :j, updated_at = :t`,
          { g: this.gameId, j: JSON.stringify(this.encounter), t: new Date().toISOString() });
        out.push({ table: 'adv_encounters', op: 'upsert', id: this.gameId, note: `exchange ${this.encounter.exchanges}` });
      } else {
        store.run('DELETE FROM adv_encounters WHERE game_id = :g', { g: this.gameId });
        out.push({ table: 'adv_encounters', op: 'delete', id: this.gameId });
      }
    }
    return out;
  }
}

export const FAME_TIERS: [number, string][] = [
  [0, 'unknown'], [1, 'a few people know your name'], [3, 'known around here'], [6, 'known in the region'],
  [10, 'famous across the land'], [15, 'a legend across the known worlds'],
];
export const fameLabel = (fame: number) => [...FAME_TIERS].reverse().find(([min]) => fame >= min)![1];
const FAME_PT = ['desconhecido', 'algumas pessoas sabem seu nome', 'conhecido por aqui', 'conhecido na região', 'famoso por toda a terra', 'uma lenda nos mundos conhecidos'];
export const fameLabelIn = (fame: number, lang: 'en' | 'pt' = 'en') =>
  lang === 'pt' ? FAME_PT[FAME_TIERS.findLastIndex(([min]) => fame >= min)]! : fameLabel(fame);
