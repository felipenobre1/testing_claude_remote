import type { Store } from '../db/store.ts';
import type {
  Channel, Character, Fact, GameEvent, Interaction, Knowledge, Memory, Relationship, Scene, TranscriptLine, WebDocument,
} from '../domain/types.ts';
import { formatGameTime, keywords, overlap } from './util.ts';

// ============================================================================
// Context Builder.
//
// Two steps, always in this order:
//   1. PERMISSION FILTER — the only store queries used here are perspective queries
//      (owned by / observed by this character). Facts, other characters' memories and
//      knowledge, and unobserved events are never loaded for an NPC.
//   2. RELEVANCE RANKING — simple signals (importance, recency, keyword/entity overlap)
//      over the already-permitted rows.
// ============================================================================

export const LIMITS = { memories: 8, knowledge: 15, events: 6, conversationLines: 16, documents: 3, docCharsNow: 4000, docCharsEarlier: 800 };

export interface Ranked<T> {
  item: T;
  score: number;
}

/** A character generated during this turn and not yet committed. */
export interface PendingCharacter {
  character: Character;
  relationshipSummary: string;
}

export interface NpcContextInput {
  npcId: string;
  partner: Character; // the player
  channel: Channel;
  interactionId: string | null; // open conversation being continued (null = new conversation)
  pendingLines: TranscriptLine[]; // what the NPC perceives this turn (observable only)
  gameTime: string;
  sceneLocation: string;
  pending?: PendingCharacter;
  pendingDocuments?: WebDocument[]; // pages opened this turn (shared by the partner)
  economy?: string; // companies this NPC is part of, offers and promises involving them (built by the economy planner)
  privateSituation?: string; // this NPC's own decision state (they know their own limits); never shown to anyone else
  resolvedDecision?: string; // engine-resolved outcome to portray (portrayal call only)
  situations?: string; // story threads this NPC is part of
  world?: string; // setting line from the game pack
}

export interface NpcPerspective {
  npc: Character;
  partner: Character;
  relationships: { relationship: Pick<Relationship, 'id' | 'toCharacterId' | 'summary' | 'source'>; towardName: string }[];
  memories: Ranked<Memory>[];
  knowledge: Ranked<Knowledge>[];
  events: Ranked<GameEvent>[];
  conversation: TranscriptLine[];
  conversationEventIds: string[];
  documents: { doc: WebDocument; openedNow: boolean }[];
  permitted: { memories: number; knowledge: number; events: number; relationships: number; documents: number };
}

function rank<T>(items: T[], score: (item: T, recency: number) => number, limit: number): Ranked<T>[] {
  const n = items.length;
  return items
    .map((item, i) => ({ item, score: round(score(item, n <= 1 ? 1 : i / (n - 1))) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
const round = (x: number) => Math.round(x * 100) / 100;

export function retrieveNpcPerspective(store: Store, input: NpcContextInput): NpcPerspective {
  const pending = input.pending;
  const npc = pending?.character ?? store.getCharacter(input.npcId);
  if (!npc || npc.isPlayer) throw new Error(`NPC ${input.npcId} not found`);

  // ---- 1. permission filter: rows owned or observed by this NPC only ----
  const ownRelationships = pending ? [] : store.listRelationshipsFrom(npc.id);
  const ownMemories = pending ? [] : store.listMemoriesOwnedBy(npc.id);
  const ownKnowledge = pending ? [] : store.listKnowledgeOf(npc.id);
  const observed = pending ? [] : store.listEventsObservedBy(npc.id);
  const seenDocuments = pending ? [] : store.listDocumentsObservedBy(npc.id);

  const conversationEvents = observed.filter((e) => input.interactionId && e.interactionId === input.interactionId);
  const pastEvents = observed.filter((e) => !(input.interactionId && e.interactionId === input.interactionId));
  const conversation = [...conversationEvents.flatMap((e) => e.transcript), ...input.pendingLines].slice(-LIMITS.conversationLines);

  // ---- 2. relevance ranking ----
  const query = keywords(conversation.map((l) => l.text).join(' '));
  const partnerId = input.partner.id;

  const memories = rank(ownMemories, (m, recency) =>
    m.importance + 2 * recency + 1.5 * overlap(query, m.summary) + (m.subjectIds.includes(partnerId) ? 1 : 0), LIMITS.memories);
  const knowledge = rank(ownKnowledge, (k, recency) =>
    k.confidence + recency + 1.5 * overlap(query, `${k.topic} ${k.belief}`) + (k.aboutCharacterId === partnerId ? 1 : 0), LIMITS.knowledge);
  const events = rank(pastEvents, (e, recency) =>
    e.importance / 2 + 2 * recency + overlap(query, e.summary), LIMITS.events);

  // Relationships: toward the partner always; toward others only when they come up in the conversation.
  const relationships: NpcPerspective['relationships'] = [];
  if (pending) {
    relationships.push({ relationship: { id: '(pending)', toCharacterId: partnerId, summary: pending.relationshipSummary, source: 'backstory' }, towardName: input.partner.name });
  }
  for (const r of ownRelationships) {
    const toward = r.toCharacterId === partnerId ? input.partner : store.getCharacter(r.toCharacterId);
    if (!toward) continue;
    if (r.toCharacterId === partnerId || overlap(query, toward.name) > 0) relationships.push({ relationship: r, towardName: toward.name });
  }
  // Pages: the ones opened this turn in full, then the most recent earlier ones (shorter).
  const nowDocs = input.pendingDocuments ?? [];
  const earlierDocs = seenDocuments.filter((d) => !nowDocs.some((n) => n.url === d.url)).reverse();
  const documents = [...nowDocs.map((doc) => ({ doc, openedNow: true })), ...earlierDocs.map((doc) => ({ doc, openedNow: false }))]
    .slice(0, LIMITS.documents);

  relationships.sort((a, b) => Number(b.relationship.toCharacterId === partnerId) - Number(a.relationship.toCharacterId === partnerId));

  return {
    npc,
    partner: input.partner,
    relationships,
    memories,
    knowledge,
    events,
    conversation,
    conversationEventIds: conversationEvents.map((e) => e.id),
    documents,
    permitted: {
      memories: ownMemories.length, knowledge: ownKnowledge.length, events: pastEvents.length,
      relationships: ownRelationships.length, documents: seenDocuments.length,
    },
  };
}

/** Ids + scores of what was retrieved, for the turn trace. */
export function perspectiveTrace(p: NpcPerspective) {
  return {
    npcId: p.npc.id,
    npcName: p.npc.name,
    permittedCounts: p.permitted,
    relationshipIds: p.relationships.map((r) => r.relationship.id),
    memories: p.memories.map((m) => ({ id: m.item.id, score: m.score, summary: m.item.summary })),
    knowledge: p.knowledge.map((k) => ({ id: k.item.id, score: k.score, topic: k.item.topic })),
    events: p.events.map((e) => ({ id: e.item.id, score: e.score, summary: e.item.summary })),
    conversationEventIds: p.conversationEventIds,
    documents: p.documents.map((d) => ({ id: d.doc.id, url: d.doc.url, status: d.doc.status, openedNow: d.openedNow })),
  };
}

const short = (gameTime: string) => formatGameTime(gameTime).replace(/^(\w{3})\w*/, '$1');

function channelLine(channel: Channel, partner: string, sceneLocation: string): string {
  switch (channel) {
    case 'phone': return `${partner} is on a phone call with you. You can hear ${partner} but cannot see them or their surroundings.`;
    case 'message': return `${partner} is texting you. You only see the messages.`;
    case 'in_person': return `You are with ${partner} in person at: ${sceneLocation}.`;
  }
}

function line(l: TranscriptLine, npc: Character): string {
  if (!l.speakerId) return `[${l.text}]`;
  return l.speakerId === npc.id ? `You (${npc.name}): ${l.text}` : `${l.speakerName}: ${l.text}`;
}

/** Renders the NPC briefing (the user prompt of the npc_turn call). Contains nothing outside `p`. */
export function renderNpcBriefing(p: NpcPerspective, input: NpcContextInput): string {
  const { npc } = p;
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '(none)');
  const chrono = <T extends { item: { gameTime: string } }>(xs: T[]) => [...xs].sort((a, b) => a.item.gameTime.localeCompare(b.item.gameTime));

  return [
    'CURRENT SITUATION',
    `It is ${formatGameTime(input.gameTime)} (${input.world ?? 'the world'}).`,
    channelLine(input.channel, p.partner.name, input.sceneLocation),
    `You live in / are based in: ${npc.location}.`,
    '',
    'YOUR CHARACTER',
    `Name: ${npc.name}, ${npc.age}${npc.gender ? `, ${npc.gender}` : ''}`,
    `Role: ${npc.role}`,
    `Occupation: ${npc.occupation ?? 'none'}`,
    `Background: ${npc.background}`,
    `Personality: ${npc.personality}`,
    `Traits: ${npc.traits.join(', ')}`,
    `Values: ${npc.values.join(', ')}`,
    `Fears: ${npc.fears.join('; ')}`,
    '',
    'YOUR CURRENT GOALS',
    list(npc.goals),
    '',
    'YOUR RELATIONSHIPS (how you see them)',
    list(p.relationships.map((r) => `${r.towardName}: ${r.relationship.summary}`)),
    '',
    'EARLIER EVENTS YOU WITNESSED (most relevant)',
    list(chrono(p.events).map((e) => `[${short(e.item.gameTime)}] ${e.item.summary}`)),
    '',
    'YOUR MEMORIES (most relevant)',
    list(chrono(p.memories).map((m) => `[${short(m.item.gameTime)}, importance ${m.item.importance}] ${m.item.summary}`)),
    '',
    'WHAT YOU KNOW OR BELIEVE (topic key: belief)',
    list(p.knowledge.map((k) => `${k.item.topic}: ${k.item.belief} (confidence ${k.item.confidence}; ${k.item.source})`)),
    '',
    'YOUR AFFAIRS: HOLDINGS, OFFERS AND PROMISES (exact figures, kept by the game)',
    input.economy || '(none)',
    '',
    'SITUATIONS IN YOUR LIFE',
    input.situations || '(nothing in particular)',
    '',
    ...(input.privateSituation ? ['YOUR PRIVATE SITUATION (only you know this)', input.privateSituation, ''] : []),
    ...(input.resolvedDecision ? ['YOUR DECISION (already settled — express it)', input.resolvedDecision, ''] : []),
    'WEB PAGES YOU HAVE OPENED (exactly as they looked when you opened them)',
    p.documents.length ? p.documents.map((d) => renderDocument(d.doc, d.openedNow)).join('\n\n') : '(none)',
    '',
    'CURRENT CONVERSATION (latest last)',
    p.conversation.map((l) => line(l, npc)).join('\n') || '(nothing yet)',
    '',
    `Respond now as ${npc.name}.`,
  ].join('\n');
}

function renderDocument(d: WebDocument, openedNow: boolean): string {
  const when = openedNow ? 'you just opened it' : `opened ${short(d.gameTime)}`;
  const head = `### ${d.finalUrl}${d.title ? ` — "${d.title}"` : ''} (${when})`;
  if (d.status === 'error') return `${head}\nThe page did not load for you (${d.error}).`;
  const limit = openedNow ? LIMITS.docCharsNow : LIMITS.docCharsEarlier;
  const text = d.text.length > limit ? `${d.text.slice(0, limit)}\n[…page continues]` : d.text;
  return `${head}\n${text || '(the page is essentially empty)'}`;
}

// ---------------------------------------------------------------------------
// Player perspective (for interpreting raw player input). The player may know
// their own canonical facts; they never see NPC-internal state.
// ---------------------------------------------------------------------------

export interface PlayerPerspective {
  player: Character;
  facts: Fact[];
  scene: Scene;
  gameTime: string;
  knownCharacters: Character[];
  interaction: Interaction | null;
  conversation: TranscriptLine[];
  news: GameEvent[]; // recent messages and world events the player actually observed
}

export function retrievePlayerPerspective(store: Store, gameId: string): PlayerPerspective {
  const game = store.getGame(gameId)!;
  const player = store.getCharacter(game.playerCharacterId)!;
  const scene = store.getScene(gameId);
  const interaction = scene.interactionId ? store.getInteraction(scene.interactionId) ?? null : null;
  const conversation = interaction
    ? store.listEventsObservedBy(player.id).filter((e) => e.interactionId === interaction.id).flatMap((e) => e.transcript).slice(-10)
    : [];
  return {
    player,
    facts: store.listFactsAbout(gameId, player.id),
    scene,
    gameTime: game.gameTime,
    knownCharacters: store.listCharacters(gameId).filter((c) => !c.isPlayer),
    interaction,
    conversation,
    news: store.listEventsObservedBy(player.id).filter((e) => ['message', 'thread_resolved', 'thread_started', 'decision', 'promise_overdue'].includes(e.type)).slice(-6),
  };
}

export function renderPlayerBriefing(p: PlayerPerspective, input: string, economy = '', world = ''): string {
  const names = new Map(p.knownCharacters.map((c) => [c.id, c.name]));
  const partner = p.interaction?.participantIds.filter((id) => id !== p.player.id).map((id) => names.get(id) ?? id) ?? [];
  return [
    `PLAYER CHARACTER: ${p.player.name}, ${p.player.age}. ${p.player.background}`,
    `${p.player.name.toUpperCase()}'S SITUATION: ${p.facts.map((f) => `${f.predicate}=${f.value}`).join('; ')}`,
    `RESOURCES, OFFERS AND PROMISES:\n${economy || '(none)'}`,
    `RECENT MESSAGES AND NEWS:\n${p.news.map((e) => `[${e.gameTime}] ${e.summary}`).join('\n') || '(none)'}`,
    `TIME: ${formatGameTime(p.gameTime)} (${world})`,
    `LOCATION: ${p.scene.location}. ${p.scene.description}`,
    `KNOWN CHARACTERS: ${p.knownCharacters.map((c) => `${c.name} (${c.role})`).join('; ') || '(none yet)'}`,
    `OPEN CONVERSATION: ${p.interaction ? `${p.interaction.channel} with ${partner.join(', ')}` : 'none'}`,
    'RECENT CONVERSATION LINES:',
    p.conversation.map((l) => (l.speakerName ? `${l.speakerName}: ${l.text}` : `[${l.text}]`)).join('\n') || '(none)',
    '',
    'PLAYER INPUT:',
    input,
  ].join('\n');
}
