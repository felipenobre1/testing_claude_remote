import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { Store } from './db/store.ts';
import { formatCharacter, formatContext, formatEvents, formatDecisions, formatFacts, formatMoney, formatWorld, formatStatus, formatStatusLine, formatTurn, formatTurnList } from './debug/inspect.ts';
import { Engine } from './engine/turn.ts';
import { OpenAIProvider } from './llm/openai.ts';
import { HttpPageFetcher } from './engine/web.ts';
import { WorldCreation, type CreationResult } from './engine/creation.ts';
import type { LLMProvider } from './llm/provider.ts';
import { PACKS, packById } from './packs/index.ts';
import type { GamePack } from './packs/types.ts';

const USAGE = `Living Story Engine

  npm start -- new                          design a new world with the World Creation Copilot, then play
                                            (resumes your unfinished world draft if there is one; --fresh starts over)
  npm start -- new --quick [--pack startup] [--name Felipe]
                                            skip the conversation: start the pack's example world
  npm start -- continue [gameId]            continue a game (default: most recent)
  npm start -- games                        list games
  npm start -- drafts                       list world drafts
  npm start -- inspect <what> [--game id]   inspect state without playing:
      turns | turn <n|last> [--full] | character <name> | context <name> | events | facts

Options: --db <path> (default data/startup.db or $STARTUP_DB), --debug (print the trace after each turn)
Live play needs OPENAI_API_KEY (optional: OPENAI_MODEL, default gpt-6-luna).

While designing: just talk. Commands: /draft (what's decided)  /finalize (show the final summary)  /approve  /abandon  /quit
In game: type what you do. Commands: /status  /debug  /inspect <what>  /quit`;

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (['db', 'game', 'name', 'pack'].includes(key) && next !== undefined) { flags[key] = next; i++; } else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

function inspect(store: Store, gameId: string, args: string[], full: boolean): string {
  const [what, arg] = args;
  switch (what) {
    case 'turns': return formatTurnList(store, gameId);
    case 'turn': return formatTurn(store, gameId, arg ?? 'last', full);
    case 'character': return arg ? formatCharacter(store, gameId, args.slice(1).join(' ')) : 'usage: inspect character <name>';
    case 'context': return arg ? formatContext(store, gameId, args.slice(1).join(' ')) : 'usage: inspect context <name>';
    case 'events': return formatEvents(store, gameId);
    case 'facts': return formatFacts(store, gameId);
    case 'money': return formatMoney(store, gameId);
    case 'decisions': return formatDecisions(store, gameId);
    case 'world': return formatWorld(store, gameId);
    default: return 'inspect: turns | turn <n|last> [--full] | character <name> | context <name> | events | facts | money | decisions | world';
  }
}

function liveLLM(): LLMProvider | null {
  try {
    return new OpenAIProvider();
  } catch (e) {
    console.error(`Cannot start live play: ${(e as Error).message}`);
    process.exitCode = 1;
    return null;
  }
}

function liveEngine(store: Store, pack: GamePack, llm: LLMProvider): Engine {
  const fetcher = process.env.STARTUP_FETCH === 'off' ? null : new HttpPageFetcher();
  // The Story Director runs during world turns (at most one model call per game day). STARTUP_DIRECTOR=off disables it.
  return new Engine(store, llm, { pack, fetcher, director: process.env.STARTUP_DIRECTOR !== 'off' });
}

/** The World Creation conversation. Returns the created game, or null if the player left or abandoned. */
/**
 * One reader for the whole session. Lines typed while the model is working are queued, not lost
 * (readline drops lines that arrive while no question is pending).
 */
function lineReader() {
  const rl = createInterface({ input: stdin, output: stdout });
  const queue: string[] = [];
  let waiter: ((line: string | null) => void) | null = null;
  let closed = false;
  rl.on('line', (l) => { if (waiter) { const w = waiter; waiter = null; w(l); } else queue.push(l); });
  rl.on('close', () => { closed = true; waiter?.(null); waiter = null; });
  return {
    next(prompt: string): Promise<string | null> {
      if (queue.length) { const l = queue.shift()!; stdout.write(`${prompt}${l}\n`); return Promise.resolve(l); }
      if (closed) return Promise.resolve(null);
      rl.setPrompt(prompt);
      rl.prompt();
      return new Promise((r) => { waiter = r; });
    },
    close: () => rl.close(),
  };
}
type Reader = ReturnType<typeof lineReader>;

/** Shows a live timer while the model works, so a slow reply never looks like a freeze. */
async function working<T>(label: string, p: Promise<T>): Promise<T> {
  const t0 = Date.now();
  const tick = () => stdout.write(`\r⏳ ${label}… ${Math.round((Date.now() - t0) / 1000)}s (you can type ahead)`);
  tick();
  const timer = setInterval(tick, 1000);
  try {
    return await p;
  } finally {
    clearInterval(timer);
    stdout.write('\r\x1b[K');
  }
}

async function design(reader: Reader, creation: WorldCreation, draftId: string, intro: string): Promise<CreationResult | null> {
  console.log(`\n${intro}\n\n(/draft shows what's decided · /finalize shows the final summary · /quit saves the draft for later)\n`);
  {
    for (;;) {
      const raw = await reader.next('world> ');
      if (raw === null) return null;
      const line = raw.trim();
      if (!line) continue;
      let r: CreationResult;
      if (line === '/quit' || line === '/exit') { console.log('Draft saved. Resume it with: npm start -- new'); return null; }
      if (line === '/draft') { console.log(`\n${creation.view(draftId)}\n`); continue; }
      if (line === '/finalize') r = creation.requestFinalize(draftId);
      else if (line === '/approve') r = creation.approve(draftId);
      else if (line === '/abandon') r = creation.abandon(draftId);
      else {
        try {
          r = await working('the Copilot is thinking', creation.say(draftId, line));
        } catch (e) {
          console.log(`(the Copilot failed: ${(e as Error).message} — your draft is unchanged; try again)\n`);
          continue;
        }
      }
      console.log(`\n${r.text}\n`);
      if (r.status === 'finalized' || r.status === 'abandoned') return r.status === 'finalized' ? r : null;
    }
  }
}

async function play(reader: Reader, engine: Engine, gameId: string, debug: boolean, intro: string) {
  const store = engine.store;
  console.log(`\n${intro}\n\n(game ${gameId} — /quit to leave; everything is saved after each turn)\n\n${formatStatusLine(store, gameId)}\n`);
  {
    for (;;) {
      const raw = await reader.next('> ');
      if (raw === null) break;
      const line = raw.trim();
      if (!line) continue;
      if (line === '/quit' || line === '/exit') break;
      if (line === '/debug') { debug = !debug; console.log(`debug ${debug ? 'on' : 'off'}`); continue; }
      if (line === '/status') { console.log(formatStatus(store, gameId)); continue; }
      if (line.startsWith('/inspect')) {
        const parts = line.split(/\s+/).slice(1);
        console.log(inspect(store, gameId, parts.filter((p) => p !== '--full'), parts.includes('--full')));
        continue;
      }
      const r = await working('the world is moving', engine.takeTurn({ gameId, input: line }));
      console.log(`\n${r.text}\n\n${formatStatusLine(store, gameId)}\n`);
      if (r.status === 'failed') console.log(`(error: ${r.error} — /inspect turn last for details)\n`);
      if (debug) console.log(`${formatTurn(store, gameId, 'last')}\n`);
    }
  }
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  const dbPath = (flags.db as string) ?? process.env.STARTUP_DB ?? 'data/startup.db';
  if (!cmd || cmd === 'help' || flags.help) return console.log(USAGE);

  const store = new Store(dbPath);
  let shared: Reader | null = null;
  const reader = () => (shared ??= lineReader());
  try {
    const latest = () => store.listGames()[0]?.id;
    if (cmd === 'new') {
      const llm = liveLLM();
      if (!llm) return;
      if (flags.quick) {
        const pack = packById((flags.pack as string) ?? 'startup');
        if (!pack) return console.error(`Unknown pack. Available: ${PACKS.map((p) => p.id).join(', ')}`);
        const engine = liveEngine(store, pack, llm);
        const { game, opening } = engine.newGame({ playerName: flags.name as string | undefined });
        return await play(reader(), engine, game.id, Boolean(flags.debug), opening);
      }
      const creation = new WorldCreation(store, llm, { packs: PACKS });
      const open = flags.fresh ? undefined : creation.latestOpen();
      let draftId: string, intro: string;
      if (open) {
        draftId = open.id;
        const last = creation.messages(draftId).at(-1);
        intro = `Resuming your world draft (npm start -- new --fresh starts a new one).\n\nSo far:\n${creation.view(draftId)}${last?.role === 'copilot' ? `\n\n${last.text}` : ''}`;
      } else {
        ({ draftId, text: intro } = creation.start());
      }
      const created = await design(reader(), creation, draftId, intro);
      if (!created?.gameId) return;
      const game = store.getGame(created.gameId)!;
      await play(reader(), liveEngine(store, packById(game.packId)!, llm), game.id, Boolean(flags.debug), created.opening!);
    } else if (cmd === 'continue') {
      const gameId = rest[0] ?? latest();
      if (!gameId || !store.getGame(gameId)) return console.error('No game to continue. Start one with: npm start -- new');
      const pack = packById(store.getGame(gameId)!.packId);
      if (!pack) return console.error(`This game needs the "${store.getGame(gameId)!.packId}" pack, which this app does not have.`);
      const llm = liveLLM();
      if (!llm) return;
      const engine = liveEngine(store, pack, llm);
      const last = store.listTurns(gameId).filter((t) => t.status === 'committed').at(-1);
      await play(reader(), engine, gameId, Boolean(flags.debug), `${formatStatus(store, gameId)}${last?.response ? `\n\nLast time:\n${last.response.text}` : ''}`);
    } else if (cmd === 'games') {
      console.log(store.listGames().map((g) => `${g.id}  [${g.packId}]  ${g.title}  ${g.gameTime}  rev ${g.revision}`).join('\n') || '(no games)');
    } else if (cmd === 'drafts') {
      console.log(store.listDrafts().map((d) => `${d.id}  ${d.status}  v${d.version}  ${d.updatedAt}${d.gameId ? `  → ${d.gameId}` : ''}`).join('\n') || '(no drafts)');
    } else if (cmd === 'inspect') {
      const gameId = (flags.game as string) ?? latest();
      if (!gameId) return console.error('No games in this database.');
      console.log(inspect(store, gameId, rest, Boolean(flags.full)));
    } else {
      console.log(USAGE);
    }
  } finally {
    (shared as Reader | null)?.close();
    store.close();
  }
}

await main();
