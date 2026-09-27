import type { Store } from '../db/store.ts';
import type { PlayerAction } from '../domain/schemas.ts';
import {
  PRODUCT_STAGES, type Account, type Character, type Company, type GameEvent, type Interaction, type Obligation, type Offer,
  type RecurringPayment, type Shareholding, type Transaction,
} from '../domain/types.ts';
import { addMinutes, formatGameTime, newId } from './util.ts';

// ============================================================================
// Deterministic economy: money, companies, equity, promises, time-driven effects.
//
// The model only *proposes* actions (player actions from the interpreter, decisions from NPCs).
// The planner checks them against a simulated copy of current state and produces a list of
// operations + events + player-facing result lines. The commit applies the operations as-is.
//
// Two kinds of "no":
//   modelError  — the proposal itself is malformed/unknown (retry the model)
//   rejected    — a legitimate game outcome ("you don't have €30,000"), reported to the player
// ============================================================================

export const FOUNDER_SHARES = 1_000_000;

export const eur = (cents: number) =>
  `${cents < 0 ? '−' : ''}€${(Math.abs(cents) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const toCents = (amountEur: number) => Math.round(amountEur * 100);
export const pct = (shares: number, total: number) => `${((shares / total) * 100).toFixed(1)}%`;

export function addMonths(gameTime: string, months: number): string {
  const d = new Date(`${gameTime}:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 16);
}

export type PlannedOp =
  | { op: 'create_account'; account: Account }
  | { op: 'transfer'; tx: Transaction }
  | { op: 'create_company'; company: Company; holding: Shareholding }
  | { op: 'update_company'; company: Company }
  | { op: 'add_shareholding'; holding: Shareholding }
  | { op: 'create_offer'; offer: Offer }
  | { op: 'resolve_offer'; offerId: string; status: 'accepted' | 'rejected'; gameTime: string }
  | { op: 'create_obligation'; obligation: Obligation }
  | { op: 'update_obligation'; obligation: Obligation }
  | { op: 'create_recurring'; recurring: RecurringPayment }
  | { op: 'update_recurring'; recurring: RecurringPayment };

export interface PlanContext {
  store: Store;
  gameId: string;
  turnId: string;
  now: string;
  gameTime: string;
  location: string;
  player: Character;
  characters: Character[]; // everyone known this turn (incl. a character generated this turn)
  interaction: Interaction | null; // current conversation (offers/promises need a listener)
}

export class EconomyPlanner {
  readonly ops: PlannedOp[] = [];
  readonly events: GameEvent[] = [];
  readonly results: string[] = []; // deterministic lines shown to the player
  readonly rejected: { action: unknown; reason: string }[] = [];

  private ctx: PlanContext;
  private accounts = new Map<string, Account>();
  private companies = new Map<string, Company>();
  private holdings = new Map<string, Shareholding[]>();
  private offers = new Map<string, Offer>();
  private obligations = new Map<string, Obligation>();
  private recurring = new Map<string, RecurringPayment>();

  constructor(ctx: PlanContext) {
    this.ctx = ctx;
    const { store, gameId } = ctx;
    for (const a of store.listAccounts(gameId)) this.accounts.set(a.id, { ...a });
    for (const c of store.listCompanies(gameId)) {
      this.companies.set(c.id, { ...c });
      this.holdings.set(c.id, store.listShareholdings(c.id).map((h) => ({ ...h })));
    }
    for (const o of store.listObligations(gameId)) this.obligations.set(o.id, { ...o });
    for (const r of store.listRecurringPayments(gameId)) this.recurring.set(r.id, { ...r });
    for (const o of store.listOffers(gameId)) this.offers.set(o.id, { ...o });
  }

  // ---------- simulated reads (store + this turn's plan) ----------
  account(kind: Account['ownerKind'], ownerId: string): Account | undefined {
    return [...this.accounts.values()].find((a) => a.ownerKind === kind && a.ownerId === ownerId);
  }
  companyByName(name: string): Company | undefined {
    const n = name.trim().toLowerCase();
    return [...this.companies.values()].find((c) => c.name.toLowerCase() === n);
  }
  company(id: string) { return this.companies.get(id); }
  holdingsOf(companyId: string) { return this.holdings.get(companyId) ?? []; }
  offer(id: string) { return this.offers.get(id); }
  obligation(id: string) { return this.obligations.get(id); }
  allOffers() { return [...this.offers.values()]; }
  allObligations() { return [...this.obligations.values()]; }
  companiesOf(characterId: string) { return [...this.companies.values()].filter((c) => this.holdingsOf(c.id).some((h) => h.characterId === characterId)); }
  recurringFor(accountId: string) { return [...this.recurring.values()].filter((r) => r.accountId === accountId && r.active); }
  private character(name: string): Character | undefined {
    const n = name.trim().toLowerCase();
    return this.ctx.characters.find((c) => c.name.toLowerCase() === n) ?? this.ctx.characters.find((c) => c.name.toLowerCase().split(' ')[0] === n.split(' ')[0]);
  }
  private name(id: string) { return this.ctx.characters.find((c) => c.id === id)?.name ?? this.ctx.store.getCharacter(id)?.name ?? id; }
  private inConversation(id: string) { return Boolean(this.ctx.interaction?.participantIds.includes(id)); }

  // ---------- simulated writes ----------
  private ensureAccount(kind: Account['ownerKind'], ownerId: string): Account {
    const existing = this.account(kind, ownerId);
    if (existing) return existing;
    const a: Account = { id: newId('acct'), gameId: this.ctx.gameId, ownerKind: kind, ownerId, balanceCents: 0, createdAt: this.ctx.now, updatedAt: this.ctx.now };
    this.accounts.set(a.id, a);
    this.ops.push({ op: 'create_account', account: { ...a } });
    return a;
  }
  private move(from: Account | null, to: Account | null, cents: number, description: string, category: string, gameTime = this.ctx.gameTime) {
    if (from) from.balanceCents -= cents;
    if (to) to.balanceCents += cents;
    this.ops.push({
      op: 'transfer',
      tx: { id: newId('tx'), gameId: this.ctx.gameId, turnId: this.ctx.turnId, fromAccountId: from?.id ?? null, toAccountId: to?.id ?? null,
        amountCents: cents, description, category, gameTime, createdAt: this.ctx.now },
    });
  }
  private event(type: GameEvent['type'], summary: string, observerIds: string[], participants: GameEvent['participants'], importance = 2, gameTime = this.ctx.gameTime) {
    const ev: GameEvent = {
      id: newId('evt'), gameId: this.ctx.gameId, turnId: this.ctx.turnId, interactionId: null, gameTime, type, summary, transcript: [],
      importance, location: this.ctx.location, createdAt: this.ctx.now, participants,
      observers: [...new Set(observerIds)].map((id) => ({ characterId: id, channel: id === this.ctx.player.id ? 'self' as const : this.ctx.interaction?.channel ?? 'in_person' })),
    };
    this.events.push(ev);
    return ev;
  }
  private reject(action: unknown, reason: string) {
    this.rejected.push({ action, reason });
    this.results.push(`✗ ${reason}`);
  }
  private payer(companyName: string | null): { account: Account; label: string } | string {
    const player = this.ctx.player;
    if (!companyName) return { account: this.ensureAccount('character', player.id), label: 'you' };
    const c = this.companyByName(companyName);
    if (!c) return `there is no company called "${companyName}"`;
    if (!this.holdingsOf(c.id).some((h) => h.characterId === player.id)) return `you are not a shareholder of ${c.name}`;
    return { account: this.ensureAccount('company', c.id), label: c.name };
  }

  // ---------- player actions ----------
  /** Returns a model error string if the action is malformed; game rejections are recorded as results. */
  playerAction(a: PlayerAction): string | null {
    const player = this.ctx.player;
    const me = player.id;
    switch (a.action) {
      case 'pay': {
        const cents = toCents(a.amountEur);
        if (cents <= 0) return 'pay: amount must be positive';
        const p = this.payer(a.fromCompanyName);
        if (typeof p === 'string') return this.reject(a, `Can't pay ${eur(cents)}: ${p}.`), null;
        if (p.account.balanceCents < cents) return this.reject(a, `Can't pay ${eur(cents)} for ${a.description}: ${p.label === 'you' ? 'you have' : `${p.label} has`} only ${eur(p.account.balanceCents)}.`), null;
        this.move(p.account, null, cents, a.description, a.recurringMonthly ? 'recurring' : 'expense');
        if (a.recurringMonthly) {
          const r: RecurringPayment = { id: newId('rec'), gameId: this.ctx.gameId, accountId: p.account.id, description: a.description, amountCents: cents,
            nextDueGameTime: addMonths(this.ctx.gameTime, 1), active: true, createdAt: this.ctx.now };
          this.recurring.set(r.id, r);
          this.ops.push({ op: 'create_recurring', recurring: { ...r } });
        }
        this.event('money', `${p.label === 'you' ? player.name : p.label} paid ${eur(cents)} for ${a.description}${a.recurringMonthly ? ' (monthly)' : ''}.`, [me], [{ characterId: me, role: 'actor' }], 1);
        this.results.push(`✓ Paid ${eur(cents)} — ${a.description}${a.recurringMonthly ? ' (every month)' : ''} · ${p.label === 'you' ? 'your cash' : `${p.label} cash`} ${eur(p.account.balanceCents)}`);
        return null;
      }
      case 'give_money': {
        const to = this.character(a.toCharacterName);
        if (!to || to.id === me) return `give_money: unknown recipient "${a.toCharacterName}"`;
        const cents = toCents(a.amountEur);
        if (cents <= 0) return 'give_money: amount must be positive';
        const from = this.ensureAccount('character', me);
        if (from.balanceCents < cents) return this.reject(a, `Can't give ${to.name} ${eur(cents)}: you have only ${eur(from.balanceCents)}.`), null;
        this.move(from, this.ensureAccount('character', to.id), cents, a.description || `gift to ${to.name}`, 'transfer');
        this.event('money', `${player.name} gave ${to.name} ${eur(cents)} (${a.description}).`, [me, to.id], [{ characterId: me, role: 'actor' }, { characterId: to.id, role: 'addressee' }]);
        this.results.push(`✓ Sent ${eur(cents)} to ${to.name} · your cash ${eur(from.balanceCents)}`);
        return null;
      }
      case 'found_company': {
        const name = a.name.trim();
        if (name.length < 2) return 'found_company: name too short';
        if (this.companyByName(name)) return this.reject(a, `A company called ${name} already exists.`), null;
        const invest = toCents(a.initialInvestmentEur);
        const personal = this.ensureAccount('character', me);
        if (invest < 0) return 'found_company: investment cannot be negative';
        if (invest > personal.balanceCents) return this.reject(a, `Can't put ${eur(invest)} into ${name}: you have only ${eur(personal.balanceCents)}.`), null;
        const company: Company = { id: newId('co'), gameId: this.ctx.gameId, name, description: a.description, productStage: 'idea', totalShares: FOUNDER_SHARES,
          foundedGameTime: this.ctx.gameTime, createdAt: this.ctx.now, updatedAt: this.ctx.now };
        const holding: Shareholding = { companyId: company.id, characterId: me, shares: FOUNDER_SHARES, role: 'founder', acquiredGameTime: this.ctx.gameTime };
        this.companies.set(company.id, company);
        this.holdings.set(company.id, [holding]);
        this.ops.push({ op: 'create_company', company: { ...company }, holding: { ...holding } });
        const acct = this.ensureAccount('company', company.id);
        if (invest > 0) this.move(personal, acct, invest, `founder investment in ${name}`, 'investment');
        this.event('company_founded', `${player.name} founded ${name}${invest ? ` with ${eur(invest)}` : ''}.`, [me], [{ characterId: me, role: 'actor' }], 4);
        this.results.push(`✓ Founded ${name} — you own 100%${invest ? ` · company cash ${eur(acct.balanceCents)} · your cash ${eur(personal.balanceCents)}` : ''}`);
        return null;
      }
      case 'invest_in_company': {
        const c = this.companyByName(a.companyName);
        if (!c) return this.reject(a, `There is no company called "${a.companyName}".`), null;
        if (!this.holdingsOf(c.id).some((h) => h.characterId === me)) return this.reject(a, `You are not a shareholder of ${c.name}.`), null;
        const cents = toCents(a.amountEur);
        if (cents <= 0) return 'invest_in_company: amount must be positive';
        const personal = this.ensureAccount('character', me);
        if (personal.balanceCents < cents) return this.reject(a, `Can't invest ${eur(cents)}: you have only ${eur(personal.balanceCents)}.`), null;
        const acct = this.ensureAccount('company', c.id);
        this.move(personal, acct, cents, `investment in ${c.name}`, 'investment');
        this.event('money', `${player.name} put ${eur(cents)} into ${c.name}.`, [me], [{ characterId: me, role: 'actor' }]);
        this.results.push(`✓ Invested ${eur(cents)} in ${c.name} · company cash ${eur(acct.balanceCents)} · your cash ${eur(personal.balanceCents)}`);
        return null;
      }
      case 'offer_equity': {
        const to = this.character(a.toCharacterName);
        if (!to || to.id === me) return `offer_equity: unknown person "${a.toCharacterName}"`;
        const c = this.companyByName(a.companyName);
        if (!c) return this.reject(a, `There is no company called "${a.companyName}" yet — found it first.`), null;
        if (!(a.percent > 0 && a.percent < 100)) return 'offer_equity: percent must be between 0 and 100';
        if (!this.holdingsOf(c.id).some((h) => h.characterId === me)) return this.reject(a, `You are not a shareholder of ${c.name}.`), null;
        if (this.holdingsOf(c.id).some((h) => h.characterId === to.id)) return this.reject(a, `${to.name} already owns part of ${c.name}.`), null;
        if (!this.inConversation(to.id)) return this.reject(a, `You need to be talking to ${to.name} to make an offer.`), null;
        const offer: Offer = { id: newId('offer'), gameId: this.ctx.gameId, companyId: c.id, fromCharacterId: me, toCharacterId: to.id, kind: 'join_company',
          equityPercent: a.percent, role: a.role, status: 'pending', createdGameTime: this.ctx.gameTime, resolvedGameTime: null, createdAt: this.ctx.now, updatedAt: this.ctx.now };
        this.offers.set(offer.id, offer);
        this.ops.push({ op: 'create_offer', offer: { ...offer } });
        this.event('offer_made', `${player.name} offered ${to.name} ${a.percent}% of ${c.name} as ${a.role}.`, [me, to.id], [{ characterId: me, role: 'actor' }, { characterId: to.id, role: 'addressee' }], 4);
        this.results.push(`→ Offer to ${to.name}: ${a.percent}% of ${c.name} as ${a.role} (waiting for their answer)`);
        return null;
      }
      case 'make_promise': {
        const to = this.character(a.toCharacterName);
        if (!to || to.id === me) return `make_promise: unknown person "${a.toCharacterName}"`;
        if (!this.inConversation(to.id)) return this.reject(a, `You need to be talking to ${to.name} to promise them something.`), null;
        this.addObligation(me, to.id, a.description, a.amountEur, a.dueInDays, a);
        return null;
      }
      case 'fulfill_promise': {
        const o = this.obligation(a.promiseId);
        if (!o || o.debtorId !== me) return `fulfill_promise: no promise ${a.promiseId} made by the player`;
        if (o.status !== 'open') return this.reject(a, `That promise is already ${o.status}.`), null;
        if (o.amountCents) {
          const personal = this.ensureAccount('character', me);
          if (personal.balanceCents < o.amountCents) return this.reject(a, `Can't pay ${this.name(o.creditorId)} ${eur(o.amountCents)}: you have only ${eur(personal.balanceCents)}.`), null;
          this.move(personal, this.ensureAccount('character', o.creditorId), o.amountCents, `promise: ${o.description}`, 'promise');
        }
        this.resolveObligation(o);
        return null;
      }
      case 'advance_product': {
        const c = this.companyByName(a.companyName);
        if (!c) return this.reject(a, `There is no company called "${a.companyName}".`), null;
        if (!this.holdingsOf(c.id).some((h) => h.characterId === me)) return this.reject(a, `You are not part of ${c.name}.`), null;
        if (PRODUCT_STAGES.indexOf(a.stage) <= PRODUCT_STAGES.indexOf(c.productStage)) return this.reject(a, `${c.name} is already at "${c.productStage}".`), null;
        c.productStage = a.stage;
        c.updatedAt = this.ctx.now;
        this.ops.push({ op: 'update_company', company: { ...c } });
        const members = this.holdingsOf(c.id).map((h) => h.characterId);
        this.event('company_updated', `${c.name}'s product reached the ${a.stage} stage.`, members, [{ characterId: me, role: 'actor' }], 3);
        this.results.push(`✓ ${c.name}: product is now at "${a.stage}"`);
        return null;
      }
    }
  }

  // ---------- NPC decisions (validated as model output, executed deterministically) ----------
  npcRespondToOffer(npcId: string, offerId: string, accept: boolean): string | null {
    const o = this.offer(offerId);
    if (!o || o.toCharacterId !== npcId) return `respond_to_offer: no offer ${offerId} addressed to you`;
    if (o.status !== 'pending') return `respond_to_offer: offer ${offerId} is already ${o.status}`;
    const c = this.company(o.companyId)!;
    o.status = accept ? 'accepted' : 'rejected';
    this.ops.push({ op: 'resolve_offer', offerId: o.id, status: o.status, gameTime: this.ctx.gameTime });
    const npc = this.name(npcId);
    if (!accept) {
      this.event('offer_resolved', `${npc} turned down ${o.equityPercent}% of ${c.name}.`, [o.fromCharacterId, npcId], [{ characterId: npcId, role: 'actor' }], 4);
      this.results.push(`✗ ${npc} declined the offer (${o.equityPercent}% of ${c.name}).`);
      return null;
    }
    // New shares are issued so the newcomer owns exactly equityPercent after issuance (everyone else is diluted).
    const newShares = Math.round((c.totalShares * o.equityPercent) / (100 - o.equityPercent));
    const holding: Shareholding = { companyId: c.id, characterId: npcId, shares: newShares, role: o.role, acquiredGameTime: this.ctx.gameTime };
    c.totalShares += newShares;
    c.updatedAt = this.ctx.now;
    this.holdings.get(c.id)!.push(holding);
    this.ops.push({ op: 'add_shareholding', holding: { ...holding } }, { op: 'update_company', company: { ...c } });
    this.event('offer_resolved', `${npc} accepted ${o.equityPercent}% of ${c.name} and joined as ${o.role}.`, [o.fromCharacterId, npcId], [{ characterId: npcId, role: 'actor' }], 5);
    const table = this.holdingsOf(c.id).map((h) => `${this.name(h.characterId)} ${pct(h.shares, c.totalShares)}`).join(', ');
    this.results.push(`✓ ${npc} joined ${c.name} as ${o.role} · ownership: ${table}`);
    return null;
  }

  npcPromise(npcId: string, creditorId: string, description: string, amountEur: number | null, dueInDays: number | null): string | null {
    if (amountEur !== null && amountEur > 0) return 'make_promise: NPC money promises are not supported yet (promise help, work or time instead)';
    this.addObligation(npcId, creditorId, description, null, dueInDays, null);
    return null;
  }

  npcFulfill(npcId: string, promiseId: string): string | null {
    const o = this.obligation(promiseId);
    if (!o || o.debtorId !== npcId) return `fulfill_promise: no promise ${promiseId} made by you`;
    if (o.status !== 'open') return `fulfill_promise: promise ${promiseId} is already ${o.status}`;
    this.resolveObligation(o);
    return null;
  }

  private addObligation(debtorId: string, creditorId: string, description: string, amountEur: number | null, dueInDays: number | null, action: unknown) {
    const cents = amountEur && amountEur > 0 ? toCents(amountEur) : null;
    if (dueInDays !== null && (dueInDays < 0 || dueInDays > 3650)) return this.reject(action, 'A promise must be due within 10 years.');
    const o: Obligation = { id: newId('prom'), gameId: this.ctx.gameId, debtorId, creditorId, description, amountCents: cents,
      dueGameTime: dueInDays === null ? null : addMinutes(this.ctx.gameTime, Math.round(dueInDays * 1440)), status: 'open', overdueNotified: false,
      createdGameTime: this.ctx.gameTime, resolvedGameTime: null, createdAt: this.ctx.now, updatedAt: this.ctx.now };
    this.obligations.set(o.id, o);
    this.ops.push({ op: 'create_obligation', obligation: { ...o } });
    const who = this.name(debtorId);
    const what = `${description}${cents ? ` (${eur(cents)})` : ''}${o.dueGameTime ? ` by ${formatGameTime(o.dueGameTime)}` : ''}`;
    this.event('promise_made', `${who} promised ${this.name(creditorId)}: ${what}.`, [debtorId, creditorId], [{ characterId: debtorId, role: 'actor' }, { characterId: creditorId, role: 'addressee' }], 3);
    this.results.push(`✓ Promise recorded — ${who} → ${this.name(creditorId)}: ${what}`);
  }

  private resolveObligation(o: Obligation) {
    o.status = 'fulfilled';
    o.resolvedGameTime = this.ctx.gameTime;
    o.updatedAt = this.ctx.now;
    this.ops.push({ op: 'update_obligation', obligation: { ...o } });
    this.event('promise_fulfilled', `${this.name(o.debtorId)} kept the promise to ${this.name(o.creditorId)}: ${o.description}.`, [o.debtorId, o.creditorId],
      [{ characterId: o.debtorId, role: 'actor' }, { characterId: o.creditorId, role: 'addressee' }], 3);
    this.results.push(`✓ Promise kept — ${this.name(o.debtorId)} → ${this.name(o.creditorId)}: ${o.description}${o.amountCents ? ` (${eur(o.amountCents)} paid)` : ''}`);
  }

  // ---------- time ----------
  /** Deterministic effects of the clock moving from `from` to `to`: recurring charges, overdue promises. */
  passTime(from: string, to: string) {
    if (to <= from) return;
    for (const r of [...this.recurring.values()].filter((x) => x.active)) {
      let guard = 0;
      while (r.nextDueGameTime <= to && guard++ < 24) {
        const acct = this.accounts.get(r.accountId)!;
        const owner = acct.ownerKind === 'company' ? this.company(acct.ownerId)?.name ?? 'company' : 'you';
        if (acct.balanceCents >= r.amountCents) {
          this.move(acct, null, r.amountCents, `${r.description} (monthly)`, 'recurring', r.nextDueGameTime);
          this.results.push(`⏰ ${formatGameTime(r.nextDueGameTime)}: ${r.description} ${eur(r.amountCents)} charged to ${owner} · balance ${eur(acct.balanceCents)}`);
        } else {
          r.active = false;
          this.results.push(`⚠ ${formatGameTime(r.nextDueGameTime)}: ${r.description} (${eur(r.amountCents)}) could not be paid — ${owner} has ${eur(acct.balanceCents)}. The service is cancelled.`);
          this.event('money', `A payment of ${eur(r.amountCents)} for ${r.description} failed; the service was cancelled.`, [this.ctx.player.id], [{ characterId: this.ctx.player.id, role: 'actor' }], 3, r.nextDueGameTime);
          break;
        }
        r.nextDueGameTime = addMonths(r.nextDueGameTime, 1);
      }
      this.ops.push({ op: 'update_recurring', recurring: { ...r } });
    }
    for (const o of this.obligations.values()) {
      if (o.status !== 'open' || !o.dueGameTime || o.overdueNotified || o.dueGameTime > to) continue;
      o.overdueNotified = true;
      o.updatedAt = this.ctx.now;
      this.ops.push({ op: 'update_obligation', obligation: { ...o } });
      const who = this.name(o.debtorId);
      this.event('promise_overdue', `${who}'s promise to ${this.name(o.creditorId)} is overdue: ${o.description}.`, [o.debtorId, o.creditorId],
        [{ characterId: o.debtorId, role: 'actor' }, { characterId: o.creditorId, role: 'addressee' }], 4, o.dueGameTime);
      this.results.push(`⚠ Overdue since ${formatGameTime(o.dueGameTime)}: ${who} → ${this.name(o.creditorId)}: ${o.description}`);
    }
  }
}

/** Applies planned operations inside the caller's transaction. Returns write records. */
export function applyOps(store: Store, ops: PlannedOp[], now: string): { table: string; op: string; id: string; note?: string }[] {
  const writes: { table: string; op: string; id: string; note?: string }[] = [];
  for (const o of ops) {
    switch (o.op) {
      case 'create_account': store.insertAccount(o.account); writes.push({ table: 'accounts', op: 'insert', id: o.account.id, note: `${o.account.ownerKind} ${o.account.ownerId}` }); break;
      case 'transfer': store.transfer(o.tx); writes.push({ table: 'transactions', op: 'insert', id: o.tx.id, note: `${eur(o.tx.amountCents)} ${o.tx.description}` }); break;
      case 'create_company': store.insertCompany(o.company); store.insertShareholding(o.holding); writes.push({ table: 'companies', op: 'insert', id: o.company.id, note: o.company.name }); break;
      case 'update_company': store.updateCompany(o.company); writes.push({ table: 'companies', op: 'update', id: o.company.id, note: `${o.company.productStage}, ${o.company.totalShares} shares` }); break;
      case 'add_shareholding': store.insertShareholding(o.holding); writes.push({ table: 'shareholdings', op: 'insert', id: `${o.holding.companyId}/${o.holding.characterId}`, note: `${o.holding.shares} shares` }); break;
      case 'create_offer': store.insertOffer(o.offer); writes.push({ table: 'offers', op: 'insert', id: o.offer.id }); break;
      case 'resolve_offer': store.resolveOffer(o.offerId, o.status, o.gameTime, now); writes.push({ table: 'offers', op: 'update', id: o.offerId, note: o.status }); break;
      case 'create_obligation': store.insertObligation(o.obligation); writes.push({ table: 'obligations', op: 'insert', id: o.obligation.id }); break;
      case 'update_obligation': store.updateObligation(o.obligation); writes.push({ table: 'obligations', op: 'update', id: o.obligation.id, note: o.obligation.status }); break;
      case 'create_recurring': store.insertRecurringPayment(o.recurring); writes.push({ table: 'recurring_payments', op: 'insert', id: o.recurring.id }); break;
      case 'update_recurring': store.updateRecurringPayment(o.recurring); writes.push({ table: 'recurring_payments', op: 'update', id: o.recurring.id }); break;
    }
  }
  return writes;
}

// ---------------------------------------------------------------------------
// Perspective views (text) for prompts. Only what this character is party to.
// ---------------------------------------------------------------------------

function companyLines(p: EconomyPlanner, c: Company, name: (id: string) => string): string[] {
  const acct = p.account('company', c.id);
  const table = p.holdingsOf(c.id).map((h) => `${name(h.characterId)} ${pct(h.shares, c.totalShares)} (${h.role})`).join(', ');
  const recurring = acct ? p.recurringFor(acct.id).map((r) => `${r.description} ${eur(r.amountCents)}/month`).join('; ') : '';
  return [`${c.name} — ${c.description}`, `  stage: ${c.productStage} · company cash: ${eur(acct?.balanceCents ?? 0)} · owners: ${table}${recurring ? ` · monthly costs: ${recurring}` : ''}`];
}

function obligationLine(o: Obligation, gameTime: string, name: (id: string) => string): string {
  const overdue = o.status === 'open' && o.dueGameTime && o.dueGameTime <= gameTime;
  const due = o.dueGameTime ? ` · due ${formatGameTime(o.dueGameTime)}` : '';
  return `[${o.id}] ${name(o.debtorId)} → ${name(o.creditorId)}: ${o.description}${o.amountCents ? ` (${eur(o.amountCents)})` : ''}${due} · ${overdue ? 'OVERDUE' : o.status}`;
}

export function npcEconomyBriefing(p: EconomyPlanner, npcId: string, gameTime: string, name: (id: string) => string): { text: string; ids: string[] } {
  const ids: string[] = [];
  const lines: string[] = [];
  for (const c of p.companiesOf(npcId)) { ids.push(c.id); lines.push(...companyLines(p, c, name)); }
  const offers = p.allOffers().filter((o) => o.toCharacterId === npcId || o.fromCharacterId === npcId);
  for (const o of offers) {
    ids.push(o.id);
    const c = p.company(o.companyId)!;
    if (o.status === 'pending' && o.toCharacterId === npcId) {
      lines.push(`PENDING OFFER [${o.id}] from ${name(o.fromCharacterId)}: ${o.equityPercent}% of ${c.name} as ${o.role}. About the company:`, ...companyLines(p, c, name).map((l) => `  ${l}`),
        '  Decide with respond_to_offer only if you have actually made up your mind; otherwise keep talking.');
    } else {
      lines.push(`Offer ${name(o.fromCharacterId)} → ${name(o.toCharacterId)}: ${o.equityPercent}% of ${c.name} — ${o.status}`);
    }
  }
  for (const o of p.allObligations().filter((x) => x.debtorId === npcId || x.creditorId === npcId)) { ids.push(o.id); lines.push(obligationLine(o, gameTime, name)); }
  return { text: lines.join('\n') || '(none)', ids };
}

export function playerEconomyBriefing(p: EconomyPlanner, playerId: string, gameTime: string, name: (id: string) => string): string {
  const cash = p.account('character', playerId)?.balanceCents ?? 0;
  const lines = [`Personal cash: ${eur(cash)}`];
  const personal = p.account('character', playerId);
  if (personal) for (const r of p.recurringFor(personal.id)) lines.push(`Personal monthly cost: ${r.description} ${eur(r.amountCents)}`);
  for (const c of p.companiesOf(playerId)) lines.push(...companyLines(p, c, name));
  for (const o of p.allOffers().filter((x) => x.fromCharacterId === playerId && x.status === 'pending')) {
    lines.push(`Pending offer to ${name(o.toCharacterId)}: ${o.equityPercent}% of ${p.company(o.companyId)!.name}`);
  }
  for (const o of p.allObligations().filter((x) => x.status === 'open' && (x.debtorId === playerId || x.creditorId === playerId))) lines.push(obligationLine(o, gameTime, name));
  return lines.join('\n');
}
