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
 * The default Adventure opening — "The Iron Pact": the Danelaw, autumn 879. A Saxon thegn lies dead in a Danish longhouse,
 * a Norse axe beside him; in three days the Saxon fyrd marches. You are the arbiter both peoples call when blood is spilled —
 * a Dane's son raised among Saxons, trusted by both and fully by neither. The truth of the killing is decided (and hidden) from the start.
 * Your own past is written as you play (recollections).
 */
export const DANELAW_WORLD: WorldDraft = {
  ...EMPTY_DRAFT,
  packId: 'adventure',
  premise: 'Autumn 879, the Danelaw. A Saxon thegn is found with his throat cut in a Danish longhouse, a Norse axe beside him. His brother musters the fyrd to burn the Danes out in three days. You are the arbiter both peoples call when blood is spilled — and the only one who can find the truth and speak a verdict before the valley drowns in a blood-feud.',
  sourceWorld: 'Anglo-Saxon and Viking England (history)',
  canonPolicy: 'background_only',
  startingStage: null,
  setting: {
    place: 'Durobrivae, the old Roman walls on the Ermine Street, by the river Nene', era: 'autumn 879, a year after King Alfred\'s peace with Guthrum',
    startDate: '0879-10-14T07:00', timezone: 'UTC',
    description: 'A river valley on the new border between Saxon and Danish England. Inside the broken Roman walls of Durobrivae a market and a toll-house shelter under the arbiter\'s peace. Upriver lies the Saxon village of Ealdwic, with its thegn\'s hall and timber church; across the water, the Danish settlement of Ketilsby, five winters old, its longhouses smoking. It has rained since Michaelmas.',
  },
  style: {
    tone: 'gritty, intimate, morally grey — a murder mystery on a muddy frontier', realism: 'high — law is custom, oaths and kin; news travels on foot; people lie to protect their own; the powerful protect themselves',
    difficulty: 'hard', narrativeStyle: 'second person, present tense, like a historical novel: rain, mud, peat smoke, wet wool, tallow and iron; terse dialogue; period words',
    playerSignificance: 'respected in the valley as its arbiter, but with no army and no lord behind him — his only power is the trust of both peoples',
    pace: 'eventful', violence: 'graphic', narration: 'literary', language: 'English',
  },
  designPrinciples: [
    'The truth is fixed: the killer, the motive and every clue were decided before the story began. The player can uncover it, miss it, or bury it — never change it.',
    'Words are the weapons: oaths, leverage, bargains, lies, threats and confessions. Violence is rare, sudden and final.',
    'Every verdict has a price: whoever is shamed, hanged or paid off has kin, and kin remember. Feuds come back.',
    'Neither people is simply good: faith, pride, hunger and fear drive Saxon and Dane alike.',
    'Give the reader the texture of the ninth century: mud, rain, peat smoke, wet wool, tallow light, salt fish, church bells and the old gods\' names.',
  ],
  worldRules: [
    'Two laws share the valley: Saxon custom (wergild, oath-helpers, the ordeal of hot iron or water for those without them) and Danish law (the Thing, where free men decide; outlawry). A verdict both sides accept must speak to both.',
    'Wergild: a killing can be paid for instead of avenged — a thegn\'s life is worth 1,200 shillings to his kin, a free man\'s 200. Kin who refuse payment may take blood-feud.',
    'An oath sworn before witnesses binds; an oath-breaker is forsworn (Saxon) or nithing (Dane) — shamed and outlawed.',
    'No one rules here outright: the ealdorman is far away, Guthrum\'s peace is a year old; thegns and Danish headmen hold what they can.',
    'Christian Saxons and Danes who keep the old gods share the land; a priest and a godi both have a voice.',
    'Weapons: seax, spear, bearded axe; swords and mail are rare and costly. Money is silver pennies (d) and hacksilver.',
    'Nobody can be in two places at once; riding from the fort to Ealdwic or Ketilsby takes about an hour.',
  ],
  player: {
    ...EMPTY_DRAFT.player,
    name: 'Aldric Thorkelsson', age: 32, gender: 'male', occupation: 'arbiter of the border, keeper of the peace at Durobrivae',
    background: 'Son of Thorkel, a Danish settler, and Eadgyth, a Saxon woman; raised in a Saxon village, he speaks both tongues and knows both laws. For six years Saxons and Danes have brought their quarrels to him inside the old walls of Durobrivae, where they trade under his peace. Saxons call him Aldric, Danes call him Thorkelsson; both trust him — and neither fully.',
    personality: 'Shaped by the player through play.',
    skills: ['both tongues, both laws', 'reading people', 'speaking before a crowd'],
    goals: ['Find out who killed Wulfstan', 'Speak a verdict both peoples will accept before the fyrd marches'],
    fears: ['A war he could have stopped'],
    ambition: 'to keep the valley at peace — and make his word law for both peoples',
    attributes: [
      { key: 'strength', value: 2 }, { key: 'agility', value: 2 }, { key: 'wits', value: 3 }, { key: 'presence', value: 3 },
      { key: 'combat', value: 1 }, { key: 'athletics', value: 1 }, { key: 'survival', value: 1 }, { key: 'stealth', value: 0 }, { key: 'perception', value: 2 },
      { key: 'persuasion', value: 2 }, { key: 'deception', value: 1 }, { key: 'lore', value: 2 }, { key: 'arcana', value: 0 }, { key: 'performance', value: 1 }, { key: 'fame', value: 2 },
    ],
    location: 'the toll-house inside the walls of Durobrivae',
    circumstances: ['keeps the market peace at Durobrivae and takes a share of the tolls', 'has no lord, no army and no kin left alive in the valley', 'a groom and an old gatekeeper serve the toll-house', 'much of his past is not yet written — he will remember it as he goes'],
    startingMoney: 40, currency: { code: 'PEN', symbol: 'd ' },
    possessions: ['a seax at his belt', 'a wax tablet and stylus', 'his father\'s silver arm-ring', 'his grey mare, stabled inside the walls'],
    knowledge: [
      'Wulfstan, thegn of Ealdwic, was found at dawn yesterday in Ketil\'s longhouse at Ketilsby with his throat cut; a Norse axe lay beside him',
      'Two days before, Hrafn Ketilsson fought Wulfstan\'s men at the ford over a stolen ewe, in front of half the valley',
      'Eadric, Wulfstan\'s brother, has sworn to march on Ketilsby with the fyrd in three days',
      'The axe was brought to the fort\'s strongroom as evidence',
    ],
    assets: [
      { name: 'seax', kind: 'weapon', description: 'A long single-edged knife, plain and well kept', url: null, state: null, metrics: [{ key: 'quality', value: 1 }, { key: 'quantity', value: 1 }], monthlyCosts: [], knownIssues: [] },
      { name: 'oiled wool cloak', kind: 'gear', description: 'Heavy, greasy, nearly rain-proof', url: null, state: null, metrics: [{ key: 'quality', value: 1 }, { key: 'quantity', value: 1 }], monthlyCosts: [], knownIssues: [] },
    ],
  },
  locations: [
    { name: 'Durobrivae', description: 'The broken Roman walls on the Ermine Street: a gatehouse, a toll-house, a market square of mud and planks, a stone strongroom; Saxon and Danish traders side by side.' },
    { name: 'Ealdwic', description: 'The Saxon village upriver: Wulfstan\'s hall, now Eadric\'s; a timber church where the body lies; stables, byres, thirty households.' },
    { name: 'Ketilsby', description: 'The Danish settlement across the river: three longhouses, a smithy, boat-sheds on the bank. Ketil\'s longhouse, where the body was found, stands at its head.' },
    { name: 'The ford', description: 'Where the valley\'s quarrels happen: shallow water, a stone causeway, a gallows-elm on the Saxon bank.' },
    { name: 'The old mill', description: 'An abandoned water-mill between Ealdwic and Ketilsby, its wheel rotted; lovers and thieves use it.' },
  ],
  factions: [
    { name: 'Ealdwic', description: 'The Saxon households under their thegn. Christian, proud, afraid of the Danes and bitter about the land lost to them.' },
    { name: 'Ketilsby', description: 'Ketil\'s crew and their families, settled five winters ago: farmers now, warriors still. Most keep the old gods.' },
    { name: 'The traders of Durobrivae', description: 'Saxon and Danish merchants who need the peace to make money — and know everything that is bought and sold.' },
  ],
  actors: [
    { name: 'Eadric', age: 41, gender: 'male', role: 'brother of the murdered thegn, now lord of Ealdwic', description: 'Broad, red-bearded, a woad-blue cloak pinned with a silver brooch; he speaks of vengeance and God\'s justice in the same breath, and his household wears the same blue.',
      personality: 'Proud and loud in public, cold and patient in private; believes the Danes are a plague to be burned out.', goals: ['Avenge his brother by burning Ketilsby', 'Hold Ealdwic as its lord'],
      relationshipToPlayer: 'Has lost a case before him once. Calls him "the Dane\'s son" when angry; still needs his verdict to look just.' },
    { name: 'Ketil Grimsson', age: 56, gender: 'male', role: 'headman of Ketilsby', description: 'Grey-bearded, heavy, a silver ring on each arm; settled here with his crew five winters ago and wants his grandchildren to farm in peace. The body was found in his longhouse.',
      personality: 'Blunt, slow to speak, hard to frighten; keeps his word and expects others to keep theirs.', goals: ['Clear his house of the killing', 'Keep the peace without bending the knee'],
      relationshipToPlayer: 'Knew his father Thorkel. Respects his fairness — and is watching to see if it holds.' },
    { name: 'Hrafn Ketilsson', age: 20, gender: 'male', role: 'Ketil\'s son', description: 'Tall, restless, a fresh scar on his chin from the fight at the ford; every Saxon in the valley names him the killer.',
      personality: 'Hot-tempered, loyal, proud to the point of folly; would rather hang than shame a woman.', goals: ['Prove he is no murderer — without saying where he was'],
      relationshipToPlayer: 'Thinks the arbiter is a Saxon at heart.' },
    { name: 'Ælfgifu', age: 18, gender: 'female', role: 'Wulfstan\'s daughter', description: 'Pale with grief, hands hidden in her sleeves; with her father dead she is in her uncle Eadric\'s keeping.',
      personality: 'Quiet, clever, frightened — and braver than she looks.', goals: ['Keep Hrafn from the gallows without ruining herself', 'Not be married off by her uncle'],
      relationshipToPlayer: 'Knows him by sight; he once settled a boundary for her father, fairly.' },
    { name: 'Bjarni', age: 45, gender: 'male', role: 'Danish trader at Durobrivae', description: 'Deals in iron, salt and slaves with both peoples; knows every coin that passes through the fort and remembers every face that paid it.',
      personality: 'Greedy, amiable, careful; tells the truth when it pays or when cornered.', goals: ['Keep trading whoever wins', 'Stay well out of the killing'],
      relationshipToPlayer: 'Pays the arbiter\'s market toll — grudgingly, and on time.' },
    { name: 'Osric', age: 34, gender: 'male', role: 'Eadric\'s huscarl', description: 'Lean, quiet, always a step behind his lord; his left hand is scarred shiny from an old forge burn.',
      personality: 'Loyal to his lord beyond his own soul; says little; lies badly when pressed hard.', goals: ['Serve Eadric', 'Keep his secret'],
      relationshipToPlayer: 'Has watched the arbiter\'s moots from the back without a word.' },
  ],
  initialSituations: [
    { title: 'The killing', summary: 'Wulfstan, thegn of Ealdwic, was found at dawn yesterday in Ketil\'s longhouse with his throat cut, a Norse axe beside him. Nobody admits knowing why he was there at night.', involves: ['Ketil Grimsson', 'Eadric'] },
    { title: 'The fyrd gathers', summary: 'Eadric is calling the free men of Ealdwic and the villages around to arms; spears are being sharpened in every yard.', involves: ['Eadric', 'Osric'] },
    { title: 'Hrafn\'s quarrel', summary: 'Two days before the killing Hrafn fought Wulfstan\'s men at the ford; every Saxon now names him the killer, and he will not say where he was that night.', involves: ['Hrafn Ketilsson'] },
    { title: 'Both sides wait for the arbiter', summary: 'Ketil swears his house is innocent and asks for the old law; Eadric says he will hear the arbiter — if the verdict comes before his men are ready.', involves: ['Ketil Grimsson', 'Eadric', 'player'] },
  ],
  secrets: [
    { truth: 'Eadric had his brother killed. His huscarl Osric did it at night in Ketil\'s longhouse with a new Norse axe bought for the purpose — to break Wulfstan\'s secret peace with the Danes, start a war, and take Ealdwic for himself.', knownBy: ['Eadric', 'Osric'] },
    { truth: 'Wulfstan was secretly arranging to marry his daughter Ælfgifu to Hrafn Ketilsson as a peace pact between Ealdwic and Ketilsby; that is why he went to Ketil\'s longhouse at night, alone. Eadric found out.', knownBy: ['Ketil Grimsson', 'Ælfgifu', 'Eadric'] },
    { truth: 'Hrafn spent the night of the killing with Ælfgifu at the old mill. He will not say it, to protect her honour; she is afraid to, because her uncle would punish her.', knownBy: ['Hrafn Ketilsson', 'Ælfgifu'] },
    { truth: 'Four days before the killing Bjarni sold a new bearded axe to a Saxon with a burned left hand, who paid in Saxon pennies without haggling.', knownBy: ['Bjarni'] },
  ],
  clues: [
    { place: 'the axe that killed Wulfstan, in the strongroom at Durobrivae', finding: 'The axe is new: no nick on the edge, no grip-wear on the haft, the smith\'s scale still on the steel. No Dane walks to a killing with an unblooded axe.', skill: 'perception', difficulty: 2 },
    { place: 'the back door of Ketil\'s longhouse at Ketilsby', finding: 'A tuft of blue-dyed wool snagged on the iron latch of the back door — the deep woad blue of Eadric\'s household cloaks.', skill: 'perception', difficulty: 3 },
    { place: 'the mud behind Ketil\'s longhouse at Ketilsby', finding: 'Prints of Saxon turnshoes — soft seamless soles, not Danish boots — coming up from the river path and going back down it.', skill: 'survival', difficulty: 3 },
    { place: 'Wulfstan\'s body, laid out in the timber church at Ealdwic', finding: 'The cut was made from behind and a little to the left, by someone standing close: Wulfstan never turned to face his killer — he did not fear him.', skill: 'lore', difficulty: 2 },
    { place: 'the loft of the old mill', finding: 'Fresh-trodden straw, a woman\'s green hair ribbon, and a Danish silver bead fallen between the boards.', skill: 'perception', difficulty: 2 },
    { place: 'the stables at Ealdwic', finding: 'The stable boy, coaxed away from the hall, whispers that Osric came in before dawn on the night of the killing, his cloak soaked to the knee and torn at the hem.', skill: 'persuasion', difficulty: 2 },
  ],
  deadlines: [
    { when: '0879-10-17T06:00', what: 'Eadric\'s fyrd — the armed free men of Ealdwic and the villages around — marches on Ketilsby to burn it; Ketil\'s men will fight, and the valley\'s peace ends in blood.' },
  ],
  economy: {
    priceList: [
      { item: 'a loaf of barley bread', price: 0.25 }, { item: 'a cup of ale', price: 0.25 }, { item: 'a night in an alehouse', price: 1 }, { item: 'a hot meal of pottage and salt fish', price: 0.5 },
      { item: 'a sheep', price: 4 }, { item: 'a cow', price: 24 }, { item: 'a riding horse', price: 120 }, { item: 'a good seax', price: 10 }, { item: 'a bearded axe', price: 15 },
      { item: 'a sword', price: 150 }, { item: 'a mail shirt', price: 400 }, { item: 'a bribe a trader would not refuse', price: 5 },
    ],
    livingCosts: [{ label: 'Food and fuel', amount: 20 }],
    income: [{ label: 'Share of the market tolls at Durobrivae', amount: 30 }],
  },
  openLeads: [
    { title: 'The moot at Durobrivae', description: 'Call both peoples to the old walls and speak your verdict. What you say there, before witnesses of both, becomes law — or war.', when: null, location: 'Durobrivae', cost: null, repeatsWeekly: false },
    { title: 'Wulfstan\'s burial', description: 'The thegn is buried at the timber church in Ealdwic; Eadric will speak over the grave, and the whole village will be there.', when: '0879-10-15T10:00', location: 'The timber church, Ealdwic', cost: null, repeatsWeekly: false },
    { title: 'Market day at Durobrivae', description: 'Traders of both peoples, and everyone with something to sell or to say.', when: '0879-10-15T08:00', location: 'The market inside the walls', cost: null, repeatsWeekly: true },
  ],
  historicalContext: 'Last year King Alfred of Wessex broke the Danish army at Edington; their king Guthrum took baptism and led his men to settle the east. Across this valley the new border runs between Saxon and Danish England. Ketil\'s crew took land at Ketilsby five winters ago; Saxons remember whose fields those were. For six years the arbiter at Durobrivae has kept a fragile peace: tolls, trade, judged quarrels. Wulfstan of Ealdwic was its strongest Saxon friend.',
  currentSituation: 'Dawn, the day after the killing. Rain since Michaelmas. Riders from both sides wait at the gate of Durobrivae: the Danes to ask for the old law, the Saxons to demand the killer. In three days Eadric\'s fyrd marches.',
  initialPressures: [
    'In three days, at dawn, Eadric\'s fyrd marches on Ketilsby. Before then you must find the truth and speak a verdict both peoples will hear.',
    'Everyone is watching what you do — and whose side you seem to be on.',
  ],
  startingScene: { location: 'The gatehouse of Durobrivae', description: 'Dawn and rain. The Roman stones are black with wet; peat smokes under the broken arch. Two riders wait at the gate in the drizzle — a Saxon in a woad-blue cloak, a Dane with an arm-ring — each come to take you to the dead man first.' },
};
