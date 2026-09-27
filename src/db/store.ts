import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations.ts';
import type {
  Character, Fact, Game, GameEvent, Interaction, Knowledge, Memory, Relationship, Scene,
  TurnRow, TurnStatus, TurnResponse,
} from '../domain/types.ts';

type Row = Record<string, any>;
type Params = Record<string, string | number | null>;

const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(s: string | null): T => (s == null ? (null as T) : (JSON.parse(s) as T));

/**
 * Thin typed access to the canonical SQLite database.
 * No game logic lives here; callers decide what is allowed.
 */
export class Store {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const row = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as Row;
    for (let v = row.v + 1; v <= MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v - 1]!);
        this.run('INSERT INTO schema_migrations (version, applied_at) VALUES (:v, :t)', { v, t: new Date().toISOString() });
      });
    }
  }

  /** Runs fn inside BEGIN IMMEDIATE … COMMIT; rolls back on any throw. Not re-entrant. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private run(sql: string, p: Record<string, unknown> = {}) {
    return this.db.prepare(sql).run(bind(sql, p));
  }
  private get(sql: string, p: Record<string, unknown> = {}): Row | undefined {
    return this.db.prepare(sql).get(bind(sql, p)) as Row | undefined;
  }
  private all(sql: string, p: Record<string, unknown> = {}): Row[] {
    return this.db.prepare(sql).all(bind(sql, p)) as Row[];
  }

  count(table: string, gameId: string): number {
    if (!/^[a-z_]+$/.test(table)) throw new Error(`bad table ${table}`);
    return (this.get(`SELECT COUNT(*) AS n FROM ${table} WHERE game_id = :gameId`, { gameId }) as Row).n;
  }

  // ---------- games ----------
  insertGame(g: Game): void {
    this.run(
      `INSERT INTO games (id, title, timezone, game_time, player_character_id, revision, created_at, updated_at)
       VALUES (:id, :title, :timezone, :gameTime, :playerCharacterId, :revision, :createdAt, :updatedAt)`,
      { ...g },
    );
  }
  getGame(id: string): Game | undefined {
    const r = this.get('SELECT * FROM games WHERE id = :id', { id });
    return r && mapGame(r);
  }
  listGames(): Game[] {
    return this.all('SELECT * FROM games ORDER BY updated_at DESC').map(mapGame);
  }
  advanceGame(id: string, gameTime: string, revision: number, now: string): void {
    this.run('UPDATE games SET game_time = :gameTime, revision = :revision, updated_at = :now WHERE id = :id', {
      id, gameTime, revision, now,
    });
  }

  // ---------- characters ----------
  insertCharacter(c: Character): void {
    this.run(
      `INSERT INTO characters (id, game_id, is_player, name, age, gender, role, occupation, background, personality,
         traits_json, values_json, goals_json, fears_json, location, origin, created_at, updated_at)
       VALUES (:id, :gameId, :isPlayer, :name, :age, :gender, :role, :occupation, :background, :personality,
         :traits, :values, :goals, :fears, :location, :origin, :createdAt, :updatedAt)`,
      {
        ...c,
        isPlayer: c.isPlayer ? 1 : 0,
        traits: json(c.traits), values: json(c.values), goals: json(c.goals), fears: json(c.fears),
      },
    );
  }
  getCharacter(id: string): Character | undefined {
    const r = this.get('SELECT * FROM characters WHERE id = :id', { id });
    return r && mapCharacter(r);
  }
  listCharacters(gameId: string): Character[] {
    return this.all('SELECT * FROM characters WHERE game_id = :gameId ORDER BY created_at, rowid', { gameId }).map(mapCharacter);
  }

  // ---------- relationships ----------
  getRelationship(fromCharacterId: string, toCharacterId: string): Relationship | undefined {
    const r = this.get('SELECT * FROM relationships WHERE from_character_id = :f AND to_character_id = :t', {
      f: fromCharacterId, t: toCharacterId,
    });
    return r && mapRelationship(r);
  }
  listRelationshipsFrom(fromCharacterId: string): Relationship[] {
    return this.all('SELECT * FROM relationships WHERE from_character_id = :f ORDER BY updated_at DESC', { f: fromCharacterId }).map(mapRelationship);
  }
  /** Insert or replace the summary of a directional relationship. Returns 'insert' | 'update'. */
  upsertRelationship(r: Relationship): 'insert' | 'update' {
    const existing = this.getRelationship(r.fromCharacterId, r.toCharacterId);
    if (existing) {
      this.run(
        `UPDATE relationships SET summary = :summary, source = :source, source_event_id = :sourceEventId, updated_at = :updatedAt
         WHERE id = :id`,
        { id: existing.id, summary: r.summary, source: r.source, sourceEventId: r.sourceEventId, updatedAt: r.updatedAt },
      );
      return 'update';
    }
    this.run(
      `INSERT INTO relationships (id, game_id, from_character_id, to_character_id, summary, source, source_event_id, created_at, updated_at)
       VALUES (:id, :gameId, :fromCharacterId, :toCharacterId, :summary, :source, :sourceEventId, :createdAt, :updatedAt)`,
      { ...r },
    );
    return 'insert';
  }

  // ---------- facts ----------
  insertFact(f: Fact): void {
    this.run(
      `INSERT INTO facts (id, game_id, subject, predicate, value, created_at, updated_at)
       VALUES (:id, :gameId, :subject, :predicate, :value, :createdAt, :updatedAt)`,
      { ...f },
    );
  }
  getFact(gameId: string, subject: string, predicate: string): Fact | undefined {
    const r = this.get('SELECT * FROM facts WHERE game_id = :gameId AND subject = :subject AND predicate = :predicate', {
      gameId, subject, predicate,
    });
    return r && mapFact(r);
  }
  listFactsAbout(gameId: string, subject: string): Fact[] {
    return this.all('SELECT * FROM facts WHERE game_id = :gameId AND subject = :subject ORDER BY predicate', { gameId, subject }).map(mapFact);
  }
  listFacts(gameId: string): Fact[] {
    return this.all('SELECT * FROM facts WHERE game_id = :gameId ORDER BY subject, predicate', { gameId }).map(mapFact);
  }

  // ---------- interactions & scene ----------
  insertInteraction(i: Interaction): void {
    this.run(
      `INSERT INTO interactions (id, game_id, channel, participant_ids_json, started_game_time, ended_game_time, created_at)
       VALUES (:id, :gameId, :channel, :participants, :startedGameTime, :endedGameTime, :createdAt)`,
      { ...i, participants: json(i.participantIds), participantIds: null },
    );
  }
  getInteraction(id: string): Interaction | undefined {
    const r = this.get('SELECT * FROM interactions WHERE id = :id', { id });
    return r && mapInteraction(r);
  }
  endInteraction(id: string, gameTime: string): void {
    this.run('UPDATE interactions SET ended_game_time = :gameTime WHERE id = :id', { id, gameTime });
  }
  insertScene(s: Scene): void {
    this.run(
      `INSERT INTO scenes (id, game_id, location, description, active_character_ids_json, interaction_id, updated_at)
       VALUES (:id, :gameId, :location, :description, :active, :interactionId, :updatedAt)`,
      { ...s, active: json(s.activeCharacterIds), activeCharacterIds: null },
    );
  }
  getScene(gameId: string): Scene {
    const r = this.get('SELECT * FROM scenes WHERE game_id = :gameId', { gameId });
    if (!r) throw new Error(`no scene for game ${gameId}`);
    return mapScene(r);
  }
  updateScene(s: Scene): void {
    this.run(
      `UPDATE scenes SET location = :location, description = :description, active_character_ids_json = :active,
         interaction_id = :interactionId, updated_at = :updatedAt WHERE id = :id`,
      { id: s.id, location: s.location, description: s.description, active: json(s.activeCharacterIds), interactionId: s.interactionId, updatedAt: s.updatedAt },
    );
  }

  // ---------- events ----------
  insertEvent(e: GameEvent): void {
    this.run(
      `INSERT INTO events (id, game_id, turn_id, interaction_id, game_time, type, summary, transcript_json, importance, location, created_at)
       VALUES (:id, :gameId, :turnId, :interactionId, :gameTime, :type, :summary, :transcript, :importance, :location, :createdAt)`,
      {
        id: e.id, gameId: e.gameId, turnId: e.turnId, interactionId: e.interactionId, gameTime: e.gameTime, type: e.type,
        summary: e.summary, transcript: json(e.transcript), importance: e.importance, location: e.location, createdAt: e.createdAt,
      },
    );
    for (const p of e.participants) {
      this.run('INSERT OR IGNORE INTO event_participants (event_id, character_id, role) VALUES (:e, :c, :r)', { e: e.id, c: p.characterId, r: p.role });
    }
    for (const o of e.observers) {
      this.run('INSERT INTO event_observers (event_id, character_id, channel) VALUES (:e, :c, :ch)', { e: e.id, c: o.characterId, ch: o.channel });
    }
  }
  private hydrateEvents(rows: Row[]): GameEvent[] {
    return rows.map((r) => {
      const participants = this.all('SELECT character_id, role FROM event_participants WHERE event_id = :id', { id: r.id })
        .map((p) => ({ characterId: p.character_id, role: p.role }));
      const observers = this.all('SELECT character_id, channel FROM event_observers WHERE event_id = :id', { id: r.id })
        .map((o) => ({ characterId: o.character_id, channel: o.channel }));
      return mapEvent(r, participants, observers);
    });
  }
  getEvent(id: string): GameEvent | undefined {
    return this.hydrateEvents(this.all('SELECT * FROM events WHERE id = :id', { id }))[0];
  }
  /** Perspective query: ONLY events this character observed. */
  listEventsObservedBy(characterId: string): GameEvent[] {
    return this.hydrateEvents(this.all(
      `SELECT e.* FROM events e JOIN event_observers o ON o.event_id = e.id
       WHERE o.character_id = :c ORDER BY e.game_time, e.rowid`,
      { c: characterId },
    ));
  }
  listEvents(gameId: string): GameEvent[] {
    return this.hydrateEvents(this.all('SELECT * FROM events WHERE game_id = :gameId ORDER BY game_time, rowid', { gameId }));
  }

  // ---------- memories ----------
  insertMemory(m: Memory): void {
    this.run(
      `INSERT INTO memories (id, game_id, owner_character_id, summary, importance, emotional_weight, source, source_event_id, game_time, created_at)
       VALUES (:id, :gameId, :ownerCharacterId, :summary, :importance, :emotionalWeight, :source, :sourceEventId, :gameTime, :createdAt)`,
      { ...m, subjectIds: null },
    );
    for (const s of m.subjectIds) {
      this.run('INSERT OR IGNORE INTO memory_subjects (memory_id, character_id) VALUES (:m, :c)', { m: m.id, c: s });
    }
  }
  /** Perspective query: ONLY memories owned by this character. */
  listMemoriesOwnedBy(characterId: string): Memory[] {
    return this.all('SELECT * FROM memories WHERE owner_character_id = :c ORDER BY game_time, rowid', { c: characterId }).map((r) => {
      const subjectIds = this.all('SELECT character_id FROM memory_subjects WHERE memory_id = :id', { id: r.id }).map((s) => s.character_id as string);
      return mapMemory(r, subjectIds);
    });
  }

  // ---------- knowledge ----------
  getKnowledge(characterId: string, topic: string): Knowledge | undefined {
    const r = this.get('SELECT * FROM knowledge WHERE character_id = :c AND topic = :topic', { c: characterId, topic });
    return r && mapKnowledge(r);
  }
  /** Perspective query: ONLY this character's knowledge. */
  listKnowledgeOf(characterId: string): Knowledge[] {
    return this.all('SELECT * FROM knowledge WHERE character_id = :c ORDER BY updated_at, rowid', { c: characterId }).map(mapKnowledge);
  }
  /** Insert, or replace belief/confidence/source for an existing (character, topic). */
  upsertKnowledge(k: Knowledge): { op: 'insert' | 'update'; id: string } {
    const existing = this.getKnowledge(k.characterId, k.topic);
    if (existing) {
      this.run(
        `UPDATE knowledge SET belief = :belief, confidence = :confidence, about_character_id = :about, source = :source,
           source_event_id = :sourceEventId, game_time = :gameTime, updated_at = :updatedAt WHERE id = :id`,
        { id: existing.id, belief: k.belief, confidence: k.confidence, about: k.aboutCharacterId, source: k.source,
          sourceEventId: k.sourceEventId, gameTime: k.gameTime, updatedAt: k.updatedAt },
      );
      return { op: 'update', id: existing.id };
    }
    this.run(
      `INSERT INTO knowledge (id, game_id, character_id, topic, belief, confidence, about_character_id, fact_id, source, source_event_id, game_time, created_at, updated_at)
       VALUES (:id, :gameId, :characterId, :topic, :belief, :confidence, :aboutCharacterId, :factId, :source, :sourceEventId, :gameTime, :createdAt, :updatedAt)`,
      { ...k },
    );
    return { op: 'insert', id: k.id };
  }

  // ---------- turns ----------
  getFinalTurnByRequest(gameId: string, requestId: string): TurnRow | undefined {
    const r = this.get(
      `SELECT * FROM turns WHERE game_id = :gameId AND request_id = :requestId AND status IN ('committed', 'clarification')`,
      { gameId, requestId },
    );
    return r && mapTurn(r);
  }
  getTurnBySeq(gameId: string, seq: number): TurnRow | undefined {
    const r = this.get('SELECT * FROM turns WHERE game_id = :gameId AND seq = :seq', { gameId, seq });
    return r && mapTurn(r);
  }
  lastTurn(gameId: string): TurnRow | undefined {
    const r = this.get('SELECT * FROM turns WHERE game_id = :gameId ORDER BY seq DESC LIMIT 1', { gameId });
    return r && mapTurn(r);
  }
  listTurns(gameId: string): TurnRow[] {
    return this.all('SELECT * FROM turns WHERE game_id = :gameId ORDER BY seq', { gameId }).map(mapTurn);
  }
  insertTurn(t: {
    id: string; gameId: string; requestId: string; status: TurnStatus; baseRevision: number; committedRevision: number | null;
    playerInput: string; response: TurnResponse | null; trace: unknown; createdAt: string;
  }): number {
    const seq = (this.get('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM turns WHERE game_id = :gameId', { gameId: t.gameId }) as Row).s;
    this.run(
      `INSERT INTO turns (id, game_id, request_id, seq, status, base_revision, committed_revision, player_input, response_json, trace_json, created_at)
       VALUES (:id, :gameId, :requestId, :seq, :status, :baseRevision, :committedRevision, :playerInput, :response, :trace, :createdAt)`,
      {
        id: t.id, gameId: t.gameId, requestId: t.requestId, seq, status: t.status, baseRevision: t.baseRevision,
        committedRevision: t.committedRevision, playerInput: t.playerInput,
        response: t.response ? json(t.response) : null, trace: json(t.trace), createdAt: t.createdAt,
      },
    );
    return seq;
  }
}

/**
 * node:sqlite rejects unknown named parameters and silently binds NULL for missing ones.
 * Pick exactly the parameters the SQL references and fail loudly on a missing one.
 */
function bind(sql: string, p: Record<string, unknown>): Params {
  const out: Params = {};
  for (const [, name] of sql.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (!(name! in p) || p[name!] === undefined) throw new Error(`missing SQL parameter :${name}`);
    out[name!] = p[name!] as string | number | null;
  }
  return out;
}

// ---------- row mappers ----------
function mapGame(r: Row): Game {
  return {
    id: r.id, title: r.title, timezone: r.timezone, gameTime: r.game_time, playerCharacterId: r.player_character_id,
    revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function mapCharacter(r: Row): Character {
  return {
    id: r.id, gameId: r.game_id, isPlayer: r.is_player === 1, name: r.name, age: r.age, gender: r.gender, role: r.role,
    occupation: r.occupation, background: r.background, personality: r.personality,
    traits: parse(r.traits_json), values: parse(r.values_json), goals: parse(r.goals_json), fears: parse(r.fears_json),
    location: r.location, origin: r.origin, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function mapRelationship(r: Row): Relationship {
  return {
    id: r.id, gameId: r.game_id, fromCharacterId: r.from_character_id, toCharacterId: r.to_character_id, summary: r.summary,
    source: r.source, sourceEventId: r.source_event_id, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function mapFact(r: Row): Fact {
  return { id: r.id, gameId: r.game_id, subject: r.subject, predicate: r.predicate, value: r.value, createdAt: r.created_at, updatedAt: r.updated_at };
}
function mapInteraction(r: Row): Interaction {
  return {
    id: r.id, gameId: r.game_id, channel: r.channel, participantIds: parse(r.participant_ids_json),
    startedGameTime: r.started_game_time, endedGameTime: r.ended_game_time, createdAt: r.created_at,
  };
}
function mapScene(r: Row): Scene {
  return {
    id: r.id, gameId: r.game_id, location: r.location, description: r.description,
    activeCharacterIds: parse(r.active_character_ids_json), interactionId: r.interaction_id, updatedAt: r.updated_at,
  };
}
function mapEvent(r: Row, participants: GameEvent['participants'], observers: GameEvent['observers']): GameEvent {
  return {
    id: r.id, gameId: r.game_id, turnId: r.turn_id, interactionId: r.interaction_id, gameTime: r.game_time, type: r.type,
    summary: r.summary, transcript: parse(r.transcript_json), importance: r.importance, location: r.location,
    createdAt: r.created_at, participants, observers,
  };
}
function mapMemory(r: Row, subjectIds: string[]): Memory {
  return {
    id: r.id, gameId: r.game_id, ownerCharacterId: r.owner_character_id, summary: r.summary, importance: r.importance,
    emotionalWeight: r.emotional_weight, source: r.source, sourceEventId: r.source_event_id, gameTime: r.game_time,
    createdAt: r.created_at, subjectIds,
  };
}
function mapKnowledge(r: Row): Knowledge {
  return {
    id: r.id, gameId: r.game_id, characterId: r.character_id, topic: r.topic, belief: r.belief, confidence: r.confidence,
    aboutCharacterId: r.about_character_id, factId: r.fact_id, source: r.source, sourceEventId: r.source_event_id,
    gameTime: r.game_time, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function mapTurn(r: Row): TurnRow {
  return {
    id: r.id, gameId: r.game_id, requestId: r.request_id, seq: r.seq, status: r.status, baseRevision: r.base_revision,
    committedRevision: r.committed_revision, playerInput: r.player_input, response: parse(r.response_json),
    trace: parse(r.trace_json), createdAt: r.created_at,
  };
}
