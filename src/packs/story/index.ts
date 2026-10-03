import type { Store } from '../../db/store.ts';
import type { GamePack } from '../types.ts';
import { FALLEN_WORLD } from './world.ts';

// ============================================================================
// Game Pack: Story — for writing a book with the engine (author mode). No dice, no money, no mechanics:
// the bible, the characters with their own memories and secrets, and the manuscript, scene by scene.
// ============================================================================

export const STORY_MIGRATIONS = [
  /* story v1 — chapters and scenes of the manuscript */ `
  CREATE TABLE story_chapters (
    game_id    TEXT NOT NULL REFERENCES games(id),
    num        INTEGER NOT NULL,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (game_id, num)
  );
  CREATE TABLE story_scenes (
    id         TEXT PRIMARY KEY,
    game_id    TEXT NOT NULL REFERENCES games(id),
    chapter    INTEGER NOT NULL,
    seq        INTEGER NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('draft', 'accepted', 'discarded')),
    brief      TEXT NOT NULL,
    notes_json TEXT NOT NULL DEFAULT '[]',
    title      TEXT NOT NULL,
    prose      TEXT NOT NULL,
    summary    TEXT NOT NULL,
    meta_json  TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
];

export interface StoryScene {
  id: string; gameId: string; chapter: number; seq: number; status: 'draft' | 'accepted' | 'discarded';
  brief: string; notes: string[]; title: string; prose: string; summary: string; meta: Record<string, unknown>; createdAt: string; updatedAt: string;
}
type Row = Record<string, any>;
const mapScene = (r: Row): StoryScene => ({ id: r.id, gameId: r.game_id, chapter: r.chapter, seq: r.seq, status: r.status, brief: r.brief, notes: JSON.parse(r.notes_json),
  title: r.title, prose: r.prose, summary: r.summary, meta: JSON.parse(r.meta_json), createdAt: r.created_at, updatedAt: r.updated_at });

export const storyRepo = {
  chapters: (store: Store, gameId: string) => store.all('SELECT num, title FROM story_chapters WHERE game_id = :g ORDER BY num', { g: gameId }) as { num: number; title: string }[],
  addChapter: (store: Store, gameId: string, num: number, title: string, now: string) =>
    store.run('INSERT INTO story_chapters (game_id, num, title, created_at) VALUES (:g, :n, :t, :now)', { g: gameId, n: num, t: title, now }),
  scenes: (store: Store, gameId: string, status: StoryScene['status'] = 'accepted') =>
    store.all('SELECT * FROM story_scenes WHERE game_id = :g AND status = :s ORDER BY chapter, seq', { g: gameId, s: status }).map(mapScene),
  draft: (store: Store, gameId: string) => { const r = store.get(`SELECT * FROM story_scenes WHERE game_id = :g AND status = 'draft' ORDER BY rowid DESC LIMIT 1`, { g: gameId }); return r ? mapScene(r) : null; },
  save: (store: Store, s: StoryScene) => store.run(`INSERT INTO story_scenes (id, game_id, chapter, seq, status, brief, notes_json, title, prose, summary, meta_json, created_at, updated_at)
      VALUES (:id, :gameId, :chapter, :seq, :status, :brief, :notes, :title, :prose, :summary, :meta, :createdAt, :updatedAt)
      ON CONFLICT (id) DO UPDATE SET status = :status, notes_json = :notes, title = :title, prose = :prose, summary = :summary, meta_json = :meta, chapter = :chapter, seq = :seq, updated_at = :updatedAt`,
    { ...s, notes: JSON.stringify(s.notes), meta: JSON.stringify(s.meta) }),
};

export const storyPack: GamePack = {
  id: 'story',
  name: 'Story (author mode)',
  currency: { code: 'EUR', symbol: '€' },
  migrations: STORY_MIGRATIONS,
  worldCreation: {
    summary: 'a book you write with the engine: you give each scene (what happens, how it feels, the atmosphere) and it writes it in full; no dice, no mechanics',
    guidance: 'Build the story bible with the author: world, rules, characters, what each knows, the hidden truths (secrets) the reader must discover slowly, the tone and the voice.',
    template: FALLEN_WORLD,
  },
  offerKinds: [],
  entities: { find: () => undefined, name: (_api, id) => id, controlledBy: () => false },
  actions: [],
  createTurnState: () => ({ commit: () => [] }),
  briefing: { player: () => [], npc: () => [] },
  statusParts: () => [],
  prompts: { interpretActions: '', director: 'Developments come only from the author.' },
};
