import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Store } from './db/store.ts';
import { formatCharacter, formatContext, formatEvents, formatFacts, formatStatus, formatTurn, formatTurnList } from './debug/inspect.ts';
import { Engine } from './engine/turn.ts';
import { OpenAIProvider } from './llm/openai.ts';

const USAGE = `Startup — Milestone 1

  npm start -- new [--name Felipe]          start a new game and play
  npm start -- continue [gameId]            continue a game (default: most recent)
  npm start -- games                        list games
  npm start -- inspect <what> [--game id]   inspect state without playing:
      turns | turn <n|last> [--full] | character <name> | context <name> | events | facts

Options: --db <path> (default data/startup.db or $STARTUP_DB), --debug (print the trace after each turn)
Live play needs OPENAI_API_KEY (optional: OPENAI_MODEL, default gpt-5.5).

In game: type what you do. Commands: /status  /debug  /inspect <what>  /quit`;

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (['db', 'game', 'name'].includes(key) && next !== undefined) { flags[key] = next; i++; } else flags[key] = true;
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
    default: return 'inspect: turns | turn <n|last> [--full] | character <name> | context <name> | events | facts';
  }
}

function liveEngine(store: Store): Engine | null {
  try {
    return new Engine(store, new OpenAIProvider());
  } catch (e) {
    console.error(`Cannot start live play: ${(e as Error).message}`);
    process.exitCode = 1;
    return null;
  }
}

async function play(engine: Engine, gameId: string, debug: boolean, intro: string) {
  const store = engine.store;
  console.log(`\n${intro}\n\n(game ${gameId} — /quit to leave; everything is saved after each turn)\n`);
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const line = (await rl.question('> ')).trim();
      if (!line) continue;
      if (line === '/quit' || line === '/exit') break;
      if (line === '/debug') { debug = !debug; console.log(`debug ${debug ? 'on' : 'off'}`); continue; }
      if (line === '/status') { console.log(formatStatus(store, gameId)); continue; }
      if (line.startsWith('/inspect')) {
        const parts = line.split(/\s+/).slice(1);
        console.log(inspect(store, gameId, parts.filter((p) => p !== '--full'), parts.includes('--full')));
        continue;
      }
      process.stdout.write('…\r');
      const r = await engine.takeTurn({ gameId, input: line });
      console.log(`\n${r.text}\n`);
      if (r.status === 'failed') console.log(`(error: ${r.error} — /inspect turn last for details)\n`);
      if (debug) console.log(`${formatTurn(store, gameId, 'last')}\n`);
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  const dbPath = (flags.db as string) ?? process.env.STARTUP_DB ?? 'data/startup.db';
  if (!cmd || cmd === 'help' || flags.help) return console.log(USAGE);

  const store = new Store(dbPath);
  try {
    const latest = () => store.listGames()[0]?.id;
    if (cmd === 'new') {
      const engine = liveEngine(store);
      if (!engine) return;
      const { game, opening } = engine.newGame({ playerName: (flags.name as string) ?? 'Felipe' });
      await play(engine, game.id, Boolean(flags.debug), opening);
    } else if (cmd === 'continue') {
      const gameId = rest[0] ?? latest();
      if (!gameId || !store.getGame(gameId)) return console.error('No game to continue. Start one with: npm start -- new');
      const engine = liveEngine(store);
      if (!engine) return;
      const last = store.listTurns(gameId).filter((t) => t.status === 'committed').at(-1);
      await play(engine, gameId, Boolean(flags.debug), `${formatStatus(store, gameId)}${last?.response ? `\n\nLast time:\n${last.response.text}` : ''}`);
    } else if (cmd === 'games') {
      console.log(store.listGames().map((g) => `${g.id}  ${g.title}  ${g.gameTime}  rev ${g.revision}`).join('\n') || '(no games)');
    } else if (cmd === 'inspect') {
      const gameId = (flags.game as string) ?? latest();
      if (!gameId) return console.error('No games in this database.');
      console.log(inspect(store, gameId, rest, Boolean(flags.full)));
    } else {
      console.log(USAGE);
    }
  } finally {
    store.close();
  }
}

await main();
