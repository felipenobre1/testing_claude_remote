import type { Store } from '../db/store.ts';
import { renderNpcBriefing, retrieveNpcPerspective, type NpcContextInput } from '../engine/context.ts';
import type { Trace } from '../engine/trace.ts';
import { findByName } from '../engine/turn.ts';
import { formatGameTime, truncate } from '../engine/util.ts';
import { eur, pct } from '../engine/economy.ts';

// Plain-text views over canonical state and turn traces, for the CLI.

const h = (title: string) => `\n── ${title} ${'─'.repeat(Math.max(0, 70 - title.length))}`;
const j = (v: unknown) => JSON.stringify(v, null, 2);

export function formatTurnList(store: Store, gameId: string): string {
  return store.listTurns(gameId)
    .map((t) => `#${String(t.seq).padStart(3)}  ${t.status.padEnd(13)} ${truncate(t.playerInput.replace(/\s+/g, ' '), 90)}`)
    .join('\n') || '(no turns yet)';
}

export function formatTurn(store: Store, gameId: string, which: string, full = false): string {
  const turn = which === 'last' ? store.lastTurn(gameId) : store.getTurnBySeq(gameId, Number(which));
  if (!turn) return `No turn ${which}.`;
  const t = turn.trace as Trace;
  const out: string[] = [];
  out.push(`TURN #${turn.seq}  status=${turn.status}  request=${turn.requestId}  turn=${turn.id}`);
  out.push(`provider=${t.provider}  revision ${t.baseRevision} → ${t.committedRevision ?? '(unchanged)'}  time before ${t.gameTimeBefore}`);

  out.push(h('PLAYER INPUT'), t.input);
  if (t.scene) out.push(h('SCENE (before)'), `${t.scene.location} — ${t.scene.description}`, `open interaction: ${t.openInteraction ? `${t.openInteraction.id} (${t.openInteraction.channel})` : 'none'}`);
  if (t.interpretation) out.push(h('INTERPRETED INTENT'), j(t.interpretation));
  if (t.resolution) out.push(h('CHARACTER RESOLUTION'), j(t.resolution));
  if (t.generatedCharacter) out.push(h('GENERATED CHARACTER (validated)'), j(t.generatedCharacter));
  if (t.retrieval) {
    const r = t.retrieval;
    out.push(h(`RETRIEVED FOR ${r.npcName} (${r.npcId})`),
      `permitted before ranking: ${j(r.permittedCounts).replace(/\s+/g, ' ')}`,
      `relationships: ${r.relationshipIds.join(', ') || '(none)'}`,
      `memories:  ${r.memories.map((m) => `\n  ${m.id} score=${m.score}  ${m.summary}`).join('') || '(none)'}`,
      `knowledge: ${r.knowledge.map((k) => `\n  ${k.id} score=${k.score}  ${k.topic}`).join('') || '(none)'}`,
      `events:    ${r.events.map((e) => `\n  ${e.id} score=${e.score}  ${e.summary}`).join('') || '(none)'}`,
      `current conversation events: ${r.conversationEventIds.join(', ') || '(new conversation)'}`);
  }
  if (t.documents?.length) {
    out.push(h('SHARED LINKS OPENED'), ...t.documents.map((d) =>
      `  ${d.id} ${d.status} ${d.finalUrl}${d.title ? ` "${d.title}"` : ''} ${d.status === 'ok' ? `(${d.chars} chars)` : `— ${d.error}`}`));
  }
  for (const c of t.llmCalls) {
    out.push(h(`LLM CALL ${c.task} (attempt ${c.attempt}, model ${c.model ?? '-'})`));
    if (full) out.push('[system]', c.system, '');
    if (full || c.task === 'npc_turn') out.push('[user — exact context sent]', c.user, '');
    else out.push('[user — exact context sent]', truncate(c.user, 600), '(use --full for the whole prompt)', '');
    out.push('[raw output]', c.rawText ?? '(none)');
    if (c.problems.length) out.push('[problems]', ...c.problems.map((p) => `  ✗ ${p}`));
  }
  for (const v of t.validation ?? []) {
    out.push(h(`VALIDATION (attempt ${v.attempt})`));
    out.push(...v.accepted.map((a) => `  ✓ ${a.op}: ${'summary' in a ? a.summary : ''}${'topic' in a ? `${a.topic} = ${a.belief}` : ''}${a.notes.length ? `  [${a.notes.join('; ')}]` : ''}`));
    out.push(...v.rejected.map((r) => `  ✗ #${r.index} ${r.reason}\n      ${JSON.stringify(r.proposal)}`));
    if (!v.accepted.length && !v.rejected.length) out.push('  (no state changes proposed)');
  }
  if (t.economy && (t.economy.actions.length || t.economy.results.length)) {
    out.push(h('MECHANICS (deterministic)'), `proposed actions: ${JSON.stringify(t.economy.actions)}`,
      ...t.economy.results.map((r) => `  ${r}`), ...t.economy.actionErrors.map((e) => `  model error: ${e}`));
  }
  if (t.writes) out.push(h('DATABASE WRITES'), ...t.writes.map((w) => `  ${w.op.padEnd(6)} ${w.table.padEnd(14)} ${w.id}${w.note ? `  (${w.note})` : ''}`));
  if (t.error) out.push(h('ERROR'), t.error);
  if (t.response) out.push(h('COMMITTED RESPONSE'), t.response.text);
  return out.join('\n');
}

export function formatCharacter(store: Store, gameId: string, name: string): string {
  const c = findByName(store.listCharacters(gameId), name)[0];
  if (!c) return `No character named "${name}".`;
  const names = new Map(store.listCharacters(gameId).map((x) => [x.id, x.name]));
  const out = [h(`CHARACTER ${c.name} (${c.id})`), j(c)];
  out.push(h('RELATIONSHIPS (owned, directional)'),
    ...store.listRelationshipsFrom(c.id).map((r) => `  → ${names.get(r.toCharacterId)} [${r.source}, ${r.id}]: ${r.summary}`));
  out.push(h('MEMORIES (owned)'),
    ...store.listMemoriesOwnedBy(c.id).map((m) => `  ${m.id} [imp ${m.importance}, emo ${m.emotionalWeight}, ${m.gameTime}] ${m.summary}`));
  out.push(h('KNOWLEDGE (owned)'),
    ...store.listKnowledgeOf(c.id).map((k) => `  ${k.id} ${k.topic} (conf ${k.confidence}; ${k.source}): ${k.belief}`));
  out.push(h('WEB PAGES SEEN'),
    ...store.listDocumentsObservedBy(c.id).map((d) => `  ${d.id} [${d.gameTime}] ${d.status} ${d.finalUrl}${d.title ? ` "${d.title}"` : ''}`));
  out.push(h('EVENTS OBSERVED'),
    ...store.listEventsObservedBy(c.id).map((e) => `  ${e.id} [${e.gameTime}] ${e.type}: ${e.summary}`));
  return out.join('\n');
}

/** Dry run: exactly what this NPC would be given if the player phoned them right now. */
export function formatContext(store: Store, gameId: string, name: string): string {
  const game = store.getGame(gameId)!;
  const npc = findByName(store.listCharacters(gameId).filter((c) => !c.isPlayer), name)[0];
  if (!npc) return `No NPC named "${name}".`;
  const player = store.getCharacter(game.playerCharacterId)!;
  const scene = store.getScene(gameId);
  const open = scene.interactionId ? store.getInteraction(scene.interactionId) : undefined;
  const inThisConversation = open?.participantIds.includes(npc.id);
  const input: NpcContextInput = {
    npcId: npc.id, partner: player, channel: inThisConversation ? open!.channel : 'phone',
    interactionId: inThisConversation ? open!.id : null,
    pendingLines: inThisConversation ? [] : [{ speakerId: null, speakerName: null, text: `${player.name} calls ${npc.name} on the phone.` }],
    gameTime: game.gameTime, sceneLocation: scene.location,
  };
  return `${h(`CONTEXT ${npc.name} WOULD RECEIVE NOW (${inThisConversation ? 'continuing the open conversation' : 'if called now'})`)}\n${renderNpcBriefing(retrieveNpcPerspective(store, input), input)}`;
}

export function formatEvents(store: Store, gameId: string): string {
  const names = new Map(store.listCharacters(gameId).map((x) => [x.id, x.name]));
  return store.listEvents(gameId).map((e) =>
    `${e.id} [${e.gameTime}] ${e.type} (imp ${e.importance})\n    ${e.summary}\n    observers: ${e.observers.map((o) => `${names.get(o.characterId)}/${o.channel}`).join(', ')}` +
    `  participants: ${e.participants.map((p) => `${names.get(p.characterId)}/${p.role}`).join(', ')}`,
  ).join('\n') || '(no events)';
}

export function formatMoney(store: Store, gameId: string): string {
  const names = new Map(store.listCharacters(gameId).map((x) => [x.id, x.name]));
  const companies = new Map(store.listCompanies(gameId).map((c) => [c.id, c.name]));
  const owner = (acctId: string | null) => {
    if (!acctId) return 'outside world';
    const a = store.getAccount(acctId)!;
    return a.ownerKind === 'company' ? companies.get(a.ownerId)! : names.get(a.ownerId)!;
  };
  const out = [h('ACCOUNTS'), ...store.listAccounts(gameId).map((a) => `  ${owner(a.id).padEnd(24)} ${eur(a.balanceCents)}`)];
  out.push(h('COMPANIES'));
  for (const c of store.listCompanies(gameId)) {
    out.push(`  ${c.name} (${c.productStage}, founded ${c.foundedGameTime}, ${c.totalShares} shares) — ${c.description}`,
      ...store.listShareholdings(c.id).map((s) => `    ${names.get(s.characterId)} ${s.shares} shares = ${pct(s.shares, c.totalShares)} (${s.role})`));
  }
  out.push(h('OFFERS'), ...store.listOffers(gameId).map((o) => `  ${o.id} ${names.get(o.fromCharacterId)} → ${names.get(o.toCharacterId)}: ${o.equityPercent}% of ${companies.get(o.companyId)} — ${o.status}`));
  out.push(h('PROMISES'), ...store.listObligations(gameId).map((o) => `  ${o.id} ${names.get(o.debtorId)} → ${names.get(o.creditorId)}: ${o.description}${o.amountCents ? ` (${eur(o.amountCents)})` : ''}${o.dueGameTime ? ` due ${o.dueGameTime}` : ''} — ${o.status}`));
  out.push(h('RECURRING'), ...store.listRecurringPayments(gameId).map((r) => `  ${owner(r.accountId)}: ${r.description} ${eur(r.amountCents)}/month, next ${r.nextDueGameTime}${r.active ? '' : ' (cancelled)'}`));
  out.push(h('LEDGER'), ...store.listTransactions(gameId).map((t) => `  [${t.gameTime}] ${eur(t.amountCents).padStart(12)}  ${owner(t.fromAccountId)} → ${owner(t.toAccountId)}  ${t.description}`));
  return out.join('\n');
}

export function formatFacts(store: Store, gameId: string): string {
  const names = new Map(store.listCharacters(gameId).map((x) => [x.id, x.name]));
  return store.listFacts(gameId).map((f) => `${names.get(f.subject) ?? f.subject}.${f.predicate} = ${f.value}`).join('\n');
}

/** One-line game HUD, built only from canonical state: time · place · cash · companies · promises · conversation. */
export function formatStatusLine(store: Store, gameId: string): string {
  const game = store.getGame(gameId)!;
  const me = game.playerCharacterId;
  const scene = store.getScene(gameId);
  const names = new Map(store.listCharacters(gameId).map((x) => [x.id, x.name.split(' ')[0]]));
  const parts = [
    formatGameTime(game.gameTime).replace(/^(\w{3})\w*,? (\d+) (\w{3})\w* \d{4}/, '$1 $2 $3'),
    scene.location.replace(/, Milan$/, ''),
    eur(store.getAccountOf(gameId, 'character', me)?.balanceCents ?? 0),
  ];
  for (const c of store.listCompaniesOf(me)) {
    const mine = store.listShareholdings(c.id).find((h) => h.characterId === me)!;
    parts.push(`${c.name} ${pct(mine.shares, c.totalShares)} · ${eur(store.getAccountOf(gameId, 'company', c.id)?.balanceCents ?? 0)} · ${c.productStage}`);
  }
  const open = store.listObligationsInvolving(me).filter((o) => o.status === 'open');
  const overdue = open.filter((o) => o.dueGameTime && o.dueGameTime <= game.gameTime).length;
  if (open.length) parts.push(`${open.length} promise${open.length > 1 ? 's' : ''}${overdue ? ` (${overdue} overdue!)` : ''}`);
  const talk = scene.interactionId ? store.getInteraction(scene.interactionId) : undefined;
  if (talk) parts.push(`${talk.channel === 'message' ? 'texting' : talk.channel === 'phone' ? 'on the phone with' : 'with'} ${talk.participantIds.filter((id) => id !== me).map((id) => names.get(id)).join(', ')}`);
  return `── ${parts.join(' · ')} ──`;
}

export function formatStatus(store: Store, gameId: string): string {
  const game = store.getGame(gameId)!;
  const scene = store.getScene(gameId);
  const open = scene.interactionId ? store.getInteraction(scene.interactionId) : undefined;
  const names = new Map(store.listCharacters(gameId).map((x) => [x.id, x.name]));
  const with_ = open ? open.participantIds.filter((id) => id !== game.playerCharacterId).map((id) => names.get(id)).join(', ') : null;
  return [
    `Milan — ${formatGameTime(game.gameTime)}`,
    `${scene.location}. ${scene.description}`,
    open ? `You are in a ${open.channel.replace('_', '-')} conversation with ${with_}.` : '',
  ].filter(Boolean).join('\n');
}
