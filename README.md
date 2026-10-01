# Living Story Engine

A persistent world played through natural language. It has no script, no chapters and no predetermined ending.

- **The world moves without you.** People have their own lives, goals and conflicts, and situations develop whether or not you're involved.
- **You live through it.** You can follow what's happening, ignore it, interfere, or change its course.

The code has two layers:

- **Living Story Engine** (`src/engine/`) — generic and knows no particular world. It covers:
  - characters, relationships, memory, knowledge and events with observers
  - time and resources (accounts, a ledger, monthly flows)
  - offers and promises
  - the Decision Resolution Engine
  - World Turns, Story Threads and the Story Director
  - context building, validation, persistence and traces
- **Game Pack** (`src/packs/<pack>/`) — defines what kind of mechanics the world runs on:
  - guidance and an example world for the World Creation Copilot
  - the kinds of offers people make and what accepting them does
  - world-specific actions and state
  - prompt flavour and status line

Two packs ship:

- **Startup** (`src/packs/startup/`) — a product with real numbers (signups, active users, known problems, usage costs), companies and cap tables, plus four offer kinds: cofounder, job, customer purchase and investment. Its default world starts where the journey starts: Felipe, 18, in Milan on Monday 28 September 2026. He has built Grade Economy alone (an MVP and landing page, 14 signups, 2 active users), has €600 and no network, and his parents want an answer about university by 15 October.
- **Open World** (`src/packs/open/`) — the engine's generic mechanics only (people, money, promises, deals, decisions, world turns). Use it for any other world: fantasy, science fiction, history, or a known fictional universe used as a reference.

**The world itself is designed with you.** `npm start -- new` opens the **World Creation Copilot**, a conversation that builds a draft of the world; you approve a final summary and the game is created from it (see *World creation* below).

The model portrays people and proposes; the engine resolves, validates and commits. SQLite is canonical.

## Run it

Requires Node ≥ 22.18. It uses the built-in `node:sqlite` and runs `.ts` directly, with no build step.

```bash
npm install
npm test                      # deterministic suite (ScriptedProvider, no network)
npm run typecheck

export OPENAI_API_KEY=sk-...  # live play / smoke test only
export OPENAI_MODEL=gpt-6-luna   # optional (default gpt-6-luna)
npm start -- new              # design a world with the Copilot, approve it, play (resumes an unfinished draft)
npm start -- new --fresh      # start a new draft even if one is unfinished
npm start -- new --quick      # skip the conversation: the default Startup world (Felipe, his MVP, €600, Milan)
npm start -- new --quick --pack adventure   # the Adventure pack's default opening: Kvothe at the University (Kingkiller-inspired, eventful, literary)
npm start -- new --quick --pack open   # the Open World pack's example world
npm start -- continue         # later, in a new process: continue the most recent game
npm start -- drafts           # list world drafts (drafting / awaiting approval / finalized / abandoned)
npm start -- delete <gameId>  # delete one game for good (asks to confirm)
npm start -- export [gameId]  # write a playtest log to playtests/ (--full adds every prompt and model output); push it to share it for review
npm start -- delete --all     # delete every game and world draft (asks to confirm; --yes skips the question)
npm run smoke                 # live multi-session run incl. a Copilot conversation; skips without key/network
```

The database defaults to `data/startup.db`. Override it with `--db <path>` or `STARTUP_DB`.

You can also set reasoning effort per task: `OPENAI_EFFORT_INTERPRET` (low), `OPENAI_EFFORT_GENERATE` (low), `OPENAI_EFFORT_NPC` (medium) and `OPENAI_EFFORT_COPILOT` (medium).

## The starting position, money and the week

These parts are generic engine features; each pack configures them.

- **Start where the story starts.** World creation establishes what the character has already made (`player.assets`, with real numbers and honest known problems), the pack's starting stage, open leads with dates, pressures and the people the opening needs. Startup's stages are `idea`, `mvp` (the default) and `first_users`. A product asset becomes a *side project* with its URL, users, problems and usage costs. It becomes a company when the player registers it.
- **A price book.** Approximate prices for the world are proposed at creation, approved with the summary and stored in `prices`. A known item always costs about the same: a payment more than 3× off is refused. A new item is remembered at the price first paid.
- **Running costs and income.** Living costs (phone, transport, "daily life") and product costs (domain, usage per active user) are monthly flows. Pocket money is income. Everything lands on the 1st and is reported as one line per payday. Product usage costs follow active users: success costs money.
- **The calendar.** Open leads with a date (talks, meetups, hackathons, a family dinner) are scheduled opportunities. They appear under UPCOMING in the interpreter's briefing and in the opening. Weekly ones come round again. Nobody has to go; going there is moving there at that time, and the people you meet are generated then.
- **The week in review.** Every Monday 08:00 the world turn runs the pack's weekly dynamics. For Startup, users arrive organically and churn, depending on known problems. Then it reports money spent and received, monthly costs vs income, net burn and runway, the product's numbers and what's coming up.
- **Player actions:**
  - `research` — generic; the findings become the player's notes, as beliefs rather than world truth.
  - `promote_product` — Startup; the game rolls how many people sign up and how many start using the product.
  - `improve_product` — Startup; fixes a known problem, or records one the player discovered.
  - `found_company` — Startup; registers the side project as a company.

## The storyteller: the world comes to you, and each turn reads like a book

These are generic engine features. Each world sets them at creation (`style.pace`, `style.violence`, `style.narration`, `player.ambition`), and they live in its immutable settings.

- **Your ambition drives the story.** The Copilot records what you dream of becoming. The Director, the scene beats and the narrator all see it and keep putting chances, rivals, costs and hard choices on the road to it. They never simply hand it over.
- **Scene beats.** A pacing clock set by the world's pace (quiet: never; steady: after 4 quiet turns; eventful: after 2; any long time skip) decides *when* something happens to you. The model proposes *what*: an arrival, a message, an encounter, a threat, an opportunity. It must be grounded in existing people, what just happened and your ambition. The engine validates it: people must exist and be alive, and a new person gets a full profile. It becomes canonical, and can open a conversation, so the stranger is talking to you. It ends with the decision it forces. (`engine/story.ts`)
- **The narrator.** In literary worlds, after the engine has decided everything (actions, fights, decisions, the world turn, the beat), a narrator writes the turn as a passage of a novel: the place, your body, the tension, ending on the choice. It must quote every spoken line exactly, which is checked, or it retries once and then falls back to the plain text. It may not change outcomes, and the engine's result lines are shown under the prose. The opening scene is narrated too.
- **Play in your language.** Set `style.language` at creation: the Copilot records the language you write in, or use `new --quick --lang "Brazilian Portuguese"`. Everything the player reads that a model writes is then in that language: narration, dialogue, scene beats, ideas, notes, messages. Prompts, event logs, traces and the engine's own result lines stay in English.
- **Next-move ideas** after each turn (`/hints` toggles them). **seek** finds people and ways in, rolled against the time you invest.
- **Violence per world:** `none`, `non_graphic` or `graphic`. Graphic worlds show fights, wounds and death in full. Sexual content is never produced, and the self-harm check (about the real player, not the character) stays.
- **Death, both ways.** Characters can die (`characters.status`). The dead can't be talked to or fought again and are marked DEAD in every briefing. **The player can die too**, if someone fighting to kill brings them to 0 health. The narrator writes the death, the turn is marked `gameOver`, and the story is over. Fights nobody means to be lethal (hurt, humiliate, drive off, subdue) can leave you at 1 health but never kill.
- **Deeds and secret consequences.** Each turn the interpreter lists the player's socially significant *deeds*: insults, threats, cruelty, betrayal, a broken promise, or kindness and courage. Witnesses are the people canonically present, plus **unseen ears**: a hidden roll by how exposed the place is (private 5%, semi-public 25%, public 60%), so an empty-looking scene can still have had someone behind the wall. If anyone saw or heard, the engine secretly rolls whether they act on it and when. The worse (or better) it was, the likelier and sooner: severity 5 comes back within 1–6 hours, severity 2 within days. The player finds out only when it happens.
- **Consequences are proportional.** People attack only when it fits who they are and what you said or did, where, and in front of whom. The powerful have it done: an attack can come from others acting for someone (`attack.by`: "her two guards"). Violence you commit starts a **consequence clock** (`consequence`), sooner and harder the worse it was, the more important the victim, and the more who saw it. When it runs out, the next scene beat *must* be the world answering it, at any pace: the watch, an arrest, revenge, a bounty, a summons, fear or respect. The Director also models grudges and retaliation as threads.
- **Protection.** Attacking someone guarded means fighting the guards first (`fight.guards`). Only when they are down does the one they protect enter the fight, and trying to kill makes the guards fight to kill.
- **People attack you.** In a conversation, an NPC can decide to attack (`attack`: intent, how dangerous they are, how). Scene beats can be attacks too: an ambush, someone you wronged, a hired blade. The attacker strikes first and a fight begins with the player on the back foot (`npcAttack`); someone who joins a fight already on is added to it.

## Writing your past as you play (recollections)

You don't need to know your character in advance. Say "I remember my mother taught me to pick locks" or "back in the docks I knew a fence called Maren", and it becomes part of your past — within limits, so nobody remembers their way into mastery:

- **Details** (who you were, where you grew up) are free, as long as they fit what is already true.
- **Knowledge** you remember is a belief, not world truth: it may be wrong, and it never reveals the world's secrets.
- **A training** costs one recollection and gives +1 to a skill, never above 2. Beyond that, skills grow only by training and use.
- **An old acquaintance** costs one recollection: an ordinary person (never a lord or a master) who comes with a rolled complication — a grudge, a debt, or good terms. When you go to meet them, they are created as you remembered them.
- **Never** items, money, titles, powers, or anything that conveniently rewrites the present. One recollection per turn.
- You start with 3 recollections and earn one per level. `/sheet` shows how many are left and the past you've written so far.

## Asking the game master

The story pauses whenever you ask the game master something out of character: `/gm <question>`, `? <question>`, or just "I ask the narrator: …" in a normal message (the interpreter recognises it). The game master answers from what your character could know (the scene, your sheet, your notes, the people you know, the last moments of play) and from the pack's rules. It never reveals secrets or decides outcomes, nothing in the world changes and no time passes. The question and answer are kept in the turn log and the playtest export.

## Game Pack: Adventure

For fantasy and science-fantasy worlds, including a known universe used as reference (Dune-like and so on). The engine stays agnostic: any world can be built with the Copilot. Quick start: `npm start -- new --quick --pack adventure` opens the default world, inspired by *The Kingkiller Chronicle*: you are Kvothe at fifteen, the day before admissions at the University, with thirteen jots, no lute and the Chandrian on your mind. Canon policy is *alternate from the start*: nothing after that morning is written. It is a story of tuition, debts, music, rivals, love and a slow mystery, with violence that is rare and matters. The original desert world of Ashkar (Rhen, a pit fighter) is kept for the tests.

- **Fights go exchange by exchange.** `fight` starts one; after that every message you send is one exchange (`combat_move`) until it ends. Your move is read from what you describe: heavy attack, quick attack, guard, feint, grapple, use of the ground (sand in the eyes, a table, a wall), break away, or yield. The opponent's move comes from their fighting style (aggressive, defensive, tricky, brute) and their breath. A counter-table decides which move beats which: a guard stops a heavy blow, a feint opens a guard, a grapple beats a feint. Then comes the rest of the roll: your combat skill, strength, weapon, armour, wounds, breath, the upper hand you have built, and a bonus for genuinely clever tactics, against theirs, plus a d20. Every exchange shows the whole breakdown and a state line (`You ❤ 72/100 · 💨 55 · ▲1 | Kesh Adar: badly hurt, breathing hard`). Several opponents strike while you deal with one. Attackers stop when they have what they wanted (humbled or driven off at half health, hurt at a third); only someone fighting to kill goes on. At the end come rolled XP, fame for a public win, and the world's answer to what you did. While a fight is on, no scene beat interrupts it, and the narrator tells one exchange at a time, stopping mid-fight so you choose the next move.
- **Sparring** (`fight` intent `spar`): agreed practice bouts of three exchanges leave bruises, not wounds. Nobody dies, there's no fame or consequence, and XP is halved. Wounds depend on what hit you: fists, clubs and training weapons bruise and crack; blades cut.
- **get_treatment:** a healer or surgeon closes wounds (serious becomes light) and restores health by their skill. Payment is a separate pay or deal.
- **attempt:** risky feats (climb, sneak, survive, work a sympathetic binding, play for a crowd) from a skill (0–5) against a difficulty; failure costs what was risked.
- **rest** heals (serious wounds need care). **train** with or without a teacher. **acquire_item** / **part_with_item** handle weapons, armour, gear and valuables, with purchases paid from the ledger.
- **The character sheet** (`/sheet`, in the player's language):
  - Attributes: strength, agility, wits and presence (1–5).
  - Ten skills (0–5): combat, stealth, athletics, survival, perception, persuasion, deception, lore, arcana (magic, sympathy, artifice) and performance (music, song, acting). Each is backed by an attribute.
  - Level and XP, health and wounds, gear, money, reputation, and the player's ambition.
- **Experience:** fights, feats, thefts, deceptions and influence give *rolled* XP (base ± 25%). Each level (100 × level XP) gives a point and +5 max health. `/spend <skill>` costs 1 point and `/spend <attribute>` costs 3. Training with `train` still builds a skill through practice.
- **One skill check for every uncertain act:** skill + attribute bonus − difficulty (− the other person's perception when opposed) + a seeded **d20** (1 → −3 … 20 → +5) → success, partial or failure. Every result line shows what went into it, e.g. `[deception 1 − difficulty 3.2 − Sarai Tul's perception 1 · d20 17 → +2.5]`, and fights show both sides. `/rolls` hides or shows these details. For acts where a hidden witness is possible (stealth, theft), the margin is not shown, so a partial success stays secret.
- **Health comes from the body:** max health = 70 + strength × 10, +5 per level after the first. Raising strength raises it.
- **Stealth and theft:** `attempt` (sneak, hide, pick, spot) and `steal`. A *partial* success looks exactly like a clean one to the player, but someone saw it, and a hidden consequence is scheduled. Failure means caught in the act.
- **Deception and influence:** the interpreter recognises lies and bluffs (`deceive`): from explicit markers (`(bluff)`, `I lie:`, `minto:`, `blefo:`), which are never spoken aloud, or from claims that contradict what the character knows, and persuasion, intimidation, charm and bribes (`influence`). Both are rolled against the target's perception. The target is told what the game decided ("You BELIEVE it", "you are frightened"), so their reaction matches the roll. Lies that worked can unravel later, secretly scheduled.
- **Fame:** from unknown to "a legend across the known worlds". NPCs hear what people say about you and see your visible wounds. People in the scene *witness* fights and feats: their reactions must match what the engine decided.
- **The weekly report** covers healing and reputation.

## World creation

```
IDEA → Copilot conversation → WORLD DRAFT → validate → final summary → explicit approval
     → WORLD SEED (immutable) → canonical game → living story
```

- **Just talk.** Describe the world however you like ("something like Dune, I'm a water-seller's apprentice"). There's no form. The Copilot proposes concrete defaults and asks only about what the start needs. If you drift into details that can emerge in play, it tells you: "we don't need to decide that yet".
- **Contradictions are challenged, not resolved silently.** "A nobody whose father rules the planet" goes into the draft's `contradictions` and blocks finalization until you settle it.
- **Known worlds are references.** You and the Copilot agree a canon policy: `background_only`, `history_continues_unless_changed`, `alternate_from_start` or `original_world`.
- **Starting situations are conditions, never outcomes.** Only the people the opening needs are created. Everyone else is generated later, when play needs them.
- **The draft persists.** Every message and every revision is saved, so `/quit` and `npm start -- new` pick up where you left off. Commands:
  - `/draft` — what's decided (no model call)
  - `/finalize` — the final summary, or what's still missing
  - `/approve` — approve the summary
  - `/abandon`
- **Approval is explicit.** The game is created only when you approve the exact summary you were shown, either with `/approve` or in your own words. If the model says "confirm", the engine checks the approval phrase appears in your message. Approving and changing something in the same message produces a new summary. Nothing canonical (characters, events, money) exists before approval.
- **The WorldSeed is the game's design contract.** It holds premise, setting, canon policy, tone, realism, player significance, design principles, world rules and the starting state. It's written once per game, and a trigger blocks updates. Every Story Director review receives it as the *world bible*, and every interpreter, NPC and character-generation prompt receives its setting line and rules, so the story doesn't drift over a long game.
- **Three separate layers:** `world_drafts` (editable, not canonical), `world_seeds` (approved, immutable) and game state (what happens in play).

The code:

- `src/domain/world.ts` — WorldDraft, WorldSeed and the Copilot turn schema
- `src/engine/creation.ts` — the Copilot conversation and finalization rules
- `src/engine/worldSeed.ts` — compile, create the canonical game, bible and summary text

All three are generic. Packs only contribute `worldCreation: { summary, guidance, template }`.

## Inspect a turn

```bash
npm start -- inspect turns                     # list turns (committed / clarification / failed)
npm start -- inspect turn last                 # full trace of the last turn
npm start -- inspect turn 3 --full             # include system prompts and full interpreter prompt
npm start -- inspect character Matteo          # identity, owned relationships, memories, knowledge, observed events
npm start -- inspect context Matteo            # exactly what Matteo would receive if called now
npm start -- inspect events                    # every event with observers vs participants
npm start -- inspect facts                     # canonical truth
npm start -- inspect money                     # accounts, pack state (companies/cap tables), offers, promises, monthly flows, ledger
npm start -- inspect decisions                 # hidden decision states and every resolved decision (score, roll, reasons)
npm start -- inspect world                     # story threads (world truth) and the world schedule
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
  engine/                       LIVING STORY ENGINE (no pack vocabulary — enforced by a test)
    turn.ts                     turn processor: interpret → resolve → portray → world turn → atomic commit
    context.ts                  Context Builder: permission filter → ranking → render (perspective only)
    planner.ts                  per-turn world planner: resources, offers, promises, threads, schedule; perspective briefings
    decision.ts                 Decision Resolution Engine (limits → weighted factors → bounded seeded roll → outcome)
    world.ts                    World Turn Engine, Story Threads, Story Director (propose → validate → commit)
    random.ts                   seeded randomness (same seed ⇒ same result; replays never reroll)
    validate.ts                 allowlists: NPC changes, portrayals vs resolved outcomes, generated characters, decision states
    prompts.ts                  prompt templates (setting text comes from the game's WorldSeed)
    creation.ts                 World Creation Copilot: conversation → draft → summary → explicit approval
    worldSeed.ts                draft compiler, canonical game creation, world bible
    web.ts, trace.ts, util.ts   shared links, trace shape, time helpers
  packs/
    types.ts                    GamePack contract (the only boundary between engine and world)
    startup/                    GAME PACK: STARTUP — companies, cap tables, product stage, offer kinds, actions, example world, prompts
    open/                       GAME PACK: OPEN WORLD — generic mechanics only (a `deal` offer kind), for any designed world
    index.ts                    the app's pack registry (the engine never imports it)
  db/                           SQLite: core migrations + per-pack migrations, typed store
  domain/                       record types and zod schemas (engine-level)
  llm/                          LLMProvider interface; OpenAIProvider (Responses API); ScriptedProvider (tests)
  debug/inspect.ts, cli.ts      inspection views and the CLI
```

### What is generic and what is Startup-specific

| Generic engine | Startup pack |
|---|---|
| World Creation Copilot, WorldDraft, WorldSeed, world bible | guidance and the example world (Felipe, 18, Milan) |
| Character, Relationship, Memory, Knowledge, Event + observers, Fact, Scene | — |
| Time, World Turns, World Schedule | — |
| Resources: accounts owned by characters or pack **entities**; ledger; monthly flows | companies as entities; company cash |
| Offers (generic `kind`, subject, label, numeric `terms`) and counter-offers | offer kinds `join_company`, `hire`, `purchase`, `investment` and what accepting them does (issuing shares, salaries, subscriptions, investment) |
| Promises / obligations, deadlines, overdue events | — |
| Decision states: goals, pressures, alternatives, limits on terms, `requiresApproval`, weighted criteria | term keys (`priceMonthly`, `salaryMonthly`, `equityPercent`, `amount`) |
| Decision Resolution Engine and its outcomes | — |
| Story Threads, Story Director, message delivery | Director background ("the Milan startup ecosystem") |
| Pack actions interface | `found_company`, `invest_in_company`, `advance_product` |


### Turn lifecycle

```
player input (+ requestId)
  → already committed? return the stored response (no model calls, no rolls, no writes)
  → LLM interpret (player perspective): speech / visible action / private thought / target / actions
  → resolve or generate the person addressed
  → player actions (money, offers, promises, pack actions), checked against simulated state
  → if an offer is waiting on this NPC:  DECISION
        load/generate their hidden decision state
        LLM appraise: only the factors THEY care about, −2…+2, grounded in evidence
        ENGINE resolve: limits → weighted score → bounded seeded roll → outcome
  → LLM portray the NPC (their perspective; must express the resolved outcome, never change it)
  → WORLD TURN for the time that passed (see below)
  → one transaction: revision check, all writes, turn + response + trace
```

Model calls per turn:

- **Every turn:** `interpret`.
- **When you talk to someone:** `npc_turn`.
- **When someone decides on an offer:** `npc_appraise`.
- **Rarely:** `generate_character` (a new person) and `decision_state` (a person's first decision of a kind).
- **At most once per game day:** `director`.

### Decision Resolution Engine

The model is never the judge of whether you succeed. For a meaningful decision:

1. **Hard limits first.** A limit on a term, such as "`priceMonthly` at most 300" or "`toll` at least 50", or needing someone's approval, removes outcomes entirely. No roll can bring them back. A liked offer above someone's authority becomes `counter` or `escalate_to_decision_maker`, never `accept`.
2. **Weighted criteria.** Only this actor's criteria count (weight 0–3). Eloquence on a factor they don't care about earns nothing.
   - The engine computes `terms_fit` and `alternatives` from real numbers.
   - The model appraises the other factors from the actor's point of view.
3. **A bounded roll** of at most ±10 points out of 100, seeded by game + request. It adds uncertainty, not chaos.
4. **Outcome**, from best to worst: `accept`, `accept_conditionally`, `escalate_to_decision_maker`, `counter`, `request_more_information`, `delay`, `reject`, `disengage`. Delays and escalations are revisited later by the world turn, when people get back to you.

Rejection, delay and counters are normal, committed outcomes. Decision states are hidden from the player and from other characters; only the actor sees their own situation.

### World turns, Story Threads and the Story Director

Whenever time passes, the world moves:

1. Monthly flows and deadlines. Overdue promises become events that both parties observe.
2. Scheduled developments fall due, e.g. a message someone sends you.
3. **Story Threads** gain momentum from their urgency and a seeded roll. A thread is a persistent developing situation, not a quest: "Matteo weighing an internship offer", "a rival launching".
   - At momentum 100, the thread's deciding actor resolves it through the same Decision Resolution Engine.
   - The outcome becomes events, can change that person's future circumstances, and may produce a message to you if they would plausibly tell you.
   - If you ignore a thread, it resolves anyway.
4. Deferred decisions on your offers are revisited.
5. Once per game day, the **Story Director** reviews world truth and may propose new threads or escalations.
   - Every proposal must cite real events, and the engine validates participants, actors and decision states. Anything citing nothing is rejected.
   - It never writes a plot and never steers you.

**Who knows what:** world developments are objective truth. Characters and the player learn about them only through events they observe (a conversation, a message, something public). The Director may see everything; nobody else can.


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

### Real web pages

If you share a link in a conversation ("check www.gradeeconomy.com"), the backend opens it once. The model never opens anything itself. The rules:

- **Fetching:** http(s) only, no local/private addresses, a 10s timeout and a 1 MB limit.
- **Storage:** the page is saved as a text snapshot in `documents`, linked to a `link_shared` event.
- **Who sees it:** the event's observers are the people in the conversation. Only they see the page, under *WEB PAGES YOU HAVE OPENED* in their briefing.
- **Later sessions:** they remember the page as it looked when they opened it, even if the site changes afterwards.
- **Failures:** a page that fails to load is shown to them as "did not load" (with the reason).
- **Not fetched:** links inside private thoughts are never opened.
- **Turning it off:** set `STARTUP_FETCH=off` to disable fetching.

### Resources, offers and promises (engine) + Startup mechanics (pack)

Code decides everything that has an objective answer; the model only proposes.

- **Player actions.** The engine provides `pay`, `give_money`, `make_offer`, `respond_to_offer`, `make_promise` and `fulfill_promise`. The Startup pack adds `found_company`, `invest_in_company` and `advance_product`.
  - The planner checks each action against a simulated copy of real balances and state.
  - Impossible actions ("buy a car for €30,000") are **world outcomes**, reported as `✗ …`.
  - Malformed actions, or ones naming unknown people or ids, are model errors and are skipped.
- **Offers** are decided by the Decision Resolution Engine and executed by the pack. For example, accepting `join_company` issues new shares so the newcomer owns exactly the offered percentage: 1,000,000 founder shares plus 40% gives 666,667 new shares, a 60/40 split.
- **Money:** integer cents in `accounts` (owned by characters or pack entities), moved only through `transactions`. The outside world is `NULL`.
- **Time is a resource:** up to a week per turn. A long activity ends an open call.
- **Who sees what:**
  - An NPC sees only pack state they are part of (e.g. companies they own a share of), offers and promises they are party to, and situations in their own life.
  - The player sees their own resources, holdings, offers and promises, and the messages and news they received.
- **Status line** after every turn, built only from canonical state. Example:

  ```
  ── Sun 27 Sep, 09:15 · Home — bedroom · €2,000.00 · Grade Economy 60.0% · €500.00 · idea · texting Matteo ──
  ```
- **Old saves** migrate automatically.

## SQLite schema

| Table | Purpose |
|---|---|
| `games` | id, **pack id**, timezone, `game_time` (local wall clock), player id, **revision** |
| `world_drafts` + `draft_messages` | World Creation drafts (status, draft JSON, version, which version the pending summary showed, resulting game) and the whole Copilot conversation |
| `world_seeds` | one approved WorldSeed per game — immutable (an update trigger aborts) |
| `characters` | stable identity only: name, age, gender, role, occupation, background, personality, traits/values/goals/fears (JSON), location, origin (`seed`/`generated`) |
| `relationships` | **directional** `from → to` summary, source (`backstory`/`gameplay`), source event. No numeric scores. |
| `facts` | canonical truth (`subject, predicate, value`) — never money (money lives in the ledger) |
| `events` | canonical history: type, summary, observable transcript, importance, time, interaction |
| `event_participants` | who acted / was addressed / was **mentioned** (identity) |
| `event_observers` | who **perceived** it, and through which channel (perception) |
| `memories` + `memory_subjects` | subjective memories owned by one character; `source` is `gameplay` or `backstory` (none generated in M1) |
| `knowledge` | per-character beliefs keyed by `(character, topic)`: belief, confidence, source, source event |
| `scenes` | current location, description, physically present characters, open interaction |
| `interactions` | live-conversation bookkeeping (channel, participants, start/end). History stays in events. |
| `documents` + `event_documents` | snapshots of real web pages shared in play; reachable only through an observed event |
| `accounts` / `transactions` | money in integer cents, owned by a character or a pack entity; every change is a ledger entry |
| `recurring_payments` | monthly flows (costs, salaries, subscriptions), from/to an account or the outside world |
| `offers` | generic offers: `kind`, subject, label, numeric `terms`, status, attempts, last outcome, when to reconsider, counter-offer parent |
| `obligations` | promises and debts between characters (due date, status, overdue notification) |
| `decision_states` | per character and domain: goals, pressures, alternatives, limits, approval, weighted criteria — **hidden** |
| `decisions` | every engine-resolved decision: outcome, score, roll, seed, reasons, full detail |
| `story_threads` + `thread_events` | persistent developing situations: momentum, urgency, visibility, participants, causes, how they resolve |
| `world_schedule` | what the world will do and when (messages, Director reviews) |
| `pack_migrations` | which game-pack migrations ran |
| `companies` / `shareholdings` | **Startup pack tables**: company state (stage, total shares) and the cap table |
| `turns` | request id (unique once final), status, base/committed revision, stored response, full trace |

## Known limitations

- Only the player→NPC conversation is modelled. NPCs don't talk to each other yet, and knowledge doesn't propagate between NPCs. The schema supports propagation through events and observers.
- Game time is a naive local clock. DST is ignored; the first transition is 25 Oct 2026.
- Retrieval is keyword/recency/importance scoring. That's fine for dozens of rows, not thousands.
- One conversation at a time. Addressing someone new ends the current conversation.
- All-or-nothing validation: one bad proposal fails the whole turn after one retry.
- Threads are resolved by one actor's decision. Branching and merging threads, and group decisions (a council, a board), are not modelled yet.
- NPCs only act through threads, deferred decisions and scheduled messages; there is no free-running NPC agency beyond what the Director proposes.
- The Copilot returns the whole draft each turn. On a very large world that costs tokens, and a careless model could drop a field. Revisions are visible in `/draft`, and nothing becomes canonical before the summary is approved.
- Starting characters from a draft get light identity (role, description, goals). Richer detail emerges in play.
- The Story Director only runs live (a model call per game day); it is exercised with scripted proposals in tests.
