// Shared links: real pages are opened by the backend and perceived only by the people they were shown to.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Store } from '../src/db/store.ts';
import { Engine } from '../src/engine/turn.ts';
import type { Trace } from '../src/engine/trace.ts';
import { checkFetchable, extractUrls, htmlToText, HttpPageFetcher, type FetchedPage, type PageFetcher } from '../src/engine/web.ts';
import { ScriptedProvider } from '../src/llm/scripted.ts';
import { startupPack } from '../src/packs/startup/index.ts';
import { interp, lastPrompt, MATTEO, npc, SOFIA, tmpDbPath } from './helpers.ts';

class StubFetcher implements PageFetcher {
  readonly fetched: string[] = [];
  private pages: Record<string, Partial<FetchedPage>>;
  constructor(pages: Record<string, Partial<FetchedPage>>) {
    this.pages = pages;
  }
  async fetch(url: string): Promise<FetchedPage> {
    this.fetched.push(url);
    const p = this.pages[url];
    if (!p) return { url, finalUrl: url, status: 'error', title: null, text: '', error: 'HTTP 404' };
    return { url, finalUrl: url, status: 'ok', title: null, text: '', error: null, ...p };
  }
}

const LANDING = 'Grade Economy — Your grades are your salary. Students earn GradeCoins for good results, budget them, and invest in a simulated market. Join the waitlist.';

function session(path: string, fetcher: PageFetcher | null) {
  const store = new Store(path);
  const llm = new ScriptedProvider();
  return { store, llm, engine: new Engine(store, llm, { pack: startupPack, fetcher }), close: () => store.close() };
}

test('extractUrls finds links, normalises them, and ignores non-links', () => {
  assert.deepEqual(extractUrls('Check the landing page at www.gradeeconomy.com What you think bro?'), ['https://www.gradeeconomy.com']);
  assert.deepEqual(extractUrls('see https://example.org/a?b=1, and gradeeconomy.it.'), ['https://example.org/a?b=1', 'https://gradeeconomy.it']);
  assert.deepEqual(extractUrls('I built it with Node.js, e.g. like the others. mail me at a@b.com'), []);
});

test('htmlToText keeps title, description and visible text only', () => {
  const page = htmlToText(`<html><head><title>Grade &amp; Economy</title><meta name="description" content="Grades as salary"><style>.x{}</style></head>
    <body><script>track()</script><h1>Your grades are your salary</h1><p>Join&nbsp;the waitlist</p><ul><li>Earn</li><li>Invest</li></ul></body></html>`);
  assert.equal(page.title, 'Grade & Economy');
  assert.equal(page.text, 'Grades as salary\nYour grades are your salary\nJoin the waitlist\n- Earn\n- Invest');
});

test('the fetcher refuses non-http schemes and private hosts', () => {
  assert.match(checkFetchable('file:///etc/passwd')!, /unsupported scheme/);
  assert.match(checkFetchable('http://localhost:3000')!, /private/);
  assert.match(checkFetchable('http://192.168.1.10/')!, /private/);
  assert.equal(checkFetchable('https://www.gradeeconomy.com'), null);
});

test('HttpPageFetcher fetches, follows redirects, and rejects non-text content', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/old') { res.writeHead(301, { location: '/' }); return res.end(); }
    if (req.url === '/img') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end('x'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<title>Grade Economy</title><body><h1>Your grades are your salary</h1></body>');
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const f = new HttpPageFetcher({ allowPrivateHosts: true });
    const page = await f.fetch(`${base}/old`);
    assert.equal(page.status, 'ok');
    assert.equal(page.finalUrl, `${base}/`);
    assert.equal(page.title, 'Grade Economy');
    assert.match(page.text, /Your grades are your salary/);
    assert.match((await f.fetch(`${base}/img`)).error!, /unsupported content type/);
    assert.match((await new HttpPageFetcher().fetch(`${base}/`)).error!, /private/);
  } finally {
    server.close();
  }
});

test('a shared link is opened for the recipient, remembered across sessions, and invisible to others', async () => {
  const path = tmpDbPath();
  const fetcher = new StubFetcher({ 'https://www.gradeeconomy.com': { title: 'Grade Economy', text: LANDING } });
  const s1 = session(path, fetcher);
  const { game } = s1.engine.newGame();

  s1.llm
    .enqueue('interpret', interp({ intents: ['start_conversation'], target: { name: 'Matteo', relationHint: 'friend' }, channel: 'message' }))
    .enqueue('generate_character', MATTEO)
    .enqueue('npc_turn', npc({ dialogue: 'yo' }))
    .enqueue('interpret', interp({ intents: ['speak'], target: { name: 'Matteo Ferrari', relationHint: null }, spokenText: 'Check the landing page at www.gradeeconomy.com What you think bro?' }))
    .enqueue('npc_turn', npc({
      dialogue: '"Your grades are your salary" — strong line. Where do I sign up?',
      changes: [{ op: 'create_memory', summary: "Felipe showed me the Grade Economy landing page: 'your grades are your salary'.", importance: 3, emotionalWeight: 1, aboutCharacterNames: ['Felipe'] }],
    }));
  assert.equal((await s1.engine.takeTurn({ gameId: game.id, input: 'I text Matteo' })).status, 'committed');
  const r = await s1.engine.takeTurn({ gameId: game.id, input: 'Check the landing page at www.gradeeconomy.com What you think bro?' });
  assert.equal(r.status, 'committed', r.error ?? '');

  assert.deepEqual(fetcher.fetched, ['https://www.gradeeconomy.com']);
  const prompt = lastPrompt(s1.llm, 'npc_turn');
  assert.match(prompt, /WEB PAGES YOU HAVE OPENED[\s\S]*https:\/\/www\.gradeeconomy\.com — "Grade Economy" \(you just opened it\)\nGrade Economy — Your grades are your salary/);
  const matteo = s1.store.listCharacters(game.id).find((c) => c.name === MATTEO.name)!;
  const trace = s1.store.lastTurn(game.id)!.trace as Trace;
  assert.equal(trace.documents![0]!.status, 'ok');
  const shared = s1.store.listEvents(game.id).find((e) => e.type === 'link_shared')!;
  assert.deepEqual(shared.observers.map((o) => o.characterId).sort(), [game.playerCharacterId, matteo.id].sort());
  s1.close();

  // New session: Matteo still has the snapshot (even if the site changed); Sofia never saw it.
  const s2 = session(path, new StubFetcher({ 'https://www.gradeeconomy.com': { title: 'Changed', text: 'totally different now' } }));
  s2.llm
    .enqueue('interpret', interp({ intents: ['start_conversation', 'speak'], target: { name: 'Matteo Ferrari', relationHint: null }, channel: 'phone', spokenText: 'Did you like the site?' }))
    .enqueue('npc_turn', npc({ dialogue: 'The grades-as-salary line stuck with me.' }))
    .enqueue('interpret', interp({ intents: ['start_conversation', 'speak'], target: { name: 'Sofia', relationHint: 'friend' }, channel: 'phone', spokenText: 'Have you seen my website?' }))
    .enqueue('generate_character', SOFIA)
    .enqueue('npc_turn', npc({ dialogue: 'What website?' }));
  await s2.engine.takeTurn({ gameId: game.id, input: 'I call Matteo: did you like the site?' });
  const matteoPrompt = lastPrompt(s2.llm, 'npc_turn');
  assert.match(matteoPrompt, /gradeeconomy\.com — "Grade Economy" \(opened Sun/);
  assert.doesNotMatch(matteoPrompt, /totally different now/);

  await s2.engine.takeTurn({ gameId: game.id, input: 'I call Sofia: have you seen my website?' });
  const sofiaPrompt = lastPrompt(s2.llm, 'npc_turn');
  assert.doesNotMatch(sofiaPrompt, /gradeeconomy|grades are your salary/i);
  assert.match(sofiaPrompt, /WEB PAGES YOU HAVE OPENED \(exactly as they looked when you opened them\)\n\(none\)/);
  s2.close();
});

test('a page that fails to load is reported honestly; private thoughts with links are never fetched', async () => {
  const fetcher = new StubFetcher({});
  const s = session(tmpDbPath(), fetcher);
  const { game } = s.engine.newGame();
  s.llm
    .enqueue('interpret', interp({
      intents: ['start_conversation', 'speak', 'private_thought'], target: { name: 'Matteo', relationHint: 'friend' }, channel: 'message',
      spokenText: 'look: https://gradeeconomy.com/beta', privateThought: 'I hope he never finds secret-plan.com',
    }))
    .enqueue('generate_character', MATTEO)
    .enqueue('npc_turn', npc({ dialogue: "Link's broken, man." }));
  const r = await s.engine.takeTurn({ gameId: game.id, input: '...' });
  assert.equal(r.status, 'committed', r.error ?? '');
  assert.deepEqual(fetcher.fetched, ['https://gradeeconomy.com/beta']);
  assert.match(lastPrompt(s.llm, 'npc_turn'), /The page did not load for you \(HTTP 404\)/);
  assert.doesNotMatch(lastPrompt(s.llm, 'npc_turn'), /secret-plan/);
  s.close();
});

test('without a fetcher, links are heard but never opened', async () => {
  const s = session(tmpDbPath(), null);
  const { game } = s.engine.newGame();
  s.llm
    .enqueue('interpret', interp({ intents: ['start_conversation', 'speak'], target: { name: 'Matteo', relationHint: 'friend' }, channel: 'message', spokenText: 'www.gradeeconomy.com' }))
    .enqueue('generate_character', MATTEO)
    .enqueue('npc_turn', npc());
  assert.equal((await s.engine.takeTurn({ gameId: game.id, input: 'x' })).status, 'committed');
  assert.equal(s.store.count('documents', game.id), 0);
  s.close();
});
