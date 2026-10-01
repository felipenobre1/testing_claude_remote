import { EMPTY_DRAFT } from '../../domain/world.ts';
import { dealOfferKind } from '../deal.ts';
import type { GamePack } from '../types.ts';

// ============================================================================
// Game Pack: Open World — the engine's generic mechanics and nothing else.
// People, memory, knowledge, relationships, money, promises, deals, decisions, world turns,
// story threads and the Story Director, in whatever world the player designs with the
// World Creation Copilot (fantasy, science fiction, history, a known fictional universe…).
// ============================================================================

const cents = (x: number) => Math.round(x * 100);

export const openPack: GamePack = {
  id: 'open',
  name: 'Open World',
  currency: { code: 'COIN', symbol: '¤' },
  migrations: [],
  worldCreation: {
    summary: 'any world you can describe — people, relationships, money, promises and deals, with no specialised mechanics',
    guidance: [
      'Generic mechanics only: people who remember and decide for themselves, money, promises, deals (a price for something), time passing.',
      'Fits any setting: fantasy, science fiction, history, a known fictional universe used as a reference.',
      'For a known universe, settle the canon policy early and keep the player\'s position modest unless they insist otherwise.',
      'Ask for a currency name/symbol only if money will matter; otherwise it can wait.',
    ].join('\n'),
    template: {
      ...EMPTY_DRAFT,
      packId: 'open',
      premise: 'A courier in a river city under a new and nervous regime.',
      sourceWorld: null,
      canonPolicy: 'original_world',
      setting: { place: 'Varessa, a river city', era: 'an early-modern age of canals and printing presses', startDate: '1650-04-02T07:30', timezone: 'UTC',
        description: 'A trading city whose council was replaced by a governor from the capital a month ago.' },
      style: { tone: 'grounded, quiet tension', realism: 'high — actions have costs and people protect themselves', difficulty: null, narrativeStyle: 'second person, concise',
        playerSignificance: 'an ordinary courier; nobody important', pace: 'steady', violence: 'non_graphic', narration: 'literary', language: 'English' },
      designPrinciples: ['Do not manufacture destiny around the player.', 'The powerful do not notice the player unless given a reason.'],
      worldRules: ['No magic. Travel is by boat, horse or on foot; news moves at that speed.'],
      player: { ...EMPTY_DRAFT.player, name: 'Tomas', age: 26, occupation: 'courier', background: 'Carries letters and parcels between merchant houses. Knows the canals well.',
        skills: ['navigating the canals', 'discretion'], goals: ['keep his licence under the new governor'], location: 'a rented room near the fish market',
        startingMoney: 40, currency: { code: 'CRN', symbol: 'cr ' }, possessions: ['a courier\'s satchel', 'a licence badge'] },
      currentSituation: 'The new governor has announced that all couriers must re-register within the month. Nobody knows what the new rules will be.',
      startingScene: { location: 'Tomas\'s rented room near the fish market', description: 'Early morning. Bells from the harbour. A letter has been pushed under the door.' },
    },
  },
  offerKinds: [dealOfferKind],
  entities: { find: () => undefined, name: (_api, id) => id, controlledBy: () => false },
  actions: [],
  createTurnState: () => ({ commit: () => [] }),
  briefing: { player: () => [], npc: () => [] },
  statusParts: () => [],
  prompts: {
    interpretActions: '  Offer kinds for make_offer: deal (terms: price_offerer_pays / price_offerer_receives on acceptance, price_offerer_pays_later / price_offerer_receives_later when it is done; put what is exchanged in label/description).',
    director: 'Developments must come from the world bible, its factions and the people already in play.',
  },
};
