import { priceKey, type PriceEntry, type Store } from '../db/store.ts';
import type { DecisionState, PlayerAction } from '../domain/schemas.ts';
import type {
  Account, Character, DecisionRecord, GameEvent, Interaction, Knowledge, Obligation, Offer, RecurringPayment, ScheduledItem, StoryThread, Transaction,
} from '../domain/types.ts';
import type { GamePack, PackTurnState } from '../packs/types.ts';
import { MAX_ATTEMPTS, reconsiderAfterMinutes, type Resolution } from './decision.ts';
import { seededRng, type RngFactory } from './random.ts';
import { addMinutes, formatGameTime, newId } from './util.ts';

// ============================================================================
// World planner (generic): resources, offers, promises, decisions, threads and schedule
// for ONE turn, simulated on a copy of canonical state.
//
// The model only proposes (player actions from the interpreter, portrayals from NPCs,
// developments from the Story Director). The planner checks proposals against simulated state
// and produces operations + events + deterministic result lines; the commit applies the
// operations as-is. Pack-specific state (e.g. companies) lives in the pack's turn state.
//
// Two kinds of "no":
//   model error — the proposal itself is malformed or references unknown things
//   rejected    — a legitimate outcome in the world ("you don't have €30,000"), reported to the player
// ============================================================================

export function addMonths(gameTime: string, months: number): string {
  const d = new Date(`${gameTime}:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 16);
}

export function formatMoney(cents: number, symbol: string): string {
  const abs = (Math.abs(cents) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${cents < 0 ? '−' : ''}${symbol}${abs}`;
}

export type PlannedOp =
  | { op: 'create_account'; account: Account }
  | { op: 'transfer'; tx: Transaction }
  | { op: 'create_offer'; offer: Offer }
  | { op: 'update_offer'; offer: Offer }
  | { op: 'insert_decision'; decision: DecisionRecord }
  | { op: 'upsert_decision_state'; gameId: string; characterId: string; domain: string; state: DecisionState }
  | { op: 'create_obligation'; obligation: Obligation }
  | { op: 'update_obligation'; obligation: Obligation }
  | { op: 'create_recurring'; recurring: RecurringPayment }
  | { op: 'update_recurring'; recurring: RecurringPayment }
  | { op: 'create_thread'; thread: StoryThread }
  | { op: 'update_thread'; thread: StoryThread }
  | { op: 'link_thread_event'; threadId: string; eventId: string }
  | { op: 'schedule'; item: ScheduledItem }
  | { op: 'schedule_done'; id: string }
  | { op: 'upsert_price'; gameId: string; item: string; priceCents: number; gameTime: string }
  | { op: 'upsert_knowledge'; knowledge: Knowledge }
  | { op: 'set_character_status'; characterId: string; status: 'alive' | 'dead' | 'missing' };

export interface PlanContext {
  store: Store;
  pack: GamePack;
  gameId: string;
  turnId: string;
  now: string;
  gameTime: string;
  location: string;
  player: Character;
  characters: Character[]; // everyone known this turn (incl. a character generated this turn)
  interaction: Interaction | null; // current conversation (offers/promises need a listener)
  /** Seeded randomness for mechanics (same request ⇒ same result). Defaults to seeds from the turn id. */
  rng?: RngFactory;
  seedBase?: string;
  /** Labels the player used for someone this turn ("an older student") → who that turned out to be. */
  aliases?: Record<string, string>;
}

/** "the older student", "um estudante mais velho" → "older student" / "estudante mais velho": labels compare without articles. */
const bareLabel = (s: string) => s.trim().toLowerCase().replace(/^(the|a|an|o|a|os|as|um|uma|uns|umas)\s+/, '');

/** A paid price may differ from the known one (sales, a fancier place) but not wildly. */
export const PRICE_TOLERANCE = 3;

export class WorldPlanner {
  readonly ops: PlannedOp[] = [];
  readonly events: GameEvent[] = [];
  readonly results: string[] = []; // deterministic lines shown to the player
  readonly rejected: { action: unknown; reason: string }[] = [];
  /** Outcomes this turn that people present witnessed (fights, feats) — the NPC's portrayal must be consistent with them. */
  readonly witnessed: string[] = [];
  readonly ctx: PlanContext;
  readonly packState: PackTurnState;

  private accounts = new Map<string, Account>();
  private offers = new Map<string, Offer>();
  private obligations = new Map<string, Obligation>();
  private recurring = new Map<string, RecurringPayment>();
  private threads = new Map<string, StoryThread>();
  private decisionStates = new Map<string, DecisionState>();
  private prices = new Map<string, PriceEntry>();

  constructor(ctx: PlanContext) {
    this.ctx = ctx;
    const { store, gameId } = ctx;
    for (const a of store.listAccounts(gameId)) this.accounts.set(a.id, { ...a });
    for (const o of store.listObligations(gameId)) this.obligations.set(o.id, { ...o });
    for (const r of store.listRecurringPayments(gameId)) this.recurring.set(r.id, { ...r });
    for (const o of store.listOffers(gameId)) this.offers.set(o.id, { ...o });
    for (const t of store.listThreads(gameId)) this.threads.set(t.id, { ...t, participantIds: [...t.participantIds], resolution: structuredClone(t.resolution) });
    for (const p of store.listPrices(gameId)) this.prices.set(p.key, p);
    this.packState = ctx.pack.createTurnState(store, gameId);
  }

  /** A seeded roll in [0, 1) for a named mechanic this turn. */
  random(label: string): number {
    return (this.ctx.rng ?? seededRng)(`${this.ctx.seedBase ?? this.ctx.turnId}:${label}`)();
  }
  knownPrices(): PriceEntry[] { return [...this.prices.values()]; }

  // ---------- reads (store + this turn's plan) ----------
  money(cents: number) { return formatMoney(cents, this.ctx.pack.currency.symbol); }
  account(kind: Account['ownerKind'], ownerId: string): Account | undefined {
    return [...this.accounts.values()].find((a) => a.ownerKind === kind && a.ownerId === ownerId);
  }
  offer(id: string) { return this.offers.get(id); }
  obligation(id: string) { return this.obligations.get(id); }
  thread(id: string) { return this.threads.get(id); }
  allOffers() { return [...this.offers.values()]; }
  allObligations() { return [...this.obligations.values()]; }
  allThreads() { return [...this.threads.values()]; }
  outgoing(accountId: string) { return [...this.recurring.values()].filter((r) => r.fromAccountId === accountId && r.active); }
  incoming(accountId: string) { return [...this.recurring.values()].filter((r) => r.toAccountId === accountId && r.active); }
  offerKind(kind: string) { return this.ctx.pack.offerKinds.find((k) => k.kind === kind); }
  describeOffer(o: Offer): string { return this.offerKind(o.kind)?.describe(this, o) ?? `${o.kind}: ${o.description}`; }
  findCharacter(name: string): Character | undefined {
    const n = name.trim().toLowerCase();
    const aliased = Object.entries(this.ctx.aliases ?? {}).find(([label]) => bareLabel(label) === bareLabel(name))?.[1];
    return this.ctx.characters.find((c) => c.name.toLowerCase() === n) ?? (aliased ? this.ctx.characters.find((c) => c.id === aliased) : undefined)
      ?? this.ctx.characters.find((c) => c.name.toLowerCase().split(' ')[0] === n.split(' ')[0]);
  }
  name(id: string) { return this.ctx.characters.find((c) => c.id === id)?.name ?? this.ctx.store.getCharacter(id)?.name ?? id; }
  inConversation(id: string) { return Boolean(this.ctx.interaction?.participantIds.includes(id)); }
  decisionState(characterId: string, domain: string): DecisionState | undefined {
    return this.decisionStates.get(`${characterId}/${domain}`) ?? this.ctx.store.getDecisionState(characterId, domain);
  }

  // ---------- writes (simulated now, applied at commit) ----------
  ensureAccount(kind: Account['ownerKind'], ownerId: string): Account {
    const existing = this.account(kind, ownerId);
    if (existing) return existing;
    const a: Account = { id: newId('acct'), gameId: this.ctx.gameId, ownerKind: kind, ownerId, balanceCents: 0, createdAt: this.ctx.now, updatedAt: this.ctx.now };
    this.accounts.set(a.id, a);
    this.ops.push({ op: 'create_account', account: { ...a } });
    return a;
  }
  move(from: Account | null, to: Account | null, cents: number, description: string, category: string, gameTime = this.ctx.gameTime) {
    if (from) from.balanceCents -= cents;
    if (to) to.balanceCents += cents;
    this.ops.push({
      op: 'transfer',
      tx: { id: newId('tx'), gameId: this.ctx.gameId, turnId: this.ctx.turnId, fromAccountId: from?.id ?? null, toAccountId: to?.id ?? null,
        amountCents: cents, description, category, gameTime, createdAt: this.ctx.now },
    });
  }
  /**
   * Money between two characters. Someone other than the player whose purse is not simulated (no account, or
   * not enough in it) pays from their own untracked means. The player can never spend money they don't have:
   * returns false (and reports it) if the player cannot afford it.
   */
  payBetween(fromId: string, toId: string, cents: number, description: string, category: string): boolean {
    if (cents <= 0) return true;
    const me = this.ctx.player.id;
    const from = fromId === me ? this.ensureAccount('character', me) : this.account('character', fromId);
    if (fromId === me && from!.balanceCents < cents) {
      this.results.push(`✗ You can't pay ${this.money(cents)} for ${description}: you have ${this.money(from!.balanceCents)}.`);
      return false;
    }
    const payer = from && from.balanceCents >= cents ? from : null;
    this.move(payer, this.ensureAccount('character', toId), cents, description, category);
    return true;
  }
  event(type: GameEvent['type'], summary: string, observerIds: string[], participants: GameEvent['participants'], importance = 2, gameTime = this.ctx.gameTime,
    transcript: GameEvent['transcript'] = [], channel?: GameEvent['observers'][number]['channel']) {
    const ev: GameEvent = {
      id: newId('evt'), gameId: this.ctx.gameId, turnId: this.ctx.turnId, interactionId: null, gameTime, type, summary, transcript,
      importance, location: this.ctx.location, createdAt: this.ctx.now, participants,
      observers: [...new Set(observerIds)].map((id) => ({
        characterId: id, channel: channel ?? (id === this.ctx.player.id ? 'self' as const : this.ctx.interaction?.channel ?? 'in_person'),
      })),
    };
    this.events.push(ev);
    return ev;
  }
  reject(action: unknown, reason: string) {
    this.rejected.push({ action, reason });
    this.results.push(`✗ ${reason}`);
  }
  addRecurring(from: Account | null, to: Account | null, description: string, cents: number) {
    const r: RecurringPayment = {
      id: newId('rec'), gameId: this.ctx.gameId, fromAccountId: from?.id ?? null, toAccountId: to?.id ?? null, description, amountCents: cents,
      nextDueGameTime: addMonths(this.ctx.gameTime, 1), active: true, createdAt: this.ctx.now,
    };
    this.recurring.set(r.id, r);
    this.ops.push({ op: 'create_recurring', recurring: { ...r } });
  }
  /** Creates, updates or stops (cents ≤ 0) the monthly flow with this description between these accounts. */
  setRecurring(from: Account | null, to: Account | null, description: string, cents: number) {
    const r = [...this.recurring.values()].find((x) => x.active && x.fromAccountId === (from?.id ?? null) && x.toAccountId === (to?.id ?? null) && x.description === description);
    if (!r) { if (cents > 0) this.addRecurring(from, to, description, cents); return; }
    if (cents > 0 && r.amountCents === cents) return;
    if (cents > 0) r.amountCents = cents; else r.active = false;
    this.ops.push({ op: 'update_recurring', recurring: { ...r } });
  }
  /** A character dies (or goes missing). Applied at commit; they can no longer be talked to. */
  setCharacterStatus(characterId: string, status: 'alive' | 'dead' | 'missing') {
    const c = this.ctx.characters.find((x) => x.id === characterId);
    if (c) c.status = status;
    if (characterId === this.ctx.player.id) this.ctx.player.status = status;
    this.ops.push({ op: 'set_character_status', characterId, status });
  }
  saveDecisionState(characterId: string, domain: string, state: DecisionState) {
    this.decisionStates.set(`${characterId}/${domain}`, state);
    this.ops.push({ op: 'upsert_decision_state', gameId: this.ctx.gameId, characterId, domain, state });
  }
  /**
   * Something the player did will come back to them: when the time comes, the world answers it
   * (a scene beat about it is forced). summary says what happened, to whom, and who saw it.
   */
  consequence(summary: string, dueInMinutes: number) {
    this.schedule(addMinutes(this.ctx.gameTime, Math.max(0, Math.round(dueInMinutes))), 'consequence', { summary });
  }
  /**
   * A deed people saw. Whether and when they act on it is decided now, secretly (the player finds out when it happens):
   * the worse (or better) it was, the likelier and sooner.
   */
  deed(d: { what: string; against: string | null; severity: number; tone: 'harm' | 'kindness'; exposure: 'private' | 'semi_public' | 'public' }, witnesses: string[]) {
    const key = `deed:${d.what}`;
    // Unseen ears: nobody the player noticed may still have heard — likelier the more exposed the place.
    const overheard = this.random(`${key}:overheard`) < { private: 0.05, semi_public: 0.25, public: 0.6 }[d.exposure];
    if (!witnesses.length && !overheard) return; // nobody saw it
    const sev = Math.max(1, Math.min(5, Math.round(d.severity)));
    const chance = [0, 0.1, 0.35, 0.65, 0.9, 1][sev]!;
    if (this.random(`${key}:happens`) >= chance) return;
    const window: [number, number] = ([[0, 0], [72, 240], [48, 168], [24, 72], [6, 24], [1, 6]] as [number, number][])[sev]!;
    const hours = window[0] + this.random(`${key}:when`) * (window[1] - window[0]);
    const seen = [...witnesses, ...(overheard ? [`someone ${this.ctx.player.name} did not notice`] : [])].join(', ');
    this.consequence(`${this.ctx.player.name} ${d.what}${d.against ? ` (to ${d.against})` : ''} at ${this.ctx.location} — seen by ${seen}. `
      + (d.tone === 'harm' ? 'Someone who saw it, or was wronged, acts on it: reports it, spreads it, or takes revenge.' : 'Someone who saw it repays it, or speaks well of them.'), hours * 60);
  }
  schedule(dueGameTime: string, kind: string, payload: Record<string, unknown>, threadId: string | null = null) {
    const item: ScheduledItem = {
      id: newId('sch'), gameId: this.ctx.gameId, dueGameTime, kind, payload, threadId, status: 'pending', createdGameTime: this.ctx.gameTime, createdAt: this.ctx.now,
    };
    this.ops.push({ op: 'schedule', item });
    return item;
  }
  scheduleDone(id: string) { this.ops.push({ op: 'schedule_done', id }); }
  createThread(t: StoryThread) {
    this.threads.set(t.id, t);
    this.ops.push({ op: 'create_thread', thread: structuredClone(t) });
  }
  updateThread(t: StoryThread) {
    this.threads.set(t.id, t);
    this.ops.push({ op: 'update_thread', thread: structuredClone(t) });
  }
  linkThreadEvent(threadId: string, eventId: string) { this.ops.push({ op: 'link_thread_event', threadId, eventId }); }

  private payer(entityName: string | null): { account: Account; label: string } | string {
    const player = this.ctx.player;
    if (!entityName) return { account: this.ensureAccount('character', player.id), label: 'you' };
    const e = this.ctx.pack.entities.find(this, entityName);
    if (!e) return `there is nothing called "${entityName}" that you control`;
    if (!this.ctx.pack.entities.controlledBy(this, e.id, player.id)) return `you don't control ${e.name}`;
    return { account: this.ensureAccount('entity', e.id), label: e.name };
  }

  // ---------- player actions ----------
  /** Returns a model error if the action is malformed; outcomes in the world are recorded as results. */
  playerAction(a: PlayerAction): string | null {
    const player = this.ctx.player;
    const me = player.id;
    const cents = (x: number) => Math.round(x * 100);
    switch (a.action) {
      case 'pay': {
        const act = a as Extract<PlayerAction, { action: 'pay' }>;
        const amount = cents(act.amount);
        if (amount <= 0) return 'pay: amount must be positive';
        const p = this.payer(act.fromEntityName);
        if (typeof p === 'string') return this.reject(a, `Can't pay ${this.money(amount)}: ${p}.`), null;
        // The world's price book keeps prices consistent: a known item costs about what it cost before.
        const known = this.prices.get(priceKey(act.description));
        if (known && known.priceCents > 0 && !act.recurringMonthly && (amount > known.priceCents * PRICE_TOLERANCE || amount * PRICE_TOLERANCE < known.priceCents)) {
          return `pay: "${known.item}" costs about ${this.money(known.priceCents)} in this world, not ${this.money(amount)}`;
        }
        if (!known && !act.recurringMonthly) {
          const entry = { key: priceKey(act.description), item: act.description, priceCents: amount, source: 'paid' };
          this.prices.set(entry.key, entry);
          this.ops.push({ op: 'upsert_price', gameId: this.ctx.gameId, item: act.description, priceCents: amount, gameTime: this.ctx.gameTime });
        }
        if (p.account.balanceCents < amount) return this.reject(a, `Can't pay ${this.money(amount)} for ${act.description}: ${p.label === 'you' ? 'you have' : `${p.label} has`} only ${this.money(p.account.balanceCents)}.`), null;
        this.move(p.account, null, amount, act.description, act.recurringMonthly ? 'recurring' : 'expense');
        if (act.recurringMonthly) this.addRecurring(p.account, null, act.description, amount);
        this.event('money', `${p.label === 'you' ? player.name : p.label} paid ${this.money(amount)} for ${act.description}${act.recurringMonthly ? ' (monthly)' : ''}.`, [me], [{ characterId: me, role: 'actor' }], 1);
        this.results.push(`✓ Paid ${this.money(amount)} — ${act.description}${act.recurringMonthly ? ' (every month)' : ''} · ${p.label === 'you' ? 'your cash' : `${p.label} cash`} ${this.money(p.account.balanceCents)}`);
        return null;
      }
      case 'give_money': {
        const act = a as Extract<PlayerAction, { action: 'give_money' }>;
        const to = this.findCharacter(act.toCharacterName);
        if (!to || to.id === me) return `give_money: unknown recipient "${act.toCharacterName}"`;
        const amount = cents(act.amount);
        if (amount <= 0) return 'give_money: amount must be positive';
        const from = this.ensureAccount('character', me);
        if (from.balanceCents < amount) return this.reject(a, `Can't give ${to.name} ${this.money(amount)}: you have only ${this.money(from.balanceCents)}.`), null;
        this.move(from, this.ensureAccount('character', to.id), amount, act.description || `gift to ${to.name}`, 'transfer');
        this.event('money', `${player.name} gave ${to.name} ${this.money(amount)} (${act.description}).`, [me, to.id], [{ characterId: me, role: 'actor' }, { characterId: to.id, role: 'addressee' }]);
        this.results.push(`✓ Sent ${this.money(amount)} to ${to.name} · your cash ${this.money(from.balanceCents)}`);
        return null;
      }
      case 'make_offer': return this.makeOffer(a as Extract<PlayerAction, { action: 'make_offer' }>);
      case 'respond_to_offer': {
        const act = a as Extract<PlayerAction, { action: 'respond_to_offer' }>;
        const o = this.offer(act.offerId);
        if (!o || o.toCharacterId !== me) return `respond_to_offer: no offer ${act.offerId} made to the player`;
        if (o.status !== 'pending') return this.reject(a, `That offer is already ${o.status}.`), null;
        if (!this.inConversation(o.fromCharacterId)) return this.reject(a, `You need to be talking to ${this.name(o.fromCharacterId)} to answer their offer.`), null;
        this.closeOffer(o, act.accept ? 'accepted' : 'rejected');
        if (act.accept) this.offerKind(o.kind)?.execute(this, o);
        else this.results.push(`✗ You turned down ${this.name(o.fromCharacterId)}'s offer (${this.describeOffer(o)}).`);
        this.event('offer_resolved', `${player.name} ${act.accept ? 'accepted' : 'turned down'} ${this.name(o.fromCharacterId)}'s offer: ${this.describeOffer(o)}.`,
          [me, o.fromCharacterId], [{ characterId: me, role: 'actor' }], 4);
        return null;
      }
      case 'make_promise': {
        const act = a as Extract<PlayerAction, { action: 'make_promise' }>;
        const to = this.findCharacter(act.toCharacterName);
        if (!to || to.id === me) return `make_promise: unknown person "${act.toCharacterName}"`;
        if (!this.inConversation(to.id)) return this.reject(a, `You need to be talking to ${to.name} to promise them something.`), null;
        this.addObligation(me, to.id, act.description, act.amount, act.dueInDays, a);
        return null;
      }
      case 'fulfill_promise': {
        const act = a as Extract<PlayerAction, { action: 'fulfill_promise' }>;
        const o = this.obligation(act.promiseId);
        if (!o || o.debtorId !== me) return `fulfill_promise: no promise ${act.promiseId} made by the player`;
        if (o.status !== 'open') return this.reject(a, `That promise is already ${o.status}.`), null;
        if (o.amountCents) {
          const personal = this.ensureAccount('character', me);
          if (personal.balanceCents < o.amountCents) return this.reject(a, `Can't pay ${this.name(o.creditorId)} ${this.money(o.amountCents)}: you have only ${this.money(personal.balanceCents)}.`), null;
          this.move(personal, this.ensureAccount('character', o.creditorId), o.amountCents, `promise: ${o.description}`, 'promise');
        }
        this.resolveObligation(o);
        return null;
      }
      case 'seek': {
        // Looking for a way to reach someone. The model proposes what could be found; the engine decides
        // whether it is found — more time spent, better odds. What is found becomes the player's contact.
        const act = a as Extract<PlayerAction, { action: 'seek' }>;
        if (!(act.hours > 0 && act.hours <= 40)) return 'seek: hours must be between 0 and 40';
        const roll = this.random(`seek:${priceKey(act.target)}`);
        const pPerson = act.ifPerson ? Math.min(0.7, 0.2 + 0.1 * act.hours) : 0;
        const pChannel = Math.min(0.95, pPerson + 0.35 + 0.05 * act.hours);
        const note = (topic: string, belief: string) => this.ops.push({ op: 'upsert_knowledge', knowledge: {
          id: newId('know'), gameId: this.ctx.gameId, characterId: me, topic: topic.slice(0, 120), belief, confidence: 0.8, aboutCharacterId: null, factId: null,
          source: 'seek', sourceEventId: null, gameTime: this.ctx.gameTime, createdAt: this.ctx.now, updatedAt: this.ctx.now } });
        if (roll < pPerson && act.ifPerson) {
          const x = act.ifPerson;
          note(`contact: ${x.name}`, `${x.role} — reachable via ${x.channel} (found by ${act.approach}); has never heard of ${player.name}`);
          this.event('discovery', `${player.name} found a contact: ${x.name}, ${x.role} (${x.channel}).`, [me], [{ characterId: me, role: 'actor' }], 2);
          this.results.push(`🔎 Found someone: ${x.name} — ${x.role} · reachable via ${x.channel}`);
        } else if (roll < pChannel && act.ifChannel) {
          note(`contact: ${act.target}`, `no named person yet; a way in: ${act.ifChannel} (found by ${act.approach})`);
          this.event('discovery', `${player.name} found a way to reach ${act.target}: ${act.ifChannel}.`, [me], [{ characterId: me, role: 'actor' }], 2);
          this.results.push(`🔎 No name yet, but a way in to ${act.target}: ${act.ifChannel}`);
        } else {
          this.event('discovery', `${player.name} looked for a way to reach ${act.target} (${act.approach}) and found nothing useful.`, [me], [{ characterId: me, role: 'actor' }], 1);
          this.results.push(`🔎 Nothing useful yet on ${act.target} via ${act.approach}. Another approach (or more time) might work.`);
        }
        return null;
      }
      case 'research': {
        // What the player character learned. Beliefs, not world truth: research can be incomplete or wrong.
        const act = a as Extract<PlayerAction, { action: 'research' }>;
        const k: Knowledge = {
          id: newId('know'), gameId: this.ctx.gameId, characterId: me, topic: `research: ${act.topic}`.slice(0, 120), belief: act.findings.join(' • '),
          confidence: 0.6, aboutCharacterId: null, factId: null, source: 'research', sourceEventId: null, gameTime: this.ctx.gameTime, createdAt: this.ctx.now, updatedAt: this.ctx.now,
        };
        this.ops.push({ op: 'upsert_knowledge', knowledge: k });
        this.event('research', `${player.name} researched ${act.topic}.`, [me], [{ characterId: me, role: 'actor' }], 1);
        this.results.push(`📝 Notes — ${act.topic}:\n${act.findings.map((f) => `   • ${f}`).join('\n')}`);
        return null;
      }
      default: {
        const packAction = this.ctx.pack.actions.find((x) => x.name === a.action);
        if (!packAction) return `unknown action "${a.action}"`;
        return packAction.handle(this, a as Record<string, unknown>);
      }
    }
  }

  private makeOffer(a: Extract<PlayerAction, { action: 'make_offer' }>): string | null {
    const me = this.ctx.player.id;
    const def = this.offerKind(a.kind);
    if (!def) return `make_offer: unknown kind "${a.kind}" (known: ${this.ctx.pack.offerKinds.map((k) => k.kind).join(', ')})`;
    const to = this.findCharacter(a.toCharacterName);
    if (!to || to.id === me) return `make_offer: unknown person "${a.toCharacterName}"`;
    const terms: Record<string, number> = {};
    for (const t of a.terms) {
      if (!def.terms.some((d) => d.key === t.key)) return `make_offer: "${t.key}" is not a term of ${a.kind} (terms: ${def.terms.map((d) => d.key).join(', ')})`;
      terms[t.key] = t.value;
    }
    const missing = def.terms.filter((d) => d.required && terms[d.key] === undefined).map((d) => d.key);
    if (missing.length) return `make_offer: ${a.kind} needs ${missing.join(', ')}`;
    const badTerms = def.validateTerms?.(terms);
    if (badTerms) return `make_offer: ${badTerms}`;
    const subject = def.resolveSubject(this, a.subject, to.id);
    if ('modelError' in subject) return `make_offer: ${subject.modelError}`;
    if ('reject' in subject) return this.reject(a, subject.reject), null;
    if (!this.inConversation(to.id)) return this.reject(a, `You need to be talking to ${to.name} to make an offer.`), null;
    if (this.allOffers().some((o) => o.status === 'pending' && o.toCharacterId === to.id && o.kind === a.kind && o.subjectRef === subject.subjectRef)) {
      return this.reject(a, `${to.name} still owes you an answer on your previous offer.`), null;
    }
    const offer: Offer = {
      id: newId('offer'), gameId: this.ctx.gameId, kind: a.kind, fromCharacterId: me, toCharacterId: to.id, subjectRef: subject.subjectRef, label: a.label,
      terms, description: a.description, status: 'pending', parentOfferId: null, attempts: 0, lastOutcome: null, nextDecisionAfter: null,
      lastAppraisal: null, createdGameTime: this.ctx.gameTime, resolvedGameTime: null, createdAt: this.ctx.now, updatedAt: this.ctx.now,
    };
    this.offers.set(offer.id, offer);
    this.ops.push({ op: 'create_offer', offer: { ...offer } });
    this.event('offer_made', `${this.ctx.player.name} offered ${to.name}: ${this.describeOffer(offer)}.`, [me, to.id], [{ characterId: me, role: 'actor' }, { characterId: to.id, role: 'addressee' }], 4);
    this.results.push(`→ Offer to ${to.name}: ${this.describeOffer(offer)}`);
    return null;
  }

  /**
   * An offer someone makes TO the player (e.g. in a scene beat). Validated like the player's own offers;
   * the player answers it with respond_to_offer. Returns a problem, or null.
   */
  npcOffer(fromId: string, o: { kind: string; label: string | null; terms: { key: string; value: number }[]; description: string }): string | null {
    const me = this.ctx.player.id;
    const def = this.offerKind(o.kind);
    if (!def) return `unknown offer kind "${o.kind}" (known: ${this.ctx.pack.offerKinds.map((k) => k.kind).join(', ')})`;
    const terms: Record<string, number> = {};
    for (const t of o.terms) {
      if (!def.terms.some((d) => d.key === t.key)) return `"${t.key}" is not a term of ${o.kind} (terms: ${def.terms.map((d) => d.key).join(', ')})`;
      terms[t.key] = t.value;
    }
    const missing = def.terms.filter((d) => d.required && terms[d.key] === undefined).map((d) => d.key);
    if (missing.length) return `${o.kind} needs ${missing.join(', ')}`;
    const bad = def.validateTerms?.(terms);
    if (bad) return bad;
    const subject = def.resolveSubject(this, null, me);
    if (!('subjectRef' in subject)) return 'reject' in subject ? subject.reject : subject.modelError;
    const offer: Offer = {
      id: newId('offer'), gameId: this.ctx.gameId, kind: o.kind, fromCharacterId: fromId, toCharacterId: me, subjectRef: subject.subjectRef, label: o.label,
      terms, description: o.description, status: 'pending', parentOfferId: null, attempts: 0, lastOutcome: null, nextDecisionAfter: null,
      lastAppraisal: null, createdGameTime: this.ctx.gameTime, resolvedGameTime: null, createdAt: this.ctx.now, updatedAt: this.ctx.now,
    };
    this.offers.set(offer.id, offer);
    this.ops.push({ op: 'create_offer', offer: { ...offer } });
    this.event('offer_made', `${this.name(fromId)} offered ${this.ctx.player.name}: ${this.describeOffer(offer)}.`, [me, fromId], [{ characterId: fromId, role: 'actor' }, { characterId: me, role: 'addressee' }], 4);
    this.results.push(`→ ${this.name(fromId)} offers you: ${this.describeOffer(offer)}`);
    return null;
  }

  // ---------- engine-resolved decisions on offers ----------
  /** Offers from the player waiting on this NPC that they may (re)consider now. */
  decidableOffersFor(npcId: string): Offer[] {
    return this.allOffers().filter((o) => o.toCharacterId === npcId && o.status === 'pending' && o.fromCharacterId === this.ctx.player.id
      && (!o.nextDecisionAfter || o.nextDecisionAfter <= this.ctx.gameTime));
  }

  /**
   * Applies an engine-resolved outcome to an offer. The portrayal supplies wording only
   * (counter terms and conditions, already validated against the actor's limits).
   */
  applyDecision(offer: Offer, r: Resolution, extra: { counter: Record<string, number> | null; condition: string | null; counterNote: string; appraisal: unknown }) {
    const o = this.offer(offer.id)!;
    const npcId = o.toCharacterId;
    const npc = this.name(npcId);
    o.attempts += 1;
    o.lastOutcome = r.outcome;
    o.lastAppraisal = extra.appraisal;
    o.updatedAt = this.ctx.now;
    const what = this.describeOffer(o);
    this.ops.push({ op: 'insert_decision', decision: {
      id: newId('dec'), gameId: this.ctx.gameId, turnId: this.ctx.turnId, offerId: o.id, threadId: null, domain: o.kind, characterId: npcId,
      outcome: r.outcome, finalScore: r.finalScore, roll: r.roll, seed: r.seed, reasons: r.reasons, detail: r, gameTime: this.ctx.gameTime, createdAt: this.ctx.now,
    } });

    switch (r.outcome) {
      case 'accept':
      case 'accept_conditionally':
        this.closeOffer(o, 'accepted');
        this.offerKind(o.kind)?.execute(this, o);
        if (r.outcome === 'accept_conditionally' && extra.condition) this.addObligation(this.ctx.player.id, npcId, `Condition for ${npc}: ${extra.condition}`, null, null, null);
        break;
      case 'counter': {
        this.closeOffer(o, 'countered');
        const counter: Offer = {
          ...o, id: newId('offer'), fromCharacterId: npcId, toCharacterId: o.fromCharacterId, terms: extra.counter ?? r.counterTerms ?? o.terms,
          description: extra.counterNote || `counter-offer to: ${o.description}`, status: 'pending', parentOfferId: o.id, attempts: 0, lastOutcome: null,
          nextDecisionAfter: null, lastAppraisal: null, createdGameTime: this.ctx.gameTime, resolvedGameTime: null, createdAt: this.ctx.now, updatedAt: this.ctx.now,
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

  // ---------- story threads ----------
  /** The deciding actor's view of a situation shifted (e.g. after talking with the player). */
  threadSignal(threadId: string, factor: string, value: number, reason: string) {
    const t = this.thread(threadId);
    if (!t) return;
    const factors = t.resolution.factors.filter((f) => f.factor !== factor);
    factors.push({ factor, value, reason });
    this.updateThread({ ...t, resolution: { ...t.resolution, factors }, updatedGameTime: this.ctx.gameTime, updatedAt: this.ctx.now });
  }

  // ---------- promises ----------
  npcPromise(npcId: string, creditorId: string, description: string, dueInDays: number | null) {
    this.addObligation(npcId, creditorId, description, null, dueInDays, null);
  }
  npcFulfill(npcId: string, promiseId: string): string | null {
    const o = this.obligation(promiseId);
    if (!o || o.debtorId !== npcId) return `fulfill_promise: no promise ${promiseId} made by you`;
    if (o.status !== 'open') return `fulfill_promise: promise ${promiseId} is already ${o.status}`;
    this.resolveObligation(o);
    return null;
  }
  addObligation(debtorId: string, creditorId: string, description: string, amount: number | null, dueInDays: number | null, action: unknown) {
    const cents = amount && amount > 0 ? Math.round(amount * 100) : null;
    if (dueInDays !== null && (dueInDays < 0 || dueInDays > 3650)) return this.reject(action, 'A promise must be due within 10 years.');
    const o: Obligation = { id: newId('prom'), gameId: this.ctx.gameId, debtorId, creditorId, description, amountCents: cents,
      dueGameTime: dueInDays === null ? null : addMinutes(this.ctx.gameTime, Math.round(dueInDays * 1440)), status: 'open', overdueNotified: false,
      createdGameTime: this.ctx.gameTime, resolvedGameTime: null, createdAt: this.ctx.now, updatedAt: this.ctx.now };
    this.obligations.set(o.id, o);
    this.ops.push({ op: 'create_obligation', obligation: { ...o } });
    const who = this.name(debtorId);
    const what = `${description}${cents ? ` (${this.money(cents)})` : ''}${o.dueGameTime ? ` by ${formatGameTime(o.dueGameTime)}` : ''}`;
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
    this.results.push(`✓ Promise kept — ${this.name(o.debtorId)} → ${this.name(o.creditorId)}: ${o.description}${o.amountCents ? ` (${this.money(o.amountCents)} paid)` : ''}`);
  }

  // ---------- time: recurring flows and deadlines ----------
  passTime(from: string, to: string) {
    if (to <= from) return;
    const ownerOf = (a: Account) => (a.ownerKind === 'entity' ? this.ctx.pack.entities.name(this, a.ownerId) : a.ownerId === this.ctx.player.id ? 'you' : this.name(a.ownerId));
    // Monthly flows, in time order; everything landing at the same moment for the same owner is reported as one line.
    const groups = new Map<string, { at: string; owner: string; account: Account; balance: number; out: [string, number][]; in: [string, number][] }>();
    const touched = new Set<RecurringPayment>();
    for (let guard = 0; guard < 500; guard++) {
      const r = [...this.recurring.values()].filter((x) => x.active && x.nextDueGameTime <= to).sort((a, b) => a.nextDueGameTime.localeCompare(b.nextDueGameTime))[0];
      if (!r) break;
      touched.add(r);
      const at = r.nextDueGameTime;
      const payer = r.fromAccountId ? this.accounts.get(r.fromAccountId)! : null;
      const payee = r.toAccountId ? this.accounts.get(r.toAccountId)! : null;
      const group = (a: Account) => {
        const k = `${at}|${a.id}`;
        if (!groups.has(k)) groups.set(k, { at, owner: ownerOf(a), account: a, balance: a.balanceCents, out: [], in: [] });
        return groups.get(k)!;
      };
      if (payer && payer.balanceCents < r.amountCents) {
        r.active = false;
        this.results.push(`⚠ ${formatGameTime(at)}: ${r.description} (${this.money(r.amountCents)}) could not be paid — ${ownerOf(payer)} has ${this.money(payer.balanceCents)}. It has been stopped.`);
        this.event('money', `A payment of ${this.money(r.amountCents)} for ${r.description} failed and was stopped.`, [this.ctx.player.id], [{ characterId: this.ctx.player.id, role: 'actor' }], 3, at);
        continue;
      }
      this.move(payer, payee, r.amountCents, `${r.description} (monthly)`, payer ? 'recurring' : 'income', at);
      if (payer) { const g = group(payer); g.out.push([r.description, r.amountCents]); g.balance = payer.balanceCents; }
      if (payee) { const g = group(payee); g.in.push([r.description, r.amountCents]); g.balance = payee.balanceCents; }
      r.nextDueGameTime = addMonths(at, 1);
    }
    for (const r of touched) this.ops.push({ op: 'update_recurring', recurring: { ...r } });
    for (const g of groups.values()) {
      const sum = (xs: [string, number][]) => xs.reduce((n, [, c]) => n + c, 0);
      const list = (xs: [string, number][]) => xs.map(([d, c]) => `${d} ${this.money(c)}`).join(', ');
      const parts = [
        g.out.length ? `monthly costs ${this.money(sum(g.out))} (${list(g.out)})` : null,
        g.in.length ? `received ${this.money(sum(g.in))} (${list(g.in)})` : null,
      ].filter(Boolean).join(' · ');
      this.results.push(`⏰ ${formatGameTime(g.at)} — ${g.owner === 'you' ? '' : `${g.owner}: `}${parts} · balance ${this.money(g.balance)}`);
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
export function applyOps(store: Store, planner: WorldPlanner): { table: string; op: string; id: string; note?: string }[] {
  const writes: { table: string; op: string; id: string; note?: string }[] = [];
  const money = (c: number) => planner.money(c);
  for (const o of planner.ops) {
    switch (o.op) {
      case 'create_account': store.insertAccount(o.account); writes.push({ table: 'accounts', op: 'insert', id: o.account.id, note: `${o.account.ownerKind} ${o.account.ownerId}` }); break;
      case 'transfer': store.transfer(o.tx); writes.push({ table: 'transactions', op: 'insert', id: o.tx.id, note: `${money(o.tx.amountCents)} ${o.tx.description}` }); break;
      case 'create_offer': store.insertOffer(o.offer); writes.push({ table: 'offers', op: 'insert', id: o.offer.id }); break;
      case 'update_offer': store.updateOffer(o.offer); writes.push({ table: 'offers', op: 'update', id: o.offer.id, note: `${o.offer.status}${o.offer.lastOutcome ? ` (${o.offer.lastOutcome})` : ''}` }); break;
      case 'insert_decision': store.insertDecision(o.decision); writes.push({ table: 'decisions', op: 'insert', id: o.decision.id, note: o.decision.outcome }); break;
      case 'upsert_decision_state': store.upsertDecisionState(o.gameId, o.characterId, o.domain, o.state, 'generated', planner.ctx.now); writes.push({ table: 'decision_states', op: 'upsert', id: `${o.characterId}/${o.domain}` }); break;
      case 'create_obligation': store.insertObligation(o.obligation); writes.push({ table: 'obligations', op: 'insert', id: o.obligation.id }); break;
      case 'update_obligation': store.updateObligation(o.obligation); writes.push({ table: 'obligations', op: 'update', id: o.obligation.id, note: o.obligation.status }); break;
      case 'create_recurring': store.insertRecurringPayment(o.recurring); writes.push({ table: 'recurring_payments', op: 'insert', id: o.recurring.id }); break;
      case 'update_recurring': store.updateRecurringPayment(o.recurring); writes.push({ table: 'recurring_payments', op: 'update', id: o.recurring.id }); break;
      case 'create_thread': store.insertThread(o.thread); writes.push({ table: 'story_threads', op: 'insert', id: o.thread.id, note: o.thread.title }); break;
      case 'update_thread': store.updateThread(o.thread); writes.push({ table: 'story_threads', op: 'update', id: o.thread.id, note: `${o.thread.status} ${o.thread.momentum}` }); break;
      case 'link_thread_event': store.linkThreadEvent(o.threadId, o.eventId); writes.push({ table: 'thread_events', op: 'insert', id: `${o.threadId}→${o.eventId}` }); break;
      case 'schedule': store.insertScheduled(o.item); writes.push({ table: 'world_schedule', op: 'insert', id: o.item.id, note: `${o.item.kind} @ ${o.item.dueGameTime}` }); break;
      case 'schedule_done': store.setScheduledStatus(o.id, 'done'); writes.push({ table: 'world_schedule', op: 'update', id: o.id, note: 'done' }); break;
      case 'upsert_price': store.upsertPrice({ gameId: o.gameId, item: o.item, priceCents: o.priceCents, source: 'paid', gameTime: o.gameTime }); writes.push({ table: 'prices', op: 'upsert', id: priceKey(o.item), note: money(o.priceCents) }); break;
      case 'set_character_status': store.setCharacterStatus(o.characterId, o.status, planner.ctx.now); writes.push({ table: 'characters', op: 'update', id: o.characterId, note: o.status }); break;
      case 'upsert_knowledge': { const r = store.upsertKnowledge(o.knowledge); writes.push({ table: 'knowledge', op: r.op, id: r.id, note: o.knowledge.topic }); break; }
    }
  }
  return writes;
}

// ---------------------------------------------------------------------------
// Perspective views (text) for prompts. Only what this character is party to.
// ---------------------------------------------------------------------------

function obligationLine(p: WorldPlanner, o: Obligation, gameTime: string): string {
  const overdue = o.status === 'open' && o.dueGameTime && o.dueGameTime <= gameTime;
  const due = o.dueGameTime ? ` · due ${formatGameTime(o.dueGameTime)}` : '';
  return `[${o.id}] ${p.name(o.debtorId)} → ${p.name(o.creditorId)}: ${o.description}${o.amountCents ? ` (${p.money(o.amountCents)})` : ''}${due} · ${overdue ? 'OVERDUE' : o.status}`;
}

/** What this NPC can see: pack state they are part of, offers and promises they are party to, situations they are in. */
export function npcWorldBriefing(p: WorldPlanner, npcId: string, gameTime: string): { text: string; ids: string[] } {
  const ids: string[] = [];
  const lines: string[] = [...p.ctx.pack.briefing.npc(p, npcId)];
  for (const o of p.allOffers().filter((x) => x.toCharacterId === npcId || x.fromCharacterId === npcId)) {
    ids.push(o.id);
    if (o.status === 'pending' && o.toCharacterId === npcId) {
      lines.push(`OFFER TO YOU [${o.id}] from ${p.name(o.fromCharacterId)}: ${p.describeOffer(o)} — "${o.description}"${o.lastOutcome ? ` (your last answer: ${o.lastOutcome.replace(/_/g, ' ')})` : ''}`);
      lines.push(...(p.offerKind(o.kind)?.context?.(p, o) ?? []).map((l) => `  ${l}`));
    } else {
      lines.push(`Offer ${p.name(o.fromCharacterId)} → ${p.name(o.toCharacterId)} [${o.id}]: ${p.describeOffer(o)} — ${o.status}`);
    }
  }
  for (const o of p.allObligations().filter((x) => x.debtorId === npcId || x.creditorId === npcId)) { ids.push(o.id); lines.push(obligationLine(p, o, gameTime)); }
  return { text: lines.join('\n') || '(none)', ids };
}

/** Situations (story threads) this NPC is part of — their own life, as they experience it. */
export function npcThreadsBriefing(p: WorldPlanner, npcId: string): string {
  return p.allThreads()
    .filter((t) => t.participantIds.includes(npcId) && (t.status === 'emerging' || t.status === 'active'))
    .map((t) => `[${t.id}] ${t.title}: ${t.summary}${t.resolution.actorId === npcId ? ` (you are weighing: ${t.resolution.option})` : ''}`)
    .join('\n');
}

export function playerWorldBriefing(p: WorldPlanner, gameTime: string): string {
  const me = p.ctx.player.id;
  const personal = p.account('character', me);
  const lines = [`Personal cash: ${p.money(personal?.balanceCents ?? 0)}`];
  if (personal) for (const r of p.outgoing(personal.id)) lines.push(`Personal monthly cost: ${r.description} ${p.money(r.amountCents)}`);
  lines.push(...p.ctx.pack.briefing.player(p));
  for (const o of p.allOffers().filter((x) => x.fromCharacterId === me && x.status === 'pending')) {
    lines.push(`Your pending offer to ${p.name(o.toCharacterId)}: ${p.describeOffer(o)}`);
  }
  for (const o of p.allOffers().filter((x) => x.toCharacterId === me && x.status === 'pending')) {
    lines.push(`[${o.id}] ${o.parentOfferId ? 'Counter-offer' : 'Offer'} from ${p.name(o.fromCharacterId)} to you: ${p.describeOffer(o)} — "${o.description}" (the player accepting or declining THIS = respond_to_offer with this id, not a new offer)`);
  }
  for (const o of p.allObligations().filter((x) => x.status === 'open' && (x.debtorId === me || x.creditorId === me))) lines.push(obligationLine(p, o, gameTime));
  const soon = upcoming(p.ctx.store, p.ctx.gameId, gameTime, 14);
  if (soon.length) lines.push('UPCOMING (on the calendar; going there = moving to that place at that time):', ...soon.map((i) => `- ${opportunityLine(i, p)}`));
  const prices = p.knownPrices();
  if (prices.length) lines.push(`KNOWN PRICES (use these amounts when paying for these items): ${prices.map((x) => `${x.item} ${p.money(x.priceCents)}`).join('; ')}`);
  return lines.join('\n');
}

/** Opportunities on the calendar in the next `days` days, soonest first. */
export function upcoming(store: Store, gameId: string, gameTime: string, days: number, p?: WorldPlanner): ScheduledItem[] {
  const until = addMinutes(gameTime, days * 1440);
  // Include what this turn has already scheduled or completed (e.g. a weekly event that just came round again).
  const done = new Set(p?.ops.flatMap((o) => (o.op === 'schedule_done' ? [o.id] : [])));
  const planned = p?.ops.flatMap((o) => (o.op === 'schedule' ? [o.item] : [])) ?? [];
  return [...store.listScheduled(gameId, 'pending'), ...planned]
    .filter((i) => !done.has(i.id) && i.kind === 'opportunity' && i.dueGameTime >= gameTime && i.dueGameTime <= until)
    .sort((a, b) => a.dueGameTime.localeCompare(b.dueGameTime));
}

export function opportunityLine(i: ScheduledItem, p?: WorldPlanner): string {
  const x = i.payload as { title: string; description?: string; location?: string | null; cost?: number | null };
  const cost = typeof x.cost === 'number' && x.cost > 0 ? ` · entry ${p ? p.money(Math.round(x.cost * 100)) : x.cost}` : '';
  return `${formatGameTime(i.dueGameTime)} — ${x.title}${x.location ? ` @ ${x.location}` : ''}${cost}${x.description ? `: ${x.description}` : ''}`;
}
