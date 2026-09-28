import { z } from 'zod';
import type { Offer } from '../../domain/types.ts';
import { STARTUP_TEMPLATE } from './worlds.ts';
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

export { CLASSIC_DRAFT, STARTUP_TEMPLATE } from './worlds.ts';

const st = (api: WorldPlanner) => api.packState as StartupState;
const cents = (x: number) => Math.round(x * 100);

function companyLines(api: WorldPlanner, c: Company): string[] {
  const acct = api.account('entity', c.id);
  const table = st(api).holdingsOf(c.id).map((h) => `${api.name(h.characterId)} ${pct(h.shares, c.totalShares)} (${h.role})`).join(', ');
  const costs = acct ? api.outgoing(acct.id).map((r) => `${r.description} ${api.money(r.amountCents)}/month`).join('; ') : '';
  const revenue = acct ? api.incoming(acct.id).map((r) => `${r.description} ${api.money(r.amountCents)}/month`).join('; ') : '';
  return [`${c.name}${c.incorporated ? '' : ' (side project — not registered as a company yet)'} — ${c.description}${c.url ? ` · ${c.url}` : ''}`,
    `  stage: ${c.productStage} · users: ${c.signups} signed up, ${c.activeUsers} active${c.incorporated ? ` · company cash: ${api.money(acct?.balanceCents ?? 0)}` : ''} · owners: ${table}`
      + `${costs ? ` · monthly costs: ${costs}` : ''}${revenue ? ` · monthly revenue: ${revenue}` : ''}`,
    ...(c.knownIssues.length ? [`  known problems: ${c.knownIssues.join('; ')}`] : [])];
}

const USAGE = (c: Company) => `${c.name}: usage costs (servers, AI/API)`;
/** Usage costs follow active users. A side project is paid from the founder's pocket; a funded company pays its own. */
function syncUsageCost(api: WorldPlanner, c: Company) {
  const personal = api.ensureAccount('character', api.ctx.player.id);
  const company = api.account('entity', c.id);
  const payer = c.incorporated && company && company.balanceCents > 0 ? company : personal;
  const other = payer === personal ? company : personal;
  api.setRecurring(payer, null, USAGE(c), c.activeUsers * c.costPerActiveUserCents);
  if (other) api.setRecurring(other, null, USAGE(c), 0);
}
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
/** Share of new signups who actually start using the product; known problems scare people off. */
const activation = (c: Company) => clamp(35 - 5 * c.knownIssues.length, 10, 50) / 100; // integer percent: no float drift
/** Share of active users still active a week later. */
const retention = (c: Company) => clamp((c.productStage === 'launched' ? 92 : 86) - 5 * c.knownIssues.length, 50, 97) / 100;
const STAGE_REACH: Record<ProductStage, number> = { idea: 0.3, prototype: 0.6, mvp: 1, launched: 1.3 };

/** A product the player works on (any company they belong to), by name. */
function playerProduct(api: WorldPlanner, a: Record<string, unknown>, key = 'productName'): Company | string {
  const c = st(api).byName(String(a[key]));
  if (!c) return `There is no product or company called "${a[key]}".`;
  if (!st(api).isMember(c.id, api.ctx.player.id)) return `You are not part of ${c.name}.`;
  return c;
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
    doc: 'found_company: actually founding/registering a company (initialInvestment = personal money put in now, often 0). Registering an existing side project uses its name.',
    handle: (api, a) => {
      const me = api.ctx.player.id;
      const name = String(a.name).trim();
      const invest = cents(Number(a.initialInvestment));
      if (invest < 0) return 'found_company: investment cannot be negative';
      const personal = api.ensureAccount('character', me);
      if (invest > personal.balanceCents) return api.reject(a, `Can't put ${api.money(invest)} into ${name}: you have only ${api.money(personal.balanceCents)}.`), null;
      const existing = st(api).byName(name);
      if (existing && !existing.incorporated && st(api).isMember(existing.id, me)) {
        // Registering the side project: same product, same users — now a company with its own account.
        st(api).update(existing.id, { incorporated: true }, api.ctx.now);
        const acct = api.ensureAccount('entity', existing.id);
        if (invest > 0) api.move(personal, acct, invest, `founder investment in ${name}`, 'investment');
        syncUsageCost(api, existing);
        api.event('company_founded', `${api.ctx.player.name} registered ${name} as a company${invest ? ` with ${api.money(invest)}` : ''}.`, [me], [{ characterId: me, role: 'actor' }], 4);
        api.results.push(`✓ ${name} is now a registered company — you own 100%${invest ? ` · company cash ${api.money(acct.balanceCents)} · your cash ${api.money(personal.balanceCents)}` : ''}`);
        return null;
      }
      if (existing) return api.reject(a, `A company called ${name} already exists.`), null;
      const c: Company = { id: newId('co'), gameId: api.ctx.gameId, name, description: String(a.description), productStage: 'idea', totalShares: 1_000_000,
        foundedGameTime: api.ctx.gameTime, createdAt: api.ctx.now, updatedAt: api.ctx.now,
        incorporated: true, url: null, signups: 0, activeUsers: 0, knownIssues: [], costPerActiveUserCents: 0 };
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
  {
    name: 'promote_product',
    schema: z.strictObject({ action: z.literal('promote_product'), productName: z.string(), channel: z.string().min(2).max(120), hours: z.number() }),
    doc: 'promote_product: the player actually puts the product in front of people now (a post in a community, messages to potential users, a demo at an event, flyers). channel = where/how; hours = effort spent. The game decides how many sign up.',
    handle: (api, a) => {
      const c = playerProduct(api, a);
      if (typeof c === 'string') return api.reject(a, c), null;
      const hours = Number(a.hours);
      if (!(hours > 0 && hours <= 80)) return 'promote_product: hours must be between 0 and 80';
      if (c.productStage === 'idea' && !c.url) return api.reject(a, `${c.name} is only an idea — there is nothing for people to sign up to yet.`), null;
      const roll = api.random(`promote:${c.id}:${a.channel}`);
      const reached = Math.round(Math.min(hours, 20) * 0.5 * STAGE_REACH[c.productStage] * (0.2 + 1.6 * roll));
      const active = Math.round(reached * activation(c));
      st(api).update(c.id, { signups: c.signups + reached, activeUsers: Math.min(c.signups + reached, c.activeUsers + active) }, api.ctx.now);
      syncUsageCost(api, c);
      const me = api.ctx.player.id;
      api.event('product_update', `${api.ctx.player.name} promoted ${c.name} (${a.channel}): ${reached} new signups.`, [me], [{ characterId: me, role: 'actor' }], 2);
      api.results.push(reached
        ? `📈 ${c.name} via ${a.channel}: +${reached} signup${reached === 1 ? '' : 's'}${active ? `, ${active} started using it` : ', nobody really started using it yet'} · now ${c.signups} signed up, ${c.activeUsers} active`
        : `📉 ${c.name} via ${a.channel}: nobody signed up this time.`);
      return null;
    },
  },
  {
    name: 'improve_product',
    schema: z.strictObject({ action: z.literal('improve_product'), productName: z.string(), fixedProblem: z.string().nullable(), newProblem: z.string().max(200).nullable(), change: z.string().min(3).max(300) }),
    doc: 'improve_product: the player works on the product (fixing a known problem, shipping something). fixedProblem = the known problem fixed (as listed), only if the time spent plausibly fixes it; newProblem = a problem they discovered (e.g. from user feedback), else null.',
    handle: (api, a) => {
      const c = playerProduct(api, a);
      if (typeof c === 'string') return api.reject(a, c), null;
      let issues = [...c.knownIssues];
      const lines: string[] = [];
      if (a.fixedProblem) {
        const want = String(a.fixedProblem).toLowerCase();
        const words = new Set(want.split(/\W+/).filter((w) => w.length > 3));
        const hit = issues.find((i) => i.toLowerCase().includes(want) || want.includes(i.toLowerCase())
          || i.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length >= 2);
        if (!hit) return api.reject(a, `${c.name} has no known problem like "${a.fixedProblem}".`), null;
        issues = issues.filter((i) => i !== hit);
        lines.push(`fixed: ${hit}`);
      }
      if (a.newProblem && !issues.includes(String(a.newProblem))) { issues = [...issues, String(a.newProblem)].slice(-8); lines.push(`new known problem: ${a.newProblem}`); }
      st(api).update(c.id, { knownIssues: issues }, api.ctx.now);
      const me = api.ctx.player.id;
      api.event('product_update', `${api.ctx.player.name} worked on ${c.name}: ${a.change}.`, [me], [{ characterId: me, role: 'actor' }], 2);
      api.results.push(`🛠 ${c.name}: ${a.change}${lines.length ? ` · ${lines.join(' · ')}` : ''} · known problems: ${issues.length}`);
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
    summary: 'a realistic present-day startup journey: a product, users, money, co-founders, hiring, equity, investors and customers',
    guidance: [
      'Startup mechanics: a product with real numbers (signups, active users, known problems, usage costs), companies with cap tables,',
      'joining/hiring/buying/investing offers, a money ledger with monthly costs, promotion and product work, events and networking.',
      'Start where the journey starts: usually the player already built something small (an MVP, a landing page) alone, with little money and no network.',
      'Put the product in player.assets with kind "product": its real URL if the player has one, state (idea/prototype/mvp/launched), metrics signups,',
      'activeUsers and costPerActiveUserMonthly (servers + AI/API per active user, typically 0.05–1), monthlyCosts (domain, paid tools) and honest knownIssues.',
      'Ask about: the product and where it stands, the player\'s age, skills, money, living situation and what pushes them. Offer 2–3 concrete open leads',
      '(meetups, talks, hackathons, communities — real kinds of events for that city) with dates in the first two weeks.',
    ].join('\n'),
    stages: [
      { id: 'idea', label: 'an idea, nothing built yet', description: 'nothing built; the journey starts at zero' },
      { id: 'mvp', label: 'a working MVP and a landing page, a handful of signups', description: 'something small and real exists; nobody knows about it' },
      { id: 'first_users', label: 'a live product with a small group of real users', description: 'people use it; the question is whether it grows' },
    ],
    defaultStage: 'mvp',
    assetKinds: [{ kind: 'product', description: 'the product the player built (becomes a side project they can later register as a company)', metrics: ['signups', 'activeUsers', 'costPerActiveUserMonthly'] }],
    validate(draft) {
      const products = draft.player.assets.filter((x) => x.kind === 'product');
      const out: string[] = [];
      if ((draft.startingStage === 'mvp' || draft.startingStage === 'first_users') && !products.length) out.push('at this starting stage the player needs a product (what have they built?)');
      for (const p of products) {
        if (p.url && !/^https?:\/\/\S+\.\S+/.test(p.url)) out.push(`${p.name}'s web address must be a full URL (https://…)`);
        const m = Object.fromEntries(p.metrics.map((x) => [x.key, x.value]));
        if ((m.activeUsers ?? 0) > (m.signups ?? 0)) out.push(`${p.name} cannot have more active users than signups`);
      }
      return out;
    },
    seed({ store, gameId, player, playerAccountId, seed, now, addMonthly }) {
      for (const p of seed.player.assets.filter((x) => x.kind === 'product')) {
        const m = Object.fromEntries(p.metrics.map((x) => [x.key, x.value]));
        const stage: ProductStage = PRODUCT_STAGES.includes(p.state as ProductStage) ? p.state as ProductStage
          : seed.startingStage === 'first_users' ? 'launched' : seed.startingStage === 'idea' ? 'idea' : 'mvp';
        const c: Company = {
          id: newId('co'), gameId, name: p.name, description: p.description, productStage: stage, totalShares: 1_000_000, foundedGameTime: seed.world.startDate,
          createdAt: now, updatedAt: now, incorporated: false, url: p.url, signups: Math.max(0, Math.round(m.signups ?? 0)),
          activeUsers: Math.max(0, Math.round(m.activeUsers ?? 0)), knownIssues: p.knownIssues, costPerActiveUserCents: cents(m.costPerActiveUserMonthly ?? 0),
        };
        companyRepo.create(store, c, player.id);
        for (const x of p.monthlyCosts) addMonthly(playerAccountId, null, `${p.name}: ${x.label}`, cents(x.amount));
        addMonthly(playerAccountId, null, USAGE(c), c.activeUsers * c.costPerActiveUserCents);
      }
    },
    template: STARTUP_TEMPLATE,
  },
  weekly(api, _since, until) {
    const me = api.ctx.player.id;
    const lines: string[] = [];
    for (const c of st(api).companiesOf(me).filter((x) => x.productStage !== 'idea' || x.url)) {
      const before = { signups: c.signups, active: c.activeUsers };
      const organic = Math.floor(api.random(`${c.id}:organic:${until}`) * (c.url ? 4 : 1) * STAGE_REACH[c.productStage]);
      const kept = Math.round(c.activeUsers * retention(c));
      const signups = c.signups + organic;
      st(api).update(c.id, { signups, activeUsers: Math.min(signups, kept + Math.round(organic * activation(c))) }, api.ctx.now);
      syncUsageCost(api, c);
      const d = (a: number, b: number) => `${a} → ${b}${b !== a ? ` (${b > a ? '+' : ''}${b - a})` : ''}`;
      lines.push(`${c.name}: signups ${d(before.signups, c.signups)} · active ${d(before.active, c.activeUsers)}${c.costPerActiveUserCents ? ` · usage costs ${api.money(c.activeUsers * c.costPerActiveUserCents)}/month` : ''}`
        + `${c.knownIssues.length ? ` · ${c.knownIssues.length} known problem${c.knownIssues.length === 1 ? '' : 's'}` : ''}`);
    }
    return lines;
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
  statusParts(store, gameId, playerId, lang = 'en') {
    return companyRepo.of(store, playerId).map((c) => {
      const mine = companyRepo.holdings(store, c.id).find((h) => h.characterId === playerId)!;
      const cash = store.getAccountOf(gameId, 'entity', c.id)?.balanceCents ?? 0;
      const users = c.signups || c.activeUsers ? (lang === 'pt' ? ` · ${c.signups} cadastros / ${c.activeUsers} ativos` : ` · ${c.signups} signups / ${c.activeUsers} active`) : '';
      if (!c.incorporated) return `${c.name} (${lang === 'pt' ? 'projeto paralelo' : 'side project'}) · ${c.productStage}${users}`;
      return `${c.name} ${pct(mine.shares, c.totalShares)} · €${(cash / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 })} · ${c.productStage}${users}`;
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
      out.push(`  ${c.name} (${c.incorporated ? '' : 'side project, '}${c.productStage}, since ${c.foundedGameTime}, ${c.totalShares} shares) — ${c.description}${c.url ? ` · ${c.url}` : ''}`,
        `    users: ${c.signups} signups, ${c.activeUsers} active · usage cost ${c.costPerActiveUserCents}c/active user/month · known problems: ${c.knownIssues.join('; ') || '-'}`,
        ...companyRepo.holdings(store, c.id).map((s) => `    ${names.get(s.characterId)} ${s.shares} shares = ${pct(s.shares, c.totalShares)} (${s.role})`));
    }
    return out.join('\n');
  },
};
