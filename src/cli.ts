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
import { longDate, UI, uiLang, type UiLang } from './i18n.ts';
import { upcoming } from './engine/planner.ts';
import type { WorldSeed } from './domain/world.ts';
import type { GamePack } from './packs/types.ts';

const USAGE = `Living Story Engine

  npm start -- new                          design a new world with the World Creation Copilot, then play
                                            (resumes your unfinished world draft if there is one; --fresh starts over)
  npm start -- new --quick [--pack startup|adventure|open] [--name Felipe] [--lang "Brazilian Portuguese"]
                                            skip the conversation: start the pack's example world
  npm start -- continue [gameId]            continue a game (default: most recent)
  npm start -- games                        list games
  npm start -- drafts                       list world drafts
  npm start -- delete <gameId>              delete one game permanently (asks to confirm; --yes skips)
  npm start -- delete --all                 delete ALL games and world drafts (asks to confirm; --yes skips)
  npm start -- inspect <what> [--game id]   inspect state without playing:
      turns | turn <n|last> [--full] | character <name> | context <name> | events | facts

Options: --db <path> (default data/startup.db or $STARTUP_DB), --debug (print the trace after each turn)
Live play needs OPENAI_API_KEY (optional: OPENAI_MODEL, default gpt-6-luna).

While designing: just talk. Commands: /draft (what's decided)  /finalize (show the final summary)  /approve  /abandon  /quit
In game: type what you do. Commands: /status  /hints (next-move ideas on/off)  /debug  /inspect <what>  /quit`;

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (['db', 'game', 'name', 'pack', 'lang'].includes(key) && next !== undefined) { flags[key] = next; i++; } else flags[key] = true;
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
async function working<T>(label: string, p: Promise<T>, lang: UiLang = 'en'): Promise<T> {
  const t0 = Date.now();
  const tick = () => stdout.write(`\r⏳ ${label}… ${Math.round((Date.now() - t0) / 1000)}s (${UI[lang].typeAhead})`);
  tick();
  const timer = setInterval(tick, 1000);
  try {
    return await p;
  } finally {
    clearInterval(timer);
    stdout.write('\r\x1b[K');
  }
}

/** In a literary world the narrator writes the opening scene; otherwise (or if it fails) the plain opening is shown. */
async function narratedOpening(engine: Engine, gameId: string, plain: string): Promise<string> {
  const lang = langOf(engine.store, gameId);
  const prose = await working(UI[lang].settingScene, engine.openingProse(gameId), lang);
  if (!prose) return plain;
  const store = engine.store;
  const game = store.getGame(gameId)!;
  const place = store.getWorldSeed<WorldSeed>(gameId)?.world.place ?? store.getScene(gameId).location;
  const soon = upcoming(store, gameId, game.gameTime, 14).map((i) => {
    const x = i.payload as { title: string; location?: string | null };
    return `  • ${longDate(i.dueGameTime, lang)} — ${x.title}${x.location ? ` (${x.location})` : ''}`;
  });
  return `${place} — ${longDate(game.gameTime, lang)}\n\n${prose}${soon.length ? `\n\n${UI[lang].comingUp}\n${soon.join('\n')}` : ''}`;
}

const langOf = (store: Store, gameId: string) => uiLang(store.getWorldSeed<WorldSeed>(gameId)?.style.language);

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
  let hints = true;
  const lang = langOf(store, gameId);
  const t = UI[lang];
  console.log(`\n${intro}\n\n${UI[langOf(store, gameId)].gameFooter(gameId)}\n\n${formatStatusLine(store, gameId)}\n`);
  {
    for (;;) {
      const raw = await reader.next('> ');
      if (raw === null) break;
      const line = raw.trim();
      if (!line) continue;
      if (line === '/quit' || line === '/exit') break;
      if (line === '/debug') { debug = !debug; console.log(`debug ${debug ? 'on' : 'off'}`); continue; }
      if (line === '/hints') { hints = !hints; console.log(hints ? t.hintsOn : t.hintsOff); continue; }
      if (line === '/status') { console.log(formatStatus(store, gameId)); continue; }
      if (line.startsWith('/inspect')) {
        const parts = line.split(/\s+/).slice(1);
        console.log(inspect(store, gameId, parts.filter((p) => p !== '--full'), parts.includes('--full')));
        continue;
      }
      const r = await working(t.worldMoving, engine.takeTurn({ gameId, input: line }), lang);
      const ideas = hints && r.suggestions?.length ? `\n\n💡 ${t.ideas}: ${r.suggestions.join(' · ')}` : '';
      console.log(`\n${r.status === 'failed' ? t.failed : r.text}${ideas}\n\n${formatStatusLine(store, gameId)}\n`);
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
        const { game, opening } = engine.newGame({ playerName: flags.name as string | undefined, language: flags.lang as string | undefined });
        return await play(reader(), engine, game.id, Boolean(flags.debug), await narratedOpening(engine, game.id, opening));
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
      const engine = liveEngine(store, packById(game.packId)!, llm);
      await play(reader(), engine, game.id, Boolean(flags.debug), await narratedOpening(engine, game.id, created.opening!));
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
    } else if (cmd === 'delete') {
      const games = store.listGames();
      const all = Boolean(flags.all);
      const target = all ? null : games.find((g) => g.id === rest[0]);
      if (!all && !target) {
        return console.error(rest[0] ? `No game ${rest[0]}. See: npm start -- games` : 'Usage: npm start -- delete <gameId>   or   npm start -- delete --all');
      }
      const what = all ? `ALL ${games.length} game(s) and ${store.listDrafts().length} world draft(s)` : `${target!.id} (${target!.title})`;
      if (!flags.yes) {
        const answer = await reader().next(`Permanently delete ${what}? This cannot be undone. Type "yes" to confirm: `);
        if (answer?.trim().toLowerCase() !== 'yes') return console.log('Nothing deleted.');
      }
      if (all) store.deleteAllGames(); else store.deleteGame(target!.id);
      console.log(`Deleted ${what}.`);
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
