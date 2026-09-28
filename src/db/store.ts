import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS, type Migration } from './migrations.ts';
import type {
  Character, Fact, Game, GameEvent, Interaction, Knowledge, Memory, Relationship, Scene,
  TurnRow, TurnStatus, TurnResponse, WebDocument,
  Account, DecisionRecord, Obligation, Offer, RecurringPayment, ScheduledItem, StoryThread, Transaction,
} from '../domain/types.ts';
import type { DecisionState } from '../domain/schemas.ts';

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

  /**
   * Permanently deletes one game and everything that belongs to it, in every table (engine and pack tables alike):
   * rows carrying its game_id, then rows left pointing at deleted parents (participants, observers, shareholdings…).
   */
  deleteGame(gameId: string): void {
    this.purge(() => {
      for (const t of this.tables()) if (this.columns(t).includes('game_id')) this.db.prepare(`DELETE FROM "${t}" WHERE game_id = ?`).run(gameId);
      this.db.prepare('DELETE FROM games WHERE id = ?').run(gameId);
    });
  }
  /** Deletes every game and every world draft (the schema and migrations stay). */
  deleteAllGames(): void {
    this.purge(() => {
      for (const t of this.tables()) if (this.columns(t).includes('game_id') || t === 'world_drafts' || t === 'games') this.db.prepare(`DELETE FROM "${t}"`).run();
    });
  }
  private tables(): string[] {
    return (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
      .map((r) => r.name).filter((t) => !['schema_migrations', 'pack_migrations'].includes(t));
  }
  private columns(table: string): string[] {
    return (this.db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
  }
  private purge(deleteRoots: () => void): void {
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      this.tx(() => {
        deleteRoots();
        // Remove orphans until nothing points at a missing parent.
        for (let pass = 0; pass < 10; pass++) {
          const orphans = this.db.prepare('PRAGMA foreign_key_check').all() as { table: string; rowid: number | null }[];
          if (!orphans.length) return;
          for (const o of orphans) {
            if (o.rowid !== null) this.db.prepare(`DELETE FROM "${o.table}" WHERE rowid = ?`).run(o.rowid);
          }
        }
        throw new Error('could not clean up all rows belonging to the deleted game(s)');
      });
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const row = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as Row;
    for (let v = row.v + 1; v <= MIGRATIONS.length; v++) {
      this.applyMigration(MIGRATIONS[v - 1]!, () => this.run('INSERT INTO schema_migrations (version, applied_at) VALUES (:v, :t)', { v, t: new Date().toISOString() }));
    }
  }

  /** Runs a pack's own migrations (tables the engine knows nothing about). Idempotent. */
  migratePack(pack: string, migrations: Migration[]): void {
    for (let v = 1; v <= migrations.length; v++) {
      if (this.get('SELECT 1 AS x FROM pack_migrations WHERE pack = :pack AND version = :v', { pack, v })) continue;
      this.applyMigration(migrations[v - 1]!, () => this.run('INSERT INTO pack_migrations (pack, version, applied_at) VALUES (:pack, :v, :t)', { pack, v, t: new Date().toISOString() }));
    }
  }

  private applyMigration(m: Migration, record: () => void): void {
    const sql = typeof m === 'string' ? m : m.sql;
    const noFk = typeof m !== 'string' && m.disableForeignKeys;
    if (noFk) this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      this.tx(() => {
        this.db.exec(sql);
        if (noFk) {
          const broken = this.all('PRAGMA foreign_key_check');
          if (broken.length) throw new Error(`migration broke foreign keys: ${JSON.stringify(broken.slice(0, 3))}`);
        }
        record();
      });
    } finally {
      if (noFk) this.db.exec('PRAGMA foreign_keys = ON');
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

  // Named-parameter helpers (also used by game packs for their own tables).
  run(sql: string, p: Record<string, unknown> = {}) {
    return this.db.prepare(sql).run(bind(sql, p));
  }
  get(sql: string, p: Record<string, unknown> = {}): Row | undefined {
    return this.db.prepare(sql).get(bind(sql, p)) as Row | undefined;
  }
  all(sql: string, p: Record<string, unknown> = {}): Row[] {
    return this.db.prepare(sql).all(bind(sql, p)) as Row[];
  }

  count(table: string, gameId: string): number {
    if (!/^[a-z_]+$/.test(table)) throw new Error(`bad table ${table}`);
    return (this.get(`SELECT COUNT(*) AS n FROM ${table} WHERE game_id = :gameId`, { gameId }) as Row).n;
  }

  // ---------- games ----------
  insertGame(g: Game): void {
    this.run(
      `INSERT INTO games (id, title, timezone, game_time, player_character_id, pack_id, revision, created_at, updated_at)
       VALUES (:id, :title, :timezone, :gameTime, :playerCharacterId, :packId, :revision, :createdAt, :updatedAt)`,
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

  // ---------- documents (web page snapshots) ----------
  insertDocument(d: WebDocument): void {
    this.run(
      `INSERT INTO documents (id, game_id, url, final_url, status, title, text, error, fetched_at, game_time, created_at)
       VALUES (:id, :gameId, :url, :finalUrl, :status, :title, :text, :error, :fetchedAt, :gameTime, :createdAt)`,
      { ...d },
    );
  }
  linkEventDocument(eventId: string, documentId: string): void {
    this.run('INSERT OR IGNORE INTO event_documents (event_id, document_id) VALUES (:e, :d)', { e: eventId, d: documentId });
  }
  /** Perspective query: ONLY documents shown to this character through an event they observed. */
  listDocumentsObservedBy(characterId: string): WebDocument[] {
    return this.all(
      `SELECT DISTINCT d.* FROM documents d
       JOIN event_documents ed ON ed.document_id = d.id
       JOIN event_observers o ON o.event_id = ed.event_id
       WHERE o.character_id = :c ORDER BY d.game_time, d.rowid`,
      { c: characterId },
    ).map(mapDocument);
  }

  // ---------- economy ----------
  insertAccount(a: Account): void {
    this.run(
      `INSERT INTO accounts (id, game_id, owner_kind, owner_id, balance_cents, created_at, updated_at)
       VALUES (:id, :gameId, :ownerKind, :ownerId, :balanceCents, :createdAt, :updatedAt)`, { ...a });
  }
  getAccountOf(gameId: string, ownerKind: Account['ownerKind'], ownerId: string): Account | undefined {
    const r = this.get('SELECT * FROM accounts WHERE game_id = :gameId AND owner_kind = :k AND owner_id = :o', { gameId, k: ownerKind, o: ownerId });
    return r && mapAccount(r);
  }
  getAccount(id: string): Account | undefined {
    const r = this.get('SELECT * FROM accounts WHERE id = :id', { id });
    return r && mapAccount(r);
  }
  listAccounts(gameId: string): Account[] {
    return this.all('SELECT * FROM accounts WHERE game_id = :gameId ORDER BY rowid', { gameId }).map(mapAccount);
  }
  /** Moves money and records it. Throws if a paying account would go negative. */
  transfer(t: Transaction): void {
    if (t.fromAccountId) {
      const from = this.getAccount(t.fromAccountId);
      if (!from) throw new Error(`account ${t.fromAccountId} not found`);
      if (from.balanceCents < t.amountCents) throw new Error(`insufficient funds in ${t.fromAccountId}`);
      this.run('UPDATE accounts SET balance_cents = balance_cents - :a, updated_at = :t WHERE id = :id', { a: t.amountCents, t: t.createdAt, id: t.fromAccountId });
    }
    if (t.toAccountId) {
      this.run('UPDATE accounts SET balance_cents = balance_cents + :a, updated_at = :t WHERE id = :id', { a: t.amountCents, t: t.createdAt, id: t.toAccountId });
    }
    this.run(
      `INSERT INTO transactions (id, game_id, turn_id, from_account_id, to_account_id, amount_cents, description, category, game_time, created_at)
       VALUES (:id, :gameId, :turnId, :fromAccountId, :toAccountId, :amountCents, :description, :category, :gameTime, :createdAt)`, { ...t });
  }
  listTransactions(gameId: string): Transaction[] {
    return this.all('SELECT * FROM transactions WHERE game_id = :gameId ORDER BY game_time, rowid', { gameId }).map(mapTransaction);
  }

  insertOffer(o: Offer): void {
    this.run(
      `INSERT INTO offers (id, game_id, kind, from_character_id, to_character_id, subject_ref, label, terms_json, description, status, parent_offer_id,
         attempts, last_outcome, next_decision_after, last_appraisal_json, created_game_time, resolved_game_time, created_at, updated_at)
       VALUES (:id, :gameId, :kind, :fromCharacterId, :toCharacterId, :subjectRef, :label, :terms, :description, :status, :parentOfferId,
         :attempts, :lastOutcome, :nextDecisionAfter, :appraisal, :createdGameTime, :resolvedGameTime, :createdAt, :updatedAt)`,
      { ...o, terms: json(o.terms), appraisal: o.lastAppraisal == null ? null : json(o.lastAppraisal) });
  }
  updateOffer(o: Offer): void {
    this.run(
      `UPDATE offers SET status = :status, attempts = :attempts, last_outcome = :lastOutcome, next_decision_after = :nextDecisionAfter,
         last_appraisal_json = :appraisal, resolved_game_time = :resolvedGameTime, updated_at = :updatedAt WHERE id = :id`,
      { ...o, appraisal: o.lastAppraisal == null ? null : json(o.lastAppraisal) });
  }
  getOffer(id: string): Offer | undefined {
    const r = this.get('SELECT * FROM offers WHERE id = :id', { id });
    return r && mapOffer(r);
  }
  listOffers(gameId: string): Offer[] {
    return this.all('SELECT * FROM offers WHERE game_id = :gameId ORDER BY rowid', { gameId }).map(mapOffer);
  }
  /** Perspective query: offers this character made or received. */
  listOffersInvolving(characterId: string): Offer[] {
    return this.all('SELECT * FROM offers WHERE from_character_id = :c OR to_character_id = :c ORDER BY rowid', { c: characterId }).map(mapOffer);
  }

  insertObligation(o: Obligation): void {
    this.run(
      `INSERT INTO obligations (id, game_id, debtor_id, creditor_id, description, amount_cents, due_game_time, status, overdue_notified, created_game_time, resolved_game_time, created_at, updated_at)
       VALUES (:id, :gameId, :debtorId, :creditorId, :description, :amountCents, :dueGameTime, :status, :overdue, :createdGameTime, :resolvedGameTime, :createdAt, :updatedAt)`,
      { ...o, overdue: o.overdueNotified ? 1 : 0 });
  }
  getObligation(id: string): Obligation | undefined {
    const r = this.get('SELECT * FROM obligations WHERE id = :id', { id });
    return r && mapObligation(r);
  }
  updateObligation(o: Obligation): void {
    this.run('UPDATE obligations SET status = :status, overdue_notified = :overdue, resolved_game_time = :resolvedGameTime, updated_at = :updatedAt WHERE id = :id',
      { ...o, overdue: o.overdueNotified ? 1 : 0 });
  }
  listObligations(gameId: string): Obligation[] {
    return this.all('SELECT * FROM obligations WHERE game_id = :gameId ORDER BY rowid', { gameId }).map(mapObligation);
  }
  /** Perspective query: obligations this character is a party to. */
  listObligationsInvolving(characterId: string): Obligation[] {
    return this.all('SELECT * FROM obligations WHERE debtor_id = :c OR creditor_id = :c ORDER BY rowid', { c: characterId }).map(mapObligation);
  }

  // ---------- story threads & world schedule ----------
  insertThread(t: StoryThread): void {
    this.run(
      `INSERT INTO story_threads (id, game_id, title, summary, status, momentum, urgency, visibility, participants_json, cause_event_ids_json,
         resolution_json, outcome, created_game_time, updated_game_time, resolved_game_time, created_at, updated_at)
       VALUES (:id, :gameId, :title, :summary, :status, :momentum, :urgency, :visibility, :participants, :causes,
         :resolution, :outcome, :createdGameTime, :updatedGameTime, :resolvedGameTime, :createdAt, :updatedAt)`,
      { ...t, participants: json(t.participantIds), causes: json(t.causeEventIds), resolution: json(t.resolution) });
  }
  updateThread(t: StoryThread): void {
    this.run(
      `UPDATE story_threads SET summary = :summary, status = :status, momentum = :momentum, urgency = :urgency, visibility = :visibility,
         resolution_json = :resolution, outcome = :outcome, updated_game_time = :updatedGameTime, resolved_game_time = :resolvedGameTime, updated_at = :updatedAt
       WHERE id = :id`, { ...t, resolution: json(t.resolution) });
  }
  getThread(id: string): StoryThread | undefined {
    const r = this.get('SELECT * FROM story_threads WHERE id = :id', { id });
    return r && mapThread(r);
  }
  listThreads(gameId: string): StoryThread[] {
    return this.all('SELECT * FROM story_threads WHERE game_id = :gameId ORDER BY rowid', { gameId }).map(mapThread);
  }
  linkThreadEvent(threadId: string, eventId: string): void {
    this.run('INSERT OR IGNORE INTO thread_events (thread_id, event_id) VALUES (:t, :e)', { t: threadId, e: eventId });
  }
  insertScheduled(i: ScheduledItem): void {
    this.run(
      `INSERT INTO world_schedule (id, game_id, due_game_time, kind, payload_json, thread_id, status, created_game_time, created_at)
       VALUES (:id, :gameId, :dueGameTime, :kind, :payload, :threadId, :status, :createdGameTime, :createdAt)`, { ...i, payload: json(i.payload) });
  }
  setScheduledStatus(id: string, status: ScheduledItem['status']): void {
    this.run('UPDATE world_schedule SET status = :status WHERE id = :id', { id, status });
  }
  listScheduled(gameId: string, status?: ScheduledItem['status']): ScheduledItem[] {
    return this.all(`SELECT * FROM world_schedule WHERE game_id = :gameId ${status ? 'AND status = :status' : ''} ORDER BY due_game_time, rowid`,
      status ? { gameId, status } : { gameId }).map(mapScheduled);
  }

  insertRecurringPayment(r: RecurringPayment): void {
    this.run(
      `INSERT INTO recurring_payments (id, game_id, from_account_id, to_account_id, description, amount_cents, next_due_game_time, active, created_at)
       VALUES (:id, :gameId, :fromAccountId, :toAccountId, :description, :amountCents, :nextDueGameTime, :active, :createdAt)`, { ...r, active: r.active ? 1 : 0 });
  }

  // ---------- decisions ----------
  getDecisionState(characterId: string, domain: string): DecisionState | undefined {
    const r = this.get('SELECT state_json FROM decision_states WHERE character_id = :c AND domain = :d', { c: characterId, d: domain });
    return r ? (JSON.parse(r.state_json) as DecisionState) : undefined;
  }
  upsertDecisionState(gameId: string, characterId: string, domain: string, state: DecisionState, source: 'generated' | 'seed', now: string): void {
    this.run(
      `INSERT INTO decision_states (game_id, character_id, domain, state_json, source, created_at, updated_at)
       VALUES (:gameId, :c, :d, :s, :source, :now, :now)
       ON CONFLICT (character_id, domain) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
      { gameId, c: characterId, d: domain, s: json(state), source, now });
  }
  listDecisionStates(gameId: string): { characterId: string; domain: string; state: DecisionState; source: string }[] {
    return this.all('SELECT * FROM decision_states WHERE game_id = :gameId ORDER BY rowid', { gameId })
      .map((r) => ({ characterId: r.character_id, domain: r.domain, state: JSON.parse(r.state_json), source: r.source }));
  }
  insertDecision(d: DecisionRecord): void {
    this.run(
      `INSERT INTO decisions (id, game_id, turn_id, offer_id, thread_id, domain, character_id, outcome, final_score, roll, seed, reasons_json, detail_json, game_time, created_at)
       VALUES (:id, :gameId, :turnId, :offerId, :threadId, :domain, :characterId, :outcome, :finalScore, :roll, :seed, :reasons, :detail, :gameTime, :createdAt)`,
      { ...d, reasons: json(d.reasons), detail: json(d.detail) });
  }
  listDecisions(gameId: string): DecisionRecord[] {
    return this.all('SELECT * FROM decisions WHERE game_id = :gameId ORDER BY rowid', { gameId }).map((r) => ({
      id: r.id, gameId: r.game_id, turnId: r.turn_id, offerId: r.offer_id, threadId: r.thread_id, domain: r.domain, characterId: r.character_id, outcome: r.outcome,
      finalScore: r.final_score, roll: r.roll, seed: r.seed, reasons: JSON.parse(r.reasons_json), detail: JSON.parse(r.detail_json),
      gameTime: r.game_time, createdAt: r.created_at,
    }));
  }
  listRecurringPayments(gameId: string): RecurringPayment[] {
    return this.all('SELECT * FROM recurring_payments WHERE game_id = :gameId ORDER BY rowid', { gameId }).map(mapRecurring);
  }
  updateRecurringPayment(r: RecurringPayment): void {
    this.run('UPDATE recurring_payments SET next_due_game_time = :nextDueGameTime, active = :active, amount_cents = :amountCents WHERE id = :id', { ...r, active: r.active ? 1 : 0 });
  }

  // ---------- world creation ----------
  insertDraft(d: { id: string; status: string; draft: unknown; version: number; now: string }): void {
    this.run(`INSERT INTO world_drafts (id, status, draft_json, version, summary_version, game_id, created_at, updated_at)
      VALUES (:id, :status, :draft, :version, NULL, NULL, :now, :now)`, { id: d.id, status: d.status, draft: json(d.draft), version: d.version, now: d.now });
  }
  updateDraft(d: { id: string; status: string; draft: unknown; version: number; summaryVersion: number | null; gameId: string | null; now: string }): void {
    this.run(`UPDATE world_drafts SET status = :status, draft_json = :draft, version = :version, summary_version = :summaryVersion, game_id = :gameId,
      updated_at = :now WHERE id = :id`, { ...d, draft: json(d.draft) });
  }
  getDraft(id: string): DraftRow | undefined {
    const r = this.get('SELECT * FROM world_drafts WHERE id = :id', { id });
    return r && mapDraft(r);
  }
  listDrafts(): DraftRow[] {
    return this.all('SELECT * FROM world_drafts ORDER BY updated_at DESC, rowid DESC').map(mapDraft);
  }
  addDraftMessage(draftId: string, role: 'player' | 'copilot', text: string, now: string): void {
    const seq = (this.get('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM draft_messages WHERE draft_id = :d', { d: draftId }) as Row).s;
    this.run('INSERT INTO draft_messages (id, draft_id, seq, role, text, created_at) VALUES (:id, :d, :seq, :role, :text, :now)',
      { id: `${draftId}:${seq}`, d: draftId, seq, role, text, now });
  }
  listDraftMessages(draftId: string): { role: 'player' | 'copilot'; text: string }[] {
    return this.all('SELECT role, text FROM draft_messages WHERE draft_id = :d ORDER BY seq', { d: draftId }).map((r) => ({ role: r.role, text: r.text }));
  }
  upsertPrice(p: { gameId: string; item: string; priceCents: number; source: string; gameTime: string }): void {
    this.run(`INSERT INTO prices (game_id, item_key, item, price_cents, source, created_game_time) VALUES (:g, :k, :item, :c, :src, :t)
      ON CONFLICT (game_id, item_key) DO NOTHING`, { g: p.gameId, k: priceKey(p.item), item: p.item, c: p.priceCents, src: p.source, t: p.gameTime });
  }
  listPrices(gameId: string): PriceEntry[] {
    return this.all('SELECT * FROM prices WHERE game_id = :g ORDER BY rowid', { g: gameId })
      .map((r) => ({ key: r.item_key, item: r.item, priceCents: r.price_cents, source: r.source }));
  }
  insertWorldSeed(gameId: string, draftId: string | null, packId: string, seed: unknown, now: string): void {
    this.run('INSERT INTO world_seeds (game_id, draft_id, pack_id, seed_json, created_at) VALUES (:g, :d, :p, :s, :now)',
      { g: gameId, d: draftId, p: packId, s: json(seed), now });
  }
  getWorldSeed<T = unknown>(gameId: string): T | undefined {
    const r = this.get('SELECT seed_json FROM world_seeds WHERE game_id = :g', { g: gameId });
    return r ? (JSON.parse(r.seed_json) as T) : undefined;
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
    id: r.id, title: r.title, timezone: r.timezone, gameTime: r.game_time, playerCharacterId: r.player_character_id, packId: r.pack_id,
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
function mapDocument(r: Row): WebDocument {
  return {
    id: r.id, gameId: r.game_id, url: r.url, finalUrl: r.final_url, status: r.status, title: r.title, text: r.text,
    error: r.error, fetchedAt: r.fetched_at, gameTime: r.game_time, createdAt: r.created_at,
  };
}
function mapAccount(r: Row): Account {
  return { id: r.id, gameId: r.game_id, ownerKind: r.owner_kind, ownerId: r.owner_id, balanceCents: r.balance_cents, createdAt: r.created_at, updatedAt: r.updated_at };
}
function mapTransaction(r: Row): Transaction {
  return {
    id: r.id, gameId: r.game_id, turnId: r.turn_id, fromAccountId: r.from_account_id, toAccountId: r.to_account_id, amountCents: r.amount_cents,
    description: r.description, category: r.category, gameTime: r.game_time, createdAt: r.created_at,
  };
}
function mapOffer(r: Row): Offer {
  const terms = Object.fromEntries(Object.entries(parse<Record<string, number | null>>(r.terms_json)).filter(([, v]) => v !== null)) as Record<string, number>;
  return {
    id: r.id, gameId: r.game_id, kind: r.kind, fromCharacterId: r.from_character_id, toCharacterId: r.to_character_id, subjectRef: r.subject_ref,
    label: r.label, terms, description: r.description, status: r.status, parentOfferId: r.parent_offer_id, attempts: r.attempts,
    lastOutcome: r.last_outcome, nextDecisionAfter: r.next_decision_after, lastAppraisal: parse(r.last_appraisal_json), createdGameTime: r.created_game_time,
    resolvedGameTime: r.resolved_game_time, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function mapObligation(r: Row): Obligation {
  return {
    id: r.id, gameId: r.game_id, debtorId: r.debtor_id, creditorId: r.creditor_id, description: r.description, amountCents: r.amount_cents,
    dueGameTime: r.due_game_time, status: r.status, overdueNotified: r.overdue_notified === 1, createdGameTime: r.created_game_time,
    resolvedGameTime: r.resolved_game_time, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function mapRecurring(r: Row): RecurringPayment {
  return {
    id: r.id, gameId: r.game_id, fromAccountId: r.from_account_id, toAccountId: r.to_account_id, description: r.description, amountCents: r.amount_cents,
    nextDueGameTime: r.next_due_game_time, active: r.active === 1, createdAt: r.created_at,
  };
}
function mapThread(r: Row): StoryThread {
  return {
    id: r.id, gameId: r.game_id, title: r.title, summary: r.summary, status: r.status, momentum: r.momentum, urgency: r.urgency,
    visibility: r.visibility, participantIds: parse(r.participants_json), causeEventIds: parse(r.cause_event_ids_json),
    resolution: parse(r.resolution_json), outcome: r.outcome, createdGameTime: r.created_game_time, updatedGameTime: r.updated_game_time,
    resolvedGameTime: r.resolved_game_time, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function mapScheduled(r: Row): ScheduledItem {
  return {
    id: r.id, gameId: r.game_id, dueGameTime: r.due_game_time, kind: r.kind, payload: parse(r.payload_json), threadId: r.thread_id,
    status: r.status, createdGameTime: r.created_game_time, createdAt: r.created_at,
  };
}
export interface PriceEntry { key: string; item: string; priceCents: number; source: string }
/** Price-book key: lowercase words only, so "Espresso at a bar" and "espresso at a bar." are the same item. */
export const priceKey = (item: string) => item.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export interface DraftRow {
  id: string;
  status: 'drafting' | 'awaiting_approval' | 'finalized' | 'abandoned';
  draft: unknown;
  version: number;
  summaryVersion: number | null;
  gameId: string | null;
  createdAt: string;
  updatedAt: string;
}
function mapDraft(r: Row): DraftRow {
  return { id: r.id, status: r.status, draft: parse(r.draft_json), version: r.version, summaryVersion: r.summary_version, gameId: r.game_id, createdAt: r.created_at, updatedAt: r.updated_at };
}
function mapTurn(r: Row): TurnRow {
  return {
    id: r.id, gameId: r.game_id, requestId: r.request_id, seq: r.seq, status: r.status, baseRevision: r.base_revision,
    committedRevision: r.committed_revision, playerInput: r.player_input, response: parse(r.response_json),
    trace: parse(r.trace_json), createdAt: r.created_at,
  };
}
