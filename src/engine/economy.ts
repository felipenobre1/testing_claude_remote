import type { Store } from '../db/store.ts';
import type { DecisionState, PlayerAction } from '../domain/schemas.ts';
import {
  PRODUCT_STAGES, type Account, type Character, type Company, type GameEvent, type Interaction, type Obligation, type Offer,
  type DecisionRecord, type OfferTerms, type RecurringPayment, type Shareholding, type Transaction,
} from '../domain/types.ts';
import { MAX_ATTEMPTS, reconsiderAfterMinutes, type Resolution } from './decision.ts';
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
  | { op: 'update_offer'; offer: Offer }
  | { op: 'insert_decision'; decision: DecisionRecord }
  | { op: 'upsert_decision_state'; gameId: string; characterId: string; domain: string; state: DecisionState }
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
  recurringFor(accountId: string) { return [...this.recurring.values()].filter((r) => r.fromAccountId === accountId && r.active); }
  incomeFor(accountId: string) { return [...this.recurring.values()].filter((r) => r.toAccountId === accountId && r.active); }
  describeOffer(o: Offer): string { return describeOffer(o, o.companyId ? this.company(o.companyId)?.name ?? 'the company' : 'the company'); }
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
          this.addRecurring(p.account, null, a.description, cents);
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
      case 'make_offer': {
        const to = this.character(a.toCharacterName);
        if (!to || to.id === me) return `make_offer: unknown person "${a.toCharacterName}"`;
        const c = this.companyByName(a.companyName);
        if (!c) return this.reject(a, `There is no company called "${a.companyName}" yet — found it first.`), null;
        if (!this.holdingsOf(c.id).some((h) => h.characterId === me)) return this.reject(a, `You are not a shareholder of ${c.name}.`), null;
        if (!this.inConversation(to.id)) return this.reject(a, `You need to be talking to ${to.name} to make an offer.`), null;
        const terms: OfferTerms = {
          equityPercent: a.equityPercent, role: a.role,
          salaryMonthlyCents: a.salaryMonthlyEur ? toCents(a.salaryMonthlyEur) : null,
          priceMonthlyCents: a.priceMonthlyEur ? toCents(a.priceMonthlyEur) : null,
          amountCents: a.amountEur ? toCents(a.amountEur) : null,
        };
        const bad = checkTerms(a.kind, terms);
        if (bad) return `make_offer: ${bad}`;
        if ((a.kind === 'join_company' || a.kind === 'investment') && this.holdingsOf(c.id).some((h) => h.characterId === to.id)) {
          return this.reject(a, `${to.name} already owns part of ${c.name}.`), null;
        }
        if (this.allOffers().some((o) => o.status === 'pending' && o.toCharacterId === to.id && o.kind === a.kind && o.companyId === c.id)) {
          return this.reject(a, `${to.name} still owes you an answer on your previous offer.`), null;
        }
        const offer: Offer = {
          id: newId('offer'), gameId: this.ctx.gameId, companyId: c.id, fromCharacterId: me, toCharacterId: to.id, kind: a.kind, terms,
          description: a.description, status: 'pending', parentOfferId: null, attempts: 0, lastOutcome: null, nextDecisionAfter: null,
          createdGameTime: this.ctx.gameTime, resolvedGameTime: null, createdAt: this.ctx.now, updatedAt: this.ctx.now,
        };
        this.offers.set(offer.id, offer);
        this.ops.push({ op: 'create_offer', offer: { ...offer } });
        this.event('offer_made', `${player.name} offered ${to.name}: ${this.describeOffer(offer)}.`, [me, to.id], [{ characterId: me, role: 'actor' }, { characterId: to.id, role: 'addressee' }], 4);
        this.results.push(`→ Offer to ${to.name}: ${this.describeOffer(offer)}`);
        return null;
      }
      case 'respond_to_offer': {
        const o = this.offer(a.offerId);
        if (!o || o.toCharacterId !== me) return `respond_to_offer: no offer ${a.offerId} made to the player`;
        if (o.status !== 'pending') return this.reject(a, `That offer is already ${o.status}.`), null;
        if (!this.inConversation(o.fromCharacterId)) return this.reject(a, `You need to be talking to ${this.name(o.fromCharacterId)} to answer their offer.`), null;
        this.closeOffer(o, a.accept ? 'accepted' : 'rejected');
        if (a.accept) this.execute(o);
        else this.results.push(`✗ You turned down ${this.name(o.fromCharacterId)}'s offer (${this.describeOffer(o)}).`);
        this.event('offer_resolved', `${player.name} ${a.accept ? 'accepted' : 'turned down'} ${this.name(o.fromCharacterId)}'s offer: ${this.describeOffer(o)}.`,
          [me, o.fromCharacterId], [{ characterId: me, role: 'actor' }], 4);
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

  // ---------- engine-resolved NPC decisions ----------
  /** Offers waiting on this NPC that they may (re)consider now. */
  decidableOffersFor(npcId: string): Offer[] {
    return this.allOffers().filter((o) => o.toCharacterId === npcId && o.status === 'pending' && o.fromCharacterId === this.ctx.player.id
      && (!o.nextDecisionAfter || o.nextDecisionAfter <= this.ctx.gameTime));
  }

  saveDecisionState(characterId: string, domain: string, state: DecisionState) {
    this.ops.push({ op: 'upsert_decision_state', gameId: this.ctx.gameId, characterId, domain, state });
  }

  /**
   * Applies an engine-resolved outcome. The NPC's portrayal supplies wording only
   * (counter terms and conditions, already validated against the hard constraints).
   */
  applyDecision(offer: Offer, r: Resolution, extra: { counter: OfferTerms | null; condition: string | null; counterNote: string }) {
    const o = this.offer(offer.id)!;
    const npcId = o.toCharacterId;
    const npc = this.name(npcId);
    o.attempts += 1;
    o.lastOutcome = r.outcome;
    o.updatedAt = this.ctx.now;
    const what = this.describeOffer(o);
    const decision: DecisionRecord = {
      id: newId('dec'), gameId: this.ctx.gameId, turnId: this.ctx.turnId, offerId: o.id, characterId: npcId, outcome: r.outcome,
      finalScore: r.finalScore, roll: r.roll, seed: r.seed, reasons: r.reasons, detail: r, gameTime: this.ctx.gameTime, createdAt: this.ctx.now,
    };
    this.ops.push({ op: 'insert_decision', decision });

    switch (r.outcome) {
      case 'accept':
      case 'accept_conditionally':
        this.closeOffer(o, 'accepted');
        this.execute(o);
        if (r.outcome === 'accept_conditionally' && extra.condition) this.addObligation(this.ctx.player.id, npcId, `Condition for ${npc}: ${extra.condition}`, null, null, null);
        break;
      case 'counter': {
        this.closeOffer(o, 'countered');
        const counter: Offer = {
          ...o, id: newId('offer'), fromCharacterId: npcId, toCharacterId: o.fromCharacterId, terms: extra.counter!, description: extra.counterNote || `counter-offer to: ${o.description}`,
          status: 'pending', parentOfferId: o.id, attempts: 0, lastOutcome: null, nextDecisionAfter: null, createdGameTime: this.ctx.gameTime,
          resolvedGameTime: null, createdAt: this.ctx.now, updatedAt: this.ctx.now,
        };
        this.offers.set(counter.id, counter);
        this.ops.push({ op: 'create_offer', offer: { ...counter } });
        this.results.push(`↩ ${npc} counter-offers: ${this.describeOffer(counter)} [${counter.id}]`);
        break;
      }
      case 'reject':
      case 'disengage':
        this.closeOffer(o, 'rejected');
        this.results.push(r.outcome === 'reject' ? `✗ ${npc} said no to: ${what}` : `✗ ${npc} isn't interested and has stepped away from: ${what}`);
        break;
      default: {
        const wait = reconsiderAfterMinutes(r.outcome);
        o.nextDecisionAfter = wait === null ? null : addMinutes(this.ctx.gameTime, wait);
        if (o.attempts >= MAX_ATTEMPTS) {
          this.closeOffer(o, 'rejected');
          this.results.push(`✗ ${npc} has stopped considering: ${what}`);
        } else {
          this.ops.push({ op: 'update_offer', offer: { ...o } });
          this.results.push(r.outcome === 'request_more_information' ? `… ${npc} wants to know more before deciding.`
            : r.outcome === 'escalate_to_decision_maker' ? `… ${npc} can't decide alone and will take it to someone else.`
            : `… No decision yet from ${npc}.`);
        }
      }
    }
    this.event('decision', `${npc} responded to ${this.name(o.fromCharacterId)}'s offer (${what}): ${r.outcome.replace(/_/g, ' ')}.`,
      [o.fromCharacterId, npcId], [{ characterId: npcId, role: 'actor' }], 4);
  }

  private closeOffer(o: Offer, status: Offer['status']) {
    o.status = status;
    o.resolvedGameTime = this.ctx.gameTime;
    o.updatedAt = this.ctx.now;
    this.ops.push({ op: 'update_offer', offer: { ...o } });
  }

  /** Executes an accepted deal. Direction doesn't matter: the non-player side is the counterparty. */
  private execute(o: Offer) {
    const me = this.ctx.player.id;
    const otherId = o.fromCharacterId === me ? o.toCharacterId : o.fromCharacterId;
    const other = this.name(otherId);
    const c = this.company(o.companyId!)!;
    const companyAcct = this.ensureAccount('company', c.id);
    const t = o.terms;
    const issue = (percent: number, role: string) => {
      const newShares = Math.round((c.totalShares * percent) / (100 - percent));
      const holding: Shareholding = { companyId: c.id, characterId: otherId, shares: newShares, role, acquiredGameTime: this.ctx.gameTime };
      c.totalShares += newShares;
      c.updatedAt = this.ctx.now;
      this.holdings.get(c.id)!.push(holding);
      this.ops.push({ op: 'add_shareholding', holding: { ...holding } }, { op: 'update_company', company: { ...c } });
    };
    const table = () => this.holdingsOf(c.id).map((h) => `${this.name(h.characterId)} ${pct(h.shares, c.totalShares)}`).join(', ');
    switch (o.kind) {
      case 'join_company':
        issue(t.equityPercent!, t.role ?? 'cofounder');
        if (t.salaryMonthlyCents) this.addRecurring(companyAcct, this.ensureAccount('character', otherId), `${other}'s salary`, t.salaryMonthlyCents);
        this.results.push(`✓ ${other} joined ${c.name} as ${t.role ?? 'cofounder'} · ownership: ${table()}`);
        break;
      case 'hire':
        this.addRecurring(companyAcct, this.ensureAccount('character', otherId), `${other}'s salary (${t.role ?? 'employee'})`, t.salaryMonthlyCents!);
        this.results.push(`✓ ${other} works for ${c.name} as ${t.role ?? 'employee'} · ${eur(t.salaryMonthlyCents!)}/month from the company`);
        break;
      case 'purchase':
        this.move(null, companyAcct, t.priceMonthlyCents!, `${other}: first month`, 'revenue');
        this.addRecurring(null, companyAcct, `${other} subscription`, t.priceMonthlyCents!);
        this.results.push(`✓ ${other} is now a paying customer of ${c.name} · ${eur(t.priceMonthlyCents!)}/month · company cash ${eur(companyAcct.balanceCents)}`);
        break;
      case 'investment':
        this.move(null, companyAcct, t.amountCents!, `investment from ${other}`, 'investment');
        issue(t.equityPercent!, 'investor');
        this.results.push(`✓ ${other} invested ${eur(t.amountCents!)} in ${c.name} · ownership: ${table()} · company cash ${eur(companyAcct.balanceCents)}`);
        break;
    }
  }

  private addRecurring(from: Account | null, to: Account | null, description: string, cents: number) {
    const r: RecurringPayment = {
      id: newId('rec'), gameId: this.ctx.gameId, fromAccountId: from?.id ?? null, toAccountId: to?.id ?? null, description, amountCents: cents,
      nextDueGameTime: addMonths(this.ctx.gameTime, 1), active: true, createdAt: this.ctx.now,
    };
    this.recurring.set(r.id, r);
    this.ops.push({ op: 'create_recurring', recurring: { ...r } });
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
        const acct = r.fromAccountId ? this.accounts.get(r.fromAccountId)! : null;
        const to = r.toAccountId ? this.accounts.get(r.toAccountId)! : null;
        const ownerOf = (a: Account) => (a.ownerKind === 'company' ? this.company(a.ownerId)?.name ?? 'company' : a.ownerId === this.ctx.player.id ? 'you' : this.name(a.ownerId));
        if (!acct) {
          this.move(null, to, r.amountCents, `${r.description} (monthly)`, 'revenue', r.nextDueGameTime);
          this.results.push(`⏰ ${formatGameTime(r.nextDueGameTime)}: ${r.description} ${eur(r.amountCents)} received by ${ownerOf(to!)} · balance ${eur(to!.balanceCents)}`);
          r.nextDueGameTime = addMonths(r.nextDueGameTime, 1);
          continue;
        }
        const owner = ownerOf(acct);
        if (acct.balanceCents >= r.amountCents) {
          this.move(acct, to, r.amountCents, `${r.description} (monthly)`, 'recurring', r.nextDueGameTime);
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
      case 'update_offer': store.updateOffer(o.offer); writes.push({ table: 'offers', op: 'update', id: o.offer.id, note: `${o.offer.status}${o.offer.lastOutcome ? ` (${o.offer.lastOutcome})` : ''}` }); break;
      case 'insert_decision': store.insertDecision(o.decision); writes.push({ table: 'decisions', op: 'insert', id: o.decision.id, note: o.decision.outcome }); break;
      case 'upsert_decision_state': store.upsertDecisionState(o.gameId, o.characterId, o.domain, o.state, 'generated', now); writes.push({ table: 'decision_states', op: 'upsert', id: `${o.characterId}/${o.domain}` }); break;
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
  const income = acct ? p.incomeFor(acct.id).map((r) => `${r.description} ${eur(r.amountCents)}/month`).join('; ') : '';
  return [`${c.name} — ${c.description}`, `  stage: ${c.productStage} · company cash: ${eur(acct?.balanceCents ?? 0)} · owners: ${table}${recurring ? ` · monthly costs: ${recurring}` : ''}${income ? ` · monthly revenue: ${income}` : ''}`];
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
    const c = o.companyId ? p.company(o.companyId) : undefined;
    if (o.status === 'pending' && o.toCharacterId === npcId) {
      lines.push(`OFFER TO YOU [${o.id}] from ${name(o.fromCharacterId)}: ${p.describeOffer(o)} — "${o.description}"${o.lastOutcome ? ` (your last answer: ${o.lastOutcome.replace(/_/g, ' ')})` : ''}`);
      if (c) lines.push('  About the company (as presented to you):', ...companyLines(p, c, name).map((l) => `  ${l}`));
    } else {
      lines.push(`Offer ${name(o.fromCharacterId)} → ${name(o.toCharacterId)} [${o.id}]: ${p.describeOffer(o)} — ${o.status}`);
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
    lines.push(`Your pending offer to ${name(o.toCharacterId)}: ${p.describeOffer(o)}`);
  }
  for (const o of p.allOffers().filter((x) => x.toCharacterId === playerId && x.status === 'pending')) {
    lines.push(`[${o.id}] Counter-offer from ${name(o.fromCharacterId)}: ${p.describeOffer(o)} — "${o.description}" (answer with respond_to_offer)`);
  }
  for (const o of p.allObligations().filter((x) => x.status === 'open' && (x.debtorId === playerId || x.creditorId === playerId))) lines.push(obligationLine(o, gameTime, name));
  return lines.join('\n');
}

export function describeOffer(o: Offer, companyName: string): string {
  const t = o.terms;
  switch (o.kind) {
    case 'join_company': return `${t.equityPercent}% of ${companyName} as ${t.role ?? 'cofounder'}${t.salaryMonthlyCents ? ` + ${eur(t.salaryMonthlyCents)}/month` : ', no salary'}`;
    case 'hire': return `job at ${companyName}${t.role ? ` as ${t.role}` : ''} for ${eur(t.salaryMonthlyCents ?? 0)}/month`;
    case 'purchase': return `${companyName} subscription at ${eur(t.priceMonthlyCents ?? 0)}/month`;
    case 'investment': return `${eur(t.amountCents ?? 0)} for ${t.equityPercent}% of ${companyName}`;
  }
}

/** Required terms per kind of offer. */
export function checkTerms(kind: Offer['kind'], t: OfferTerms): string | null {
  const pctOk = (x: number | null) => x !== null && x > 0 && x < 100;
  switch (kind) {
    case 'join_company': return pctOk(t.equityPercent) ? null : 'join_company needs equityPercent between 0 and 100';
    case 'hire': return t.salaryMonthlyCents && t.salaryMonthlyCents > 0 ? null : 'hire needs a monthly salary';
    case 'purchase': return t.priceMonthlyCents && t.priceMonthlyCents > 0 ? null : 'purchase needs a monthly price';
    case 'investment': return t.amountCents && t.amountCents > 0 && pctOk(t.equityPercent) ? null : 'investment needs an amount and an equity percentage';
  }
}
