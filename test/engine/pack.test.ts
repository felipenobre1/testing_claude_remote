// The engine runs a different world with no Startup code: a tiny test-only pack (a border keep, 1204).
// Same persistence, characters, knowledge, decisions and world turns — only the pack differs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../../src/db/store.ts';
import type { DecisionState } from '../../src/domain/schemas.ts';
import { EMPTY_DRAFT } from '../../src/domain/world.ts';
import { Engine } from '../../src/engine/turn.ts';
import { ScriptedProvider } from '../../src/llm/scripted.ts';
import type { GamePack } from '../../src/packs/types.ts';
import { fixedRng, interp, lastPrompt, npc, tmpDbPath } from '../helpers.ts';

const keep: GamePack = {
  id: 'border-keep',
  name: 'The Border Keep (test pack)',
  currency: { code: 'GOLD', symbol: '₲' },
  migrations: [],
  worldCreation: {
    summary: 'a medieval border march where trade, tolls and loyalty decide who crosses the pass',
    guidance: 'Test pack.',
    template: {
      ...EMPTY_DRAFT, packId: 'border-keep', premise: 'A caravan master must cross a guarded mountain pass before winter.',
      sourceWorld: null, canonPolicy: 'original_world',
      setting: { place: 'a mountain border keep', era: 'the year 1204', startDate: '1204-10-01T07:00', timezone: 'UTC', description: null },
      style: { tone: 'austere', realism: 'harsh', difficulty: null, narrativeStyle: null, playerSignificance: 'a merchant among many', pace: 'quiet', violence: 'non_graphic', narration: 'concise' },
      player: { ...EMPTY_DRAFT.player, name: 'Edric', age: 24, occupation: 'caravan master', background: 'Leads a small caravan of wool traders.',
        skills: ['stubborn'], goals: ['cross the pass before winter'], location: 'the valley road', startingMoney: 200 },
      currentSituation: 'The gate is shut.',
      startingScene: { location: 'The gate of the border keep', description: 'Guards watch the caravan from the wall.' },
    },
  },
  offerKinds: [{
    kind: 'grant_passage',
    summary: 'the lord lets the caravan through the pass for a toll',
    terms: [{ key: 'toll', description: 'gold paid for passage', required: true }],
    resolveSubject: () => ({ subjectRef: null }),
    describe: (api, o) => `passage through the pass for ${api.money(Math.round(o.terms.toll! * 100))}`,
    execute: (api, o) => {
      const lordId = o.fromCharacterId === api.ctx.player.id ? o.toCharacterId : o.fromCharacterId;
      api.move(api.ensureAccount('character', api.ctx.player.id), api.ensureAccount('character', lordId), Math.round(o.terms.toll! * 100), 'toll', 'toll');
      api.results.push(`✓ The gate opens. Toll paid: ${api.money(Math.round(o.terms.toll! * 100))}`);
    },
  }],
  entities: { find: () => undefined, name: (_api, id) => id, controlledBy: () => false },
  actions: [],
  createTurnState: () => ({ commit: () => [] }),
  briefing: { player: () => [], npc: () => [] },
  statusParts: () => [],
  prompts: { interpretActions: '  Offer kinds for make_offer: grant_passage (terms: toll).', director: 'A medieval border march.' },
};

const LORD = {
  name: 'Aldric Voss', age: 51, gender: 'male', role: 'lord of the keep', occupation: 'Warden of the pass',
  background: 'Holds the pass for the duke; lost men to raiders last spring.', personality: 'Careful, proud, suspicious of merchants.',
  traits: ['careful', 'proud'], values: ['duty', 'order'], goals: ['keep the pass safe'], fears: ['raiders'], location: 'the keep',
  relationshipToPlayer: 'Has never met this caravan master.',
};
const LORD_STATE: DecisionState = {
  role: 'lord deciding whether to open the pass', goals: ['keep the pass safe', 'fill the treasury'], pressures: [{ text: 'raids this season', expiresGameTime: null }],
  alternatives: [{ text: 'keep the gate shut until spring', strength: 0.4 }],
  limits: [{ term: 'toll', op: 'min', value: 50, note: 'the duke set a minimum toll' }], requiresApproval: null,
  criteria: [{ factor: 'trust', weight: 2, note: 'unknown merchant' }, { factor: 'risk', weight: 3, note: 'raiders' }], baseWillingness: 50,
};

test('a different pack: same engine, same decision engine, different world', async () => {
  const store = new Store(tmpDbPath());
  const llm = new ScriptedProvider();
  const engine = new Engine(store, llm, { pack: keep, rng: fixedRng(0.5) });
  const { game, player } = engine.newGame();

  llm.enqueue('interpret', interp({ intents: ['start_conversation', 'speak'], target: { name: 'Aldric', relationHint: 'lord of the keep' }, channel: 'in_person', spokenText: 'My lord, we ask passage.' }))
    .enqueue('generate_character', LORD).enqueue('npc_turn', npc({ dialogue: 'State your business.' }));
  await engine.takeTurn({ gameId: game.id, input: 'I ask the lord for passage' });
  assert.match(llm.callsFor('generate_character')[0]!.system, /a mountain border keep, the year 1204/);
  const lord = store.listCharacters(game.id).find((c) => c.name === 'Aldric Voss')!;
  store.upsertDecisionState(game.id, lord.id, 'grant_passage', LORD_STATE, 'seed', new Date().toISOString());

  // A low toll: the lord's own limit makes a yes impossible; he counters at the duke's minimum.
  const offer = (toll: number) => interp({ intents: ['speak'], target: { name: 'Aldric Voss', relationHint: null }, spokenText: `${toll} gold for passage.`,
    actions: [{ action: 'make_offer', toCharacterName: 'Aldric Voss', kind: 'grant_passage', subject: null, label: null, terms: [{ key: 'toll', value: toll }], description: 'passage for the caravan' }] });
  llm.enqueue('interpret', offer(20))
    .enqueue('npc_appraise', { factors: [{ factor: 'trust', value: 2, reason: 'sealed letter from the abbot' }, { factor: 'risk', value: 2, reason: 'armed escort of twelve' }] })
    .enqueue('npc_turn', npc({ expressedDecision: 'counter', counterTerms: { terms: [{ key: 'toll', value: 50 }], note: 'the duke\'s toll' }, dialogue: 'Fifty. Not a coin less.' }));
  const r = await engine.takeTurn({ gameId: game.id, input: 'I offer 20 gold' });
  assert.equal(r.status, 'committed', r.error ?? '');
  assert.match(r.text, /↩ Aldric Voss counter-offers: passage through the pass for ₲50\.00/);
  assert.match(lastPrompt(llm, 'npc_turn'), /YOUR PRIVATE SITUATION[\s\S]*toll: at least 50/);

  // Accept the counter: the pack executes it; the generic ledger moves the gold.
  const counter = store.listOffers(game.id).find((o) => o.fromCharacterId === lord.id)!;
  llm.enqueue('interpret', interp({ intents: ['speak'], target: { name: 'Aldric Voss', relationHint: null }, spokenText: 'Fifty, then.',
    actions: [{ action: 'respond_to_offer', offerId: counter.id, accept: true }] }))
    .enqueue('npc_turn', npc({ dialogue: 'Open the gate.' }));
  const r2 = await engine.takeTurn({ gameId: game.id, input: 'I pay fifty' });
  assert.match(r2.text, /✓ The gate opens\. Toll paid: ₲50\.00/);
  assert.equal(store.getAccountOf(game.id, 'character', player.id)!.balanceCents, 15_000);
  store.close();
});
