import type { Store } from '../db/store.ts';
import { DecisionStateProposalSchema, DirectorProposalSchema, type Appraisal, type DecisionState, type DirectorProposal, type Outcome } from '../domain/schemas.ts';
import type { StoryThread } from '../domain/types.ts';
import { NEGATIVE, POSITIVE, resolveDecision } from './decision.ts';
import type { WorldPlanner } from './planner.ts';
import type { RngFactory } from './random.ts';
import { addMinutes, formatGameTime, newId } from './util.ts';
import { decisionStateProblems } from './validate.ts';

// ============================================================================
// World Turn Engine + Story Threads + Story Director (all generic).
//
// When time passes, the world moves without the player:
//   recurring flows & deadlines → due scheduled developments → story threads gain momentum and
//   resolve through the Decision Resolution Engine → deferred decisions on the player's offers →
//   (daily) the Story Director proposes situations that grow out of what already happened.
// World truth is objective; characters and the player learn about it only through events they
// observe (a message, a conversation, a public event).
// ============================================================================

export const THREAD_ACTIVE_AT = 30;
export const THREAD_RESOLVES_AT = 100;
const DIRECTOR_HOUR = '08:00';

export interface WorldTurnDeps {
  store: Store;
  rng: RngFactory;
  seedBase: string; // game + request: a retried request replays the same world
  director: null | ((system: string, user: string) => Promise<DirectorProposal>);
}

export interface WorldTurnTrace {
  from: string;
  to: string;
  scheduled: { id: string; kind: string; due: string; result: string }[];
  threads: { id: string; title: string; momentumBefore: number; gain: number; momentumAfter: number; resolved?: { outcome: Outcome; roll: number; score: number } }[];
  deferred: { offerId: string; outcome: Outcome; roll: number }[];
  director?: { ran: boolean; proposal?: DirectorProposal; accepted: string[]; rejected: { item: string; reason: string }[] };
}

const days = (from: string, to: string) => (new Date(`${to}:00Z`).getTime() - new Date(`${from}:00Z`).getTime()) / 86_400_000;
const nextDirectorTime = (after: string) => {
  const sameDay = `${after.slice(0, 10)}T${DIRECTOR_HOUR}`;
  return sameDay > after ? sameDay : `${addMinutes(`${after.slice(0, 10)}T00:00`, 1440).slice(0, 10)}T${DIRECTOR_HOUR}`;
};

export async function runWorldTurn(p: WorldPlanner, from: string, to: string, deps: WorldTurnDeps): Promise<WorldTurnTrace> {
  const trace: WorldTurnTrace = { from, to, scheduled: [], threads: [], deferred: [] };
  const { store } = deps;
  const gameId = p.ctx.gameId;
  const player = p.ctx.player;
  if (to <= from) return trace;

  // 1. Recurring flows and deadlines.
  p.passTime(from, to);

  // 2. Scheduled developments that fall due.
  const due = store.listScheduled(gameId, 'pending').filter((i) => i.dueGameTime <= to);
  let directorDue = false;
  for (const item of due) {
    p.scheduleDone(item.id);
    if (item.kind === 'message') {
      const fromId = String(item.payload.fromId);
      const text = String(item.payload.text);
      deliverMessage(p, fromId, text, item.dueGameTime, item.threadId);
      trace.scheduled.push({ id: item.id, kind: item.kind, due: item.dueGameTime, result: 'delivered' });
    } else if (item.kind === 'director_review') {
      directorDue = true;
      trace.scheduled.push({ id: item.id, kind: item.kind, due: item.dueGameTime, result: 'review due' });
    } else {
      trace.scheduled.push({ id: item.id, kind: item.kind, due: item.dueGameTime, result: 'no handler' });
    }
  }

  // 3. Story threads move on — with or without the player.
  const elapsed = days(from, to);
  for (const t of p.allThreads().filter((x) => x.status === 'emerging' || x.status === 'active')) {
    const rng = deps.rng(`${deps.seedBase}:${t.id}:momentum`);
    const gain = Math.round(t.urgency * elapsed * (0.5 + rng()));
    const before = t.momentum;
    const thread: StoryThread = { ...t, momentum: Math.min(THREAD_RESOLVES_AT, t.momentum + gain), updatedGameTime: to, updatedAt: p.ctx.now };
    const entry: WorldTurnTrace['threads'][number] = { id: t.id, title: t.title, momentumBefore: before, gain, momentumAfter: thread.momentum };
    trace.threads.push(entry);
    if (thread.status === 'emerging' && thread.momentum >= THREAD_ACTIVE_AT) {
      thread.status = 'active';
      const ev = p.event('thread_development', `${t.title}: it is becoming pressing.`, observersOf(p, thread), [{ characterId: t.resolution.actorId, role: 'actor' }], 2, to);
      p.linkThreadEvent(t.id, ev.id);
    }
    if (thread.momentum >= THREAD_RESOLVES_AT) {
      const r = resolveThread(p, thread, to, deps);
      if (r) entry.resolved = r;
    }
    if (gain !== 0 || thread.status !== t.status) p.updateThread(thread);
  }

  // 4. Deferred decisions on the player's offers: people get back to you (or don't).
  for (const o of p.allOffers()) {
    if (o.status !== 'pending' || o.fromCharacterId !== player.id || !o.nextDecisionAfter || !o.lastAppraisal) continue;
    if (o.nextDecisionAfter > to || o.nextDecisionAfter <= from) continue;
    const state = p.decisionState(o.toCharacterId, o.kind);
    if (!state) continue;
    const seed = `${deps.seedBase}:${o.id}:${o.attempts + 1}`;
    const res = resolveDecision({ state: activePressures(state, o.nextDecisionAfter), option: { kind: o.kind, terms: o.terms }, appraisal: o.lastAppraisal as Appraisal, rng: deps.rng(seed), seed });
    const at = o.nextDecisionAfter;
    deliverMessage(p, o.toCharacterId, replyFor(res.outcome, state), at, null);
    p.applyDecision(o, res, { counter: res.counterTerms, condition: null, counterNote: 'what they could accept instead', appraisal: o.lastAppraisal });
    trace.deferred.push({ offerId: o.id, outcome: res.outcome, roll: res.roll });
  }

  // 5. The Story Director reviews the world (at most once per game day).
  if (deps.director) {
    const pending = store.listScheduled(gameId, 'pending').some((i) => i.kind === 'director_review' && i.dueGameTime > to);
    if (directorDue) {
      trace.director = await runDirector(p, deps, to);
    }
    if (directorDue || !pending) p.schedule(nextDirectorTime(to), 'director_review', {});
  }
  return trace;
}

function observersOf(p: WorldPlanner, t: StoryThread): string[] {
  const ids = t.participantIds.filter((id) => id !== p.ctx.player.id || t.visibility !== 'hidden');
  return t.visibility === 'public' ? [...new Set([...ids, p.ctx.player.id])] : ids;
}

function activePressures(state: DecisionState, at: string): DecisionState {
  return { ...state, pressures: state.pressures.filter((x) => !x.expiresGameTime || x.expiresGameTime > at) };
}

/** A message reaches the player: an observable event, never silent knowledge. */
export function deliverMessage(p: WorldPlanner, fromId: string, text: string, at: string, threadId: string | null) {
  const player = p.ctx.player;
  const ev = p.event('message', `${p.name(fromId)} messaged ${player.name}: "${text}"`, [fromId, player.id],
    [{ characterId: fromId, role: 'actor' }, { characterId: player.id, role: 'addressee' }], 3, at,
    [{ speakerId: fromId, speakerName: p.name(fromId), text }], 'message');
  if (threadId) p.linkThreadEvent(threadId, ev.id);
  p.results.push(`📱 ${formatGameTime(at)} — ${p.name(fromId)}: “${text}”`);
}

function replyFor(outcome: Outcome, state: DecisionState): string {
  switch (outcome) {
    case 'accept': return "I've thought about it. Ok — let's do it.";
    case 'accept_conditionally': return "Ok, I'm in — but I have a condition. Let's talk.";
    case 'counter': return "I've thought about it. Not on those terms — here's what I could do.";
    case 'escalate_to_decision_maker': return `I talked to ${state.requiresApproval ?? 'the others'}. Still waiting on them, sorry.`;
    case 'request_more_information': return 'I need more details before I can decide.';
    case 'delay': return 'Still thinking. Give me a few more days.';
    case 'reject': return "I've thought about it — I'm going to pass. Sorry.";
    case 'disengage': return "I'm not interested. Please don't count on me for this.";
  }
}

/** A thread reaches its decision point: the actor decides with the same engine as everyone else. */
function resolveThread(p: WorldPlanner, t: StoryThread, at: string, deps: WorldTurnDeps) {
  const r = t.resolution;
  const state = p.decisionState(r.actorId, r.domain);
  if (!state) return null; // cannot happen for validated threads
  const seed = `${deps.seedBase}:${t.id}:resolve`;
  const res = resolveDecision({
    state: activePressures(state, at), option: { kind: r.domain, terms: {} },
    appraisal: { factors: r.factors.map((f) => ({ factor: f.factor as Appraisal['factors'][number]['factor'], value: f.value, reason: f.reason })) },
    rng: deps.rng(seed), seed,
  });
  p.ops.push({ op: 'insert_decision', decision: {
    id: newId('dec'), gameId: p.ctx.gameId, turnId: p.ctx.turnId, offerId: null, threadId: t.id, domain: r.domain, characterId: r.actorId,
    outcome: res.outcome, finalScore: res.finalScore, roll: res.roll, seed, reasons: res.reasons, detail: res, gameTime: at, createdAt: p.ctx.now,
  } });
  const branch = POSITIVE.includes(res.outcome) ? r.ifAccepted : NEGATIVE.includes(res.outcome) ? r.ifRejected : null;
  if (!branch) {
    // Still undecided: the situation lingers and will come back.
    t.momentum = 60;
    const ev = p.event('thread_development', `${t.title}: still undecided (${res.outcome.replace(/_/g, ' ')}).`, observersOf(p, t), [{ characterId: r.actorId, role: 'actor' }], 2, at);
    p.linkThreadEvent(t.id, ev.id);
    return { outcome: res.outcome, roll: res.roll, score: res.finalScore };
  }
  t.status = 'resolved';
  t.outcome = branch.summary;
  t.resolvedGameTime = at;
  const ev = p.event('thread_resolved', branch.summary, observersOf(p, t), [{ characterId: r.actorId, role: 'actor' }], 4, at);
  p.linkThreadEvent(t.id, ev.id);
  if (branch.newPressure) {
    // The outcome changes the actor's circumstances for every future decision.
    for (const d of deps.store.listDecisionStates(p.ctx.gameId).filter((x) => x.characterId === r.actorId)) {
      const current = p.decisionState(r.actorId, d.domain) ?? d.state;
      p.saveDecisionState(r.actorId, d.domain, { ...current, pressures: [...current.pressures, { text: branch.newPressure, expiresGameTime: null }].slice(-5) });
    }
  }
  if (branch.messageToPlayer && r.actorId !== p.ctx.player.id) {
    const delay = 30 + Math.floor(deps.rng(`${seed}:msg`)() * 2 * 1440); // they tell you when they get round to it
    p.schedule(addMinutes(at, delay), 'message', { fromId: r.actorId, text: branch.messageToPlayer }, t.id);
  }
  return { outcome: res.outcome, roll: res.roll, score: res.finalScore };
}

// ---------------------------------------------------------------------------
// Story Director: proposes situations that grow out of world truth. The engine validates.
// ---------------------------------------------------------------------------

export function directorSystemPrompt(packContext: string): string {
  return `You are the Story Director of a persistent, living world. You do NOT write a plot, chapters or quests, and you never steer the player.
You look at what has actually happened and ask: what situations are naturally developing from this?
World background: ${packContext}

Propose at most two NEW situations (story threads) and any ESCALATIONS of existing ones, only when real events support them.
- Every thread must cite causeEventIds from the EVENTS list and be driven by the people's own goals, pressures and circumstances.
- A thread is decided eventually by one actor (never the player): say what they are weighing, which factors matter (−2…+2 from their point of view), and what happens either way.
- messageToPlayer: only if that person would plausibly tell the player; otherwise null (the player may never find out).
- Most of the time the right answer is no new thread. Prefer quiet realism over drama. Return JSON only.`;
}

export function directorUserPrompt(p: WorldPlanner, store: Store, at: string): string {
  const events = store.listEvents(p.ctx.gameId).slice(-30);
  const chars = store.listCharacters(p.ctx.gameId);
  const threads = p.allThreads().filter((t) => t.status !== 'resolved');
  return [
    `NOW: ${formatGameTime(at)}`,
    'PEOPLE:', ...chars.map((c) => `- ${c.name}${c.isPlayer ? ' (THE PLAYER)' : ''}, ${c.age}, ${c.occupation ?? c.role}. Goals: ${c.goals.join('; ') || '-'}. Fears: ${c.fears.join('; ') || '-'}`),
    'OPEN SITUATIONS:', ...(threads.length ? threads.map((t) => `- [${t.id}] ${t.title} (${t.status}, momentum ${t.momentum}): ${t.summary}`) : ['(none)']),
    'EVENTS (world truth, oldest first):', ...events.map((e) => `- [${e.id}] ${e.gameTime} ${e.type}: ${e.summary}`),
  ].join('\n');
}

/** Validates a Director proposal against world state. Returns accepted item labels and rejections. */
export function applyDirectorProposal(p: WorldPlanner, store: Store, proposal: DirectorProposal, at: string) {
  const accepted: string[] = [];
  const rejected: { item: string; reason: string }[] = [];
  const gameId = p.ctx.gameId;
  const eventExists = (id: string) => store.getEvent(id)?.gameId === gameId;
  for (const nt of proposal.newThreads) {
    const bad = (reason: string) => rejected.push({ item: `thread "${nt.title}"`, reason });
    const missing = nt.causeEventIds.filter((id) => !eventExists(id));
    if (missing.length) { bad(`cites events that do not exist: ${missing.join(', ')}`); continue; }
    const participants = nt.participantNames.map((n) => p.findCharacter(n));
    if (participants.some((c) => !c)) { bad(`unknown participant(s): ${nt.participantNames.filter((_, i) => !participants[i]).join(', ')}`); continue; }
    const actor = p.findCharacter(nt.resolution.actorName);
    if (!actor || !participants.some((c) => c!.id === actor.id)) { bad('the deciding actor must be one of the participants'); continue; }
    if (actor.id === p.ctx.player.id) { bad("the player's decisions belong to the player"); continue; }
    if (p.allThreads().some((t) => t.status !== 'resolved' && t.title.toLowerCase() === nt.title.toLowerCase())) { bad('duplicate of an open thread'); continue; }
    if (!p.decisionState(actor.id, nt.resolution.domain)) {
      if (!nt.decisionState) { bad(`${actor.name} has no decision state for "${nt.resolution.domain}" and none was proposed`); continue; }
      const parsed = DecisionStateProposalSchema.safeParse(nt.decisionState);
      const problems = parsed.success ? decisionStateProblems(parsed.data) : ['invalid decision state'];
      if (problems.length) { bad(problems.join('; ')); continue; }
      const ds = parsed.data!;
      p.saveDecisionState(actor.id, nt.resolution.domain, {
        ...ds, pressures: ds.pressures.map((x) => ({ text: x.text, expiresGameTime: x.expiresInDays === null ? null : addMinutes(at, Math.round(x.expiresInDays * 1440)) })),
      });
    }
    const thread: StoryThread = {
      id: newId('thr'), gameId, title: nt.title, summary: nt.summary, status: 'emerging', momentum: 10, urgency: nt.urgency, visibility: nt.visibility,
      participantIds: [...new Set(participants.map((c) => c!.id))], causeEventIds: nt.causeEventIds,
      resolution: { actorId: actor.id, domain: nt.resolution.domain, option: nt.resolution.option, factors: nt.resolution.factors,
        ifAccepted: nt.resolution.ifAccepted, ifRejected: nt.resolution.ifRejected },
      outcome: null, createdGameTime: at, updatedGameTime: at, resolvedGameTime: null, createdAt: p.ctx.now, updatedAt: p.ctx.now,
    };
    p.createThread(thread);
    const ev = p.event('thread_started', `${nt.title}: ${nt.summary}`, observersOf(p, thread), [{ characterId: actor.id, role: 'actor' }], 3, at);
    p.linkThreadEvent(thread.id, ev.id);
    accepted.push(`thread ${thread.id} "${nt.title}"`);
  }
  for (const es of proposal.escalations) {
    const t = p.thread(es.threadId);
    const bad = (reason: string) => rejected.push({ item: `escalation of ${es.threadId}`, reason });
    if (!t || t.status === 'resolved') { bad('no such open thread'); continue; }
    const missing = es.causeEventIds.filter((id) => !eventExists(id));
    if (missing.length) { bad(`cites events that do not exist: ${missing.join(', ')}`); continue; }
    p.updateThread({ ...t, momentum: Math.max(0, Math.min(THREAD_RESOLVES_AT - 1, t.momentum + es.momentumDelta)), updatedGameTime: at, updatedAt: p.ctx.now });
    accepted.push(`escalation ${t.id} ${es.momentumDelta >= 0 ? '+' : ''}${es.momentumDelta}`);
  }
  return { accepted, rejected };
}

async function runDirector(p: WorldPlanner, deps: WorldTurnDeps, at: string) {
  const proposal = await deps.director!(directorSystemPrompt(p.ctx.pack.prompts.director), directorUserPrompt(p, deps.store, at));
  const { accepted, rejected } = applyDirectorProposal(p, deps.store, proposal, at);
  return { ran: true, proposal, accepted, rejected };
}

export { DirectorProposalSchema };
