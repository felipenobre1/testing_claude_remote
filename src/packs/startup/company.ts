import type { Store } from '../../db/store.ts';
import type { PackTurnState } from '../types.ts';

// Startup pack state: companies, their ownership (cap table) and product stage.
// Money itself is generic (the company owns an engine account of kind "entity").

export type ProductStage = 'idea' | 'prototype' | 'mvp' | 'launched';
export const PRODUCT_STAGES: ProductStage[] = ['idea', 'prototype', 'mvp', 'launched'];
export const FOUNDER_SHARES = 1_000_000;

export interface Company {
  id: string;
  gameId: string;
  name: string;
  description: string;
  productStage: ProductStage;
  totalShares: number;
  foundedGameTime: string;
  createdAt: string;
  updatedAt: string;
}

export interface Shareholding {
  companyId: string;
  characterId: string;
  shares: number;
  role: string;
  acquiredGameTime: string;
}

export const STARTUP_MIGRATIONS = [
  /* startup v1 — companies and cap tables (existing saves already have these tables) */ `
  CREATE TABLE IF NOT EXISTS companies (
    id                TEXT PRIMARY KEY,
    game_id           TEXT NOT NULL REFERENCES games(id),
    name              TEXT NOT NULL,
    description       TEXT NOT NULL,
    product_stage     TEXT NOT NULL CHECK (product_stage IN ('idea', 'prototype', 'mvp', 'launched')),
    total_shares      INTEGER NOT NULL CHECK (total_shares > 0),
    founded_game_time TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    UNIQUE (game_id, name)
  );
  CREATE TABLE IF NOT EXISTS shareholdings (
    company_id         TEXT NOT NULL REFERENCES companies(id),
    character_id       TEXT NOT NULL REFERENCES characters(id),
    shares             INTEGER NOT NULL CHECK (shares > 0),
    role               TEXT NOT NULL,
    acquired_game_time TEXT NOT NULL,
    PRIMARY KEY (company_id, character_id)
  );
  `,
];

type Row = Record<string, any>;
const mapCompany = (r: Row): Company => ({
  id: r.id, gameId: r.game_id, name: r.name, description: r.description, productStage: r.product_stage, totalShares: r.total_shares,
  foundedGameTime: r.founded_game_time, createdAt: r.created_at, updatedAt: r.updated_at,
});
const mapHolding = (r: Row): Shareholding => ({
  companyId: r.company_id, characterId: r.character_id, shares: r.shares, role: r.role, acquiredGameTime: r.acquired_game_time,
});

// ---- read access (used by the pack's status line and inspection) ----
export const companyRepo = {
  list: (store: Store, gameId: string) => store.all('SELECT * FROM companies WHERE game_id = :gameId ORDER BY rowid', { gameId }).map(mapCompany),
  get: (store: Store, id: string) => { const r = store.get('SELECT * FROM companies WHERE id = :id', { id }); return r && mapCompany(r); },
  holdings: (store: Store, companyId: string) =>
    store.all('SELECT * FROM shareholdings WHERE company_id = :c ORDER BY acquired_game_time, rowid', { c: companyId }).map(mapHolding),
  of: (store: Store, characterId: string) =>
    store.all('SELECT c.* FROM companies c JOIN shareholdings h ON h.company_id = c.id WHERE h.character_id = :ch ORDER BY c.rowid', { ch: characterId }).map(mapCompany),
};

/** Simulated company state for one turn; written at commit. */
export class StartupState implements PackTurnState {
  readonly companies = new Map<string, Company>();
  readonly holdings = new Map<string, Shareholding[]>();
  private writes: ({ kind: 'insert_company'; c: Company } | { kind: 'update_company'; c: Company } | { kind: 'insert_holding'; h: Shareholding })[] = [];

  constructor(store: Store, gameId: string) {
    for (const c of companyRepo.list(store, gameId)) {
      this.companies.set(c.id, c);
      this.holdings.set(c.id, companyRepo.holdings(store, c.id));
    }
  }

  byName(name: string) {
    const n = name.trim().toLowerCase();
    return [...this.companies.values()].find((c) => c.name.toLowerCase() === n);
  }
  holdingsOf(companyId: string) { return this.holdings.get(companyId) ?? []; }
  isMember(companyId: string, characterId: string) { return this.holdingsOf(companyId).some((h) => h.characterId === characterId); }
  companiesOf(characterId: string) { return [...this.companies.values()].filter((c) => this.isMember(c.id, characterId)); }

  found(c: Company, founderId: string) {
    const h: Shareholding = { companyId: c.id, characterId: founderId, shares: FOUNDER_SHARES, role: 'founder', acquiredGameTime: c.foundedGameTime };
    this.companies.set(c.id, c);
    this.holdings.set(c.id, [h]);
    this.writes.push({ kind: 'insert_company', c: { ...c } }, { kind: 'insert_holding', h: { ...h } });
  }
  /** Issues new shares so the newcomer owns exactly `percent` afterwards (everyone else is diluted). */
  issue(companyId: string, characterId: string, percent: number, role: string, gameTime: string, now: string) {
    const c = this.companies.get(companyId)!;
    const shares = Math.round((c.totalShares * percent) / (100 - percent));
    const h: Shareholding = { companyId, characterId, shares, role, acquiredGameTime: gameTime };
    c.totalShares += shares;
    c.updatedAt = now;
    this.holdings.get(companyId)!.push(h);
    this.writes.push({ kind: 'insert_holding', h: { ...h } }, { kind: 'update_company', c: { ...c } });
  }
  setStage(companyId: string, stage: ProductStage, now: string) {
    const c = this.companies.get(companyId)!;
    c.productStage = stage;
    c.updatedAt = now;
    this.writes.push({ kind: 'update_company', c: { ...c } });
  }

  commit(store: Store) {
    const out: { table: string; op: string; id: string; note?: string }[] = [];
    for (const w of this.writes) {
      if (w.kind === 'insert_company') {
        store.run(`INSERT INTO companies (id, game_id, name, description, product_stage, total_shares, founded_game_time, created_at, updated_at)
          VALUES (:id, :gameId, :name, :description, :productStage, :totalShares, :foundedGameTime, :createdAt, :updatedAt)`, { ...w.c });
        out.push({ table: 'companies', op: 'insert', id: w.c.id, note: w.c.name });
      } else if (w.kind === 'update_company') {
        store.run('UPDATE companies SET product_stage = :productStage, total_shares = :totalShares, updated_at = :updatedAt WHERE id = :id', { ...w.c });
        out.push({ table: 'companies', op: 'update', id: w.c.id, note: `${w.c.productStage}, ${w.c.totalShares} shares` });
      } else {
        store.run(`INSERT INTO shareholdings (company_id, character_id, shares, role, acquired_game_time)
          VALUES (:companyId, :characterId, :shares, :role, :acquiredGameTime)`, { ...w.h });
        out.push({ table: 'shareholdings', op: 'insert', id: `${w.h.companyId}/${w.h.characterId}`, note: `${w.h.shares} shares` });
      }
    }
    return out;
  }
}

export const pct = (shares: number, total: number) => `${((shares / total) * 100).toFixed(1)}%`;
