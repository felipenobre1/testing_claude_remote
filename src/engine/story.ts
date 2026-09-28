import { z } from 'zod';
import type { Store } from '../db/store.ts';
import { CharacterProposalSchema } from '../domain/schemas.ts';
import type { Character } from '../domain/types.ts';
import type { WorldSeed } from '../domain/world.ts';
import { contentRule, languageRule, type WorldContext } from './prompts.ts';
import { formatGameTime } from './util.ts';

// ============================================================================
// Storyteller (generic): the world comes to the player, and each turn reads like a book.
//
//   Scene beats — a pacing clock (set by the world's pace) decides WHEN something happens to the
//   player; the model proposes WHAT (an arrival, a message, a threat…), grounded in the world, the
//   people in it and the player's ambition. The engine validates it and makes it canonical.
//
//   Narrator — after the engine has decided everything (actions, fights, decisions, the world turn,
//   the beat), the narrator writes the turn as prose. It may not change outcomes: NPC words are quoted
//   verbatim and results are facts it must respect. It ends at a moment of choice.
// ============================================================================

// ---- scene beats ----

export const BEAT_KINDS = ['arrival', 'message', 'encounter', 'incident', 'news', 'opportunity', 'threat'] as const;

export const SceneBeatSchema = z.object({
  kind: z.enum(BEAT_KINDS),
  title: z.string().min(3).max(120),
  /** What the player perceives, plainly (the narrator dresses it). No outcomes of the player's future choices. */
  perceived: z.string().min(10).max(800),
  involves: z.array(z.string().max(80)).max(4), // existing, living characters by exact name
  newPerson: CharacterProposalSchema.nullable(), // someone who did not exist yet (e.g. a stranger who approaches)
  opensConversation: z.object({
    name: z.string().max(80), channel: z.enum(['in_person', 'phone', 'message']), openingLine: z.string().min(1).max(600),
  }).nullable(),
  /** The decision this puts in front of the player, in one line. */
  choice: z.string().min(5).max(300),
});
export type SceneBeat = z.infer<typeof SceneBeatSchema>;

const THRESHOLD: Record<WorldSeed['style']['pace'], number> = { quiet: Infinity, steady: 4, eventful: 2 };

/**
 * Is a beat due? Counts the player's recent turns in which nothing came to them (no NPC answered,
 * no beat). Long stretches of time also make one due (outside quiet worlds).
 */
export function beatDue(store: Store, gameId: string, pace: WorldSeed['style']['pace'], thisTurn: { npcResponded: boolean; minutes: number }): boolean {
  if (pace === 'quiet') return false;
  if (thisTurn.npcResponded) return false; // someone is already talking to the player
  if (thisTurn.minutes >= 6 * 60) return true;
  let quietTurns = 1; // this one
  for (const t of store.listTurns(gameId).filter((x) => x.status === 'committed').reverse()) {
    const r = t.response as { npc?: unknown; beat?: unknown } | null;
    if (!r || r.beat || r.npc) break;
    quietTurns++;
  }
  return quietTurns >= THRESHOLD[pace];
}

export function beatSystemPrompt(bible: string, world: WorldContext): string {
  return `You are the storyteller of a living world. Something is about to happen TO the player — now, in this scene.
THE WORLD BIBLE (binding):
${bible}

Propose ONE thing that happens now and puts a real decision in front of the player:
- It grows out of the world: its factions, dangers and customs, the people already in play, what just happened, and the player's AMBITION (opportunities and obstacles on the road to it; rivals; costs; temptations). Never a random event with no roots.
- kind: arrival (someone comes), message, encounter (a stranger approaches), incident (something happens nearby), news (word reaches them), opportunity, threat.
- perceived: what the player sees/hears, concretely and plainly, 1–3 sentences. Do NOT decide what the player does or how it ends.
- involves: exact names of existing living characters involved (never the player). newPerson: a new ordinary person if the moment needs one (full profile; never a real public figure); otherwise null.
- opensConversation: if someone addresses the player directly, their name (existing or the newPerson), the channel, and their first words. null otherwise.
- choice: the decision this forces, in one line (e.g. "Take the offered blade and the debt that comes with it, or walk away").
- Respect the bible: pace, tone, realism, player significance. ${contentRule(world.violence, 'narrator')}${languageRule(world.language, 'title, perceived, choice and opensConversation.openingLine')}
Return JSON only.`;
}

export function beatUserPrompt(opts: {
  gameTime: string; scene: { location: string; description: string }; player: Character; people: Character[];
  recent: string[]; notes: string[]; justNow: string; playerState: string[];
}): string {
  return [
    `NOW: ${formatGameTime(opts.gameTime)}`,
    `SCENE: ${opts.scene.location}. ${opts.scene.description}`,
    `THE PLAYER: ${opts.player.name}, ${opts.player.age}. ${opts.player.background}`,
    ...(opts.playerState.length ? ['PLAYER STATE:', ...opts.playerState] : []),
    'PEOPLE IN THE WORLD:', ...(opts.people.length ? opts.people.map((c) => `- ${c.name} (${c.role}${c.status && c.status !== 'alive' ? `, ${c.status.toUpperCase()}` : ''}) — ${c.location}`) : ['(none yet)']),
    'WHAT HAS HAPPENED RECENTLY:', ...(opts.recent.length ? opts.recent : ['(nothing yet)']),
    ...(opts.notes.length ? ['WHAT THE PLAYER KNOWS:', ...opts.notes] : []),
    `WHAT THE PLAYER JUST DID: ${opts.justNow || '(nothing in particular)'}`,
  ].join('\n');
}

export function beatProblems(b: SceneBeat, ctx: { characters: Character[]; playerId: string; conversationOpen: boolean }): string[] {
  const problems: string[] = [];
  const byName = (n: string) => ctx.characters.find((c) => c.name.toLowerCase() === n.trim().toLowerCase());
  for (const n of b.involves) {
    const c = byName(n);
    if (!c) problems.push(`involves: "${n}" is not an existing character (use exact names, or newPerson)`);
    else if (c.id === ctx.playerId) problems.push('involves: never the player');
    else if (c.status === 'dead') problems.push(`involves: ${c.name} is dead`);
  }
  if (b.newPerson && byName(b.newPerson.name)) problems.push(`newPerson: "${b.newPerson.name}" already exists — put them in involves instead`);
  if (b.opensConversation) {
    const n = b.opensConversation.name.toLowerCase();
    const ok = (b.newPerson && b.newPerson.name.toLowerCase() === n) || b.involves.some((x) => x.toLowerCase() === n);
    if (!ok) problems.push('opensConversation: the speaker must be in involves or be the newPerson');
    if (ctx.conversationOpen) problems.push('opensConversation: the player is already in a conversation — make it an interruption without a new conversation (opensConversation null)');
  }
  return problems;
}

// ---- narrator ----

export const NarrationSchema = z.object({
  prose: z.string().min(20).max(8000),
});

export function narratorSystemPrompt(world: WorldContext, bible: string, playerName: string): string {
  return `You are the narrator of an interactive novel set in ${world.line}. The reader is ${playerName}; write in the second person, present tense.
THE WORLD BIBLE (binding):
${bible}

Write this turn as a passage of a novel:
- Put the reader inside the scene: the place (light, sounds, smells, temperature, objects), their body (breath, pain, fatigue, hunger), what they feel — concrete, specific, never generic. Vary rhythm; no purple prose, no clichés.
- Everything in THE FACTS OF THIS TURN is decided and true. Narrate it faithfully: never change, soften or add outcomes (who wins, who dies, what is found, what is paid), never invent numbers. You may show HOW it happened.
- Quote every line of dialogue listed under WORDS SPOKEN exactly as written (you may add who says it, how, gestures around it). Do not invent other dialogue for anyone.
- Never decide what ${playerName} does, says or feels about a choice next.
- End on the moment that asks for ${playerName}'s decision — the tension, the open question, the person waiting for an answer. Do not list options.
- Length: 2–6 paragraphs; shorter for small moments.
- ${contentRule(world.violence, 'narrator')}${languageRule(world.language, 'the prose')}
Return JSON: { "prose": "..." }`;
}

export interface NarratorInput {
  gameTime: string;
  location: string;
  sceneDescription: string;
  playerState: string[];
  input: string; // what the player typed
  playerSaid: string | null;
  playerDid: string | null;
  draftNarration: string; // the interpreter's short account of the player's own actions
  facts: string[]; // deterministic results + witnessed outcomes + world developments + the beat
  words: { speaker: string; text: string; how: string }[];
  conversationEnded: boolean;
  choice: string | null;
}

export function narratorUserPrompt(n: NarratorInput): string {
  return [
    `TIME: ${formatGameTime(n.gameTime)}`,
    `PLACE: ${n.location}. ${n.sceneDescription}`,
    ...(n.playerState.length ? ['THE READER\'S CONDITION:', ...n.playerState] : []),
    `WHAT THE PLAYER WROTE: ${n.input}`,
    ...(n.playerSaid ? [`THE PLAYER SAYS: "${n.playerSaid}"`] : []),
    ...(n.playerDid ? [`THE PLAYER DOES: ${n.playerDid}`] : []),
    ...(n.draftNarration ? [`SHORT ACCOUNT OF THE PLAYER'S OWN ACTIONS: ${n.draftNarration}`] : []),
    'THE FACTS OF THIS TURN (decided by the game):', ...(n.facts.length ? n.facts.map((f) => `- ${f}`) : ['- (nothing beyond the player\'s own actions)']),
    'WORDS SPOKEN (quote exactly):', ...(n.words.length ? n.words.map((w) => `- ${w.speaker}${w.how ? ` (${w.how})` : ''}: "${w.text}"`) : ['- (none)']),
    ...(n.conversationEnded ? ['The conversation ends here.'] : []),
    ...(n.choice ? [`THE DECISION NOW IN FRONT OF THE PLAYER: ${n.choice}`] : []),
  ].join('\n');
}

const squash = (s: string) => s.toLowerCase().replace(/[\s"'“”‘’«».,!?;:—–-]+/g, ' ').trim();

/** Every spoken line must appear verbatim (modulo punctuation/spacing) in the prose. */
export function narrationProblems(prose: string, words: NarratorInput['words']): string[] {
  const p = squash(prose);
  return words.filter((w) => w.text.trim() && !p.includes(squash(w.text))).map((w) => `the prose must quote ${w.speaker}'s words exactly: "${w.text}"`);
}
