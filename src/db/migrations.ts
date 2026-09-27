// Ordered schema migrations. Each entry runs once, inside a transaction.
// Never edit an applied migration; append a new one.

export const MIGRATIONS: string[] = [
  /* v1 — Milestone 1 core */ `
  CREATE TABLE games (
    id                  TEXT PRIMARY KEY,
    title               TEXT NOT NULL,
    timezone            TEXT NOT NULL,
    game_time           TEXT NOT NULL,          -- local wall time in games.timezone, 'YYYY-MM-DDTHH:MM'
    player_character_id TEXT NOT NULL,
    revision            INTEGER NOT NULL DEFAULT 0,  -- bumped by every committed turn
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  );

  -- Relatively stable identity. No relationships, memories, knowledge or current state here.
  CREATE TABLE characters (
    id          TEXT PRIMARY KEY,
    game_id     TEXT NOT NULL REFERENCES games(id),
    is_player   INTEGER NOT NULL DEFAULT 0,
    name        TEXT NOT NULL,
    age         INTEGER NOT NULL,
    gender      TEXT,
    role        TEXT NOT NULL,
    occupation  TEXT,
    background  TEXT NOT NULL,
    personality TEXT NOT NULL,
    traits_json TEXT NOT NULL,
    values_json TEXT NOT NULL,
    goals_json  TEXT NOT NULL,
    fears_json  TEXT NOT NULL,
    location    TEXT NOT NULL,                  -- where the character lives / is based
    origin      TEXT NOT NULL CHECK (origin IN ('seed', 'generated')),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX characters_game ON characters(game_id);

  -- Directional: how "from" sees "to". Summary only (no numeric scores in M1).
  CREATE TABLE relationships (
    id                TEXT PRIMARY KEY,
    game_id           TEXT NOT NULL REFERENCES games(id),
    from_character_id TEXT NOT NULL REFERENCES characters(id),
    to_character_id   TEXT NOT NULL REFERENCES characters(id),
    summary           TEXT NOT NULL,
    source            TEXT NOT NULL CHECK (source IN ('backstory', 'gameplay')),
    source_event_id   TEXT REFERENCES events(id),
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    UNIQUE (game_id, from_character_id, to_character_id),
    CHECK (from_character_id <> to_character_id)
  );

  -- Canonical world truth. Never shown to NPCs directly.
  CREATE TABLE facts (
    id         TEXT PRIMARY KEY,
    game_id    TEXT NOT NULL REFERENCES games(id),
    subject    TEXT NOT NULL,
    predicate  TEXT NOT NULL,
    value      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (game_id, subject, predicate)
  );

  -- A live conversation (phone call, meeting). Bookkeeping only; history lives in events.
  CREATE TABLE interactions (
    id                   TEXT PRIMARY KEY,
    game_id              TEXT NOT NULL REFERENCES games(id),
    channel              TEXT NOT NULL CHECK (channel IN ('phone', 'in_person', 'message')),
    participant_ids_json TEXT NOT NULL,
    started_game_time    TEXT NOT NULL,
    ended_game_time      TEXT,
    created_at           TEXT NOT NULL
  );

  -- Canonical history.
  CREATE TABLE events (
    id              TEXT PRIMARY KEY,
    game_id         TEXT NOT NULL REFERENCES games(id),
    turn_id         TEXT,
    interaction_id  TEXT REFERENCES interactions(id),
    game_time       TEXT NOT NULL,
    type            TEXT NOT NULL,
    summary         TEXT NOT NULL,
    transcript_json TEXT NOT NULL DEFAULT '[]',  -- observable lines only
    importance      INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
    location        TEXT,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX events_game ON events(game_id, game_time);
  CREATE INDEX events_interaction ON events(interaction_id);

  -- Who the event is about / who acted. Says nothing about perception.
  CREATE TABLE event_participants (
    event_id     TEXT NOT NULL REFERENCES events(id),
    character_id TEXT NOT NULL REFERENCES characters(id),
    role         TEXT NOT NULL CHECK (role IN ('actor', 'addressee', 'mentioned')),
    PRIMARY KEY (event_id, character_id, role)
  );

  -- Who perceived the event. The only path by which an event reaches a character.
  CREATE TABLE event_observers (
    event_id     TEXT NOT NULL REFERENCES events(id),
    character_id TEXT NOT NULL REFERENCES characters(id),
    channel      TEXT NOT NULL CHECK (channel IN ('in_person', 'phone', 'message', 'self')),
    PRIMARY KEY (event_id, character_id)
  );
  CREATE INDEX event_observers_character ON event_observers(character_id);

  -- Subjective memories.
  CREATE TABLE memories (
    id                 TEXT PRIMARY KEY,
    game_id            TEXT NOT NULL REFERENCES games(id),
    owner_character_id TEXT NOT NULL REFERENCES characters(id),
    summary            TEXT NOT NULL,
    importance         INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
    emotional_weight   INTEGER CHECK (emotional_weight BETWEEN -5 AND 5),
    source             TEXT NOT NULL CHECK (source IN ('gameplay', 'backstory')),
    source_event_id    TEXT REFERENCES events(id),
    game_time          TEXT NOT NULL,
    created_at         TEXT NOT NULL
  );
  CREATE INDEX memories_owner ON memories(owner_character_id);

  CREATE TABLE memory_subjects (
    memory_id    TEXT NOT NULL REFERENCES memories(id),
    character_id TEXT NOT NULL REFERENCES characters(id),
    PRIMARY KEY (memory_id, character_id)
  );

  -- What a specific character knows or believes. One row per (character, topic).
  CREATE TABLE knowledge (
    id                 TEXT PRIMARY KEY,
    game_id            TEXT NOT NULL REFERENCES games(id),
    character_id       TEXT NOT NULL REFERENCES characters(id),
    topic              TEXT NOT NULL,
    belief             TEXT NOT NULL,
    confidence         REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    about_character_id TEXT REFERENCES characters(id),
    fact_id            TEXT REFERENCES facts(id),  -- optional link to canonical truth (unused by the M1 model)
    source             TEXT NOT NULL,
    source_event_id    TEXT REFERENCES events(id),
    game_time          TEXT NOT NULL,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    UNIQUE (game_id, character_id, topic)
  );

  -- The current short-term situation (one row per game). Clock lives in games.game_time.
  CREATE TABLE scenes (
    id                         TEXT PRIMARY KEY,
    game_id                    TEXT NOT NULL UNIQUE REFERENCES games(id),
    location                   TEXT NOT NULL,
    description                TEXT NOT NULL,
    active_character_ids_json  TEXT NOT NULL,   -- physically present
    interaction_id             TEXT REFERENCES interactions(id),  -- open conversation, if any
    updated_at                 TEXT NOT NULL
  );

  -- Turn log: idempotency record + stored response + debug trace.
  CREATE TABLE turns (
    id                 TEXT PRIMARY KEY,
    game_id            TEXT NOT NULL REFERENCES games(id),
    request_id         TEXT NOT NULL,
    seq                INTEGER NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('committed', 'clarification', 'failed')),
    base_revision      INTEGER NOT NULL,
    committed_revision INTEGER,
    player_input       TEXT NOT NULL,
    response_json      TEXT,
    trace_json         TEXT NOT NULL,
    created_at         TEXT NOT NULL,
    UNIQUE (game_id, seq)
  );
  CREATE UNIQUE INDEX turns_request_final ON turns(game_id, request_id)
    WHERE status IN ('committed', 'clarification');
  `,
];
