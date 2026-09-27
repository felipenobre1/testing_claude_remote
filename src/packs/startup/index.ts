import { z } from 'zod';
import type { Offer } from '../../domain/types.ts';
import { EMPTY_DRAFT } from '../../domain/world.ts';
import type { WorldPlanner } from '../../engine/planner.ts';
import { newId } from '../../engine/util.ts';
import type { GamePack, OfferKindDef, PackAction } from '../types.ts';
import { companyRepo, pct, PRODUCT_STAGES, STARTUP_MIGRATIONS, StartupState, type Company, type ProductStage } from './company.ts';

// ============================================================================
// Game Pack: Startup — an 18-year-old in the real Milan, September 2026, with €2,500.
// Everything startup-specific lives here: companies, ownership, product stage, and what
// joining / hiring / buying / investing means. The engine only sees generic offers,
// entities (companies own accounts) and pack actions.
// ============================================================================

export const START_TIME = '2026-09-27T09:14'; // Sunday, Europe/Rome

const st = (api: WorldPlanner) => api.packState as StartupState;
const cents = (x: number) => Math.round(x * 100);

function companyLines(api: WorldPlanner, c: Company): string[] {
  const acct = api.account('entity', c.id);
  const table = st(api).holdingsOf(c.id).map((h) => `${api.name(h.characterId)} ${pct(h.shares, c.totalShares)} (${h.role})`).join(', ');
  const costs = acct ? api.outgoing(acct.id).map((r) => `${r.description} ${api.money(r.amountCents)}/month`).join('; ') : '';
  const revenue = acct ? api.incoming(acct.id).map((r) => `${r.description} ${api.money(r.amountCents)}/month`).join('; ') : '';
  return [`${c.name} — ${c.description}`,
    `  stage: ${c.productStage} · company cash: ${api.money(acct?.balanceCents ?? 0)} · owners: ${table}${costs ? ` · monthly costs: ${costs}` : ''}${revenue ? ` · monthly revenue: ${revenue}` : ''}`];
}

/** Offers are made on behalf of a company the player owns part of. */
function playerCompany(api: WorldPlanner, name: string | null): { subjectRef: string } | { reject: string } | { modelError: string } {
  if (!name) return { modelError: 'which company is this offer from? (subject = company name)' };
  const c = st(api).byName(name);
  if (!c) return { reject: `There is no company called "${name}" yet — found it first.` };
  if (!st(api).isMember(c.id, api.ctx.player.id)) return { reject: `You are not a shareholder of ${c.name}.` };
  return { subjectRef: c.id };
}
const companyOf = (api: WorldPlanner, o: Offer) => st(api).companies.get(o.subjectRef ?? '')!;
const counterpartyOf = (api: WorldPlanner, o: Offer) => (o.fromCharacterId === api.ctx.player.id ? o.toCharacterId : o.fromCharacterId);
const presented = (api: WorldPlanner, o: Offer) => ['About the company (as presented to you):', ...companyLines(api, companyOf(api, o))];
const pctOk = (x: number | undefined) => (x !== undefined && x > 0 && x < 100 ? null : 'equityPercent must be between 0 and 100');

const offerKinds: OfferKindDef[] = [
  {
    kind: 'join_company',
    summary: 'join the company as cofounder/partner for a stake (label = role)',
    terms: [{ key: 'equityPercent', description: 'stake after joining', required: true }, { key: 'salaryMonthly', description: 'monthly pay, if any', required: false }],
    validateTerms: (t) => pctOk(t.equityPercent),
    resolveSubject: (api, subject, toId) => {
      const r = playerCompany(api, subject);
      if ('subjectRef' in r && st(api).isMember(r.subjectRef, toId)) return { reject: `${api.name(toId)} already owns part of ${st(api).companies.get(r.subjectRef)!.name}.` };
      return r;
    },
    describe: (api, o) => `${o.terms.equityPercent}% of ${companyOf(api, o).name} as ${o.label ?? 'cofounder'}${o.terms.salaryMonthly ? ` + ${api.money(cents(o.terms.salaryMonthly))}/month` : ', no salary'}`,
    context: presented,
    execute: (api, o) => {
      const c = companyOf(api, o);
      const who = counterpartyOf(api, o);
      st(api).issue(c.id, who, o.terms.equityPercent!, o.label ?? 'cofounder', api.ctx.gameTime, api.ctx.now);
      if (o.terms.salaryMonthly) api.addRecurring(api.ensureAccount('entity', c.id), api.ensureAccount('character', who), `${api.name(who)}'s salary`, cents(o.terms.salaryMonthly));
      const table = st(api).holdingsOf(c.id).map((h) => `${api.name(h.characterId)} ${pct(h.shares, c.totalShares)}`).join(', ');
      api.results.push(`✓ ${api.name(who)} joined ${c.name} as ${o.label ?? 'cofounder'} · ownership: ${table}`);
    },
  },
  {
    kind: 'hire',
    summary: 'a paid job at the company (label = role)',
    terms: [{ key: 'salaryMonthly', description: 'monthly pay', required: true }],
    resolveSubject: (api, subject) => playerCompany(api, subject),
    describe: (api, o) => `job at ${companyOf(api, o).name}${o.label ? ` as ${o.label}` : ''} for ${api.money(cents(o.terms.salaryMonthly ?? 0))}/month`,
    context: presented,
    execute: (api, o) => {
      const c = companyOf(api, o);
      const who = counterpartyOf(api, o);
      api.addRecurring(api.ensureAccount('entity', c.id), api.ensureAccount('character', who), `${api.name(who)}'s salary (${o.label ?? 'employee'})`, cents(o.terms.salaryMonthly!));
      api.results.push(`✓ ${api.name(who)} works for ${c.name} as ${o.label ?? 'employee'} · ${api.money(cents(o.terms.salaryMonthly!))}/month from the company`);
    },
  },
  {
    kind: 'purchase',
    summary: "the other person buys the company's product as a monthly subscription",
    terms: [{ key: 'priceMonthly', description: 'monthly price', required: true }],
    resolveSubject: (api, subject) => playerCompany(api, subject),
    describe: (api, o) => `${companyOf(api, o).name} subscription at ${api.money(cents(o.terms.priceMonthly ?? 0))}/month`,
    execute: (api, o) => {
      const c = companyOf(api, o);
      const acct = api.ensureAccount('entity', c.id);
      const who = api.name(counterpartyOf(api, o));
      api.move(null, acct, cents(o.terms.priceMonthly!), `${who}: first month`, 'revenue');
      api.addRecurring(null, acct, `${who} subscription`, cents(o.terms.priceMonthly!));
      api.results.push(`✓ ${who} is now a paying customer of ${c.name} · ${api.money(cents(o.terms.priceMonthly!))}/month · company cash ${api.money(acct.balanceCents)}`);
    },
  },
  {
    kind: 'investment',
    summary: 'the other person invests money for a stake',
    terms: [{ key: 'amount', description: 'money invested', required: true }, { key: 'equityPercent', description: 'stake received', required: true }],
    validateTerms: (t) => pctOk(t.equityPercent) ?? (t.amount! > 0 ? null : 'amount must be positive'),
    resolveSubject: (api, subject) => playerCompany(api, subject),
    describe: (api, o) => `${api.money(cents(o.terms.amount ?? 0))} for ${o.terms.equityPercent}% of ${companyOf(api, o).name}`,
    context: presented,
    execute: (api, o) => {
      const c = companyOf(api, o);
      const who = counterpartyOf(api, o);
      const acct = api.ensureAccount('entity', c.id);
      api.move(null, acct, cents(o.terms.amount!), `investment from ${api.name(who)}`, 'investment');
      st(api).issue(c.id, who, o.terms.equityPercent!, 'investor', api.ctx.gameTime, api.ctx.now);
      const table = st(api).holdingsOf(c.id).map((h) => `${api.name(h.characterId)} ${pct(h.shares, c.totalShares)}`).join(', ');
      api.results.push(`✓ ${api.name(who)} invested ${api.money(cents(o.terms.amount!))} in ${c.name} · ownership: ${table} · company cash ${api.money(acct.balanceCents)}`);
    },
  },
];

const actions: PackAction[] = [
  {
    name: 'found_company',
    schema: z.strictObject({ action: z.literal('found_company'), name: z.string().min(2).max(80), description: z.string().min(3).max(400), initialInvestment: z.number() }),
    doc: 'found_company: actually founding/registering a company (initialInvestment = personal money put in now, often 0).',
    handle: (api, a) => {
      const me = api.ctx.player.id;
      const name = String(a.name).trim();
      if (st(api).byName(name)) return api.reject(a, `A company called ${name} already exists.`), null;
      const invest = cents(Number(a.initialInvestment));
      if (invest < 0) return 'found_company: investment cannot be negative';
      const personal = api.ensureAccount('character', me);
      if (invest > personal.balanceCents) return api.reject(a, `Can't put ${api.money(invest)} into ${name}: you have only ${api.money(personal.balanceCents)}.`), null;
      const c: Company = { id: newId('co'), gameId: api.ctx.gameId, name, description: String(a.description), productStage: 'idea', totalShares: 1_000_000,
        foundedGameTime: api.ctx.gameTime, createdAt: api.ctx.now, updatedAt: api.ctx.now };
      st(api).found(c, me);
      const acct = api.ensureAccount('entity', c.id);
      if (invest > 0) api.move(personal, acct, invest, `founder investment in ${name}`, 'investment');
      api.event('company_founded', `${api.ctx.player.name} founded ${name}${invest ? ` with ${api.money(invest)}` : ''}.`, [me], [{ characterId: me, role: 'actor' }], 4);
      api.results.push(`✓ Founded ${name} — you own 100%${invest ? ` · company cash ${api.money(acct.balanceCents)} · your cash ${api.money(personal.balanceCents)}` : ''}`);
      return null;
    },
  },
  {
    name: 'invest_in_company',
    schema: z.strictObject({ action: z.literal('invest_in_company'), companyName: z.string(), amount: z.number() }),
    doc: 'invest_in_company: moving personal money into a company the player owns part of.',
    handle: (api, a) => {
      const me = api.ctx.player.id;
      const c = st(api).byName(String(a.companyName));
      if (!c) return api.reject(a, `There is no company called "${a.companyName}".`), null;
      if (!st(api).isMember(c.id, me)) return api.reject(a, `You are not a shareholder of ${c.name}.`), null;
      const amount = cents(Number(a.amount));
      if (amount <= 0) return 'invest_in_company: amount must be positive';
      const personal = api.ensureAccount('character', me);
      if (personal.balanceCents < amount) return api.reject(a, `Can't invest ${api.money(amount)}: you have only ${api.money(personal.balanceCents)}.`), null;
      const acct = api.ensureAccount('entity', c.id);
      api.move(personal, acct, amount, `investment in ${c.name}`, 'investment');
      api.event('money', `${api.ctx.player.name} put ${api.money(amount)} into ${c.name}.`, [me], [{ characterId: me, role: 'actor' }]);
      api.results.push(`✓ Invested ${api.money(amount)} in ${c.name} · company cash ${api.money(acct.balanceCents)} · your cash ${api.money(personal.balanceCents)}`);
      return null;
    },
  },
  {
    name: 'advance_product',
    schema: z.strictObject({ action: z.literal('advance_product'), companyName: z.string(), stage: z.enum(['prototype', 'mvp', 'launched']) }),
    doc: 'advance_product: only after the player has plausibly done the work (considering the time spent and their skills).',
    handle: (api, a) => {
      const me = api.ctx.player.id;
      const c = st(api).byName(String(a.companyName));
      if (!c) return api.reject(a, `There is no company called "${a.companyName}".`), null;
      if (!st(api).isMember(c.id, me)) return api.reject(a, `You are not part of ${c.name}.`), null;
      const stage = a.stage as ProductStage;
      if (PRODUCT_STAGES.indexOf(stage) <= PRODUCT_STAGES.indexOf(c.productStage)) return api.reject(a, `${c.name} is already at "${c.productStage}".`), null;
      st(api).setStage(c.id, stage, api.ctx.now);
      const members = st(api).holdingsOf(c.id).map((h) => h.characterId);
      api.event('company_updated', `${c.name}'s product reached the ${stage} stage.`, members, [{ characterId: me, role: 'actor' }], 3);
      api.results.push(`✓ ${c.name}: product is now at "${stage}"`);
      return null;
    },
  },
];

export const startupPack: GamePack = {
  id: 'startup',
  name: 'Startup — Milan',
  currency: { code: 'EUR', symbol: '€' },
  migrations: STARTUP_MIGRATIONS,
  worldCreation: {
    summary: 'a realistic present-day life where the player tries to build a company: money, co-founders, hiring, equity, investors and customers',
    guidance: [
      'Startup mechanics: companies with cap tables, joining/hiring/buying/investing offers, a money ledger, recurring costs and promises.',
      'Good fit for grounded, real-world settings (any real city, any recent year). Ask about: where, when, the player\'s age, money, skills,',
      'living situation and whether they already have an idea or a company. Starting money matters a lot here — make it explicit.',
      'Default world: the real world, history continues unless the story changes it; NPCs are busy, sceptical and have their own lives.',
    ].join('\n'),
    template: {
      ...EMPTY_DRAFT,
      packId: 'startup',
      premise: 'An eighteen-year-old in Milan wants to build a startup, with €2,500, a laptop and no idea yet.',
      sourceWorld: 'the real world',
      canonPolicy: 'history_continues_unless_changed',
      setting: { place: 'Milan', era: '2026, the present day', startDate: START_TIME, timezone: 'Europe/Rome',
        description: 'The real Milan in September 2026: universities starting, a small but active startup scene, expensive rents.' },
      style: { tone: 'grounded, realistic, sometimes funny', realism: 'high — real prices, real institutions, busy people who owe the player nothing',
        difficulty: 'hard; most attempts fail', narrativeStyle: 'second person, concise', playerSignificance: 'a nobody: no network, no money, no reputation yet' },
      designPrinciples: [
        'Do not manufacture destiny around the player; success must be earned.',
        'People have their own lives and priorities; rejection and silence are normal.',
        'Money, time and trust are scarce and tracked.',
      ],
      worldRules: ['The real world of 2026: real laws, real companies, real technology — nothing magical.'],
      player: { ...EMPTY_DRAFT.player,
        name: 'Felipe', age: 18, occupation: 'Recent liceo graduate, not enrolled anywhere yet',
        background: 'Born and raised in Milan. Just finished liceo scientifico. Still lives at home with parents. '
          + 'Self-taught programmer who has built small web apps and scripts. No company yet and little business experience.',
        skills: ['technical', 'ambitious'], goals: ['Build a startup'], location: 'Milan (family apartment)',
        circumstances: ['lives with parents'], startingMoney: 2_500, currency: { code: 'EUR', symbol: '€' }, possessions: ['a laptop', 'a phone'] },
      currentSituation: "You're eighteen and still living with your parents. You've got €2,500 in your bank account, a laptop, and enough programming "
        + "experience to build things yourself. For months you've been thinking about starting a company. You don't have an idea yet. "
        + 'No investors. No employees. No customers.',
      startingScene: { location: 'Home — bedroom in the family apartment, Milan', description: 'Sunday morning. Laptop open on the desk, phone beside it.' },
    },
  },
  offerKinds,
  entities: {
    find: (api, name) => { const c = st(api).byName(name); return c && { id: c.id, name: c.name }; },
    name: (api, id) => st(api).companies.get(id)?.name ?? 'a company',
    controlledBy: (api, id, characterId) => st(api).isMember(id, characterId),
  },
  actions,
  createTurnState: (store, gameId) => new StartupState(store, gameId),
  briefing: {
    player: (api) => st(api).companiesOf(api.ctx.player.id).flatMap((c) => companyLines(api, c)),
    // An NPC sees the companies they own part of — nothing else.
    npc: (api, npcId) => st(api).companiesOf(npcId).flatMap((c) => companyLines(api, c)),
  },
  statusParts(store, gameId, playerId) {
    return companyRepo.of(store, playerId).map((c) => {
      const mine = companyRepo.holdings(store, c.id).find((h) => h.characterId === playerId)!;
      const cash = store.getAccountOf(gameId, 'entity', c.id)?.balanceCents ?? 0;
      return `${c.name} ${pct(mine.shares, c.totalShares)} · €${(cash / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 })} · ${c.productStage}`;
    });
  },
  prompts: {
    interpretActions: [
      '  Startup actions:',
      ...actions.map((a) => `  - ${a.doc}`),
      '  Offer kinds for make_offer (subject = the company name; label = role where relevant):',
      ...offerKinds.map((k) => `    - ${k.kind}: ${k.summary}. terms: ${k.terms.map((t) => `${t.key}${t.required ? '' : ' (optional)'} = ${t.description}`).join('; ')}`),
    ].join('\n'),
    director: 'A young founder in the Milan startup ecosystem (2026): universities (Politecnico, Bocconi), student jobs and internships, families with opinions, '
      + 'small businesses as potential customers, accelerators and angels, competitors, money pressure. Plausible developments come from people\'s own lives '
      + 'and incentives: job offers, exams, family pressure, rivals, customers changing their minds, cash running low.',
  },
  entityLabel: (store, id) => companyRepo.get(store, id)?.name ?? id,
  inspect(store, gameId) {
    const names = new Map(store.listCharacters(gameId).map((c) => [c.id, c.name]));
    const out: string[] = ['── COMPANIES (startup pack) ──'];
    for (const c of companyRepo.list(store, gameId)) {
      out.push(`  ${c.name} (${c.productStage}, founded ${c.foundedGameTime}, ${c.totalShares} shares) — ${c.description}`,
        ...companyRepo.holdings(store, c.id).map((s) => `    ${names.get(s.characterId)} ${s.shares} shares = ${pct(s.shares, c.totalShares)} (${s.role})`));
    }
    return out.join('\n');
  },
};
