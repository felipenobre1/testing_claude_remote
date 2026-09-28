import { EMPTY_DRAFT, type WorldDraft } from '../../domain/world.ts';

/**
 * Example Adventure world (original): a desert planet of fighting pits, water debts and great houses.
 * Quick start: `npm start -- new --quick --pack adventure`. With the Copilot you can build any world instead (e.g. Dune as a reference).
 */
export const ADVENTURE_WORLD: WorldDraft = {
  ...EMPTY_DRAFT,
  packId: 'adventure',
  premise: 'On the desert world of Qasr, a young fighter from the lower city wants his name sung across the known worlds. The great houses feed on water debts, and the fighting pits are the only door upward.',
  sourceWorld: null,
  canonPolicy: 'original_world',
  startingStage: null,
  setting: {
    place: 'Ashkar, the pit-city of Qasr', era: 'the 94th year of the Tithe, under House Varr', startDate: '0094-03-11T05:40', timezone: 'UTC',
    description: 'A walled city of sandstone and tarred canvas on the rim of the deep desert. Water is sold by the cup and owed by the year. Above the lower city stand the spires of House Varr; below it, the fighting pits roar every seventh night.',
  },
  style: {
    tone: 'harsh, sensual, epic but grounded', realism: 'high — wounds hurt, debts are collected, the powerful protect themselves',
    difficulty: 'hard', narrativeStyle: 'second person, present tense, like a novel: heat, dust, sweat, steel', playerSignificance: 'a nobody from the lower city with a dangerous ambition',
    pace: 'eventful', violence: 'graphic', narration: 'literary',
  },
  designPrinciples: [
    'Nothing is handed to the player: every step toward the ambition costs blood, water, loyalty or pride.',
    'The world keeps moving and keeps coming to the player: patrons, rivals, debts, storms.',
    'Force real choices; never make one option obviously right.',
  ],
  worldRules: [
    'No firearms: blades, spears, slings and crossbows. House guards wear lamellar armour.',
    'Water is currency and debt; a water-debt passes to your family if you die.',
    'The pits are legal; killing outside them is murder unless a house says otherwise.',
  ],
  player: {
    ...EMPTY_DRAFT.player,
    name: 'Rhen', age: 19, gender: 'male', occupation: 'water-carrier and unranked pit fighter',
    background: 'Born in the lower city. His father fought in the pits and died owing House Varr eleven years of water; the debt is now Rhen\'s. He has won three small bouts in the lower pits and lost one badly.',
    personality: 'Shaped by the player through play.',
    skills: ['knife-fighting', 'endurance', 'knows the lower city'], goals: ['Get a place in the high pit', 'Pay off the water-debt'], fears: ['Dying owing the house', 'Being forgotten'],
    ambition: 'to become a warrior whose name is known across the known worlds',
    attributes: [{ key: 'combat', value: 2 }, { key: 'athletics', value: 2 }, { key: 'survival', value: 1 }, { key: 'stealth', value: 1 }, { key: 'persuasion', value: 0 }, { key: 'lore', value: 0 }, { key: 'fame', value: 1 }],
    location: 'a rented sleeping-niche above the Cisterns quarter',
    circumstances: ['owes House Varr eleven years of water (inherited)', 'sleeps in a rented niche'],
    startingMoney: 30, currency: { code: 'DRM', symbol: 'dr ' },
    possessions: ['a water-skin', 'his father\'s pit token'],
    knowledge: ['The high pit fights on the seventh night; a sponsor from a house is needed to enter', 'Oda Venn trains fighters in the Cisterns quarter for a share of their winnings'],
    assets: [
      { name: 'curved knife', kind: 'weapon', description: 'His father\'s knife, re-edged many times', url: null, state: null, metrics: [{ key: 'quality', value: 1 }, { key: 'quantity', value: 1 }], monthlyCosts: [], knownIssues: [] },
      { name: 'padded desert coat', kind: 'armor', description: 'Thick cloth against sun and shallow cuts', url: null, state: null, metrics: [{ key: 'quality', value: 0 }, { key: 'quantity', value: 1 }], monthlyCosts: [], knownIssues: [] },
    ],
  },
  actors: [
    { name: 'Oda Venn', age: 51, role: 'pit trainer in the Cisterns quarter', description: 'A one-eyed former champion who trains lower-city fighters for a third of their winnings.',
      personality: 'Economical with words; cruel in training, loyal to those who survive it.', goals: ['Put one of her fighters in the high pit before she dies'],
      relationshipToPlayer: 'Watched him win his small bouts. Thinks he has fire and no discipline. Has not offered to train him — yet.' },
    { name: 'Kesh Adar', age: 22, role: 'rising pit fighter sponsored by House Varr', description: 'Handsome, fast and cruel; the lower city\'s favourite to reach the high pit.',
      personality: 'Charming in public, vicious in the ring; hates being upstaged.', goals: ['Win the house champion\'s title'],
      relationshipToPlayer: 'Knows Rhen as the water-carrier\'s boy who got lucky. Would enjoy humiliating him.' },
    { name: 'Sarai Tul', age: 38, role: 'debt-collector for House Varr', description: 'Collects water-debts in the lower city with two guards and a ledger.',
      personality: 'Polite, patient, unmovable.', goals: ['Bring in this season\'s tithe in full'],
      relationshipToPlayer: 'Holds Rhen\'s father\'s debt. Sees him as a ledger line that may soon be worth more alive than dead.' },
  ],
  initialSituations: [
    { title: 'The tithe is due', summary: 'Sarai Tul is collecting this season\'s water tithe in the Cisterns quarter; Rhen\'s share is due within days.', involves: ['Sarai Tul', 'player'] },
    { title: 'Kesh wants a warm-up', summary: 'Kesh Adar is looking for an easy public fight before the high pit, to show off for his house.', involves: ['Kesh Adar'] },
  ],
  economy: {
    priceList: [
      { item: 'a cup of clean water', price: 1 }, { item: 'a day\'s bread and dates', price: 2 }, { item: 'a night in a sleeping-niche', price: 3 },
      { item: 'a lower-pit entry token', price: 5 }, { item: 'a good steel knife', price: 40 }, { item: 'a short sword', price: 120 },
      { item: 'lamellar armour (used)', price: 300 }, { item: 'a healer\'s stitching', price: 8 }, { item: 'a crossbow and ten bolts', price: 90 },
    ],
    livingCosts: [{ label: 'Water ration', amount: 30 }, { label: 'Sleeping-niche rent', amount: 20 }],
    income: [{ label: 'Carrying water for the Cisterns', amount: 45 }],
  },
  openLeads: [
    { title: 'Lower-pit night', description: 'Open bouts for unranked fighters; small purses, big crowds. House scouts sometimes watch.', when: '0094-03-14T21:00', location: 'The lower pits, Ashkar', cost: 5, repeatsWeekly: true },
    { title: 'Caravan hiring guards', description: 'A salt caravan leaving for the deep desert needs blades; the pay is good because not everyone comes back.', when: '0094-03-12T06:00', location: 'The south gate', cost: null, repeatsWeekly: false },
    { title: 'Oda Venn\'s yard', description: 'Oda trains her fighters at dawn in a walled yard behind the cisterns. Strangers are not welcome — unless they prove something.', when: null, location: null, cost: null, repeatsWeekly: false },
  ],
  historicalContext: 'Eleven years ago the Great Drought broke the old water guilds; House Varr bought their debts and now owns most of Ashkar. The high pit has become the house\'s stage: champions win water-rights, sponsors win prestige, losers are forgotten. Rumours say a rival house, Qell, is buying fighters in secret.',
  currentSituation: 'Dawn in Ashkar. The tithe-collectors are out in the Cisterns quarter, the lower pits open in three nights, and everyone is talking about Kesh Adar\'s coming bout in the high pit.',
  initialPressures: ['Your share of the water tithe is due within days — and you have 30 drams.'],
  startingScene: { location: 'Rhen\'s sleeping-niche above the Cisterns quarter', description: 'Grey light through the canvas. Below, the clank of water-yokes and a collector\'s bell ringing street by street.' },
};
