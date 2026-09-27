# Startup — Milestone 1

A persistent AI life/startup simulation. This repository contains only **Milestone 1**. It proves that an NPC (Matteo) can be:

- created on demand
- remembered across sessions
- given relationships, memories and knowledge
- kept strictly within what he could have perceived

All canonical state lives in SQLite. The LLM proposes, and the backend validates and commits.

## Run it

Requires Node ≥ 22.18. It uses the built-in `node:sqlite` and runs `.ts` directly, with no build step.

```bash
npm install
npm test                      # deterministic suite (ScriptedProvider, no network)
npm run typecheck

export OPENAI_API_KEY=sk-...  # live play / smoke test only
export OPENAI_MODEL=gpt-6-luna   # optional (default gpt-6-luna)
npm start -- new              # new game: Felipe, 18, Milan, Sunday 27 Sep 2026 09:14
npm start -- continue         # later, in a new process: continue the most recent game
npm run smoke                 # live two-session Milestone 1 run; skips without key/network
```

The database defaults to `data/startup.db`. Override it with `--db <path>` or `STARTUP_DB`.

You can also set reasoning effort per task: `OPENAI_EFFORT_INTERPRET` (low), `OPENAI_EFFORT_GENERATE` (low) and `OPENAI_EFFORT_NPC` (medium).

## Inspect a turn

```bash
npm start -- inspect turns                     # list turns (committed / clarification / failed)
npm start -- inspect turn last                 # full trace of the last turn
npm start -- inspect turn 3 --full             # include system prompts and full interpreter prompt
npm start -- inspect character Matteo          # identity, owned relationships, memories, knowledge, observed events
npm start -- inspect context Matteo            # exactly what Matteo would receive if called now
npm start -- inspect events                    # every event with observers vs participants
npm start -- inspect facts                     # canonical truth
```

Inside the game you can use `/inspect …`, `/debug` (print the trace after every turn), `/status` and `/quit`.

A turn trace shows:

- the player input and the scene before the turn
- the interpreted intent
- the character resolution (loaded, generated, or ambiguous), plus the generated record if any
- the ids and scores of the relationships, memories, knowledge and events that were retrieved, with the counts permitted *before* ranking
- the **exact prompt** and **raw output** of every model call, and the problems found in each attempt
- the accepted and rejected proposals, with reasons
- every database write
- the committed response

It never contains model chain-of-thought.

Reading a trace tells you which layer failed:

| Symptom in the trace | Layer |
|---|---|
| Raw output is not valid JSON or is truncated, or an `LLMError` appears | LLM / transport |
| Retrieval ids are right, but the reply ignores them or the proposals don't match what was said | prompt / model interpretation |
| Something relevant is missing from the retrieval ids or counts | retrieval |
| Something appears in an NPC's prompt that they never observed | knowledge leak (the tests guard against this) |
| A problem is listed under "problems" or "rejected" | validation (working as intended) |
| Status is `failed` with a SQLite / `RevisionConflict` error | persistence |

## Architecture

```
src/
  db/migrations.ts    schema (append-only migrations)
  db/store.ts         typed SQLite access; perspective queries (owned-by / observed-by)
  domain/types.ts     record types
  domain/schemas.ts   zod schemas for all model output + JSON-schema conversion
  llm/provider.ts     LLMProvider interface (one structured-completion method)
  llm/openai.ts       OpenAIProvider — Responses API, strict json_schema output
  llm/scripted.ts     ScriptedProvider — deterministic, for tests
  engine/newGame.ts   seed: player, facts, opening scene
  engine/context.ts   Context Builder (permission filter → ranking → render)
  engine/prompts.ts   system prompts per task
  engine/validate.ts  allowlist validation of proposals and generated characters
  engine/turn.ts      turn processor, atomic commit, idempotency
  engine/trace.ts     trace shape
  debug/inspect.ts    text views for the CLI
  cli.ts              play / continue / inspect
scripts/smoke.ts      live smoke run
test/                 node:test suites
```

### Turn lifecycle

```
player input (+ requestId)
  → already committed? return stored response (no model calls, no writes)
  → load game, scene, open conversation                       [no transaction held]
  → LLM 1  interpret   (player perspective)
           splits input → spokenText / visibleAction / privateThought / target / intents
  → resolve target by name; if unknown → LLM generate_character → validate
  → Context Builder for the NPC (only what the NPC may know + what they perceive this turn)
  → LLM 2  npc_turn    (NPC perspective) → dialogue + proposed changes
  → validate every proposal (allowlist); any rejection → one corrective retry → else fail the turn
  → BEGIN IMMEDIATE: request-id + revision check, write everything, revision+1, store turn + response + trace; COMMIT
  → return the response (only after commit)
```

Most turns make two model calls: `interpret` and `npc_turn`. `generate_character` only runs the first time someone is mentioned.

The `interpret` call has to come first because the NPC must never see the raw input: it may contain the player's private thoughts. Consequence extraction is **not** a separate call. The NPC call returns its proposed changes together with the dialogue.

### Knowledge rules

- **An NPC's context comes only from data the NPC owns or observed.** That means:
  - their own Character row
  - relationships they own
  - memories they own
  - knowledge they own
  - events they appear in via `event_observers`
  - the lines they perceive this turn, which depend on the channel: on the phone they hear speech but see no actions

  Facts and other characters' state are never loaded. Filtering happens in SQL, before any ranking.
- **Being mentioned doesn't mean being told.** Being named in an event (`event_participants.role = 'mentioned'`) gives no access to it. Only `event_observers` does.
- **Private thoughts are stored as `private_thought` events** whose only observer is the player.
- **What the player says becomes an NPC belief, never a Fact.** "I have €10,000" updates Matteo's `felipe.savings` belief. `cash_eur` stays 2500.
- **The model can only propose three operations:** `create_memory`, `upsert_knowledge` and `update_relationship`, all owned by the responding NPC. Everything else is backend-derived:
  - events, observers and time
  - scene and conversation state
  - character creation

  Attempts such as `update_fact` or `update_character`, unknown fields, or out-of-range values are rejected.

## SQLite schema

| Table | Purpose |
|---|---|
| `games` | id, timezone (Europe/Rome), `game_time` (local wall clock), player id, **revision** |
| `characters` | stable identity only: name, age, gender, role, occupation, background, personality, traits/values/goals/fears (JSON), location, origin (`seed`/`generated`) |
| `relationships` | **directional** `from → to` summary, source (`backstory`/`gameplay`), source event. No numeric scores. |
| `facts` | canonical truth (`subject, predicate, value`), e.g. the player's `cash_eur = 2500` |
| `events` | canonical history: type, summary, observable transcript, importance, time, interaction |
| `event_participants` | who acted / was addressed / was **mentioned** (identity) |
| `event_observers` | who **perceived** it, and through which channel (perception) |
| `memories` + `memory_subjects` | subjective memories owned by one character; `source` is `gameplay` or `backstory` (none generated in M1) |
| `knowledge` | per-character beliefs keyed by `(character, topic)`: belief, confidence, source, source event |
| `scenes` | current location, description, physically present characters, open interaction |
| `interactions` | live-conversation bookkeeping (channel, participants, start/end). History stays in events. |
| `turns` | request id (unique once final), status, base/committed revision, stored response, full trace |

## Known limitations (Milestone 1)

- Only the player→NPC conversation is modelled. NPCs don't talk to each other yet, and knowledge doesn't propagate between NPCs. The schema supports propagation through events and observers.
- Game time is a naive local clock. DST is ignored; the first transition is 25 Oct 2026.
- Retrieval is keyword/recency/importance scoring. That's fine for dozens of rows, not thousands.
- One conversation at a time. Addressing someone new ends the current conversation.
- All-or-nothing validation: one bad proposal fails the whole turn after one retry.
