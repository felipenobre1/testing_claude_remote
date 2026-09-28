// The Startup journey starts where the story starts: a small MVP, little money, running costs, open leads,
// and a week that ends with a report. Deterministic (fixed rolls).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db/store.ts';
import { EMPTY_DRAFT } from '../src/domain/world.ts';
import type { Trace } from '../src/engine/trace.ts';
import { compileDraft } from '../src/engine/worldSeed.ts';
import { Engine } from '../src/engine/turn.ts';
import { formatStatusLine } from '../src/debug/inspect.ts';
import { ScriptedProvider } from '../src/llm/scripted.ts';
import { PACKS } from '../src/packs/index.ts';
import { companyRepo } from '../src/packs/startup/company.ts';
import { startupPack, STARTUP_TEMPLATE } from '../src/packs/startup/index.ts';
import { copilotSystemPrompt } from '../src/engine/creation.ts';
import { fixedRng, interp, lastPrompt, tmpDbPath } from './helpers.ts';

function start() {
  const store = new Store(tmpDbPath());
  const llm = new ScriptedProvider();
  const engine = new Engine(store, llm, { pack: startupPack, rng: fixedRng(0.5) });
  const { game, player, opening } = engine.newGame();
  const product = () => companyRepo.list(store, game.id)[0]!;
  const cash = () => store.getAccountOf(game.id, 'character', player.id)!.balanceCents;
  const turn = async (input: string, i: Parameters<typeof interp>[0]) => {
    llm.enqueue('interpret', interp(i));
    const r = await engine.takeTurn({ gameId: game.id, input });
    assert.equal(r.status, 'committed', r.error ?? '');
    return r;
  };
  return { store, llm, engine, game, player, opening, product, cash, turn };
}

test('the default Startup world starts at the MVP: product, money, running costs, prices and leads are canonical', async () => {
  const s = start();
  assert.match(s.opening, /^Milan — Monday, 28 September 2026, 08:40/);
  assert.match(s.opening, /Grade Economy has been live for twelve days/);
  assert.match(s.opening, /Your parents want to know by 15 October/);
  assert.match(s.opening, /Coming up:\n  • Tuesday, 29 September 2026, 18:00 — Talk: "From side project to startup"[\s\S]*Thursday, 1 October 2026, 19:00 — Founders' aperitivo/);

  // The product is a side project, not a registered company; it has an address, users and honest problems.
  const p = s.product();
  assert.equal(p.name, 'Grade Economy');
  assert.equal(p.incorporated, false);
  assert.equal(p.url, 'https://www.gradeeconomy.com');
  assert.deepEqual([p.productStage, p.signups, p.activeUsers, p.costPerActiveUserCents], ['mvp', 14, 2, 30]);
  assert.equal(p.knownIssues.length, 2);
  assert.equal(companyRepo.holdings(s.store, p.id)[0]!.characterId, s.player.id);

  // Money: €600, monthly living costs and product costs from the player's pocket, pocket money in; first due 1 October.
  assert.equal(s.cash(), 60_000);
  const flows = s.store.listRecurringPayments(s.game.id).map((r) => `${r.fromAccountId ? '-' : '+'}${r.description} ${r.amountCents} @${r.nextDueGameTime}`);
  assert.deepEqual(flows.sort(), [
    '+Pocket money from parents 10000 @2026-10-01T09:00',
    '-ATM monthly pass (under 27) 2200 @2026-10-01T09:00',
    '-Daily life (coffee, snacks, going out) 8000 @2026-10-01T09:00',
    '-Grade Economy: domain (yearly €15, per month) 125 @2026-10-01T09:00',
    '-Grade Economy: usage costs (servers, AI/API) 60 @2026-10-01T09:00',
    '-Phone plan 1000 @2026-10-01T09:00',
  ]);
  assert.equal(s.store.listPrices(s.game.id).length, 15);
  const cal = s.store.listScheduled(s.game.id, 'pending').map((i) => `${i.kind} ${i.dueGameTime}`).sort();
  assert.deepEqual(cal, ['opportunity 2026-09-29T18:00', 'opportunity 2026-10-01T19:00', 'opportunity 2026-10-10T09:00', 'opportunity 2026-10-15T20:00', 'weekly_report 2026-10-05T08:00']);
  // The parents exist from the start; the enrolment question is known to the three of them.
  const chars = s.store.listCharacters(s.game.id).map((c) => c.name).sort();
  assert.deepEqual(chars, ['Carla Bianchi', 'Felipe', 'Giorgio Bianchi']);
  const q = s.store.listEvents(s.game.id).find((e) => e.type === 'situation_seed')!;
  assert.equal(q.observers.length, 3);
  assert.ok(s.store.listFacts(s.game.id).some((f) => f.predicate === 'lead' && /online community of Italian founders/.test(f.value)));
  assert.match(formatStatusLine(s.store, s.game.id), /Grade Economy \(side project\) · mvp · 14 signups \/ 2 active/);

  // The interpreter sees the calendar, the price book and the product as it is.
  await s.turn('I check the dashboard', { intents: ['general_action'], minutesElapsed: 5, narration: 'Still 14.' });
  const brief = lastPrompt(s.llm, 'interpret');
  assert.match(brief, /UPCOMING \(on the calendar[\s\S]*Tuesday, 29 September 2026, 18:00 — Talk/);
  assert.match(brief, /KNOWN PRICES[^\n]*Coworking day pass €20\.00/);
  assert.match(brief, /Grade Economy \(side project — not registered as a company yet\)[^\n]*https:\/\/www\.gradeeconomy\.com\n  stage: mvp · users: 14 signed up, 2 active/);
  assert.match(brief, /known problems: Signup is confusing on mobile; No onboarding/);
  s.store.close();
});

test('a week passes: bills and pocket money land on the 1st, users come and go, and the week ends with a report', async () => {
  const s = start();
  const r = await s.turn('I spend the week coding', { intents: ['general_action'], minutesElapsed: 7 * 1440, narration: 'A week of late nights.' });
  // 1 October: 10 + 22 + 80 + 1.25 + 0.60 out, 100 in.
  assert.match(r.text, /⏰ Thursday, 1 October 2026, 09:00 — monthly costs €113\.85 \(Phone plan €10\.00, ATM monthly pass \(under 27\) €22\.00, Daily life \(coffee, snacks, going out\) €80\.00, Grade Economy: domain \(yearly €15, per month\) €1\.25, Grade Economy: usage costs \(servers, AI\/API\) €0\.60\) · received €100\.00 \(Pocket money from parents €100\.00\) · balance €586\.15/);
  assert.equal((r.text.match(/⏰/g) ?? []).length, 1);
  assert.equal(s.cash(), 60_000 - 11_385 + 10_000);
  // Weekly dynamics (roll 0.5): 2 organic signups, retention keeps 2 active, 1 new activates; usage cost follows.
  assert.deepEqual([s.product().signups, s.product().activeUsers], [16, 3]);
  assert.equal(s.store.listRecurringPayments(s.game.id).find((x) => /usage costs/.test(x.description))!.amountCents, 90);
  assert.match(r.text, /📅 WEEK IN REVIEW — Monday, 28 September 2026 → Monday, 5 October 2026\n/);
  assert.match(r.text, /Money: spent €113\.85 \(Daily life \(coffee, snacks, going out\) €80\.00, ATM monthly pass \(under 27\) €22\.00, Phone plan €10\.00, Grade Economy: domain[^)]*\) €1\.25, …\) · received €100\.00 · cash now €586\.15/);
  assert.match(r.text, /Monthly: costs €114\.15 · income €100\.00 · net −€14\.15\/month → runway ≈ 41 months/);
  assert.match(r.text, /Grade Economy: signups 14 → 16 \(\+2\) · active 2 → 3 \(\+1\) · usage costs €0\.90\/month · 2 known problems/);
  // The weekly meetup came round again; the hackathon is next week.
  assert.match(r.text, /Coming up:\n  • Thursday, 8 October 2026, 19:00 — Founders' aperitivo[\s\S]*Saturday, 10 October 2026, 09:00 — Weekend hackathon \(EdTech track\) @ Politecnico di Milano, Bovisa · entry €10\.00/);
  const world = (s.store.lastTurn(s.game.id)!.trace as Trace).world!;
  assert.deepEqual(world.scheduled.map((x) => `${x.kind}:${x.result}`).sort(), ['opportunity:passed', 'opportunity:passed', 'weekly_report:report']);
  const next = s.store.listScheduled(s.game.id, 'pending').map((i) => `${i.kind} ${i.dueGameTime}`).sort();
  assert.deepEqual(next, ['opportunity 2026-10-08T19:00', 'opportunity 2026-10-10T09:00', 'opportunity 2026-10-15T20:00', 'weekly_report 2026-10-12T08:00']);
  s.store.close();
});

test('promoting and improving the product move canonical numbers; the game decides how many sign up', async () => {
  const s = start();
  const promo = await s.turn('I post about Grade Economy in the founders Slack and message 10 classmates', {
    intents: ['general_action'], minutesElapsed: 240, narration: 'You write the post three times.',
    actions: [{ action: 'promote_product', productName: 'Grade Economy', channel: 'founders Slack + classmates', hours: 4 }],
  });
  assert.match(promo.text, /📈 Grade Economy via founders Slack \+ classmates: \+2 signups, 1 started using it · now 16 signed up, 3 active/);
  assert.equal(s.store.listRecurringPayments(s.game.id).find((x) => /usage costs/.test(x.description))!.amountCents, 90);

  const fix = await s.turn('I spend the day fixing the mobile signup', {
    intents: ['general_action'], minutesElapsed: 480, narration: 'CSS, mostly.',
    actions: [{ action: 'improve_product', productName: 'Grade Economy', fixedProblem: 'mobile signup', newProblem: null, change: 'rebuilt the signup form for phones' }],
  });
  assert.match(fix.text, /🛠 Grade Economy: rebuilt the signup form for phones · fixed: Signup is confusing on mobile · known problems: 1/);
  const bogus = await s.turn('I fix the payments bug', {
    intents: ['general_action'], minutesElapsed: 60, narration: '',
    actions: [{ action: 'improve_product', productName: 'Grade Economy', fixedProblem: 'payments crash', newProblem: null, change: 'fixed payments' }],
  });
  assert.match(bogus.text, /✗ Grade Economy has no known problem like "payments crash"/);
  assert.equal(s.product().knownIssues.length, 1);
  s.store.close();
});

test('prices stay consistent: known items cost what the price book says; new items are remembered', async () => {
  const s = start();
  const ok = await s.turn('I buy a coworking day pass', { intents: ['general_action'], minutesElapsed: 10, narration: '',
    actions: [{ action: 'pay', amount: 20, description: 'Coworking day pass', fromEntityName: null, recurringMonthly: false }] });
  assert.match(ok.text, /✓ Paid €20\.00 — Coworking day pass/);
  const wild = await s.turn('I buy another day pass', { intents: ['general_action'], minutesElapsed: 10, narration: '',
    actions: [{ action: 'pay', amount: 200, description: 'coworking day pass', fromEntityName: null, recurringMonthly: false }] });
  assert.match(wild.text, /Couldn't do that \(pay: "Coworking day pass" costs about €20\.00 in this world, not €200\.00\)/);
  await s.turn('I buy a notebook', { intents: ['general_action'], minutesElapsed: 10, narration: '',
    actions: [{ action: 'pay', amount: 3.5, description: 'Moleskine-style notebook', fromEntityName: null, recurringMonthly: false }] });
  const learned = s.store.listPrices(s.game.id).find((x) => x.item === 'Moleskine-style notebook')!;
  assert.deepEqual([learned.priceCents, learned.source], [350, 'paid']);
  assert.equal(s.cash(), 60_000 - 2_000 - 350);
  s.store.close();
});

test('research becomes the player\'s notes; registering the side project makes it a company', async () => {
  const s = start();
  const r = await s.turn('I research edtech competitors in Italy', { intents: ['general_action'], minutesElapsed: 180, narration: 'Tabs everywhere.',
    actions: [{ action: 'research', topic: 'EdTech competitors in Italy', findings: ['Several apps gamify studying, few tie grades to money', 'Schools rarely pay for student apps'] }] });
  assert.match(r.text, /📝 Notes — EdTech competitors in Italy:\n   • Several apps gamify studying/);
  const k = s.store.listKnowledgeOf(s.player.id).find((x) => x.topic === 'research: EdTech competitors in Italy')!;
  assert.equal(k.source, 'research');

  const reg = await s.turn('I register Grade Economy as a company and put in 100 euros', { intents: ['general_action'], minutesElapsed: 120, narration: '',
    actions: [{ action: 'found_company', name: 'Grade Economy', description: 'Grades as salary', initialInvestment: 100 }] });
  assert.match(reg.text, /✓ Grade Economy is now a registered company — you own 100% · company cash €100\.00 · your cash €500\.00/);
  assert.equal(s.product().incorporated, true);
  assert.equal(s.product().signups, 14); // same product, same users
  // With its own cash, the company now pays its own usage costs.
  const usage = s.store.listRecurringPayments(s.game.id).filter((x) => /usage costs/.test(x.description) && x.active);
  assert.equal(usage.length, 1);
  assert.equal(usage[0]!.fromAccountId, s.store.getAccountOf(s.game.id, 'entity', s.product().id)!.id);
  s.store.close();
});

test('world creation checks the starting position; the Copilot is told the stages and asset kinds', () => {
  const now = new Date().toISOString();
  const noProduct = compileDraft({ ...STARTUP_TEMPLATE, player: { ...STARTUP_TEMPLATE.player, assets: [] } }, PACKS, { now });
  assert.ok(noProduct.problems.includes('at this starting stage the player needs a product (what have they built?)'));
  const bad = compileDraft({
    ...STARTUP_TEMPLATE, startingStage: 'unicorn',
    economy: { ...STARTUP_TEMPLATE.economy, priceList: [{ item: 'coffee', price: -1 }] },
    openLeads: [{ title: 'Old meetup', description: '', when: '2026-01-01T19:00', location: null, cost: null, repeatsWeekly: false }],
  }, PACKS, { now });
  assert.ok(bad.problems.includes('the starting stage must be one of: idea, mvp, first_users'));
  assert.ok(bad.problems.includes('prices, costs and income cannot be negative'));
  assert.ok(bad.problems.includes('"Old meetup" needs a date/time after the start'));
  assert.equal(compileDraft(STARTUP_TEMPLATE, PACKS, { now }).problems.length, 0);
  // An Open World draft needs none of this.
  assert.equal(compileDraft({ ...EMPTY_DRAFT, ...PACKS[1]!.worldCreation.template }, PACKS, { now }).problems.length, 0);

  const sys = copilotSystemPrompt(PACKS);
  assert.match(sys, /startingStage options: idea \(nothing built[^)]*\); mvp \([^)]*\); first_users \([^)]*\) — default mvp/);
  assert.match(sys, /asset kinds with mechanics: product \(the product the player built[^\n]*; metrics: signups, activeUsers, costPerActiveUserMonthly\)/);
  assert.match(sys, /Start where the story starts, not before it/);
  assert.match(sys, /economy\.priceList/);
});

test('deleting a game removes every row that belongs to it and nothing else; delete-all clears games and drafts', async () => {
  const keep = start();
  const store = keep.store;
  const other = keep.engine.newGame();
  await keep.turn('I register the company', { intents: ['general_action'], minutesElapsed: 60, narration: '',
    actions: [{ action: 'found_company', name: 'Grade Economy', description: 'Grades as salary', initialInvestment: 50 }] });
  const rows = (gameId: string) => ({
    characters: store.listCharacters(gameId).length, events: store.listEvents(gameId).length, companies: companyRepo.list(store, gameId).length,
    seed: Boolean(store.getWorldSeed(gameId)), turns: store.listTurns(gameId).length,
  });
  const otherBefore = rows(other.game.id);
  store.deleteGame(keep.game.id);
  assert.equal(store.getGame(keep.game.id), undefined);
  assert.deepEqual(rows(keep.game.id), { characters: 0, events: 0, companies: 0, seed: false, turns: 0 });
  assert.deepEqual(rows(other.game.id), otherBefore);
  const count = (t: string) => (store.get(`SELECT COUNT(*) AS n FROM ${t}`) as { n: number }).n;
  assert.equal(count('shareholdings'), 1); // only the other game's founder
  assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);

  store.insertDraft({ id: 'draft_x', status: 'drafting', draft: EMPTY_DRAFT, version: 0, now: 'x' });
  store.addDraftMessage('draft_x', 'player', 'hi', 'x');
  store.deleteAllGames();
  for (const t of ['games', 'characters', 'events', 'event_observers', 'companies', 'shareholdings', 'world_seeds', 'world_drafts', 'draft_messages', 'prices', 'turns']) {
    assert.equal(count(t), 0, t);
  }
  // The database still works afterwards.
  const again = keep.engine.newGame();
  assert.ok(store.getGame(again.game.id));
  store.close();
});

test('seeking a contact: the engine decides what is found (more time, better odds); contacts become notes the next turn sees', async () => {
  const seek = (hours: number) => ({ action: 'seek', target: 'someone at FEduF', approach: 'LinkedIn and their website', hours,
    ifPerson: { name: 'Chiara Rinaldi', role: 'school programmes coordinator at FEduF', channel: 'LinkedIn message' }, ifChannel: 'the contact form on feduf.it' });
  // Roll 0.5: 4 hours gives a named person (p = 0.6); 1 hour only a general channel (person p = 0.3, channel p = 0.7).
  const lucky = start();
  const r = await lucky.turn('I look for someone at FEduF', { intents: ['general_action'], minutesElapsed: 240, narration: 'You dig through LinkedIn.',
    actions: [seek(4)], suggestions: ['Message Chiara on LinkedIn', 'Go to Wednesday\'s pitching event'] });
  assert.match(r.text, /🔎 Found someone: Chiara Rinaldi — school programmes coordinator at FEduF · reachable via LinkedIn message/);
  assert.deepEqual(r.suggestions, ['Message Chiara on LinkedIn', 'Go to Wednesday\'s pitching event']);
  await lucky.turn('what now', { intents: ['general_action'], minutesElapsed: 5, narration: '' });
  const brief = lastPrompt(lucky.llm, 'interpret');
  assert.match(brief, /NOTES AND CONTACTS[^\n]*\n- contact: Chiara Rinaldi: school programmes coordinator at FEduF — reachable via LinkedIn message/);
  assert.match(brief, /RECENT ACTIVITY:\n[\s\S]*found a contact: Chiara Rinaldi/);
  lucky.store.close();

  const quick = start();
  const r2 = await quick.turn('I quickly google FEduF', { intents: ['general_action'], minutesElapsed: 60, narration: '', actions: [seek(1)] });
  assert.match(r2.text, /🔎 No name yet, but a way in to someone at FEduF: the contact form on feduf\.it/);
  quick.store.close();
});
