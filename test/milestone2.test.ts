// Milestone 2: a company with Matteo — money, ownership, expenses, equity, promises, company state, time —
// across two sessions on the same SQLite file. Deterministic (ScriptedProvider).

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { Store } from '../src/db/store.ts';
import { formatStatusLine } from '../src/debug/inspect.ts';
import type { Trace } from '../src/engine/trace.ts';
import type { LLMRequest } from '../src/llm/provider.ts';
import { interp, lastPrompt, MATTEO, npc, openSession, SOFIA, tmpDbPath } from './helpers.ts';

const onPhoneWithMatteo = { target: { name: 'Matteo Ferrari', relationHint: null } };
const idFrom = (re: RegExp) => (req: LLMRequest) => req.user.match(re)?.[1] ?? 'missing';

test('Milestone 2: founding Grade Economy with Matteo, across sessions', async (t) => {
  const path = tmpDbPath();
  const s1 = openSession(path);
  const { game, player } = s1.engine.newGame();
  const gameId = game.id;
  const cash = (store = s1.store) => store.getAccountOf(gameId, 'character', player.id)!.balanceCents;
  let matteoId = '';
  let companyId = '';

  await t.test('call Matteo and buy the domain (€12)', async () => {
    s1.llm
      .enqueue('interpret', interp({ intents: ['start_conversation'], target: { name: 'Matteo', relationHint: 'friend' }, channel: 'phone' }))
      .enqueue('generate_character', MATTEO)
      .enqueue('npc_turn', npc({ dialogue: 'Pronto?' }))
      .enqueue('interpret', interp({
        ...onPhoneWithMatteo, intents: ['speak', 'general_action'], spokenText: 'Hold on, buying the domain right now.', minutesElapsed: 10,
        actions: [{ action: 'pay', amountEur: 12, description: 'domain gradeeconomy.com', fromCompanyName: null, recurringMonthly: false }],
      }))
      .enqueue('npc_turn', npc({ dialogue: 'lol ok' }));
    await s1.engine.takeTurn({ gameId, input: 'I call Matteo' });
    matteoId = s1.store.listCharacters(gameId).find((c) => c.name === MATTEO.name)!.id;
    const r = await s1.engine.takeTurn({ gameId, input: 'I buy gradeeconomy.com for €12' });
    assert.equal(r.status, 'committed', r.error ?? '');
    assert.equal(cash(), 248_800);
    assert.match(r.text, /✓ Paid €12\.00 — domain gradeeconomy\.com · your cash €2,488\.00/);
    assert.match(formatStatusLine(s1.store, gameId), /€2,488\.00/);
  });

  await t.test('found Grade Economy with €500 of personal money', async () => {
    s1.llm
      .enqueue('interpret', interp({
        ...onPhoneWithMatteo, intents: ['speak', 'general_action'], spokenText: "Done. Grade Economy exists now, I put 500 in.",
        actions: [{ action: 'found_company', name: 'Grade Economy', description: 'Grades as salary: financial literacy for schools', initialInvestmentEur: 500 }],
      }))
      .enqueue('npc_turn', npc({ dialogue: 'Serious?' }));
    const r = await s1.engine.takeTurn({ gameId, input: 'I found Grade Economy and put €500 in' });
    assert.equal(r.status, 'committed', r.error ?? '');
    const company = s1.store.listCompanies(gameId)[0]!;
    companyId = company.id;
    assert.equal(company.productStage, 'idea');
    assert.equal(cash(), 198_800);
    assert.equal(s1.store.getAccountOf(gameId, 'company', companyId)!.balanceCents, 50_000);
    assert.deepEqual(s1.store.listShareholdings(companyId).map((h) => [h.characterId, h.shares]), [[player.id, 1_000_000]]);
  });

  await t.test('offer Matteo 40%; he decides; the engine issues shares (60/40)', async () => {
    s1.llm
      .enqueue('interpret', interp({
        ...onPhoneWithMatteo, spokenText: 'Be my cofounder. 40% of Grade Economy.',
        actions: [{ action: 'offer_equity', toCharacterName: 'Matteo Ferrari', companyName: 'Grade Economy', percent: 40, role: 'cofounder' }],
      }))
      .enqueue('npc_turn', (req: LLMRequest) => npc({
        dialogue: 'Ok. I\'m in. But weekends only until exams are over.',
        importance: 5,
        changes: [
          { op: 'respond_to_offer', offerId: idFrom(/PENDING OFFER \[(offer_\w+)\]/)(req), accept: true },
          { op: 'make_promise', description: 'Write the landing page copy', amountEur: null, dueInDays: 3 },
        ],
      }));
    const r = await s1.engine.takeTurn({ gameId, input: 'I offer Matteo 40% as cofounder' });
    assert.equal(r.status, 'committed', r.error ?? '');
    const prompt = lastPrompt(s1.llm, 'npc_turn');
    assert.match(prompt, /PENDING OFFER \[offer_\w+\] from Felipe: 40% of Grade Economy as cofounder/);
    assert.match(prompt, /company cash: €500\.00 · owners: Felipe 100\.0% \(founder\)/);

    const holdings = s1.store.listShareholdings(companyId);
    assert.deepEqual(holdings.map((h) => [h.characterId, h.shares]), [[player.id, 1_000_000], [matteoId, 666_667]]);
    assert.equal(s1.store.getCompany(companyId)!.totalShares, 1_666_667);
    assert.match(r.text, /✓ Matteo Ferrari joined Grade Economy as cofounder · ownership: Felipe 60\.0%, Matteo Ferrari 40\.0%/);
    assert.match(r.text, /✓ Promise recorded — Matteo Ferrari → Felipe: Write the landing page copy by/);
    const joined = s1.store.listEvents(gameId).find((e) => e.type === 'offer_resolved')!;
    assert.deepEqual(joined.observers.map((o) => o.characterId).sort(), [player.id, matteoId].sort());
  });

  await t.test('company expense (monthly hosting) and a promise with money and deadline', async () => {
    s1.llm
      .enqueue('interpret', interp({
        ...onPhoneWithMatteo, spokenText: "I'll pay you back the €100 for the logo by Friday. And I set up hosting on the company card.",
        actions: [
          { action: 'pay', amountEur: 10, description: 'hosting', fromCompanyName: 'Grade Economy', recurringMonthly: true },
          { action: 'make_promise', toCharacterName: 'Matteo', description: 'Pay back €100 for the logo', amountEur: 100, dueInDays: 5 },
        ],
      }))
      .enqueue('npc_turn', npc({ dialogue: 'deal' }));
    const r = await s1.engine.takeTurn({ gameId, input: '...' });
    assert.equal(r.status, 'committed', r.error ?? '');
    assert.equal(s1.store.getAccountOf(gameId, 'company', companyId)!.balanceCents, 49_000);
    assert.equal(s1.store.listRecurringPayments(gameId)[0]!.nextDueGameTime.slice(0, 10), '2026-10-27');
    assert.equal(s1.store.listObligations(gameId).filter((o) => o.status === 'open').length, 2);
  });

  await t.test('you cannot spend money you do not have — a game outcome, not an error', async () => {
    const before = cash();
    s1.llm
      .enqueue('interpret', interp({ ...onPhoneWithMatteo, spokenText: 'Buying a car for the company!', actions: [{ action: 'pay', amountEur: 30_000, description: 'a car', fromCompanyName: null, recurringMonthly: false }] }))
      .enqueue('npc_turn', npc({ dialogue: 'with what money??' }));
    const r = await s1.engine.takeTurn({ gameId, input: 'I buy a car for €30,000' });
    assert.equal(r.status, 'committed');
    assert.match(r.text, /✗ Can't pay €30,000\.00 for a car: you have only €1,988\.00\./);
    assert.equal(cash(), before);
  });

  await t.test('an NPC cannot accept the same offer twice or invent offers', async () => {
    const bad = (req: LLMRequest) => npc({ changes: [{ op: 'respond_to_offer', offerId: s1.store.listOffers(gameId)[0]!.id, accept: true }] });
    s1.llm.enqueue('interpret', interp({ ...onPhoneWithMatteo, spokenText: 'so we are good?' })).enqueue('npc_turn', bad, bad);
    const r = await s1.engine.takeTurn({ gameId, input: 'so we are good?' });
    assert.equal(r.status, 'failed');
    assert.match(JSON.stringify((s1.store.lastTurn(gameId)!.trace as Trace).validation), /already accepted/);
    assert.equal(s1.store.getCompany(companyId)!.totalShares, 1_666_667);
    s1.close();
  });

  // ------------------------------------------------------------------ session 2
  const s2 = openSession(path);

  await t.test('session 2: balances, ownership, expenses and promises are exactly as left', () => {
    assert.equal(cash(s2.store), 198_800);
    assert.equal(s2.store.getAccountOf(gameId, 'company', companyId)!.balanceCents, 49_000);
    assert.deepEqual(s2.store.listShareholdings(companyId).map((h) => h.shares), [1_000_000, 666_667]);
    assert.match(formatStatusLine(s2.store, gameId), /Grade Economy 60\.0% · €490\.00 · idea · 2 promises/);
  });

  await t.test('a week of work: the call ends, promises go overdue, the product advances', async () => {
    s2.llm.enqueue('interpret', interp({
      intents: ['general_action'], minutesElapsed: 10080, narration: 'You disappear into the code for a week.',
      actions: [{ action: 'advance_product', companyName: 'Grade Economy', stage: 'prototype' }],
    }));
    const r = await s2.engine.takeTurn({ gameId, input: 'I spend the whole week building the prototype' });
    assert.equal(r.status, 'committed', r.error ?? '');
    assert.equal(r.gameTime.slice(0, 10), '2026-10-04');
    assert.equal(s2.store.getScene(gameId).interactionId, null, 'no one stays on the phone for a week');
    assert.match(r.text, /⚠ Overdue since .*Matteo Ferrari → Felipe: Write the landing page copy/);
    assert.match(r.text, /⚠ Overdue since .*Felipe → Matteo Ferrari: Pay back €100 for the logo/);
    assert.equal(s2.store.getCompany(companyId)!.productStage, 'prototype');
    const overdue = s2.store.listEvents(gameId).filter((e) => e.type === 'promise_overdue');
    assert.equal(overdue.length, 2);
    assert.ok(overdue.every((e) => e.observers.some((o) => o.characterId === matteoId)));
  });

  await t.test('monthly costs are charged when their date passes, once per month', async () => {
    for (let i = 0; i < 4; i++) s2.llm.enqueue('interpret', interp({ intents: ['general_action'], minutesElapsed: 10080, narration: 'Another week goes by.' }));
    for (let i = 0; i < 4; i++) await s2.engine.takeTurn({ gameId, input: 'another week of work' });
    assert.equal(s2.store.getGame(gameId)!.gameTime.slice(0, 10), '2026-11-01');
    assert.equal(s2.store.getAccountOf(gameId, 'company', companyId)!.balanceCents, 48_000);
    assert.equal(s2.store.listRecurringPayments(gameId)[0]!.nextDueGameTime.slice(0, 10), '2026-11-27');
  });

  await t.test('Matteo sees the company and the overdue promise; Sofia sees none of it', async () => {
    s2.llm
      .enqueue('interpret', interp({ intents: ['start_conversation'], ...onPhoneWithMatteo, channel: 'phone' }))
      .enqueue('npc_turn', npc({ dialogue: "Where's my hundred?" }))
      .enqueue('interpret', interp({ intents: ['start_conversation'], target: { name: 'Sofia', relationHint: 'friend' }, channel: 'phone' }))
      .enqueue('generate_character', SOFIA)
      .enqueue('npc_turn', npc({ dialogue: 'Ciao!' }));
    await s2.engine.takeTurn({ gameId, input: 'I call Matteo' });
    const m = lastPrompt(s2.llm, 'npc_turn');
    assert.match(m, /Grade Economy — Grades as salary/);
    assert.match(m, /stage: prototype · company cash: €480\.00 · owners: Felipe 60\.0% \(founder\), Matteo Ferrari 40\.0% \(cofounder\)/);
    assert.match(m, /Felipe → Matteo Ferrari: Pay back €100 for the logo \(€100\.00\) · due .* · OVERDUE/);

    await s2.engine.takeTurn({ gameId, input: 'I call Sofia' });
    const s = lastPrompt(s2.llm, 'npc_turn');
    assert.doesNotMatch(s, /Grade Economy|€480|logo|OVERDUE/);
    assert.match(s, /YOUR COMPANIES, OFFERS AND PROMISES \(exact figures, kept by the game\)\n\(none\)/);
  });

  await t.test('keeping a promise moves the money and closes it', async () => {
    s2.llm
      .enqueue('interpret', (req: LLMRequest) => interp({
        intents: ['start_conversation', 'speak'], ...onPhoneWithMatteo, channel: 'message', spokenText: 'sent you the 100, sorry for the delay',
        actions: [{ action: 'fulfill_promise', promiseId: idFrom(/\[(prom_\w+)\] Felipe → Matteo Ferrari/)(req) }],
      }))
      .enqueue('npc_turn', npc({ dialogue: 'finally 😂 thx' }));
    const r = await s2.engine.takeTurn({ gameId, input: 'I send Matteo the 100 I owe him' });
    assert.equal(r.status, 'committed', r.error ?? '');
    assert.match(r.text, /✓ Promise kept — Felipe → Matteo Ferrari: Pay back €100 for the logo \(€100\.00 paid\)/);
    assert.equal(cash(s2.store), 188_800);
    assert.equal(s2.store.getAccountOf(gameId, 'character', matteoId)!.balanceCents, 10_000);
  });

  await t.test('the ledger balances: every cent is accounted for', () => {
    const accounts = s2.store.listAccounts(gameId).reduce((n, a) => n + a.balanceCents, 0);
    const outflows = s2.store.listTransactions(gameId).filter((x) => !x.toAccountId).reduce((n, x) => n + x.amountCents, 0);
    const inflows = s2.store.listTransactions(gameId).filter((x) => !x.fromAccountId).reduce((n, x) => n + x.amountCents, 0);
    assert.equal(accounts, 250_000 - outflows + inflows);
    assert.equal(outflows, 1_200 + 1_000 * 2);
    s2.close();
  });
});

test('a paid action replayed with the same request id is charged once', async () => {
  const s = openSession(tmpDbPath());
  const { game, player } = s.engine.newGame();
  s.llm.enqueue('interpret', interp({ intents: ['general_action'], actions: [{ action: 'pay', amountEur: 50, description: 'laptop stand', fromCompanyName: null, recurringMonthly: false }] }));
  await s.engine.takeTurn({ gameId: game.id, input: 'buy a stand', requestId: 'r1' });
  const again = await s.engine.takeTurn({ gameId: game.id, input: 'buy a stand', requestId: 'r1' });
  assert.equal(again.replayed, true);
  assert.equal(s.store.getAccountOf(game.id, 'character', player.id)!.balanceCents, 245_000);
  assert.equal(s.store.listTransactions(game.id).length, 1);
  s.close();
});

test('offers and promises need the other person to be in the conversation', async () => {
  const s = openSession(tmpDbPath());
  const { game } = s.engine.newGame();
  s.llm
    .enqueue('interpret', interp({ intents: ['start_conversation'], target: { name: 'Matteo', relationHint: 'friend' }, channel: 'phone' }))
    .enqueue('generate_character', MATTEO)
    .enqueue('npc_turn', npc({ dialogue: 'yo', endsConversation: true }))
    .enqueue('interpret', interp({
      intents: ['general_action'],
      actions: [
        { action: 'found_company', name: 'Grade Economy', description: 'edtech', initialInvestmentEur: 0 },
        { action: 'offer_equity', toCharacterName: 'Matteo', companyName: 'Grade Economy', percent: 30, role: 'cofounder' },
      ],
    }));
  await s.engine.takeTurn({ gameId: game.id, input: 'call Matteo' });
  const r = await s.engine.takeTurn({ gameId: game.id, input: 'I found it and give Matteo 30%' });
  assert.match(r.text, /✓ Founded Grade Economy/);
  assert.match(r.text, /✗ You need to be talking to Matteo Ferrari to make an offer\./);
  assert.equal(s.store.listOffers(game.id).length, 0);
  s.close();
});

test('migration: an existing Milestone 1 save gets a real account from its cash fact', () => {
  const path = tmpDbPath();
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const [i, sql] of MIGRATIONS.slice(0, 2).entries()) {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(i + 1, 'x');
  }
  db.exec(`INSERT INTO games VALUES ('g1','t','Europe/Rome','2026-09-27T09:14','p1',3,'x','x');
    INSERT INTO characters VALUES ('p1','g1',1,'Felipe',18,NULL,'player',NULL,'b','p','[]','[]','[]','[]','Milan','seed','x','x');
    INSERT INTO facts VALUES ('f1','g1','p1','cash_eur','2500','x','x'), ('f2','g1','p1','company','none','x','x'), ('f3','g1','p1','housing','lives with parents','x','x');`);
  db.close();

  const store = new Store(path);
  assert.equal(store.getAccountOf('g1', 'character', 'p1')!.balanceCents, 250_000);
  assert.deepEqual(store.listFacts('g1').map((f) => f.predicate), ['housing']);
  store.close();
});
