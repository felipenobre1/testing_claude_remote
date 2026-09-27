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

  /* v2 — real web pages shared in play, snapshotted when first seen */ `
  CREATE TABLE documents (
    id          TEXT PRIMARY KEY,
    game_id     TEXT NOT NULL REFERENCES games(id),
    url         TEXT NOT NULL,
    final_url   TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('ok', 'error')),
    title       TEXT,
    text        TEXT NOT NULL,              -- readable text snapshot (truncated)
    error       TEXT,
    fetched_at  TEXT NOT NULL,              -- real-world time of the fetch
    game_time   TEXT NOT NULL,              -- game time at which it was opened
    created_at  TEXT NOT NULL
  );
  -- A document reaches a character only through an event they observed.
  CREATE TABLE event_documents (
    event_id    TEXT NOT NULL REFERENCES events(id),
    document_id TEXT NOT NULL REFERENCES documents(id),
    PRIMARY KEY (event_id, document_id)
  );
  `,

  /* v3 — Milestone 2: money, companies, equity, obligations */ `
  -- Money lives in accounts and only moves through transactions (integer cents).
  CREATE TABLE accounts (
    id            TEXT PRIMARY KEY,
    game_id       TEXT NOT NULL REFERENCES games(id),
    owner_kind    TEXT NOT NULL CHECK (owner_kind IN ('character', 'company')),
    owner_id      TEXT NOT NULL,
    balance_cents INTEGER NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (game_id, owner_kind, owner_id)
  );
  -- Ledger. NULL from/to = the outside world (shops, hosting, salaries from outside).
  CREATE TABLE transactions (
    id              TEXT PRIMARY KEY,
    game_id         TEXT NOT NULL REFERENCES games(id),
    turn_id         TEXT,
    from_account_id TEXT REFERENCES accounts(id),
    to_account_id   TEXT REFERENCES accounts(id),
    amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
    description     TEXT NOT NULL,
    category        TEXT NOT NULL,
    game_time       TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    CHECK (from_account_id IS NOT NULL OR to_account_id IS NOT NULL)
  );
  CREATE TABLE companies (
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
  CREATE TABLE shareholdings (
    company_id         TEXT NOT NULL REFERENCES companies(id),
    character_id       TEXT NOT NULL REFERENCES characters(id),
    shares             INTEGER NOT NULL CHECK (shares > 0),
    role               TEXT NOT NULL,
    acquired_game_time TEXT NOT NULL,
    PRIMARY KEY (company_id, character_id)
  );
  -- Offers need the other person's decision (made by the NPC, executed by the engine).
  CREATE TABLE offers (
    id                 TEXT PRIMARY KEY,
    game_id            TEXT NOT NULL REFERENCES games(id),
    company_id         TEXT NOT NULL REFERENCES companies(id),
    from_character_id  TEXT NOT NULL REFERENCES characters(id),
    to_character_id    TEXT NOT NULL REFERENCES characters(id),
    kind               TEXT NOT NULL CHECK (kind IN ('join_company')),
    equity_percent     REAL NOT NULL CHECK (equity_percent > 0 AND equity_percent < 100),
    role               TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
    created_game_time  TEXT NOT NULL,
    resolved_game_time TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
  );
  -- Promises and debts. The engine knows objectively that they exist; characters remember them.
  CREATE TABLE obligations (
    id                 TEXT PRIMARY KEY,
    game_id            TEXT NOT NULL REFERENCES games(id),
    debtor_id          TEXT NOT NULL REFERENCES characters(id),
    creditor_id        TEXT NOT NULL REFERENCES characters(id),
    description        TEXT NOT NULL,
    amount_cents       INTEGER CHECK (amount_cents IS NULL OR amount_cents > 0),
    due_game_time      TEXT,
    status             TEXT NOT NULL CHECK (status IN ('open', 'fulfilled', 'cancelled')),
    overdue_notified   INTEGER NOT NULL DEFAULT 0,
    created_game_time  TEXT NOT NULL,
    resolved_game_time TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
  );
  CREATE TABLE recurring_payments (
    id                 TEXT PRIMARY KEY,
    game_id            TEXT NOT NULL REFERENCES games(id),
    account_id         TEXT NOT NULL REFERENCES accounts(id),
    description        TEXT NOT NULL,
    amount_cents       INTEGER NOT NULL CHECK (amount_cents > 0),
    next_due_game_time TEXT NOT NULL,
    active             INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT NOT NULL
  );

  -- Existing saves: the player's cash Fact becomes a real account; "company = none" is now derived.
  INSERT INTO accounts (id, game_id, owner_kind, owner_id, balance_cents, created_at, updated_at)
    SELECT 'acct_' || id, game_id, 'character', subject, CAST(ROUND(CAST(value AS REAL) * 100) AS INTEGER), created_at, updated_at
    FROM facts WHERE predicate = 'cash_eur';
  DELETE FROM facts WHERE predicate IN ('cash_eur', 'company');
  `,

  /* v4 — independent NPC decisions: generic offers, decision states, resolved decisions */ `
  -- Offers become generic deals (cofounder, job, customer purchase, investment).
  CREATE TABLE offers_v4 (
    id                  TEXT PRIMARY KEY,
    game_id             TEXT NOT NULL REFERENCES games(id),
    company_id          TEXT REFERENCES companies(id),
    from_character_id   TEXT NOT NULL REFERENCES characters(id),
    to_character_id     TEXT NOT NULL REFERENCES characters(id),
    kind                TEXT NOT NULL CHECK (kind IN ('join_company', 'hire', 'purchase', 'investment')),
    terms_json          TEXT NOT NULL,  -- { equityPercent, salaryMonthlyCents, priceMonthlyCents, amountCents, role }
    description         TEXT NOT NULL,
    status              TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'countered', 'withdrawn')),
    parent_offer_id     TEXT,           -- set on counter-offers
    attempts            INTEGER NOT NULL DEFAULT 0,  -- how many times the recipient has resolved it
    last_outcome        TEXT,
    next_decision_after TEXT,           -- game time before which the recipient won't reconsider
    created_game_time   TEXT NOT NULL,
    resolved_game_time  TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  );
  INSERT INTO offers_v4 (id, game_id, company_id, from_character_id, to_character_id, kind, terms_json, description, status,
      parent_offer_id, attempts, last_outcome, next_decision_after, created_game_time, resolved_game_time, created_at, updated_at)
    SELECT id, game_id, company_id, from_character_id, to_character_id, kind,
      json_object('equityPercent', equity_percent, 'salaryMonthlyCents', NULL, 'priceMonthlyCents', NULL, 'amountCents', NULL, 'role', role),
      'join as ' || role, status, NULL, 0, NULL, NULL, created_game_time, resolved_game_time, created_at, updated_at
    FROM offers;
  DROP TABLE offers;
  ALTER TABLE offers_v4 RENAME TO offers;

  -- Recurring payments can now flow in (customer subscriptions) or between accounts (salaries).
  CREATE TABLE recurring_v4 (
    id                 TEXT PRIMARY KEY,
    game_id            TEXT NOT NULL REFERENCES games(id),
    from_account_id    TEXT REFERENCES accounts(id),  -- NULL = outside world pays
    to_account_id      TEXT REFERENCES accounts(id),  -- NULL = outside world receives
    description        TEXT NOT NULL,
    amount_cents       INTEGER NOT NULL CHECK (amount_cents > 0),
    next_due_game_time TEXT NOT NULL,
    active             INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT NOT NULL,
    CHECK (from_account_id IS NOT NULL OR to_account_id IS NOT NULL)
  );
  INSERT INTO recurring_v4 SELECT id, game_id, account_id, NULL, description, amount_cents, next_due_game_time, active, created_at FROM recurring_payments;
  DROP TABLE recurring_payments;
  ALTER TABLE recurring_v4 RENAME TO recurring_payments;

  -- A character's private situation for one kind of decision. Hidden from the player.
  CREATE TABLE decision_states (
    game_id      TEXT NOT NULL REFERENCES games(id),
    character_id TEXT NOT NULL REFERENCES characters(id),
    domain       TEXT NOT NULL,          -- offer kind
    state_json   TEXT NOT NULL,
    source       TEXT NOT NULL CHECK (source IN ('generated', 'seed')),
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (character_id, domain)
  );

  -- Every engine-resolved decision, with its inputs (debug) and outcome (canonical).
  CREATE TABLE decisions (
    id           TEXT PRIMARY KEY,
    game_id      TEXT NOT NULL REFERENCES games(id),
    turn_id      TEXT NOT NULL,
    offer_id     TEXT NOT NULL REFERENCES offers(id),
    character_id TEXT NOT NULL REFERENCES characters(id),
    outcome      TEXT NOT NULL,
    final_score  INTEGER NOT NULL,
    roll         INTEGER NOT NULL,
    seed         TEXT NOT NULL,
    reasons_json TEXT NOT NULL,
    detail_json  TEXT NOT NULL,
    game_time    TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
  `,
];
