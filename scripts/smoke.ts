// Live Milestone 1 smoke run against the real OpenAI provider.
//
//   OPENAI_API_KEY=… npm run smoke
//
// Skips (exit 0) when OPENAI_API_KEY is missing or the API is unreachable.
// STRUCTURAL checks must hold regardless of what the model says (state/retrieval/isolation).
// BEHAVIOURAL checks depend on the model and are reported, not enforced — a failure there
// points at prompts / model interpretation, not persistence.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { Store } from '../src/db/store.ts';
import type { Trace } from '../src/engine/trace.ts';
import { Engine } from '../src/engine/turn.ts';
import { OpenAIProvider } from '../src/llm/openai.ts';
import { HttpPageFetcher } from '../src/engine/web.ts';
import { companyRepo } from '../src/packs/startup/company.ts';
import { CLASSIC_DRAFT, startupPack } from '../src/packs/startup/index.ts';

// Sessions 1–3 replay the original Milestone 1/2 script (idea stage, €2,500).
const classicStartupPack = { ...startupPack, worldCreation: { ...startupPack.worldCreation, template: CLASSIC_DRAFT } };
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/llm/provider.ts';
import { WorldCreation } from '../src/engine/creation.ts';
import type { WorldSeed } from '../src/domain/world.ts';
import { PACKS } from '../src/packs/index.ts';

if (!process.env.OPENAI_API_KEY) {
  console.log('SKIP live smoke test: OPENAI_API_KEY is not set.');
  process.exit(0);
}

/** Wraps the live provider to keep every request for prompt-level leak checks. */
class Recording implements LLMProvider {
  readonly name: string;
  readonly calls: { req: LLMRequest; res?: LLMResponse }[] = [];
  private inner: LLMProvider;
  constructor(inner: LLMProvider) {
    this.inner = inner;
    this.name = inner.name;
  }
  async complete(req: LLMRequest) {
    const entry: { req: LLMRequest; res?: LLMResponse } = { req };
    this.calls.push(entry);
    entry.res = await this.inner.complete(req);
    return entry.res;
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync('data', { recursive: true });
const dbPath = `data/smoke-${stamp}.db`;
const reportPath = `data/smoke-${stamp}.md`;
const transcript: string[] = [];
const structural: { name: string; ok: boolean; detail?: string }[] = [];
const behavioural: { name: string; ok: boolean; detail?: string }[] = [];
const check = (list: typeof structural, name: string, ok: boolean, detail?: string) => list.push({ name, ok, detail });

const SECRET = "Honestly I've been thinking a lot about starting a company. I've actually got €2,500 saved, but don't tell anyone — my parents think I only have €500.";
const THOUGHT_MARKER = 'not even need Matteo';
const MONEY = /2[.,]?500|two and a half|duemilacinquecento|10[.,]?000/i;

async function session(label: string, inputs: string[], gameId?: string) {
  const store = new Store(dbPath);
  const llm = new Recording(new OpenAIProvider());
  const engine = new Engine(store, llm, { pack: classicStartupPack, fetcher: new HttpPageFetcher(), director: true });
  let id = gameId;
  if (!id) {
    const g = engine.newGame();
    id = g.game.id;
    transcript.push(`## ${label}\n\n${g.opening.replace(/\n/g, '  \n')}\n`);
  } else {
    transcript.push(`## ${label}\n`);
  }
  const turns: { input: string; seq: number; status: string; text: string; npc?: string; error?: string | null }[] = [];
  for (const input of inputs) {
    const r = await engine.takeTurn({ gameId: id, input });
    const seq = store.lastTurn(id)!.seq;
    turns.push({ input, seq, status: r.status, text: r.text, npc: r.npc?.name, error: r.error });
    transcript.push(`**> ${input}**  \n_(turn #${seq}, ${r.status}, ${r.gameTime})_\n\n${r.text.replace(/\n/g, '  \n')}\n${r.error ? `\n⚠️ ${r.error}\n` : ''}`);
    if (r.status === 'failed' && /LLMError: \[(network|config|http_401|http_403)\]/.test(r.error ?? '')) {
      store.close();
      rmSync(dbPath, { force: true });
      console.log(`SKIP live smoke test: OpenAI API unavailable (${r.error}).`);
      process.exit(0);
    }
  }
  return { store, llm, gameId: id, turns };
}

// ---------------- session 1 ----------------
const s1 = await session('Session 1', [
  'I grab a Coke from the fridge, go out on the balcony and call my friend Matteo.',
  'Hey! What are you up to today?',
  SECRET,
  `I think to myself: if this startup works out, I might ${THOUGHT_MARKER}. Out loud I say: anyway, would you ever want to build something with me?`,
  'Ok, I have to go. Talk later! I hang up.',
]);
const gameId = s1.gameId;
const matteo = s1.store.listCharacters(gameId).find((c) => /^matteo/i.test(c.name));
const player = s1.store.getCharacter(s1.store.getGame(gameId)!.playerCharacterId)!;
check(structural, 'Matteo was generated and persisted in session 1', Boolean(matteo), matteo?.name);
const matteoRow = matteo && JSON.stringify(s1.store.getCharacter(matteo.id));
const relBackstory = matteo && s1.store.getRelationship(matteo.id, player.id)?.summary;
const s1Knowledge = matteo ? s1.store.listKnowledgeOf(matteo.id) : [];
const s1Memories = matteo ? s1.store.listMemoriesOwnedBy(matteo.id) : [];
check(behavioural, 'Matteo acquired knowledge about the €2,500', s1Knowledge.some((k) => MONEY.test(k.belief)), s1Knowledge.map((k) => `${k.topic}: ${k.belief}`).join(' | '));
check(behavioural, 'Matteo formed at least one memory', s1Memories.length > 0, s1Memories.map((m) => m.summary).join(' | '));
check(behavioural, 'Interpreter separated the private thought', s1.store.listEvents(gameId).some((e) => e.type === 'private_thought'));
s1.store.close();

// ---------------- session 2 (fresh process state) ----------------
const s2 = await session('Session 2 (new session, same database)', [
  'I call Matteo again.',
  'Do you remember what I told you this morning about my money?',
  'Ok. I hang up and call my friend Sofia.',
  'Hey Sofia! Random question: do you have any idea how much money I have saved?',
], gameId);
const store = s2.store;
const matteoAgain = store.listCharacters(gameId).filter((c) => /^matteo/i.test(c.name));
check(structural, 'Session 2 loaded the same single Matteo (no regeneration)', matteoAgain.length === 1 && matteoAgain[0]!.id === matteo?.id);
check(structural, 'Matteo identity unchanged across sessions', matteo ? JSON.stringify(store.getCharacter(matteo.id)) === matteoRow : false);
check(structural, 'Canonical cash still €2,500', store.getAccountOf(gameId, 'character', player.id)?.balanceCents === 250_000);

const allCalls = [...s1.llm.calls, ...s2.llm.calls];
const npcPromptsFor = (name: string) => allCalls.filter((c) => c.req.task === 'npc_turn' && c.req.system.includes(`You are ${name}`));
check(structural, 'Private thought never appeared in any Matteo prompt',
  matteo ? npcPromptsFor(matteo.name).every((c) => !c.req.user.includes(THOUGHT_MARKER)) : false);

const turnTraces = store.listTurns(gameId).map((t) => t.trace as Trace);
const rememberTrace = turnTraces.find((t) => /remember what I told you/.test(t.input));
if (rememberTrace?.retrieval) {
  check(structural, 'Session 2: Matteo memories/knowledge retrieved into context when relevant',
    rememberTrace.retrieval.memories.length + rememberTrace.retrieval.knowledge.length > 0,
    JSON.stringify({ memories: rememberTrace.retrieval.memories.map((m) => m.summary), knowledge: rememberTrace.retrieval.knowledge.map((k) => k.topic) }));
}
const relNow = matteo && store.getRelationship(matteo.id, player.id)?.summary;
check(behavioural, 'Matteo relationship summary evolved from backstory', Boolean(relNow && relNow !== relBackstory), relNow ?? '');
const rememberTurn = s2.turns.find((t) => /remember what I told you/.test(t.input));
check(behavioural, 'Matteo recalls the money secret in session 2', MONEY.test(rememberTurn?.text ?? ''), rememberTurn?.text);

const sofia = store.listCharacters(gameId).find((c) => /^sofia/i.test(c.name));
check(structural, 'Sofia was generated', Boolean(sofia), sofia?.name);
if (sofia) {
  check(structural, 'Sofia has no knowledge of the €2,500', !store.listKnowledgeOf(sofia.id).some((k) => MONEY.test(k.belief)));
  check(structural, 'No Sofia prompt (generation or NPC) contains the amount',
    allCalls.filter((c) => (c.req.task === 'npc_turn' && c.req.system.includes(`You are ${sofia.name}`)) || (c.req.task === 'generate_character' && /Sofia/.test(c.req.user)))
      .every((c) => !MONEY.test(c.req.user)));
  const sofiaTurn = s2.turns.at(-1);
  check(behavioural, "Sofia's reply does not reveal the amount", !MONEY.test(sofiaTurn?.text.split('\n').filter((l) => l.startsWith(sofia.name)).join(' ') ?? ''), sofiaTurn?.text);
}
store.close();

// ---------------- session 3: Milestone 2 — company, equity, money, promises, time ----------------
const s3 = await session('Session 3 (Milestone 2: the company)', [
  'I buy the domain gradeeconomy.com for €12.',
  "I found Grade Economy and put €500 of my savings into it.",
  'I call Matteo and tell him: I just founded Grade Economy. I want you as cofounder — I offer you 40% of the company.',
  "I promise Matteo I'll have a working prototype to show him within 7 days.",
  'I hang up and spend the next week building the prototype.',
], gameId);
const st = s3.store;
const companies = companyRepo.list(st, gameId);
check(structural, 'Company exists after founding', companies.length === 1, companies.map((c) => c.name).join(', '));
for (const c of companies) {
  const sum = companyRepo.holdings(st, c.id).reduce((n, h) => n + h.shares, 0);
  check(structural, `${c.name}: shareholdings add up to total shares`, sum === c.totalShares, `${sum} / ${c.totalShares}`);
}
const accounts = st.listAccounts(gameId);
check(structural, 'No account is negative', accounts.every((a) => a.balanceCents >= 0));
const txs = st.listTransactions(gameId);
const outflow = txs.filter((x) => !x.toAccountId).reduce((n, x) => n + x.amountCents, 0);
const inflow = txs.filter((x) => !x.fromAccountId).reduce((n, x) => n + x.amountCents, 0);
check(structural, 'Ledger balances (accounts = €2,500 − spent + received)', accounts.reduce((n, a) => n + a.balanceCents, 0) === 250_000 - outflow + inflow);
const offers = st.listOffers(gameId);
check(behavioural, 'Interpreter turned the offer into a make_offer action', offers.length > 0, offers.map((o) => `${o.kind} ${JSON.stringify(o.terms)} ${o.status} (${o.lastOutcome ?? '-'})`).join(', '));
check(behavioural, 'Matteo made a decision on the offer (or is still considering)', offers.some((o) => o.status !== 'pending'), offers.map((o) => o.status).join(', '));
check(behavioural, 'The promise was recorded as an obligation', st.listObligations(gameId).length > 0);
check(behavioural, 'A week of work moved the clock by days', (st.getGame(gameId)!.gameTime.slice(0, 10)) > '2026-09-28', st.getGame(gameId)!.gameTime);
const failed = [...s1.turns, ...s2.turns, ...s3.turns].filter((t) => t.status !== 'committed' && t.status !== 'clarification');
check(structural, 'Every turn committed', failed.length === 0, failed.map((t) => `#${t.seq}: ${t.error}`).join(' | '));
st.close();

// ---------------- session 4: World Creation Copilot (Open World pack, a world no pack hard-codes) ----------------
{
  const cs = new Store(dbPath);
  const llm = new Recording(new OpenAIProvider());
  const creation = new WorldCreation(cs, llm, { packs: PACKS });
  const { draftId, text } = creation.start();
  transcript.push('## Session 4 (World Creation Copilot)', `COPILOT: ${text}`);
  const gamesBefore = cs.listGames().length;
  const say = async (input: string) => {
    const r = await creation.say(draftId, input);
    transcript.push(`> ${input}`, `COPILOT [${r.status}]: ${r.text}`);
    return r;
  };
  try {
    await say("Something like Dune. I'm a nobody, and my father rules the planet.");
    check(behavioural, 'Copilot flagged the nobody/ruler contradiction', creation.draft(draftId).contradictions.length > 0, creation.draft(draftId).contradictions.join(' | '));
    await say("Fair — make my father a disgraced water-seller instead. I'm 17, alternate history from the start. You decide everything else.");
    await say("Let's start.");
    check(structural, 'No canonical game before approval', cs.listGames().length === gamesBefore);
    let r = await say('Yes, create it.');
    if (r.status === 'awaiting_approval' || r.status === 'drafting') r = await say('Yes, I approve. Create it.');
    check(behavioural, 'World created after explicit approval', r.status === 'finalized', r.status);
    if (r.gameId) {
      const seed = cs.getWorldSeed<WorldSeed>(r.gameId);
      check(structural, 'Exactly one WorldSeed stored for the new game', Boolean(seed) && seed!.draftId === draftId);
      check(behavioural, 'Seed keeps the player insignificant', !/ruler|heir|chosen/i.test(seed?.style.playerSignificance ?? ''), seed?.style.playerSignificance);
      transcript.push(`OPENING:\n${r.opening}`);
    }
  } catch (e) {
    check(structural, 'World Creation Copilot ran without errors', false, (e as Error).message);
  }
  cs.close();
}

// ---------------- report ----------------
const fmt = (xs: typeof structural) => xs.map((c) => `- ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `\n  - ${c.detail.replace(/\n/g, ' ')}` : ''}`).join('\n');
const report = [
  `# Live Milestone 1 smoke run — ${stamp}`,
  `Provider: openai, model: ${new OpenAIProvider().model}. Database: \`${dbPath}\`.`,
  `Inspect any turn with: \`npm start -- inspect turn <n> --db ${dbPath}\``,
  '## Structural checks (must pass — state, retrieval, isolation)', fmt(structural),
  '## Behavioural checks (model-dependent — failures point at prompts/model)', fmt(behavioural),
  '# Transcript', ...transcript,
].join('\n\n');
writeFileSync(reportPath, report);
console.log(report.split('# Transcript')[0]);
console.log(`Full report: ${reportPath}`);
process.exitCode = structural.every((c) => c.ok) ? 0 : 1;
