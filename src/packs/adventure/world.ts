import { EMPTY_DRAFT, type WorldDraft } from '../../domain/world.ts';

/**
 * A second Adventure world (original): a desert planet of fighting pits, water debts and great houses. Used by the tests.
 * With the Copilot you can build any world instead (e.g. Dune as a reference).
 */
export const ASHKAR_WORLD: WorldDraft = {
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
    pace: 'eventful', violence: 'graphic', narration: 'literary', language: 'English',
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
    attributes: [
      { key: 'strength', value: 3 }, { key: 'agility', value: 3 }, { key: 'wits', value: 2 }, { key: 'presence', value: 2 },
      { key: 'combat', value: 2 }, { key: 'athletics', value: 2 }, { key: 'survival', value: 1 }, { key: 'stealth', value: 1 }, { key: 'perception', value: 1 },
      { key: 'persuasion', value: 0 }, { key: 'deception', value: 1 }, { key: 'lore', value: 0 }, { key: 'fame', value: 1 },
    ],
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
    { name: 'Oda Venn', age: 51, gender: 'female', role: 'pit trainer in the Cisterns quarter', description: 'A one-eyed former champion who trains lower-city fighters for a third of their winnings.',
      personality: 'Economical with words; cruel in training, loyal to those who survive it.', goals: ['Put one of her fighters in the high pit before she dies'],
      relationshipToPlayer: 'Watched him win his small bouts. Thinks he has fire and no discipline. Has not offered to train him — yet.' },
    { name: 'Kesh Adar', age: 22, gender: 'male', role: 'rising pit fighter sponsored by House Varr', description: 'Handsome, fast and cruel; the lower city\'s favourite to reach the high pit.',
      personality: 'Charming in public, vicious in the ring; hates being upstaged.', goals: ['Win the house champion\'s title'],
      relationshipToPlayer: 'Knows Rhen as the water-carrier\'s boy who got lucky. Would enjoy humiliating him.' },
    { name: 'Sarai Tul', age: 38, gender: 'female', role: 'debt-collector for House Varr', description: 'Collects water-debts in the lower city with two guards and a ledger.',
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

/**
 * The default Adventure opening: a world inspired by The Kingkiller Chronicle. You are Kvothe at fifteen, the day before
 * admissions at the University — alternate from the start: nothing after this morning is written. Descriptions are our own.
 * A story of study, money, music, rivalry, love and a slow, dangerous mystery — with violence when it comes.
 */
export const KINGKILLER_WORLD: WorldDraft = {
  ...EMPTY_DRAFT,
  packId: 'adventure',
  premise: 'Kvothe, fifteen, the last of an Edema Ruh troupe murdered by the Chandrian, walks into the University after three years starving on the streets of Tarbean. He wants the name of the wind, the secrets locked in the Archives, and the truth about the ones who killed his family. From this morning on, nothing is written.',
  sourceWorld: 'The Kingkiller Chronicle (Patrick Rothfuss)',
  canonPolicy: 'alternate_from_start',
  startingStage: null,
  setting: {
    place: 'The University, across the river from Imre', era: 'the autumn admissions, when Kvothe is fifteen', startDate: '0001-09-14T08:30', timezone: 'UTC',
    description: 'The oldest school of the arcane in the Four Corners: grey stone, workshops that smell of forge-smoke and acid, a windowless Archives that holds more books than anyone has counted. Across the Omethi river, over a great stone bridge, lies Imre — music halls, moneylenders, nobles and taverns.',
  },
  style: {
    tone: 'lyrical, wry and bittersweet; wonder with hunger underneath', realism: 'high — tuition must be paid, pride makes enemies, the powerful protect themselves, magic has costs',
    difficulty: 'hard', narrativeStyle: 'second person, present tense, like a novel: stone, candle-smoke, music, cold, the ache of an empty purse', playerSignificance: 'a brilliant, penniless nobody with a dangerous past and a dangerous ambition',
    pace: 'eventful', violence: 'graphic', narration: 'literary', language: 'English',
  },
  designPrinciples: [
    'Most of the story is not fighting: tuition, debts, study, music, rivalry, friendship, love, secrets — violence is rare and it matters when it comes.',
    'Nothing is handed to Kvothe: every term costs money he does not have; cleverness opens doors and pride makes enemies.',
    'The Chandrian are a slow-burning mystery: hints, rumours and dangers, never easy answers. Asking about them has a price.',
    'Force real choices: study or earn, pride or prudence, the truth or safety, a friend or a chance.',
  ],
  worldRules: [
    'Sympathy is a craft: bind two things and what happens to one reaches the other — but the energy must come from a source (a candle, a fire, your own body heat), and some is always lost. A split, stubborn mind makes stronger bindings. Overreaching can kill you.',
    'Hurting a person through sympathy is malfeasance: the Masters punish it with the whip or expulsion.',
    'Naming is rare and wild: to know the true name of a thing (wind, fire, stone) is to command it. It cannot be learned from books alone, and it comes and goes.',
    'Artificers inscribe runes (sygaldry) to make lasting bindings: lamps that burn without fire, heat that flows where it is told. Students earn money making them.',
    'The Masters rule the University; tuition is set each term by how well a student answers them. Nobles buy favour; commoners earn it.',
    'The Edema Ruh are travelling players, despised by settled folk as thieves and vagabonds.',
    'No firearms: knives, swords (rare for commoners), bows. The currency: iron drabs, copper jots, silver talents (10 jots), gold marks.',
  ],
  player: {
    ...EMPTY_DRAFT.player,
    name: 'Kvothe', age: 15, gender: 'male', occupation: 'orphan and would-be student of the arcane',
    background: 'Born into an Edema Ruh troupe; grew up on the road, on stage, with a lute in his hands. An old arcanist, Abenthy, travelled with the troupe and taught him the first principles of sympathy. At eleven he came back to camp to find his family butchered by the Chandrian, who spoke to him and left. Three years followed on the streets of Tarbean: theft, hunger, beatings, silence. He has walked here with almost nothing, to learn what the Chandrian are and how to fight them.',
    personality: 'Brilliant and proud; a quick tongue and a quicker temper; a memory that keeps everything; hungry to know. The player shapes the rest.',
    skills: ['the basics of sympathy', 'lute and song (without a lute)', 'surviving on the street', 'a memory that forgets nothing', 'a quick, clever tongue'],
    goals: ['Pass admissions and get into the University', 'Get into the Archives and find out the truth about the Chandrian', 'Win a lute back — and his silver pipes at the Eolian'],
    fears: ['The Chandrian', 'Going back to the gutters of Tarbean', 'Being turned away for lack of money'],
    ambition: 'to become a great arcanist — to learn the name of the wind — and to find the Chandrian and make them answer for his family',
    attributes: [
      { key: 'strength', value: 1 }, { key: 'agility', value: 3 }, { key: 'wits', value: 5 }, { key: 'presence', value: 4 },
      { key: 'combat', value: 0 }, { key: 'athletics', value: 2 }, { key: 'survival', value: 2 }, { key: 'stealth', value: 2 }, { key: 'perception', value: 2 },
      { key: 'persuasion', value: 2 }, { key: 'deception', value: 2 }, { key: 'lore', value: 2 }, { key: 'arcana', value: 1 }, { key: 'performance', value: 3 }, { key: 'fame', value: 0 },
    ],
    location: 'nowhere yet — he slept on the road last night',
    circumstances: ['has no lodging', 'has no lute: his father\'s was broken in Tarbean', 'pawned Abenthy\'s book in Tarbean to eat', 'nobody here knows who he is'],
    startingMoney: 13, currency: { code: 'JOT', symbol: 'j ' },
    possessions: ['a patched travelling cloak', 'the clothes he wears', 'a pawn ticket for a book'],
    knowledge: [
      'Admissions: each applicant is questioned by the Masters, who set the tuition from the answers — or send them away',
      'The Chandrian are real. Their signs: blue flame, wood that rots, iron that rusts. Nobody believes it; asking gets you laughed at — or worse',
      'Sympathy: bindings, sources, slippage — what Abenthy taught him on the road',
      'The Eolian in Imre: a musician who plays well enough wins silver pipes, and patrons',
      'Gaelets (moneylenders) in Imre lend to students at cruel interest',
    ],
    assets: [
      { name: 'patched travelling cloak', kind: 'gear', description: 'Many pockets, many patches; warm enough, just', url: null, state: null, metrics: [{ key: 'quality', value: 0 }, { key: 'quantity', value: 1 }], monthlyCosts: [], knownIssues: [] },
    ],
  },
  locations: [
    { name: 'The Archives', description: 'A windowless block of grey stone holding the University\'s books. Master Lorren\'s scrivs guard it; students need admission to enter; fire is forbidden inside.' },
    { name: 'The Fishery', description: 'Master Kilvin\'s workshops: forges, glassworks, acids, rune-work. Students make and sell sympathy lamps and other artifice for commission.' },
    { name: 'The Eolian', description: 'The finest music hall in Imre. Musicians may try for their silver pipes; a failed attempt is remembered.' },
    { name: 'Anker\'s', description: 'A tavern near the University where a musician can trade playing for a room and meals.' },
    { name: 'The Medica', description: 'The University\'s school of healing, under Master Arwyl. Students there stitch up other students — for a fee.' },
  ],
  factions: [
    { name: 'The Masters', description: 'The nine who run the University — among them the Chancellor, Lorren of the Archives, Kilvin of the Fishery, Elodin the Namer, Hemme of Rhetoric and Arwyl of the Medica. Their favour sets tuition; their displeasure ends careers.' },
    { name: 'The nobility', description: 'Rich students from Vintas and the Commonwealth who buy their way and expect deference.' },
    { name: 'The Chandrian', description: 'Seven figures from a children\'s rhyme who, in truth, kill anyone who learns too much about them. Nobody believes in them.' },
  ],
  actors: [
    { name: 'Kilvin', age: 55, gender: 'male', role: 'Master Artificer, head of the Fishery', description: 'A huge bearded Cealdish man with burn-scarred hands who speaks slowly and thinks carefully. Runs the Fishery like a ship.',
      personality: 'Patient, blunt, deeply cautious with dangerous work; respects skill and honesty, has no use for show-offs.', goals: ['Keep the Fishery safe', 'Find students worth teaching'],
      relationshipToPlayer: 'Has never met him. Sits on the admissions panel tomorrow.' },
    { name: 'Elodin', age: 40, gender: 'male', role: 'Master Namer', description: 'The youngest student ever admitted to the University, once locked away in its asylum, now a Master who teaches almost nothing to almost no one. Barefoot as often as not.',
      personality: 'Playful, unsettling, brilliant, impossible to predict; tests people in ways they do not notice.', goals: ['Find a student who can hear names'],
      relationshipToPlayer: 'Has never met him. Curious about anyone who asks the wrong questions.' },
    { name: 'Ambrose Jakis', age: 19, gender: 'male', role: 'noble student, heir to a Vintish barony', description: 'Rich, handsome, well connected; buys what he wants, including favour with some of the Masters.',
      personality: 'Arrogant, vindictive, charming when it pays; cannot bear to be mocked by an inferior.', goals: ['Be raised in the Arcanum', 'Be admired'],
      relationshipToPlayer: 'Does not know him yet. Would despise a poor Ruh boy who does not bow.' },
    { name: 'Simmon', age: 17, gender: 'male', role: 'student of the University', description: 'A younger son of Aturan gentry, sandy-haired, bright and kind; writes bad poetry.',
      personality: 'Warm, honest, easily flustered, fiercely loyal once he likes you.', goals: ['Pass his examinations', 'Keep his friends out of trouble'],
      relationshipToPlayer: 'Has not met him yet.' },
    { name: 'Denna', age: 16, gender: 'female', role: 'a young woman drifting between patrons in Imre', description: 'Dark-haired, quick-witted, beautiful in a way people remember; she sings, travels, and changes her name when it suits her.',
      personality: 'Elusive, warm, restless, secretive about where she goes and who pays for it.', goals: ['Find a patron worth having', 'Keep her freedom'],
      relationshipToPlayer: 'Travelled a few days with him on a merchant caravan; remembers the red-haired boy who made her laugh. Does not know he is here.' },
    { name: 'Devi', age: 21, gender: 'female', role: 'gaelet (moneylender) in Imre, expelled from the University', description: 'Small, sharp and fair-haired, she lends to students from a room above a butcher\'s shop. She takes a drop of blood as surety — and knows exactly what she can do with it.',
      personality: 'Clever, amused, merciless about debts; respects people who are clever too.', goals: ['Get back into the Archives', 'Be paid, on time, with interest'],
      relationshipToPlayer: 'Does not know him.' },
  ],
  initialSituations: [
    { title: 'Admissions', summary: 'The Masters are holding admissions: tomorrow each applicant stands before them, is questioned, and has a tuition set — or is sent away. Kvothe has thirteen jots and no patron.', involves: ['Kilvin', 'Elodin', 'player'] },
    { title: 'Ambrose holds court', summary: 'Ambrose Jakis and his hangers-on rule the corridors near the Masters\' offices, taking a cut of favour and humiliating anyone low-born who crosses them.', involves: ['Ambrose Jakis'] },
    { title: 'Denna is in Imre', summary: 'Denna has come to Imre looking for a patron and sings some nights near the Eolian, never in the same place twice.', involves: ['Denna'] },
    { title: 'Blue fire on the road', summary: 'Travellers at the inns tell of a farmstead burned out to the north, and of fire that burned blue. Most laugh. Some do not.', involves: ['player'] },
  ],
  economy: {
    priceList: [
      { item: 'a loaf of bread', price: 0.2 }, { item: 'a hot meal at a tavern', price: 0.5 }, { item: 'a night\'s bed at an inn in Imre', price: 1 },
      { item: 'a term\'s room in the Mews (student lodging)', price: 20 }, { item: 'tuition for a term (set at admissions)', price: 30 },
      { item: 'a battered secondhand lute', price: 40 }, { item: 'a good lute', price: 150 }, { item: 'a set of plain clothes', price: 8 },
      { item: 'a simple knife', price: 3 }, { item: 'a sympathy lamp (Fishery-made)', price: 120 }, { item: 'entry to the Eolian', price: 1 },
      { item: 'redeeming a pawned book', price: 25 }, { item: 'stitches at the Medica', price: 3 },
    ],
    livingCosts: [{ label: 'Food', amount: 15 }],
    income: [],
  },
  openLeads: [
    { title: 'Admissions', description: 'Stand before the Masters in the Hollows; answer well and your tuition is low — or they pay you. Answer badly and you are sent away until next term.', when: '0001-09-15T09:00', location: 'The Hollows, the University', cost: null, repeatsWeekly: false },
    { title: 'Open night at the Eolian', description: 'Musicians may try for their silver pipes before the house and its patrons. You need a lute — and the entry fee.', when: '0001-09-18T19:00', location: 'The Eolian, Imre', cost: 1, repeatsWeekly: true },
    { title: 'Work at the Fishery', description: 'Students with a Master\'s leave can work in Kilvin\'s workshops and earn commission on what they make.', when: null, location: 'The Fishery, the University', cost: null, repeatsWeekly: false },
    { title: 'Anker\'s needs a musician', description: 'Anker trades a room and meals for music a few nights a week — for someone who can play.', when: null, location: 'Anker\'s, near the University', cost: null, repeatsWeekly: false },
    { title: 'A gaelet over the butcher\'s', description: 'In Imre, a moneylender called Devi lends to students who cannot pay tuition. The interest is steep; the surety is stranger.', when: null, location: 'Imre', cost: null, repeatsWeekly: false },
  ],
  historicalContext: 'The University is older than anyone\'s memory, the one great school of the arcane: sympathy, sygaldry, alchemy, medicine, naming. It is ruled by its Masters and fed by nobles\' money. Four years ago, Kvothe\'s troupe was killed in one night by the Chandrian — seven figures from a nursery rhyme — because his father was making a song about them. Their signs are blue flame, rot and rust. Kvothe spent the three years after on the streets of Tarbean, until an old story about the Chandrian, told in a tavern, pulled him back to his purpose. The Amyr — an order said to have fought such things — were disbanded centuries ago, if they ever were real.',
  currentSituation: 'Autumn morning at the University. Admissions start tomorrow; applicants crowd the courtyards and taverns. Kvothe has just arrived, with thirteen jots, one cloak and a head full of questions.',
  initialPressures: ['Admissions are tomorrow: if the Masters set your tuition higher than what you have, you are turned away.', 'You have thirteen jots, no lute and nowhere to sleep tonight.'],
  startingScene: { location: 'A courtyard of the University, in the shadow of the Archives', description: 'Morning. Grey stone, students in dark robes, the smell of forge-smoke from the Fishery; the Archives stand windowless over everything.' },
};
