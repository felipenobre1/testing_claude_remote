import { EMPTY_DRAFT, type WorldDraft } from '../../domain/world.ts';

/**
 * The first book: fallen angels in present-day Rome, in Holy Week. The bible is the author's — it holds everything,
 * including what the reader must not be told yet. The prose reveals only what each scene needs.
 */
export const FALLEN_WORLD: WorldDraft = {
  ...EMPTY_DRAFT,
  packId: 'story',
  premise: 'The fallen angels have lived among us since the fall — not as the monsters people paint, but as doomed, ancient beings who know exactly what they gave up. Every prophecy is fulfilled; their master is desperate, because the Return is near. In present-day Rome, during Holy Week, a hunter and one of the master\'s faithful search for a fallen angel who has hidden from all the others for centuries.',
  sourceWorld: 'the real world, present day; Christian scripture and the Book of Enoch as background',
  canonPolicy: 'background_only',
  setting: {
    place: 'Rome', era: 'the present day, Holy Week (the year is never stated)', startDate: '2027-03-21T05:30', timezone: 'Europe/Rome',
    description: 'Rome exactly as it is today: a city of layers — catacombs under churches, churches on temples, temples on older ruins; trams, scooters, tourists, pilgrims, rain on travertine, the bells of nine hundred churches. During Holy Week the whole city relives the Passion: processions, the Via Crucis by torchlight at the Colosseum on Good Friday, crowds in St Peter\'s Square.',
  },
  style: {
    tone: 'mysterious and unsettling; doomed beings who know they are doomed; the reader is drawn to them, afraid of them, and uneasy at pitying them',
    realism: 'the real world, exactly as it is; the supernatural is felt, almost never seen',
    difficulty: null,
    narrativeStyle: 'third person, past tense, literary Brazilian Portuguese; close to the point-of-view character; restraint; concrete real details of Rome',
    playerSignificance: 'one fallen angel among thousands, old beyond counting, small before the master',
    pace: 'steady', violence: 'graphic', narration: 'literary', language: 'Brazilian Portuguese',
  },
  designPrinciples: [
    'Mystery first: reveal only what the scene needs. Never explain the rules of this world, the master, the past in Heaven or the secrets unless the author asks — let them be felt through gesture, consequence and silence. The reader should end each scene wanting to know more, and a little afraid to.',
    'The fallen speak like ancient beings: few words, precise, cold courtesy, the condescension of those who watched empires rise and rot.',
    'Humans never see them unless they choose to (and that costs them dearly). Humans feel them: a chill, sudden sorrow, a thought that seems their own, the urge to do something they would not do.',
    'The uncanny comes from inside the scenes — a character\'s thought, what happens, what a fallen says to a human — never addressed to the reader.',
    'Everyone knows they are doomed, and so do they. Never preach, never soften it: let the reader feel sorry for them and then question that feeling.',
    'Sariel\'s two "hounds" are a mystery: never name them, describe them or explain them until the author does. At most they are glimpsed, sensed, implied.',
  ],
  worldRules: [
    'There is no forgiveness for the fallen: since the Cross they are doomed, and they know it.',
    'They are spirits, invisible to the natural world unless they choose to be seen. Being seen costs them dearly; mostly they act by inducing feelings and thoughts in humans. Only the most powerful can make themselves visible, and only to some.',
    'They are bound to this world until the Return, when they will be destroyed. They cannot leave.',
    'They are neither omnipresent nor omniscient. They can hide from one another, and most do.',
    'They cannot destroy one another; the stronger subjugate the weaker — by corruption, intelligence, dissuasion. The more one is corrupted, the more it becomes like an animal: wild, very powerful, and tameable by other fallen.',
    'The earth is the master\'s domain: every fallen feels his weight. In his presence his power bends and corrupts them. He can harm, and he can kill even the fallen — he rarely does. He is the father of lies and deception; he subjugates.',
    'They choose their side: most want humanity to perish with them at the Return; a few, unable to feel God or goodness anymore, regret so much that they try to work against the master anyway; others regret and simply do not care, living by rules only they know; some hide alone, complex and powerful, wanting never to be found.',
  ],
  player: {
    ...EMPTY_DRAFT.player,
    name: 'Sariel', age: 40, gender: 'male', occupation: 'a hunter of the fallen',
    background: 'One of the fallen, ancient beyond counting. He finds those who do not want to be found. He regrets, and does not care; he accepted his fate long ago and lives by rules only he knows.',
    personality: 'Cold, patient, ironic, almost bored; precise in everything; courteous the way a blade is courteous.',
    skills: ['finding those who hide', 'reading the traces the fallen leave on humans'],
    goals: ['Find Malariel'], fears: [],
    circumstances: [
      'Corrupted directly by the master: he does what the master commands, and does not care (never stated to the reader until the author decides)',
      'Hunts with two "hounds" — a mystery: never named, described or explained until the author does',
    ],
    ambition: null, location: 'Rome',
  },
  actors: [
    { name: 'Kokabiel', age: 40, gender: 'male', role: 'one of the master\'s faithful', description: 'A fallen angel who serves the master with devotion; he wants humanity to perish with them at the Return.',
      personality: 'Elegant, persuasive, contemptuous of humans; fervent in a way that resembles faith.', goals: ['Bring Malariel back to the master'],
      relationshipToPlayer: 'Uses the hunter as one uses a tool: with respect for its edge, not for its owner.' },
    { name: 'Malariel', age: 40, gender: 'male', role: 'a solitary fallen angel, hidden for centuries', description: 'He has hidden from the other fallen for centuries, somewhere in Rome. Complex and powerful.',
      personality: 'Unknown to the others; the story will show him.', goals: ['Never to be found'],
      relationshipToPlayer: 'Does not know he is being hunted.' },
  ],
  secrets: [
    { truth: 'The master wants every fallen angel gathered back to him before the Return. He has sent Kokabiel to bring Malariel, with Sariel to find him.', knownBy: ['Kokabiel'] },
    { truth: 'Kokabiel and Malariel were close in Heaven, before the fall. This is revealed to the reader only slowly, as the story develops.', knownBy: ['Kokabiel', 'Malariel'] },
  ],
  historicalContext: 'They fell before the world was young, and since then they have lived among humans: through Rome\'s kings and emperors, the martyrs, the plague years, the wars. Since the Cross there has been no forgiveness for them. Now every prophecy is fulfilled, and their master is desperate.',
  currentSituation: 'Palm Sunday, before dawn. Holy Week begins in Rome. Kokabiel has come to the city on the master\'s orders, with Sariel, to find Malariel.',
  initialPressures: [],
  startingScene: { location: 'Rome', description: 'Palm Sunday, before dawn.' },
};
