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
  /** Someone attacks the player as part of this moment (an ambush, a hired blade, a jealous husband). The game decides how it goes. */
  attack: z.object({ byName: z.string().max(80), intent: z.enum(['kill', 'hurt', 'humiliate', 'drive_off']), threat: z.number().int().min(1).max(5), how: z.string().min(3).max(200) }).nullable(),
  /** A concrete proposal the speaker makes to the player (becomes a real offer the player can accept or refuse). */
  offer: z.object({
    kind: z.string().max(40), label: z.string().max(80).nullable(), terms: z.array(z.object({ key: z.string().max(40), value: z.number() })).max(6),
    description: z.string().min(3).max(300),
  }).nullable(),
});
export type SceneBeat = z.infer<typeof SceneBeatSchema>;
/** Lenient parsing: a beat without an offer field has no offer. */
export const SceneBeatParseSchema = SceneBeatSchema.extend({ offer: SceneBeatSchema.shape.offer.default(null), attack: SceneBeatSchema.shape.attack.default(null) });

const THRESHOLD: Record<WorldSeed['style']['pace'], number> = { quiet: Infinity, steady: 4, eventful: 2 };

/**
 * Is a beat due? Counts the player's recent turns in which nothing came to them (no NPC answered,
 * no beat). Long stretches of time also make one due (outside quiet worlds).
 */
export function beatDue(store: Store, gameId: string, pace: WorldSeed['style']['pace'], thisTurn: { npcResponded: boolean; minutes: number; pressing?: number }): boolean {
  if (thisTurn.pressing) return true; // the world must answer something the player did — at any pace
  if (pace === 'quiet') return false;
  if (thisTurn.npcResponded) return false; // someone is already talking to the player
  if (thisTurn.minutes >= 6 * 60) return true;
  let quietTurns = 1; // this one
  for (const t of store.listTurns(gameId).filter((x) => x.status === 'committed').reverse()) {
    const r = t.response as { npc?: unknown; beat?: unknown; held?: unknown } | null;
    if (!r || r.beat || r.npc || r.held) break; // a fight or a conversation is not a quiet turn
    quietTurns++;
  }
  return quietTurns >= THRESHOLD[pace];
}

export function beatSystemPrompt(bible: string, world: WorldContext, offerKinds = ''): string {
  return `You are the storyteller of a living world. Something is about to happen TO the player — now, in this scene.
THE WORLD BIBLE (binding):
${bible}

Propose ONE thing that happens now and puts a real decision in front of the player:
- Proportionality: what happens to the player follows from what they did and said, to whom, where, and who saw it. People do not attack without a reason that fits them and the moment — but insults, crimes and violence against the powerful are answered, often by others acting for them (guards, kin, hirelings, the law).
- It grows out of the world: its factions, dangers and customs, the people already in play, what just happened, and the player's AMBITION (opportunities and obstacles on the road to it; rivals; costs; temptations). Never a random event with no roots.
- kind: arrival (someone comes), message, encounter (a stranger approaches), incident (something happens nearby), news (word reaches them), opportunity, threat.
- perceived: what the player sees/hears, concretely and plainly, 1–3 sentences. Do NOT decide what the player does or how it ends.
- involves: exact names of existing living characters involved (never the player). newPerson: a new ordinary person if the moment needs one (full profile; never a real public figure); otherwise null.
- opensConversation: if someone addresses the player directly, their name (existing or the newPerson), the channel, and their first words. null otherwise.
- choice: the decision this forces, in one line (e.g. "Take the offered blade and the debt that comes with it, or walk away").
- attack: when the moment is violence against the player (an ambush, someone they wronged, a robbery, an assassin), who attacks (existing name or the newPerson), intent (kill / hurt / humiliate / drive_off), threat 1–5 (how dangerous the attacker is) and how. The game decides how it goes; perceived shows the attack beginning, never its outcome. Otherwise null. The player is not protected by the story: enemies they made will come for them.
- offer: when the speaker proposes a concrete deal to the player (pay for a job, a sparring bout for coins, a blade on credit), state it so the player can accept or refuse it: kind and terms from these offer kinds, a short label and description; otherwise null.
${offerKinds}
- Respect the bible: pace, tone, realism, player significance. ${contentRule(world.violence, 'narrator')}${languageRule(world.language, 'title, perceived, choice and opensConversation.openingLine')}
Return JSON only.`;
}

export function beatUserPrompt(opts: {
  gameTime: string; scene: { location: string; description: string }; player: Character; people: Character[];
  recent: string[]; notes: string[]; justNow: string; playerState: string[]; pressing?: string[];
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
    ...(opts.pressing?.length ? ['', 'CONSEQUENCES DUE NOW — this beat MUST be the world answering this, proportionally (who was wronged, their power, allies, kin, witnesses, the law): arrest, the watch, revenge, a bounty, a summons, fear, respect, a price on the player\'s head…', ...opts.pressing.map((x) => `- ${x}`)] : []),
  ].join('\n');
}

/**
 * Fixes harmless slips in place before checking: the new person listed in involves too, exact-name casing,
 * duplicates, and a new conversation while one is already open (it becomes an interruption instead).
 */
export function normalizeBeat(b: SceneBeat, ctx: { characters: Character[]; conversationOpen: boolean }): void {
  const byName = (n: string) => ctx.characters.find((c) => c.name.toLowerCase() === n.trim().toLowerCase());
  const newName = b.newPerson?.name.trim().toLowerCase();
  b.involves = [...new Set(b.involves.filter((n) => n.trim().toLowerCase() !== newName).map((n) => byName(n)?.name ?? n.trim()))];
  if (b.opensConversation && ctx.conversationOpen) b.opensConversation = null;
}

export function beatProblems(b: SceneBeat, ctx: { characters: Character[]; playerId: string; conversationOpen: boolean }): string[] {
  normalizeBeat(b, ctx);
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
  }
  if (b.offer && !b.opensConversation) problems.push('offer: someone must be speaking to the player to make an offer (opensConversation)');
  if (b.attack) {
    const n = b.attack.byName.trim().toLowerCase();
    const ok = (b.newPerson && b.newPerson.name.toLowerCase() === n) || b.involves.some((x) => x.toLowerCase() === n);
    if (!ok) problems.push('attack: the attacker must be in involves or be the newPerson');
  }
  return problems;
}

// ---- narrator ----

export const NarrationSchema = z.object({
  prose: z.string().min(20).max(8000),
  /** 2–3 next moves, written after everything is decided — they answer the situation as the passage ends. */
  suggestions: z.array(z.string().min(3).max(160)).max(3),
  /** The game's result lines in the player's language (same count and numbers); [] when the player plays in English. */
  lines: z.array(z.string().max(800)).max(40),
});
/** Parsing is lenient about the two extra fields (older scripted replies, a model that omits them). */
export const NarrationParseSchema = NarrationSchema.extend({
  suggestions: NarrationSchema.shape.suggestions.default([]),
  lines: NarrationSchema.shape.lines.default([]),
});
export type Narration = z.infer<typeof NarrationSchema>;

export function narratorSystemPrompt(world: WorldContext, bible: string, playerName: string): string {
  return `You are the narrator of an interactive novel set in ${world.line}. The reader is ${playerName}; write in the second person, present tense.
THE WORLD BIBLE (binding):
${bible}

Write this turn as a passage of a novel:
- Put the reader inside the scene: the place (light, sounds, smells, temperature, objects), their body (breath, pain, fatigue, hunger), what they feel — concrete, specific, never generic. Vary rhythm; no purple prose, no clichés.
- CONTINUITY: the PREVIOUS PASSAGE is what the reader has just read. Continue from it like the next paragraph of the same book. Do not describe the place, the light, the smells, the weather or the reader's gear again unless something changed (a new place, time passing, a new sense detail that matters). Never reuse its images or phrases.
- The reader just wrote their own words and actions: do NOT repeat them back. Show their effect instead (a reaction, a silence, the other person's face); at most echo a few words when it matters.
- Everything in THE FACTS OF THIS TURN is decided and true. Narrate it faithfully: never change, soften or add outcomes (who wins, who dies, what is found, what is paid), never invent numbers. You may show HOW it happened.
- A fight goes exchange by exchange. If the facts show an exchange but not that the fight is over, narrate only that exchange — the blows, the breath, the ground, the faces — and stop in the middle of it, with the opponent's next threat clear: the player chooses the next move. Suggestions are then concrete moves for this moment of the fight (and a way out).
- Quote every line of dialogue listed under WORDS SPOKEN exactly as written (you may add who says it, how, gestures around it). Do not invent other dialogue for anyone.
- Never decide what ${playerName} does, says or feels about a choice next.
- Never move the reader or let time pass beyond THE FACTS: the passage ends where WHERE THE READER IS AT THE END says, at that time. Do not narrate a departure, a journey or an arrival the facts don't contain. If the reader only said they will go somewhere, they have not gone yet.
- Write the final text only: never correct yourself on the page (no "a fiddle — no, a lute").
- Characters keep their gender (see PEOPLE HERE); refer to each person the same way every time.
- Someone MET FOR THE FIRST TIME is a stranger to the reader: before their words, show how the reader finds or notices them and how the reader approaches (what they did or said to start it), and what the person looks like and how they come across. Never write as if a conversation were already under way. The reader learns their name only when it is given (they introduce themselves, someone names them); until then describe them ("the older student").
- The reader's body is exactly THE READER'S CONDITION: never invent injuries, objects in wounds, illness or lost belongings the facts don't state.
- End on the moment that asks for ${playerName}'s decision — the tension, the open question, the person waiting for an answer. Do not list options.
- Length follows the moment: an exchange of words = one short paragraph around the dialogue; an action with consequences = 1–3 paragraphs; a new place or a big event = up to 5.
- ${contentRule(world.violence, 'narrator')}

Also return:
- suggestions: 2–3 next moves for the reader as short imperative phrases, grounded in how YOUR passage ends — above all the decision now in front of them (accept, refuse, answer, flee, bargain…) — and in what they know (people, places, upcoming events). Never repeat PREVIOUS IDEAS, never suggest what the reader just did.
- lines: ${localized(world.language) ? `THE RESULT LINES rendered in ${world.language}, same count and order; keep emoji, names and every number exactly (you may adapt decimal separators).` : '[] (the reader plays in English).'}${languageRule(world.language, 'the prose, suggestions and lines')}
Return JSON: { "prose": "...", "suggestions": [...], "lines": [...] }`;
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
  endLocation?: string; // where the reader is when the passage ends (canonical)
  people?: string[]; // "Name (role, gender)" for everyone in the scene
  newPeople?: string[]; // met for the first time this turn: "Name (role, gender) — what they look like and how they come across"
  resultLines?: string[]; // the game's result lines, to be rendered in the player's language
  previousIdeas?: string[];
  previousPassage?: string; // what the reader read last turn (for continuity; never repeated)
}

export const localized = (language: string) => Boolean(language) && !/^english$/i.test(language.trim());

export function narratorUserPrompt(n: NarratorInput): string {
  return [
    ...(n.previousPassage ? ['PREVIOUS PASSAGE (already read — continue from it, do not repeat it):', n.previousPassage, ''] : []),
    `TIME: ${formatGameTime(n.gameTime)}`,
    `PLACE: ${n.location}. ${n.sceneDescription}`,
    ...(n.playerState.length ? ['THE READER\'S CONDITION:', ...n.playerState] : []),
    `WHAT THE PLAYER WROTE: ${n.input}`,
    ...(n.playerSaid ? [`THE PLAYER SAID (do not repeat it back): "${n.playerSaid}"`] : []),
    ...(n.playerDid ? [`THE PLAYER DID: ${n.playerDid}`] : []),
    ...(n.draftNarration ? [`SHORT ACCOUNT OF THE PLAYER'S OWN ACTIONS: ${n.draftNarration}`] : []),
    'THE FACTS OF THIS TURN (decided by the game):', ...(n.facts.length ? n.facts.map((f) => `- ${f}`) : ['- (nothing beyond the player\'s own actions)']),
    'WORDS SPOKEN (quote exactly):', ...(n.words.length ? n.words.map((w) => `- ${w.speaker}${w.how ? ` (${w.how})` : ''}: "${w.text}"`) : ['- (none)']),
    ...(n.conversationEnded ? ['The conversation ends here.'] : []),
    ...(n.choice ? [`THE DECISION NOW IN FRONT OF THE PLAYER: ${n.choice}`] : []),
    ...(n.people?.length ? [`PEOPLE HERE: ${n.people.join('; ')}`] : []),
    ...(n.newPeople?.length ? ['MET FOR THE FIRST TIME THIS TURN (the reader has never seen them before):', ...n.newPeople.map((p) => `- ${p}`)] : []),
    ...(n.endLocation ? [`WHERE THE READER IS AT THE END: ${n.endLocation}`] : []),
    ...(n.previousIdeas?.length ? [`PREVIOUS IDEAS (do not repeat): ${n.previousIdeas.join(' · ')}`] : []),
    ...(n.resultLines?.length ? ['THE RESULT LINES (the game shows these under your passage):', ...n.resultLines.map((l, i) => `${i + 1}. ${l}`)] : []),
  ].join('\n');
}

const squash = (s: string) => s.toLowerCase().replace(/[\s"'“”‘’«».,!?;:—–-]+/g, ' ').trim();

/** Every spoken line must appear verbatim (modulo punctuation/spacing) in the prose. */
export function narrationProblems(prose: string, words: NarratorInput['words']): string[] {
  const p = squash(prose);
  return words.filter((w) => w.text.trim() && !p.includes(squash(w.text))).map((w) => `the prose must quote ${w.speaker}'s words exactly: "${w.text}"`);
}

const numbers = (s: string) => (s.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/\D/g, '')).sort();

/** Rendered result lines must match the originals one-to-one, with exactly the same numbers. */
export function linesProblems(lines: string[], source: string[]): string[] {
  if (lines.length !== source.length) return [`lines must have exactly ${source.length} entries (one per RESULT LINE), got ${lines.length}`];
  return source.flatMap((src, i) => (numbers(src).join('|') === numbers(lines[i]!).join('|') ? [] : [`lines[${i}] must keep every number of RESULT LINE ${i + 1} exactly`]));
}
