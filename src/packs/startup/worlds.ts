import { EMPTY_DRAFT, type WorldDraft } from '../../domain/world.ts';

// Example worlds for the Startup pack. The World Creation Copilot designs new ones with the player;
// quick start (`npm start -- new --quick`) uses STARTUP_TEMPLATE. Prices are approximate Milan 2026 figures.

const MILAN_PRICES = [
  { item: 'Espresso at a bar', price: 1.3 },
  { item: 'Cappuccino and brioche', price: 3 },
  { item: 'Metro/tram single ticket', price: 2.2 },
  { item: 'Pizza margherita at a pizzeria', price: 9 },
  { item: 'Aperitivo drink', price: 9 },
  { item: 'Lunch menu at a trattoria', price: 14 },
  { item: 'Coworking day pass', price: 20 },
  { item: 'Hackathon ticket', price: 10 },
  { item: 'Train ticket Milan–Turin (regional)', price: 13 },
  { item: '.com domain (per year)', price: 15 },
  { item: 'Basic cloud hosting (per month)', price: 10 },
  { item: 'AI API credits', price: 20 },
  { item: 'Business cards (100)', price: 25 },
  { item: 'Registering an SRL with a notary (all-in estimate)', price: 1500 },
  { item: 'Refurbished laptop', price: 450 },
];

/** Default: an 18-year-old who has already built a small MVP alone. The journey starts here. */
export const STARTUP_TEMPLATE: WorldDraft = {
  ...EMPTY_DRAFT,
  packId: 'startup',
  premise: 'An eighteen-year-old in Milan has built a small MVP alone. No money, no network, no experience — now the startup journey starts.',
  sourceWorld: 'the real world',
  canonPolicy: 'history_continues_unless_changed',
  startingStage: 'mvp',
  setting: {
    place: 'Milan', era: '2026, the present day', startDate: '2026-09-28T08:40', timezone: 'Europe/Rome',
    description: 'The real Milan in autumn 2026: universities starting, a small but active startup scene (coworkings in Isola and Porta Romana, university incubators), expensive rents.',
  },
  style: {
    tone: 'grounded, realistic, sometimes funny', realism: 'high — real prices, real institutions, busy people who owe the player nothing',
    difficulty: 'hard; most attempts fail', narrativeStyle: 'second person, concise', playerSignificance: 'a nobody: no network, no money, no reputation yet',
  },
  designPrinciples: [
    'Do not manufacture destiny around the player; success must be earned.',
    'People have their own lives and priorities; rejection and silence are normal.',
    'Money, time and trust are scarce and tracked.',
  ],
  worldRules: ['The real world of 2026: real laws, real companies, real technology — nothing magical.'],
  player: {
    ...EMPTY_DRAFT.player,
    name: 'Felipe', age: 18, occupation: 'Recent liceo graduate, not enrolled anywhere yet',
    background: 'Born and raised in Milan. Just finished liceo scientifico. Still lives at home with parents. Self-taught programmer. '
      + 'Over the summer he built Grade Economy alone, at night — a landing page and a rough MVP. Never sold anything, never pitched, knows nobody in the startup scene.',
    personality: 'Shaped by the player through play.',
    skills: ['web development (self-taught)', 'stubborn'], goals: ['Turn Grade Economy into a real startup'], fears: ['Wasting a year on something nobody wants'],
    location: 'Milan (family apartment)',
    circumstances: ['lives with parents', 'not enrolled at university'],
    startingMoney: 600, currency: { code: 'EUR', symbol: '€' },
    possessions: ['a five-year-old laptop', 'a phone'],
    knowledge: ['Knows how to build and deploy a small web app', 'Has never talked to an investor'],
    assets: [{
      name: 'Grade Economy', kind: 'product', url: 'https://www.gradeeconomy.com', state: 'mvp',
      description: 'Your grades are your salary: students earn GradeCoins for good results, budget them and invest in a simulated market.',
      metrics: [{ key: 'signups', value: 14 }, { key: 'activeUsers', value: 2 }, { key: 'costPerActiveUserMonthly', value: 0.3 }],
      monthlyCosts: [{ label: 'domain (yearly €15, per month)', amount: 1.25 }],
      knownIssues: ['Signup is confusing on mobile', 'No onboarding — new users do not know what to do first'],
    }],
  },
  actors: [
    { name: 'Carla Bianchi', age: 49, role: "Felipe's mother", description: 'Pharmacist in Città Studi. Practical, loving, worried about her son drifting.',
      personality: 'Warm but direct; asks concrete questions; hates vague answers.', goals: ['See Felipe enrolled somewhere or earning a living'],
      relationshipToPlayer: 'Her son. Proud he builds things, afraid he is wasting a year on a hobby. Wants a real answer by 15 October.' },
    { name: 'Giorgio Bianchi', age: 52, role: "Felipe's father", description: 'Accountant at a logistics company. Careful with money; sceptical of "startups".',
      personality: 'Quiet, dry humour, numbers-first.', goals: ['Keep the family finances steady'],
      relationshipToPlayer: 'His son. Pays his pocket money. Thinks Grade Economy is a nice project but not a job.' },
  ],
  initialSituations: [{ title: 'The university question', summary: 'Carla and Giorgio expect Felipe to decide by 15 October between enrolling at university and finding a job. They see Grade Economy as a hobby.',
    involves: ['Carla Bianchi', 'Giorgio Bianchi', 'player'] }],
  economy: {
    priceList: MILAN_PRICES,
    livingCosts: [{ label: 'Phone plan', amount: 10 }, { label: 'ATM monthly pass (under 27)', amount: 22 }, { label: 'Daily life (coffee, snacks, going out)', amount: 80 }],
    income: [{ label: 'Pocket money from parents', amount: 100 }],
  },
  openLeads: [
    { title: 'Talk: "From side project to startup"', description: 'An evening talk by a founder at a university incubator; open to the public, free.', when: '2026-09-29T18:00', location: 'University incubator, Città Studi', cost: null, repeatsWeekly: false },
    { title: 'Founders\' aperitivo', description: 'A weekly informal meetup of early-stage founders at a coworking in Isola. Free entry; people buy their own drinks.', when: '2026-10-01T19:00', location: 'Coworking space, Isola', cost: null, repeatsWeekly: true },
    { title: 'Weekend hackathon (EdTech track)', description: 'A 24-hour student hackathon with an EdTech track; teams of 2–4, small cash prizes.', when: '2026-10-10T09:00', location: 'Politecnico di Milano, Bovisa', cost: 10, repeatsWeekly: false },
    { title: 'Family dinner: your answer about university', description: 'Your parents expect a decision tonight: enrol, get a job, or convince them otherwise.', when: '2026-10-15T20:00', location: 'Home', cost: null, repeatsWeekly: false },
    { title: 'An online community of Italian founders', description: 'You joined its Slack last month and have never posted.', when: null, location: null, cost: null, repeatsWeekly: false },
  ],
  currentSituation: 'Grade Economy has been live for twelve days: a landing page and a rough MVP at gradeeconomy.com. '
    + '14 people signed up — mostly classmates — and 2 still use it. You built it alone. You have €600 saved, no contacts in the startup scene, '
    + 'and your parents think it\'s a hobby.',
  initialPressures: ['Your parents want to know by 15 October whether you\'re enrolling at university or looking for a job.'],
  startingScene: { location: 'Home — bedroom in the family apartment, Milan', description: 'Monday morning. The house is quiet; your parents have left for work. Laptop open, the Grade Economy dashboard on screen: 14 signups.' },
};

/** The original opening (idea stage, €2,500, no running costs) — kept for tests and the live smoke run. */
export const CLASSIC_DRAFT: WorldDraft = {
  ...EMPTY_DRAFT,
  packId: 'startup',
  premise: 'An eighteen-year-old in Milan wants to build a startup, with €2,500, a laptop and no idea yet.',
  sourceWorld: 'the real world',
  canonPolicy: 'history_continues_unless_changed',
  startingStage: 'idea',
  setting: { place: 'Milan', era: '2026, the present day', startDate: '2026-09-27T09:14', timezone: 'Europe/Rome',
    description: 'The real Milan in September 2026: universities starting, a small but active startup scene, expensive rents.' },
  style: STARTUP_TEMPLATE.style,
  designPrinciples: STARTUP_TEMPLATE.designPrinciples,
  worldRules: STARTUP_TEMPLATE.worldRules,
  player: { ...EMPTY_DRAFT.player,
    name: 'Felipe', age: 18, occupation: 'Recent liceo graduate, not enrolled anywhere yet',
    background: 'Born and raised in Milan. Just finished liceo scientifico. Still lives at home with parents. '
      + 'Self-taught programmer who has built small web apps and scripts. No company yet and little business experience.',
    skills: ['technical', 'ambitious'], goals: ['Build a startup'], location: 'Milan (family apartment)',
    circumstances: ['lives with parents'], startingMoney: 2_500, currency: { code: 'EUR', symbol: '€' }, possessions: ['a laptop', 'a phone'] },
  currentSituation: "You're eighteen and still living with your parents. You've got €2,500 in your bank account, a laptop, and enough programming "
    + "experience to build things yourself. For months you've been thinking about starting a company. You don't have an idea yet. "
    + 'No investors. No employees. No customers.',
  startingScene: { location: 'Home — bedroom in the family apartment, Milan', description: 'Sunday morning. Laptop open on the desk, phone beside it.' },
};
