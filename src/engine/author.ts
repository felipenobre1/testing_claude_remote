import { z } from 'zod';
import type { Store } from '../db/store.ts';
import type { Character } from '../domain/types.ts';
import type { WorldSeed } from '../domain/world.ts';
import { LLMError, type LLMProvider } from '../llm/provider.ts';
import { storyRepo, type StoryScene } from '../packs/story/index.ts';
import { ProseTap } from './story.ts';
import { foldName, newId } from './util.ts';
import { bibleText } from './worldSeed.ts';

// ============================================================================
// Author mode: writing a book with the engine.
//
// The author gives a scene (what happens, how it should feel, the atmosphere); the writer drafts it in full, in the
// book's voice, from the story bible — which holds everything, including what the reader must not be told yet — and
// from what each character knows. The author revises and accepts: an accepted scene is canon (the characters remember
// it, the manuscript grows). Nothing is canon until the author accepts it.
// ============================================================================

export const SceneDraftSchema = z.object({
  prose: z.string().min(50).max(30000), // first, so it can stream
  title: z.string().min(1).max(120),
  summary: z.string().min(10).max(1200), // what happened, for continuity
  present: z.array(z.string().max(80)).max(12), // who is in the scene
  remembers: z.array(z.strictObject({ name: z.string().max(80), memory: z.string().min(3).max(400) })).max(12), // what each will remember
  newCharacters: z.array(z.strictObject({ name: z.string().min(1).max(80), gender: z.string().max(20).nullable(), role: z.string().max(120), description: z.string().max(600) })).max(4),
});
export type SceneDraft = z.infer<typeof SceneDraftSchema>;

export const AuthorAnswerSchema = z.object({ answer: z.string().min(1).max(3000) });

export function writerSystemPrompt(bible: string, language: string): string {
  return `You are writing a novel together with its author. The author gives you a scene — what happens, how it should feel, the atmosphere — and you write it in full, as a scene of a published novel. The author decides what happens; you write it so the reader is inside it.

THE STORY BIBLE (the author's; binding — it holds everything, including what the reader must not be told yet):
${bible}

HOW TO WRITE:
- Language: ${language}, literary and natural — never translated-sounding. Third person, past tense, close to the scene's point-of-view character (the one the author names, or the most central one).
- Follow the author's scene exactly in its events. Add texture freely — gestures, sensory detail, small beats, walk-on people — but no major event, death, revelation or important new character that the author did not ask for.
- Mystery: reveal only what this scene needs. Never explain the world's rules, the hidden truths or anyone's past unless the author asks for it; let them be felt through gesture, consequence and silence. Never write exposition.
- Each character acts and speaks only from what they know (see THE CHARACTERS): a secret one character holds never surfaces in another's mind or words.
- Continuity: everything in THE STORY SO FAR happened. Keep places, objects, wounds, times and what people know consistent with it. Do not repeat what the reader already read.
- Concrete over abstract: real places, weather, light, sounds, smells, objects — the details that make it feel true. No clichés, no purple prose; restraint is stronger than emphasis.
- Length: what the author asks; otherwise 900–1600 words.

ALSO RETURN:
- title: a short title for the scene (${language}).
- summary: 3–5 sentences of what happened, plainly, for continuity (${language}).
- present: the names of the characters in the scene.
- remembers: for each character present who will remember it, one sentence of what they now know or experienced (only what they could perceive).
- newCharacters: anyone new the scene introduced who may matter again (name, gender, role, a short description); [] otherwise.
Return JSON only.`;
}

export class Author {
  private readonly store: Store;
  private readonly llm: LLMProvider;
  private readonly now: () => string;

  constructor(store: Store, llm: LLMProvider, now: () => string = () => new Date().toISOString()) {
    this.store = store;
    this.llm = llm;
    this.now = now;
  }

  private seed(gameId: string): WorldSeed {
    const seed = this.store.getWorldSeed<WorldSeed>(gameId);
    if (!seed) throw new Error(`no story bible for ${gameId}`);
    return seed;
  }

  /** Everything the writer may use: the bible, the hidden truths, and each character with what only they know. */
  bible(gameId: string): string {
    const seed = this.seed(gameId);
    const game = this.store.getGame(gameId)!;
    const people = this.store.listCharacters(gameId);
    const facts = this.store.listFactsAbout(gameId, game.playerCharacterId);
    const character = (c: Character) => {
      const private_ = this.store.listKnowledgeOf(c.id).map((k) => k.belief);
      const memories = this.store.listMemoriesOwnedBy(c.id).slice(-8).map((m) => m.summary);
      return [
        `- ${c.name}${c.gender ? ` (${c.gender})` : ''} — ${c.role}. ${c.background}${c.personality && c.personality !== c.background ? ` Personality: ${c.personality}` : ''}${c.goals.length ? ` Wants: ${c.goals.join('; ')}.` : ''}`,
        ...(c.isPlayer ? facts.map((f) => `    · ${f.value}`) : []),
        ...private_.map((k) => `    · knows (privately): ${k}`),
        ...memories.map((m) => `    · remembers: ${m}`),
      ].join('\n');
    };
    return [
      bibleText(seed),
      ...(seed.world.description ? [`THE PLACE: ${seed.world.description}`] : []),
      `WHEN: ${seed.world.era}.`,
      `THE SITUATION AT THE START: ${seed.world.currentSituation}`,
      ...(seed.secrets?.length ? ['HIDDEN TRUTHS (the reader discovers these slowly — never state them unless the author asks):', ...seed.secrets.map((x) => `- ${x.truth}`)] : []),
      'THE CHARACTERS:', ...people.map(character),
    ].join('\n');
  }

  /** The book so far: every accepted scene's summary by chapter, and the end of the last one. */
  storySoFar(gameId: string): string {
    const chapters = storyRepo.chapters(this.store, gameId);
    const scenes = storyRepo.scenes(this.store, gameId);
    if (!scenes.length) return '(nothing yet — this is the first scene of the book)';
    const titleOf = (n: number) => chapters.find((c) => c.num === n)?.title;
    const lines: string[] = [];
    let chapter = 0;
    for (const s of scenes) {
      if (s.chapter !== chapter) { chapter = s.chapter; lines.push(`Chapter ${chapter}${titleOf(chapter) ? ` — ${titleOf(chapter)}` : ''}:`); }
      lines.push(`- ${s.title}: ${s.summary}`);
    }
    const last = scenes.at(-1)!;
    return [...lines, '', 'THE END OF THE LAST SCENE (continue from here; do not repeat it):', last.prose.slice(-2500)].join('\n');
  }

  currentChapter(gameId: string): number {
    return Math.max(1, ...storyRepo.chapters(this.store, gameId).map((c) => c.num), ...storyRepo.scenes(this.store, gameId).map((s) => s.chapter));
  }

  /** A new chapter: the next scenes belong to it. */
  newChapter(gameId: string, title: string): number {
    const used = storyRepo.chapters(this.store, gameId).map((c) => c.num);
    const hasScenes = storyRepo.scenes(this.store, gameId).some((s) => s.chapter === this.currentChapter(gameId));
    const num = used.includes(this.currentChapter(gameId)) || hasScenes ? this.currentChapter(gameId) + 1 : this.currentChapter(gameId);
    storyRepo.addChapter(this.store, gameId, num, title.trim(), this.now());
    return num;
  }

  /** Drafts a scene from the author's description. Replaces any draft not yet accepted. */
  async write(gameId: string, brief: string, onProse?: (delta: string) => void): Promise<StoryScene> {
    const previous = storyRepo.draft(this.store, gameId);
    if (previous) storyRepo.save(this.store, { ...previous, status: 'discarded', updatedAt: this.now() });
    const user = [`THE STORY SO FAR:\n${this.storySoFar(gameId)}`, '', `THE AUTHOR'S SCENE:\n${brief.trim()}`].join('\n');
    const draft = await this.draft(gameId, user, onProse);
    const now = this.now();
    const scene: StoryScene = {
      id: newId('scene'), gameId, chapter: this.currentChapter(gameId), seq: 0, status: 'draft', brief: brief.trim(), notes: [],
      title: draft.title, prose: draft.prose, summary: draft.summary, meta: { present: draft.present, remembers: draft.remembers, newCharacters: draft.newCharacters }, createdAt: now, updatedAt: now,
    };
    storyRepo.save(this.store, scene);
    return scene;
  }

  /** Rewrites the current draft with the author's notes, keeping what the notes don't touch. */
  async rewrite(gameId: string, notes: string, onProse?: (delta: string) => void): Promise<StoryScene> {
    const current = storyRepo.draft(this.store, gameId);
    if (!current) throw new Error('There is no draft to rewrite. Describe a scene first.');
    const user = [
      `THE STORY SO FAR:\n${this.storySoFar(gameId)}`, '',
      `THE AUTHOR'S SCENE:\n${current.brief}`, '',
      ...(current.notes.length ? [`EARLIER NOTES (already applied):\n${current.notes.map((n) => `- ${n}`).join('\n')}`, ''] : []),
      `YOUR CURRENT DRAFT:\n${current.prose}`, '',
      `THE AUTHOR'S NOTES — rewrite the scene applying them; keep everything they don't touch:\n${notes.trim()}`,
    ].join('\n');
    const draft = await this.draft(gameId, user, onProse);
    const next: StoryScene = { ...current, notes: [...current.notes, notes.trim()], title: draft.title, prose: draft.prose, summary: draft.summary,
      meta: { present: draft.present, remembers: draft.remembers, newCharacters: draft.newCharacters }, updatedAt: this.now() };
    storyRepo.save(this.store, next);
    return next;
  }

  /** The author accepts the draft: it becomes canon — part of the manuscript, remembered by those who were there. */
  accept(gameId: string): StoryScene {
    const draft = storyRepo.draft(this.store, gameId);
    if (!draft) throw new Error('There is no draft to accept.');
    const now = this.now();
    const game = this.store.getGame(gameId)!;
    const chapter = this.currentChapter(gameId);
    const seq = storyRepo.scenes(this.store, gameId).filter((s) => s.chapter === chapter).length + 1;
    const meta = draft.meta as Pick<SceneDraft, 'present' | 'remembers' | 'newCharacters'>;
    this.store.tx(() => {
      const people = this.store.listCharacters(gameId);
      const find = (name: string) => people.find((c) => foldName(c.name) === foldName(name)) ?? people.find((c) => foldName(c.name).split(' ')[0] === foldName(name).split(' ')[0]);
      for (const n of meta.newCharacters ?? []) {
        if (find(n.name)) continue;
        const c: Character = { id: newId('chr'), gameId, isPlayer: false, name: n.name, age: 40, gender: n.gender, role: n.role, occupation: null, background: n.description,
          personality: n.description, traits: [], values: [], goals: [], fears: [], location: game.title, origin: 'generated', createdAt: now, updatedAt: now };
        this.store.insertCharacter(c);
        people.push(c);
      }
      for (const r of meta.remembers ?? []) {
        const who = find(r.name);
        if (!who) continue;
        this.store.insertMemory({ id: newId('mem'), gameId, ownerCharacterId: who.id, summary: `${draft.title}: ${r.memory}`, importance: 3, emotionalWeight: null,
          source: 'gameplay', sourceEventId: null, gameTime: game.gameTime, createdAt: now, subjectIds: [] });
      }
      storyRepo.save(this.store, { ...draft, status: 'accepted', chapter, seq, updatedAt: now });
    });
    return { ...draft, status: 'accepted', chapter, seq };
  }

  discard(gameId: string): boolean {
    const draft = storyRepo.draft(this.store, gameId);
    if (!draft) return false;
    storyRepo.save(this.store, { ...draft, status: 'discarded', updatedAt: this.now() });
    return true;
  }

  /** The manuscript: accepted scenes, by chapter, as Markdown. */
  manuscript(gameId: string, title = 'Sem título'): string {
    const chapters = storyRepo.chapters(this.store, gameId);
    const scenes = storyRepo.scenes(this.store, gameId);
    const out = [`# ${title}`, ''];
    let chapter = 0;
    for (const s of scenes) {
      if (s.chapter !== chapter) {
        chapter = s.chapter;
        const t = chapters.find((c) => c.num === chapter)?.title;
        out.push(`## ${chapter}${t ? ` — ${t}` : ''}`, '');
      } else {
        out.push('* * *', '');
      }
      out.push(s.prose.trim(), '');
    }
    return out.join('\n');
  }

  /** The author asks about the story — continuity, who knows what, what happened. The author may know everything. */
  async ask(gameId: string, question: string): Promise<string> {
    const seed = this.seed(gameId);
    const res = await this.llm.complete({
      task: 'author_ask', schemaName: 'author_answer', schema: AuthorAnswerSchema,
      system: `You help the author of a novel keep their story straight. Answer briefly and precisely from THE STORY BIBLE and THE STORY SO FAR — including hidden truths: the author knows everything. If the answer isn't decided yet, say so and suggest options. Answer in ${seed.style.language || 'English'}. Return JSON only.`,
      user: [`THE STORY BIBLE:\n${this.bible(gameId)}`, '', `THE STORY SO FAR:\n${this.storySoFar(gameId)}`, '', `THE AUTHOR ASKS: ${question}`].join('\n'),
    });
    const parsed = AuthorAnswerSchema.safeParse(JSON.parse(res.rawText));
    if (!parsed.success) throw new LLMError('invalid', 'the answer was not valid');
    return parsed.data.answer;
  }

  private async draft(gameId: string, user: string, onProse?: (delta: string) => void): Promise<SceneDraft> {
    const seed = this.seed(gameId);
    const system = writerSystemPrompt(this.bible(gameId), seed.style.language || 'English');
    let feedback = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const tap = attempt === 1 && onProse ? new ProseTap(onProse) : null;
      const res = await this.llm.complete({ task: 'write_scene', system, user: feedback ? `${user}\n\n${feedback}` : user, schemaName: 'scene', schema: SceneDraftSchema,
        ...(tap ? { onText: (d: string) => tap.push(d) } : {}) });
      let value: unknown;
      try { value = JSON.parse(res.rawText); } catch { value = null; }
      const parsed = SceneDraftSchema.safeParse(value);
      if (parsed.success) return { ...parsed.data, prose: tap?.text.trim() || parsed.data.prose.trim() };
      // What the author already read stands; only the bookkeeping is missing.
      if (tap?.text.trim()) return { prose: tap.text.trim(), title: 'Cena', summary: tap.text.trim().slice(0, 600), present: [], remembers: [], newCharacters: [] };
      feedback = `YOUR PREVIOUS OUTPUT WAS NOT VALID (${parsed.success ? '' : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}). Return the full JSON.`;
    }
    throw new LLMError('invalid', 'the scene could not be written — try again');
  }
}
