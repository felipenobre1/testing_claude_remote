import type { DraftRow, Store } from '../db/store.ts';
import { applyDraftChanges, CopilotTurnSchema, EMPTY_DRAFT, WorldDraftSchema, type CopilotTurn, type WorldDraft } from '../domain/world.ts';
import type { LLMProvider } from '../llm/provider.ts';
import type { GamePack } from '../packs/types.ts';
import { newId } from './util.ts';
import { compileDraft, createGameFromSeed, draftView, seedSummary } from './worldSeed.ts';

// ============================================================================
// World Creation Copilot (generic).
//
//   IDEA → conversation → WorldDraft (persistent, editable, not canonical)
//        → final summary → explicit approval → WorldSeed (immutable) → canonical game.
//
// The model proposes the reply, the updated draft and the player's intent. The engine decides:
// it persists the draft, compiles it, shows the summary, and creates the game only when the
// player explicitly approves the exact summary they were shown. Nothing canonical exists before.
// ============================================================================

export type DraftStatus = DraftRow['status'];

export interface CreationResult {
  draftId: string;
  status: DraftStatus;
  /** What to show the player. */
  text: string;
  /** Set once the world is created. */
  gameId?: string;
  opening?: string;
}

export const COPILOT_GREETING = [
  "Let's build the world you'll live in.",
  'What kind of world or story do you want to live in? Describe it however you like — a place, a time, who you are, what you want.',
  "I'll only ask about what matters for the start; the rest can emerge in play.",
].join('\n');

const HISTORY = 16; // messages of conversation the Copilot sees each turn

export function copilotSystemPrompt(packs: GamePack[]): string {
  return `You are the World Creation Copilot of a living story game. Through natural conversation you help the player design the world they will live in. You are a design collaborator — not a form, not a narrator, not a game master yet.

HOW TO WORK
- Understand what the player wants. Offer concrete, specific proposals instead of long lists of questions; ask at most one or two questions per reply, only about what matters for the start.
- Don't ask about what the player already told you or what can be inferred. When the player delegates ("you decide", "whatever fits"), choose sensible defaults, put them in the draft, and say briefly what you chose.
- Scope discipline: settle only what the opening needs. If the player drifts into details that can be discovered in play (a rival's full history, a distant region's economy), say so plainly — "we don't need to decide that yet; it can emerge in play" — and move on.
- Challenge contradictions honestly and specifically (e.g. "an ordinary nobody whose father rules the planet" — that is not a nobody). Put each unresolved contradiction in draft.contradictions and remove it only once the player resolves it. Never silently pick a side.
- Player significance must fit the background: a royal heir, a famous name or unusual power is significant; say so.
- Known worlds (novels, films, games, real history) are references: agree the canon policy — background_only (canon as inspiration), history_continues_unless_changed (established events proceed unless the story changes them), alternate_from_start (diverges from the moment play begins), original_world (no external canon). Paraphrase; never reproduce copyrighted text.
- Starting situations are conditions already in motion, never outcomes: no predetermined plot, no destiny, no guaranteed success or failure. Create only the people the opening needs (usually 0–4); everyone else will be created when play needs them.
- Start where the story starts, not before it. Establish the player's STARTING POSITION from their history: what they have already made or own (player.assets — with real numbers and honest known problems), what they can and can't do, who they already know (usually few, weak ties), concrete open leads with dates (openLeads — events, deadlines, communities), one or two pressures, and the pack's startingStage. Check it against the backstory: someone who "can't code and has no money" did not build the MVP alone — ask who did.
- Money is part of the start: propose an approximate price list for this place and time (economy.priceList — 10–20 everyday and domain-relevant items at realistic prices), the player's monthly living costs given their circumstances (someone living with parents pays little rent; everyday spending can be one "daily life" line) and any monthly income. For real places use realistic current prices; for invented worlds anchor one price (a meal) and keep the rest proportional. Show these briefly and let the player correct them.
- historicalContext: the relevant recent history and state of things everyone in this world knows (for the real world: real, verifiable context from the months before the start, relevant to the player's goals; hedge anything uncertain). Everyone in the game shares it. Unless the player asks for the past, start in the present.
- Learn the player's AMBITION (player.ambition: what they dream of becoming) and anything else they want the story to know about them; the story will push toward it and against it. Record numeric traits a pack uses in player.attributes.
- Settle how the story should feel: style.pace (quiet: the world waits; steady; eventful: the world keeps coming at the player and forcing choices), style.violence (none / non_graphic / graphic: ask, never assume graphic) and style.narration (literary: each turn written like a novel; concise: short game text). Offer sensible defaults for the kind of world.
- If the player has a real product or website, put its real URL in the asset — people in the world will be able to open it.
- Never start playing: no scene narration, no dialogue from characters, no events happening. That begins after approval.
- Replies are short and conversational (a few sentences). No headings, no forms.
- Reply in the language the player writes in, and record it in style.language (e.g. "Brazilian Portuguese") — the whole game will be played in it. Draft content can be in that language too; JSON keys and enum values stay English.

THE DRAFT
Send ONLY what changes. changes has one entry per section of CURRENT DRAFT (premise, setting, style, player, economy, openLeads, actors, …): put the section's COMPLETE new value (same shape as in CURRENT DRAFT, all its fields) when anything in it changes, and null for sections that stay as they are. To clear a section entirely, list it in reset. Keep everything already decided unless the player changes it; when they revise something, update only that and what depends on it.
Capture everything the player tells you in the same turn (name, place, money, product, URL…) — don't wait to be asked twice.
setting.startDate is local time "YYYY-MM-DDTHH:MM" (map any calendar to that form); player.startingMoney is in major units of player.currency.
initialSituations[].involves lists starting character names or "player". For a mystery or intrigue, decide its answer now so it cannot drift: secrets (the hidden truths — who did it, why, who knows what; knownBy = starting characters), clues (physical traces at a place: what is found, the skill to find it, difficulty 1–5) and deadlines (what happens at a fixed time unless the player changes it). If the player wants to be surprised, decide these without describing them in your reply. unresolvedQuestions: only what must be settled before the start.

GAME PACKS (the mechanics that run the world — pick packId with the player; infer it when obvious):
${packs.map((p) => `- ${p.id}: ${p.worldCreation.summary}\n${p.worldCreation.guidance.split('\n').map((l) => `    ${l}`).join('\n')}${p.worldCreation.stages ? `\n    startingStage options: ${p.worldCreation.stages.map((x) => `${x.id} (${x.description})`).join('; ')}${p.worldCreation.defaultStage ? ` — default ${p.worldCreation.defaultStage}` : ''}` : ''}${p.worldCreation.assetKinds ? `\n    asset kinds with mechanics: ${p.worldCreation.assetKinds.map((k) => `${k.kind} (${k.description}; metrics: ${k.metrics.join(', ')})`).join('; ')}` : ''}`).join('\n')}

INTENT (what the player wants with their latest message)
- discuss: designing, revising, asking (the default).
- summarize: they ask what has been decided so far. The engine prints the decided list itself; your reply only mentions what is still open, in one or two lines.
- request_finalize: they want to start / create the world / play. The engine checks the draft and shows the final summary for approval; your reply is one short line.
- confirm_finalize: ONLY when STATUS says a final summary is awaiting approval AND their latest message clearly approves it. If they approve but also change something, that is discuss (a change needs a new summary).
- abandon: they want to throw this world away entirely.
For confirm_finalize and abandon, approvalQuote = their exact words from the latest message that express it; otherwise null.`;
}

export function copilotUserPrompt(opts: { draft: WorldDraft; awaiting: string | null; history: { role: string; text: string }[]; input: string }): string {
  return [
    opts.awaiting ? `STATUS: A FINAL SUMMARY IS AWAITING THE PLAYER'S APPROVAL:\n${opts.awaiting}` : 'STATUS: drafting (no summary awaiting approval).',
    '',
    `CURRENT DRAFT:\n${JSON.stringify(opts.draft)}`,
    '',
    `CONVERSATION SO FAR (most recent last):\n${opts.history.map((m) => `${m.role === 'player' ? 'PLAYER' : 'COPILOT'}: ${m.text}`).join('\n') || '(none)'}`,
    '',
    `PLAYER'S NEW MESSAGE: ${opts.input}`,
  ].join('\n');
}

const norm = (s: string) => s.toLowerCase().replace(/[\s"'“”‘’.,!?;:()-]+/g, ' ').trim();

/** The approval must be the player's own words, not the model's paraphrase. */
export function quoteIsFrom(quote: string | null, message: string): boolean {
  return Boolean(quote && norm(quote).length >= 2 && norm(message).includes(norm(quote)));
}

export class WorldCreation {
  readonly store: Store;
  private llm: LLMProvider;
  private packs: GamePack[];
  private now: () => string;

  constructor(store: Store, llm: LLMProvider, opts: { packs: GamePack[]; now?: () => string }) {
    this.store = store;
    this.llm = llm;
    this.packs = opts.packs;
    this.now = opts.now ?? (() => new Date().toISOString());
    for (const p of this.packs) store.migratePack(p.id, p.migrations);
  }

  /** Starts a new draft. Nothing canonical is created. */
  start(): CreationResult {
    const id = newId('draft');
    const now = this.now();
    this.store.tx(() => {
      this.store.insertDraft({ id, status: 'drafting', draft: EMPTY_DRAFT, version: 0, now });
      this.store.addDraftMessage(id, 'copilot', COPILOT_GREETING, now);
    });
    return { draftId: id, status: 'drafting', text: COPILOT_GREETING };
  }

  /** The most recent draft still being designed (to resume after a restart). */
  latestOpen(): DraftRow | undefined {
    return this.store.listDrafts().find((d) => d.status === 'drafting' || d.status === 'awaiting_approval');
  }

  draft(draftId: string): WorldDraft {
    return WorldDraftSchema.parse(this.row(draftId).draft);
  }

  /** "What have we decided?" — deterministic, no model call. */
  view(draftId: string): string {
    return draftView(this.draft(draftId));
  }

  messages(draftId: string) {
    return this.store.listDraftMessages(draftId);
  }

  /** One conversational turn with the Copilot. */
  async say(draftId: string, input: string): Promise<CreationResult> {
    const row = this.open(draftId);
    const current = WorldDraftSchema.parse(row.draft);
    const awaiting = row.status === 'awaiting_approval' ? this.summaryOf(current) : null;
    const turn = await this.copilot(current, awaiting, this.messages(draftId).slice(-HISTORY), input);

    const draft: WorldDraft = { ...turn.draft, packId: this.packs.some((p) => p.id === turn.draft.packId) ? turn.draft.packId : null };
    const changed = JSON.stringify(draft) !== JSON.stringify(current);
    const version = changed ? row.version + 1 : row.version;
    const now = this.now();
    const save = (status: DraftStatus, text: string, summaryVersion: number | null) => {
      this.store.tx(() => {
        this.store.updateDraft({ id: draftId, status, draft, version, summaryVersion, gameId: null, now });
        this.store.addDraftMessage(draftId, 'player', input, now);
        this.store.addDraftMessage(draftId, 'copilot', text, now);
      });
      return { draftId, status, text };
    };

    switch (turn.intent) {
      case 'abandon':
        return save('abandoned', `${turn.reply}\n\n(This draft is abandoned. Nothing was created.)`, null);
      case 'summarize':
        return this.keepStatus(row, changed, (status, sv) => save(status, `So far:\n${draftView(draft)}${turn.reply ? `\n\n${turn.reply}` : ''}`, sv));
      case 'confirm_finalize':
        // Approval applies to the exact summary shown: same draft version, nothing changed since.
        if (row.status === 'awaiting_approval' && !changed && row.summaryVersion === row.version) {
          return this.create(row, draft, (tx) => {
            tx.addDraftMessage(draftId, 'player', input, now);
            tx.addDraftMessage(draftId, 'copilot', turn.reply, now);
          });
        }
        // Not approvable yet: show the (new) summary first; the model's "creating it" line would be false.
        return this.finalizeRequest(draft, version, null, save);
      case 'request_finalize':
        return this.finalizeRequest(draft, version, turn.reply, save);
      default:
        return this.keepStatus(row, changed, (status, sv) => save(status, status === 'drafting' ? turn.reply + this.readyHint(draft) : turn.reply, sv));
    }
  }

  /** /finalize: validate and show the final summary for approval (no model call). */
  requestFinalize(draftId: string): CreationResult {
    const row = this.open(draftId);
    const draft = WorldDraftSchema.parse(row.draft);
    return this.finalizeRequest(draft, row.version, null, (status, text, summaryVersion) => {
      this.store.updateDraft({ id: draftId, status, draft, version: row.version, summaryVersion, gameId: null, now: this.now() });
      this.store.addDraftMessage(draftId, 'copilot', text, this.now());
      return { draftId, status, text };
    });
  }

  /** /approve: explicit approval of the summary awaiting it. The only other path to a game is confirm_finalize. */
  approve(draftId: string): CreationResult {
    const row = this.open(draftId);
    if (row.status !== 'awaiting_approval' || row.summaryVersion !== row.version) {
      return { draftId, status: row.status, text: 'There is no final summary awaiting approval. Say you want to start (or /finalize) to see it first.' };
    }
    return this.create(row, WorldDraftSchema.parse(row.draft), (tx) => tx.addDraftMessage(draftId, 'player', '/approve', this.now()));
  }

  abandon(draftId: string): CreationResult {
    const row = this.open(draftId);
    this.store.updateDraft({ id: draftId, status: 'abandoned', draft: row.draft, version: row.version, summaryVersion: null, gameId: null, now: this.now() });
    return { draftId, status: 'abandoned', text: 'Draft abandoned. Nothing was created.' };
  }

  // ---- internals ----

  private row(draftId: string): DraftRow {
    const row = this.store.getDraft(draftId);
    if (!row) throw new Error(`no draft ${draftId}`);
    return row;
  }

  private open(draftId: string): DraftRow {
    const row = this.row(draftId);
    if (row.status === 'finalized' || row.status === 'abandoned') throw new Error(`draft ${draftId} is ${row.status}`);
    return row;
  }

  /** Once the draft is complete enough to create, say so — the player should never have to guess how to start. */
  private readyHint(draft: WorldDraft): string {
    return compileDraft(draft, this.packs, { now: this.now() }).seed
      ? '\n\n(This is enough to start. Keep refining, or say "let\'s start" — or type /finalize — to see the final summary.)'
      : '';
  }

  private summaryOf(draft: WorldDraft): string | null {
    const { seed } = compileDraft(draft, this.packs, { now: this.now() });
    return seed ? seedSummary(seed, this.packs.find((p) => p.id === seed.packId)!) : null;
  }

  /** A pending summary stays pending only while the draft is unchanged. */
  private keepStatus(row: DraftRow, changed: boolean, save: (status: DraftStatus, summaryVersion: number | null) => CreationResult): CreationResult {
    return row.status === 'awaiting_approval' && !changed ? save('awaiting_approval', row.summaryVersion) : save('drafting', null);
  }

  private finalizeRequest(draft: WorldDraft, version: number, reply: string | null,
    save: (status: DraftStatus, text: string, summaryVersion: number | null) => CreationResult): CreationResult {
    const { seed, problems } = compileDraft(draft, this.packs, { now: this.now() });
    const lead = reply ? `${reply}\n\n` : '';
    if (!seed) {
      return save('drafting', `${lead}Before I can create this world we still need to settle:\n${problems.map((p) => `- ${p}`).join('\n')}\n\n`
        + '(I can propose something for any of these — just say "you decide".)', null);
    }
    const pack = this.packs.find((p) => p.id === seed.packId)!;
    return save('awaiting_approval', `${lead}Here is the world I'll create:\n\n${seedSummary(seed, pack)}\n\n`
      + 'Once play starts this becomes the fixed starting point of the game and cannot be edited. '
      + 'Say so if you approve it, or tell me what to change.', version);
  }

  private create(row: DraftRow, draft: WorldDraft, alsoInTx: (store: Store) => void): CreationResult {
    const now = this.now();
    const { seed, problems } = compileDraft(draft, this.packs, { draftId: row.id, now });
    if (!seed) return { draftId: row.id, status: row.status, text: `The draft no longer compiles: ${problems.join('; ')}` };
    const pack = this.packs.find((p) => p.id === seed.packId)!;
    this.store.migratePack(pack.id, pack.migrations);
    const { game, opening } = createGameFromSeed(this.store, pack, seed, now, () => {
      this.store.updateDraft({ id: row.id, status: 'finalized', draft, version: row.version, summaryVersion: row.summaryVersion, gameId: seed.gameId, now });
      alsoInTx(this.store);
    });
    return { draftId: row.id, status: 'finalized', text: 'World created. The story begins.', gameId: game.id, opening };
  }

  private async copilot(draft: WorldDraft, awaiting: string | null, history: { role: string; text: string }[], input: string): Promise<CopilotTurn & { draft: WorldDraft }> {
    const system = copilotSystemPrompt(this.packs);
    const user = copilotUserPrompt({ draft, awaiting, history, input });
    let feedback: string[] = [];
    let last: (CopilotTurn & { draft: WorldDraft }) | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const prompt = feedback.length ? `${user}\n\nYOUR PREVIOUS OUTPUT WAS REJECTED:\n${feedback.map((f) => `- ${f}`).join('\n')}\nReturn corrected JSON.` : user;
      const res = await this.llm.complete({ task: 'world_copilot', system, user: prompt, schemaName: 'copilot_turn', schema: CopilotTurnSchema });
      let value: unknown;
      try { value = JSON.parse(res.rawText); } catch { feedback = ['output was not valid JSON']; continue; }
      const parsed = CopilotTurnSchema.safeParse(value);
      if (!parsed.success) { feedback = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`); continue; }
      last = { ...parsed.data, draft: applyDraftChanges(draft, parsed.data.changes, parsed.data.reset) };
      feedback = [];
      if ((last.intent === 'confirm_finalize' || last.intent === 'abandon') && !quoteIsFrom(last.approvalQuote, input)) {
        feedback.push(`intent ${last.intent} needs approvalQuote copied exactly from the player's latest message; if they did not say it, use discuss`);
      }
      if (!feedback.length) return last;
    }
    if (!last) throw new Error(`world_copilot: model output rejected on both attempts (${feedback.join('; ')})`);
    // Never create or discard a world on an unverified approval.
    return { ...last, intent: 'discuss', approvalQuote: null,
      reply: last.intent === 'abandon' ? 'Do you want to abandon this world? Say so explicitly (or type /abandon).'
        : 'Say explicitly that you approve the summary (for example "yes, create it"), or type /approve.' };
  }
}
