// Author mode: the author describes scenes, the engine writes them from the story bible; accepted scenes are canon.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db/store.ts';
import { Author } from '../src/engine/author.ts';
import { Engine } from '../src/engine/turn.ts';
import { ScriptedProvider } from '../src/llm/scripted.ts';
import { storyPack, storyRepo } from '../src/packs/story/index.ts';
import { fixedRng, tmpDbPath } from './helpers.ts';

function book() {
  const store = new Store(tmpDbPath());
  const llm = new ScriptedProvider();
  const engine = new Engine(store, llm, { pack: storyPack, rng: fixedRng(0.5), beats: false, narrator: false, director: false });
  const { game } = engine.newGame({ language: 'pt' });
  return { store, llm, author: new Author(store, llm, () => '2026-10-03T12:00:00.000Z'), gameId: game.id };
}

const scene = (p: Record<string, unknown> = {}) => ({
  prose: 'A chuva escorria pelo travertino da escadaria de Santa Maria in Aracoeli. Sariel não sentia o frio; lembrava-se dele, como quem lembra uma língua morta.',
  title: 'Domingo de Ramos', summary: 'Sariel espera Kokabiel na escadaria, antes do amanhecer.', present: ['Sariel', 'Kokabiel'],
  remembers: [{ name: 'Sariel', memory: 'Esperou Kokabiel na escadaria de Aracoeli, antes do amanhecer.' }, { name: 'Kokabiel', memory: 'Encontrou Sariel em Roma.' }],
  newCharacters: [{ name: 'Dona Lucia', gender: 'female', role: 'sacristã de Aracoeli', description: 'Uma senhora que sente frio quando eles passam.' }], ...p,
});

test('the story bible: the author\'s whole truth — rules, hidden truths, what each character knows privately', () => {
  const { store, author, gameId } = book();
  const bible = author.bible(gameId);
  assert.match(bible, /There is no forgiveness for the fallen: since the Cross they are doomed/);
  assert.match(bible, /HIDDEN TRUTHS \(the reader discovers these slowly — never state them unless the author asks\):\n- The master wants every fallen angel gathered/);
  assert.match(bible, /- Kokabiel — one of the master's faithful\.[\s\S]*knows \(privately\): Kokabiel and Malariel were close in Heaven/);
  assert.match(bible, /The fallen have no sex and no gender/);
  assert.match(bible, /many of them receive the worship meant for God, pretending to come from Him/);
  assert.match(bible, /- Sariel — a hunter[\s\S]*Corrupted directly by the master[\s\S]*two "hounds" — a mystery/);
  assert.match(bible, /PLAYER'S LANGUAGE: Brazilian Portuguese/);
  assert.equal(store.listGames()[0]!.packId, 'story');
  store.close();
});

test('a scene is written as the author reads it, rewritten with notes, and becomes canon only when accepted', async () => {
  const { store, llm, author, gameId } = book();
  let streamed = '';
  llm.enqueue('write_scene', (req: { system: string; user: string }) => {
    assert.match(req.system, /You are writing a novel together with its author/);
    assert.match(req.system, /Mystery: reveal only what this scene needs/);
    assert.match(req.system, /Language: Brazilian Portuguese, literary and natural/);
    assert.match(req.user, /THE STORY SO FAR:\n\(nothing yet — this is the first scene of the book\)/);
    assert.match(req.user, /THE AUTHOR'S SCENE:\nSariel espera Kokabiel em Aracoeli, chuva, antes do amanhecer\./);
    return scene();
  });
  const draft = await author.write(gameId, 'Sariel espera Kokabiel em Aracoeli, chuva, antes do amanhecer.', (d) => { streamed += d; });
  assert.equal(streamed, scene().prose); // the author read it as it was written
  assert.equal(draft.status, 'draft');
  assert.equal(author.manuscript(gameId, 'Os Caídos'), '# Os Caídos\n'); // nothing is canon yet

  llm.enqueue('write_scene', (req: { user: string }) => {
    assert.match(req.user, /YOUR CURRENT DRAFT:\nA chuva escorria/);
    assert.match(req.user, /THE AUTHOR'S NOTES — rewrite the scene applying them; keep everything they don't touch:\nmais silêncio, menos frio/);
    return scene({ prose: 'A chuva escorria pelo travertino. Sariel esperava em silêncio, e o silêncio esperava com ele, paciente como as pedras de Roma.' });
  });
  const second = await author.rewrite(gameId, 'mais silêncio, menos frio');
  assert.deepEqual(second.notes, ['mais silêncio, menos frio']);
  assert.equal(second.id, draft.id);

  const accepted = author.accept(gameId);
  assert.deepEqual([accepted.status, accepted.chapter, accepted.seq], ['accepted', 1, 1]);
  // Those who were there remember it; the new person exists from now on.
  const kokabiel = store.listCharacters(gameId).find((c) => c.name === 'Kokabiel')!;
  assert.match(store.listMemoriesOwnedBy(kokabiel.id).map((m) => m.summary).join(), /Domingo de Ramos: Encontrou Sariel em Roma\./);
  assert.ok(store.listCharacters(gameId).some((c) => c.name === 'Dona Lucia' && c.gender === 'female'));
  assert.match(author.manuscript(gameId, 'Os Caídos'), /^# Os Caídos\n\n## 1\n\nA chuva escorria pelo travertino\. Sariel esperava em silêncio/);

  // A new chapter; the next scene continues from the last one.
  assert.equal(author.newChapter(gameId, 'O Caçador'), 2);
  llm.enqueue('write_scene', (req: { system: string; user: string }) => {
    assert.match(req.user, /Chapter 1:\n- Domingo de Ramos: Sariel espera Kokabiel/);
    assert.match(req.user, /THE END OF THE LAST SCENE \(continue from here; do not repeat it\):\nA chuva escorria/);
    assert.match(req.system, /- Kokabiel[\s\S]*remembers: Domingo de Ramos: Encontrou Sariel em Roma\./);
    return scene({ title: 'Os cães', prose: 'Algo andava atrás de Sariel na Via dei Fori Imperiali, e não fazia barulho nenhum ao pisar nas poças.', newCharacters: [] });
  });
  await author.write(gameId, 'Sariel atravessa a Via dei Fori Imperiali; algo o segue.');
  author.accept(gameId);
  assert.match(author.manuscript(gameId, 'Os Caídos'), /## 2 — O Caçador\n\nAlgo andava atrás de Sariel/);
  assert.equal(storyRepo.scenes(store, gameId).length, 2);

  // Discarding a draft leaves the book untouched.
  llm.enqueue('write_scene', scene({ title: 'Descartada' }));
  await author.write(gameId, 'uma cena qualquer');
  assert.equal(author.discard(gameId), true);
  assert.equal(storyRepo.scenes(store, gameId).length, 2);
  store.close();
});

test('the author can ask about the story — and may know everything', async () => {
  const { store, llm, author, gameId } = book();
  llm.enqueue('author_ask', (req: { system: string; user: string }) => {
    assert.match(req.system, /the author knows everything/);
    assert.match(req.user, /THE AUTHOR ASKS: o que o Kokabiel sabe sobre o Malariel\?/);
    assert.match(req.user, /Kokabiel and Malariel were close in Heaven/);
    return { answer: 'Que foram próximos no Céu — e que o mestre o quer de volta.' };
  });
  assert.equal(await author.ask(gameId, 'o que o Kokabiel sabe sobre o Malariel?'), 'Que foram próximos no Céu — e que o mestre o quer de volta.');
  store.close();
});
