import { z } from 'zod';
import type { Character } from '../../domain/types.ts';
import type { WorldPlanner } from '../../engine/planner.ts';
import { newId } from '../../engine/util.ts';
import type { GamePack, PackAction } from '../types.ts';
import { ADVENTURE_WORLD } from './world.ts';
import {
  ADVENTURE_MIGRATIONS, AdventureState, advRepo, fameLabel, fameLabelIn, MAX_LEVEL, practiceFor, SKILLS, type Injury, type Item, type Profile,
} from './state.ts';

// ============================================================================
// Game Pack: Adventure — danger, bodies and glory in any fantasy or science-fantasy world.
// The engine decides how fights and risky feats turn out (skills, gear, wounds, a bounded seeded roll);
// the model only proposes what is attempted and portrays what the engine decided.
// ============================================================================

const st = (api: WorldPlanner) => api.packState as AdventureState;
const profile = (api: WorldPlanner, id: string, init?: Partial<Profile>) => st(api).profileOf(id, api.ctx.gameId, api.ctx.now, init);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const BODY = ['left arm', 'right arm', 'ribs', 'thigh', 'shoulder', 'face', 'hand', 'side', 'back', 'leg'];
const QUALITY = ['crude', 'common', 'fine', 'masterwork'];

function skillLevel(p: Profile, skill: string) { return p.skills[skill]?.level ?? 0; }
/** Practice makes better: returns a line when the skill levels up. */
function practise(p: Profile, skill: string, points: number): string | null {
  const s = (p.skills[skill] ??= { level: 0, practice: 0 });
  if (s.level >= MAX_LEVEL) return null;
  s.practice += points;
  let up = false;
  while (s.level < MAX_LEVEL && s.practice >= practiceFor(s.level)) { s.practice -= practiceFor(s.level); s.level++; up = true; }
  return up ? `⬆ ${skill} is now ${s.level}` : null;
}
function hurt(api: WorldPlanner, p: Profile, amount: number, label: string): string | null {
  if (amount <= 0) return null;
  const severity: Injury['severity'] = amount >= 35 ? 'critical' : amount >= 18 ? 'serious' : 'light';
  const part = BODY[Math.min(BODY.length - 1, Math.floor(api.random(`${label}:body`) * BODY.length))]!;
  const text = severity === 'critical' ? `a grievous wound to the ${part}` : severity === 'serious' ? `a deep wound to the ${part}` : `a cut to the ${part}`;
  p.health = Math.max(p.characterId === api.ctx.player.id ? 1 : 0, p.health - amount); // the player is never killed by a single roll
  p.injuries = [...p.injuries, { text, severity }].slice(-6);
  return text;
}
function condition(p: Profile): string {
  const ratio = p.health / p.maxHealth;
  const state = ratio > 0.85 ? 'fit' : ratio > 0.6 ? 'hurt' : ratio > 0.35 ? 'badly hurt' : ratio > 0.1 ? 'in terrible shape' : 'barely alive';
  return `${state} (${p.health}/${p.maxHealth})${p.injuries.length ? ` — ${p.injuries.map((i) => i.text).join(', ')}` : ''}`;
}
function addDeed(p: Profile, deed: string) { p.deeds = [...p.deeds, deed].slice(-4); }

const OUTCOMES = ['decisive', 'win_hurt', 'stalemate', 'lose', 'crushing'] as const;

const actions: PackAction[] = [
  {
    name: 'fight',
    schema: z.strictObject({
      action: z.literal('fight'),
      opponent: z.string().min(2).max(120), // a known person's exact name, or a description ("two dock thugs")
      threat: z.number(), // 1–5, how dangerous the opponent is (ignored for known people with a record)
      intent: z.enum(['kill', 'subdue', 'drive_off', 'defend', 'duel']),
      weaponName: z.string().max(80).nullable(),
      witnessed: z.boolean(), // others see it (fame)
    }),
    doc: 'fight: the player fights now (attacks, defends, duels). opponent = exact name of a known person or a short description; threat 1 (weak) … 5 (deadly) — honest; intent; weaponName from what they carry, or null for bare hands. The game decides the outcome — never narrate who wins.',
    handle: (api, a) => {
      const me = api.ctx.player.id;
      const player = profile(api, me);
      const known = api.findCharacter(String(a.opponent));
      const named: Character | undefined = known && known.id !== me ? known : undefined;
      if (named?.status === 'dead') return api.reject(a, `${named.name} is already dead.`), null;
      const threat = clamp(Math.round(Number(a.threat)), 1, 5);
      const foe = named ? profile(api, named.id, { skills: { combat: { level: threat, practice: 0 } } }) : null;
      const weapon = a.weaponName ? st(api).findItem(me, String(a.weaponName)) : undefined;
      if (a.weaponName && !weapon) return api.reject(a, `You don't have "${a.weaponName}".`), null;
      const armor = st(api).best(me, 'armor');
      const mine = skillLevel(player, 'combat') + (weapon?.kind === 'weapon' ? 1 + weapon.quality : 0) + (armor ? 0.5 + armor.quality * 0.5 : 0)
        - (player.health < 25 ? 2 : player.health < 50 ? 1 : 0);
      const theirs = foe ? skillLevel(foe, 'combat') + 1.5 - (foe.health < 40 ? 1 : 0) : threat * 1.3;
      const roll = api.random(`fight:${a.opponent}`) * 10 - 5;
      const margin = mine - theirs + roll;
      const outcome: (typeof OUTCOMES)[number] = margin >= 4 ? 'decisive' : margin >= 1 ? 'win_hurt' : margin >= -1.5 ? 'stalemate' : margin >= -5 ? 'lose' : 'crushing';
      const dmg = (lo: number, hi: number, k: string) => Math.round(lo + api.random(`fight:${a.opponent}:${k}`) * (hi - lo));
      const taken = { decisive: dmg(0, 6, 'p'), win_hurt: dmg(8, 22, 'p'), stalemate: dmg(8, 20, 'p'), lose: dmg(20, 38, 'p'), crushing: dmg(40, 70, 'p') }[outcome];
      const wound = hurt(api, player, taken, `fight:${a.opponent}:p`);
      const who = named?.name ?? String(a.opponent);
      const foeLine = (() => {
        if (outcome === 'decisive' || outcome === 'win_hurt') {
          if (a.intent === 'kill') {
            if (named) api.setCharacterStatus(named.id, 'dead');
            return named ? `${who} is dead` : `${who}: killed`;
          }
          if (foe) hurt(api, foe, dmg(15, 35, 'f'), `fight:${a.opponent}:f`);
          return a.intent === 'subdue' ? `${who} is beaten and at your mercy` : a.intent === 'drive_off' ? `${who} flees` : `${who} yields`;
        }
        if (outcome === 'stalemate') { if (foe) hurt(api, foe, dmg(8, 20, 'f'), `fight:${a.opponent}:f`); return `neither of you can finish it; you break apart`; }
        return outcome === 'lose' ? `${who} gets the better of you` : `${who} beats you down completely — you are at their mercy`;
      })();
      const label = { decisive: 'decisive victory', win_hurt: 'victory, but it cost you', stalemate: 'stalemate', lose: 'defeat', crushing: 'crushing defeat' }[outcome];
      const lvl = practise(player, 'combat', outcome === 'decisive' || outcome === 'win_hurt' ? 2 : 1);
      let fame = '';
      if (a.witnessed && (outcome === 'decisive' || outcome === 'win_hurt')) {
        const gain = threat >= 4 || named ? 2 : 1;
        player.fame += gain;
        addDeed(player, `${a.intent === 'kill' ? 'killed' : 'beat'} ${who} in front of witnesses`);
        fame = ` · fame +${gain} (${fameLabel(player.fame)})`;
      } else if (a.witnessed && (outcome === 'lose' || outcome === 'crushing')) {
        addDeed(player, `was beaten by ${who} in front of witnesses`);
      }
      st(api).touch(player, api.ctx.now);
      if (foe) st(api).touch(foe, api.ctx.now);
      const line = `⚔ Fight — ${who}: ${label}. ${foeLine[0]!.toUpperCase()}${foeLine.slice(1)}.${wound ? ` You took ${wound} (−${taken}; ${player.health}/${player.maxHealth}).` : ' You are unhurt.'}${lvl ? ` ${lvl}` : ''}${fame}`;
      api.results.push(line);
      api.witnessed.push(`${api.ctx.player.name} fought ${who} (${a.intent}${weapon ? `, with ${weapon.name}` : ', bare-handed'}): ${label}; ${foeLine}${wound ? `; ${api.ctx.player.name} took ${wound}` : ''}.`);
      const observers = [me, ...(named ? [named.id] : []), ...(api.ctx.interaction?.participantIds ?? [])];
      api.event('fight', `${api.ctx.player.name} fought ${who}: ${label}; ${foeLine}.`, observers, [{ characterId: me, role: 'actor' }, ...(named ? [{ characterId: named.id, role: 'actor' as const }] : [])], 4);
      return null;
    },
  },
  {
    name: 'attempt',
    schema: z.strictObject({
      action: z.literal('attempt'), feat: z.string().min(3).max(200), skill: z.enum(SKILLS), difficulty: z.number(),
      risk: z.enum(['none', 'injury', 'caught', 'loss']),
    }),
    doc: `attempt: a risky feat whose outcome is uncertain (climbing, sneaking past guards, persuading a hostile official, surviving a storm). skill one of ${SKILLS.join('/')}; difficulty 1 (easy) … 5 (near impossible) — honest; risk = what failure costs. The game decides success.`,
    handle: (api, a) => {
      const me = api.ctx.player.id;
      const p = profile(api, me);
      const diff = clamp(Math.round(Number(a.difficulty)), 1, 5);
      const margin = skillLevel(p, String(a.skill)) - diff + api.random(`attempt:${a.feat}`) * 8 - 3;
      const outcome = margin >= 1.5 ? 'success' : margin >= -1 ? 'partial' : 'failure';
      let cost = '';
      if (outcome !== 'success' && a.risk === 'injury') {
        const amount = outcome === 'failure' ? 15 + Math.round(api.random(`attempt:${a.feat}:d`) * 15) : 5 + Math.round(api.random(`attempt:${a.feat}:d`) * 8);
        cost = ` You took ${hurt(api, p, amount, `attempt:${a.feat}`)} (−${amount}; ${p.health}/${p.maxHealth}).`;
      } else if (outcome === 'failure' && a.risk !== 'none') {
        cost = a.risk === 'caught' ? ' You were seen.' : ' It cost you something.';
      }
      const lvl = practise(p, String(a.skill), outcome === 'success' ? 1 : 1);
      st(api).touch(p, api.ctx.now);
      const label = { success: 'success', partial: 'partly — it works, but not cleanly', failure: 'failure' }[outcome];
      api.results.push(`🎲 ${a.feat} (${a.skill}, difficulty ${diff}): ${label}.${cost}${lvl ? ` ${lvl}` : ''}`);
      api.witnessed.push(`${api.ctx.player.name} tried to ${a.feat}: ${label}.`);
      api.event('feat', `${api.ctx.player.name} tried to ${a.feat}: ${label}.`, [me, ...(api.ctx.interaction?.participantIds ?? [])], [{ characterId: me, role: 'actor' }], 2);
      return null;
    },
  },
  {
    name: 'rest',
    schema: z.strictObject({ action: z.literal('rest'), hours: z.number(), tended: z.boolean() }),
    doc: 'rest: the player rests or sleeps to recover (hours; tended = a healer or proper care). Heals over time; serious wounds need care and days.',
    handle: (api, a) => {
      const p = profile(api, api.ctx.player.id);
      const hours = clamp(Number(a.hours), 0, 72);
      const gain = Math.round(Math.min(60, hours * (a.tended ? 3 : 1.5)));
      const before = p.health;
      p.health = Math.min(p.maxHealth, p.health + gain);
      const healed: string[] = [];
      const canHeal = (i: Injury) => i.severity === 'light' ? hours >= 6 : i.severity === 'serious' ? Boolean(a.tended) && hours >= 12 : Boolean(a.tended) && hours >= 48;
      p.injuries = p.injuries.filter((i) => (canHeal(i) && healed.length < 2 ? (healed.push(i.text), false) : true));
      st(api).touch(p, api.ctx.now);
      api.results.push(`🛏 Rested ${hours}h: health ${before} → ${p.health}${healed.length ? ` · healed: ${healed.join(', ')}` : ''}${p.injuries.length ? ` · still: ${p.injuries.map((i) => i.text).join(', ')}` : ''}`);
      return null;
    },
  },
  {
    name: 'train',
    schema: z.strictObject({ action: z.literal('train'), skill: z.enum(SKILLS), hours: z.number(), teacherName: z.string().nullable() }),
    doc: `train: deliberate practice of a skill (${SKILLS.join('/')}) for some hours, alone or with a teacher (a known person, by exact name).`,
    handle: (api, a) => {
      const p = profile(api, api.ctx.player.id);
      const teacher = a.teacherName ? api.findCharacter(String(a.teacherName)) : undefined;
      if (a.teacherName && (!teacher || teacher.status === 'dead')) return api.reject(a, `There is no one called ${a.teacherName} to train with.`), null;
      const points = Math.max(1, Math.floor(clamp(Number(a.hours), 0, 40) / (teacher ? 1.5 : 3)));
      const lvl = practise(p, String(a.skill), points);
      st(api).touch(p, api.ctx.now);
      const s = p.skills[String(a.skill)]!;
      api.results.push(`🏋 Trained ${a.skill}${teacher ? ` with ${teacher.name}` : ''}: ${lvl ?? `level ${s.level}`} (practice ${s.practice}/${practiceFor(s.level)})`);
      return null;
    },
  },
  {
    name: 'acquire_item',
    schema: z.strictObject({
      action: z.literal('acquire_item'), name: z.string().min(2).max(80), kind: z.enum(['weapon', 'armor', 'gear', 'valuable']), quality: z.number(),
      quantity: z.number(), how: z.enum(['bought', 'found', 'looted', 'given', 'made']), price: z.number().nullable(),
    }),
    doc: 'acquire_item: the player gets a weapon, armour, gear or a valuable now (bought → price is paid; looted only from someone defeated). quality 0 crude … 3 masterwork — honest.',
    handle: (api, a) => {
      const me = api.ctx.player.id;
      if (a.how === 'bought') {
        const cents = Math.round(Number(a.price ?? 0) * 100);
        if (cents <= 0) return 'acquire_item: a bought item needs a price';
        const acct = api.ensureAccount('character', me);
        if (acct.balanceCents < cents) return api.reject(a, `You can't afford ${a.name} (${api.money(cents)}; you have ${api.money(acct.balanceCents)}).`), null;
        api.move(acct, null, cents, String(a.name), 'expense');
      }
      const item: Item = { id: newId('item'), gameId: api.ctx.gameId, ownerId: me, name: String(a.name), kind: a.kind as Item['kind'],
        quality: clamp(Math.round(Number(a.quality)), 0, 3), quantity: Math.max(1, Math.round(Number(a.quantity))), createdAt: api.ctx.now };
      st(api).addItem(item);
      api.results.push(`🎒 ${a.how === 'bought' ? 'Bought' : a.how === 'looted' ? 'Took' : a.how === 'made' ? 'Made' : 'Got'}: ${item.name} (${QUALITY[item.quality]} ${item.kind}${item.quantity > 1 ? ` ×${item.quantity}` : ''})`);
      return null;
    },
  },
  {
    name: 'part_with_item',
    schema: z.strictObject({ action: z.literal('part_with_item'), name: z.string(), how: z.enum(['given', 'sold', 'lost', 'used', 'dropped']), toCharacterName: z.string().nullable(), price: z.number().nullable() }),
    doc: 'part_with_item: the player gives, sells, loses or uses up something they carry.',
    handle: (api, a) => {
      const me = api.ctx.player.id;
      const item = st(api).findItem(me, String(a.name));
      if (!item) return api.reject(a, `You don't have "${a.name}".`), null;
      const to = a.toCharacterName ? api.findCharacter(String(a.toCharacterName)) : undefined;
      if (to && a.how === 'given') st(api).giveItem(item, to.id); else st(api).removeItem(item, 1);
      if (a.how === 'sold' && a.price) api.move(null, api.ensureAccount('character', me), Math.round(Number(a.price) * 100), `sold ${item.name}`, 'income');
      api.results.push(`🎒 ${a.how === 'sold' ? `Sold ${item.name}${a.price ? ` for ${api.money(Math.round(Number(a.price) * 100))}` : ''}` : `${item.name}: ${a.how}${to ? ` to ${to.name}` : ''}`}`);
      return null;
    },
  },
];

function playerLines(api: WorldPlanner): string[] {
  const me = api.ctx.player.id;
  const p = profile(api, me);
  const skills = SKILLS.map((s) => `${s} ${skillLevel(p, s)}`).join(', ');
  const gear = st(api).itemsOf(me).map((i) => `${i.name} (${QUALITY[i.quality]} ${i.kind}${i.quantity > 1 ? ` ×${i.quantity}` : ''})`).join(', ');
  return [`Condition: ${condition(p)}`, `Skills (0–5): ${skills}`, `Carrying: ${gear || 'nothing of note'}`, `Reputation: ${fameLabel(p.fame)}${p.deeds.length ? ` — people talk about how ${api.ctx.player.name} ${p.deeds.join('; ')}` : ''}`];
}

export const adventurePack: GamePack = {
  id: 'adventure',
  name: 'Adventure',
  currency: { code: 'COIN', symbol: '¤' },
  migrations: ADVENTURE_MIGRATIONS,
  worldCreation: {
    summary: 'danger, bodies and glory in any fantasy or science-fantasy world: fights, wounds, skills, gear, feats and fame',
    guidance: [
      'Adventure mechanics: the game resolves fights and risky feats from skills (0–5), weapons/armour and wounds; health and injuries; skills grow with practice;',
      'fame grows with witnessed deeds and people hear of it. Good for fantasy, science-fantasy, a known universe used as reference (Dune-like, etc.).',
      `Ask for the player's AMBITION (what they dream of becoming) and set player.attributes with starting skill levels: ${SKILLS.join(', ')} (0–5, most 0–2 at the start), plus fame (usually 0).`,
      'Starting gear goes in player.assets with kind weapon/armor/gear/valuable and metrics quality (0–3) and quantity. Suggest pace eventful, narration literary, and ask how violence should be shown.',
      'Start in the middle of the world: a place with danger nearby, a few people who matter (a teacher, a rival, someone the player owes), and 2–3 open leads with dates.',
    ].join('\n'),
    assetKinds: [
      { kind: 'weapon', description: 'a weapon the player carries', metrics: ['quality', 'quantity'] },
      { kind: 'armor', description: 'armour or protective clothing', metrics: ['quality', 'quantity'] },
      { kind: 'gear', description: 'useful equipment', metrics: ['quality', 'quantity'] },
      { kind: 'valuable', description: 'something worth money or meaning', metrics: ['quality', 'quantity'] },
    ],
    validate(draft) {
      return draft.player.attributes.filter((x) => (SKILLS as readonly string[]).includes(x.key) && (x.value < 0 || x.value > MAX_LEVEL))
        .map((x) => `${x.key} must be between 0 and ${MAX_LEVEL}`);
    },
    seed({ store, gameId, player, seed, now }) {
      const attrs = Object.fromEntries(seed.player.attributes.map((x) => [x.key, x.value]));
      advRepo.saveProfile(store, {
        characterId: player.id, gameId, health: 100, maxHealth: 100, injuries: [], fame: Math.max(0, Math.round(attrs.fame ?? 0)), deeds: [],
        skills: Object.fromEntries(SKILLS.map((s) => [s, { level: clamp(Math.round(attrs[s] ?? 0), 0, MAX_LEVEL), practice: 0 }])),
        createdAt: now, updatedAt: now,
      });
      for (const a of seed.player.assets.filter((x) => ['weapon', 'armor', 'gear', 'valuable'].includes(x.kind))) {
        const m = Object.fromEntries(a.metrics.map((x) => [x.key, x.value]));
        advRepo.insertItem(store, { id: newId('item'), gameId, ownerId: player.id, name: a.name, kind: a.kind as Item['kind'],
          quality: clamp(Math.round(m.quality ?? 1), 0, 3), quantity: Math.max(1, Math.round(m.quantity ?? 1)), createdAt: now });
      }
    },
    template: ADVENTURE_WORLD,
  },
  weekly(api) {
    const p = profile(api, api.ctx.player.id);
    const before = p.health;
    p.health = Math.min(p.maxHealth, p.health + 10);
    p.injuries = p.injuries.filter((i) => i.severity !== 'light');
    st(api).touch(p, api.ctx.now);
    return [`Body: ${before} → ${p.health} health · ${condition(p)}`, `Reputation: ${fameLabel(p.fame)} (${p.fame})`];
  },
  offerKinds: [{
    kind: 'deal',
    summary: 'an agreement: service, protection, a job, a trade — money may change hands',
    terms: [
      { key: 'price_offerer_pays', description: 'money the offerer pays the recipient on acceptance', required: false },
      { key: 'price_offerer_receives', description: 'money the recipient pays the offerer on acceptance', required: false },
    ],
    validateTerms: (t) => (Object.values(t).some((v) => v < 0) ? 'prices cannot be negative' : null),
    resolveSubject: () => ({ subjectRef: null }),
    describe: (api, o) => {
      const pays = o.terms.price_offerer_pays, gets = o.terms.price_offerer_receives;
      return `${o.label ?? o.description}${pays ? ` for ${api.money(Math.round(pays * 100))}` : gets ? ` at ${api.money(Math.round(gets * 100))}` : ''}`;
    },
    execute: (api, o) => {
      const from = api.ensureAccount('character', o.fromCharacterId), to = api.ensureAccount('character', o.toCharacterId);
      const pays = Math.round((o.terms.price_offerer_pays ?? 0) * 100), gets = Math.round((o.terms.price_offerer_receives ?? 0) * 100);
      if (pays) api.move(from, to, pays, o.label ?? 'deal', 'deal');
      if (gets) api.move(to, from, gets, o.label ?? 'deal', 'deal');
      api.results.push(`✓ Deal: ${o.label ?? o.description}`);
    },
  }],
  entities: { find: () => undefined, name: (_api, id) => id, controlledBy: () => false },
  actions,
  createTurnState: (store, gameId) => new AdventureState(store, gameId),
  briefing: {
    player: playerLines,
    // What anyone can know about the player: their reputation and how they look.
    npc: (api) => {
      const p = profile(api, api.ctx.player.id);
      return [`What people say about ${api.ctx.player.name}: ${fameLabel(p.fame)}${p.deeds.length ? ` — ${p.deeds.join('; ')}` : ''}`,
        ...(p.injuries.length ? [`${api.ctx.player.name} visibly carries: ${p.injuries.map((i) => i.text).join(', ')}`] : [])];
    },
  },
  statusParts(store, _gameId, playerId, lang = 'en') {
    const p = advRepo.profile(store, playerId);
    if (!p) return [];
    return [`❤ ${p.health}/${p.maxHealth}`, `⚔ ${lang === 'pt' ? 'combate' : 'combat'} ${p.skills.combat?.level ?? 0}`, `★ ${fameLabelIn(p.fame, lang)}`];
  },
  prompts: {
    interpretActions: [
      '  Adventure actions (the game decides outcomes — never narrate who wins or whether a feat works):',
      ...actions.map((a) => `  - ${a.doc}`),
      '  Offer kinds for make_offer: deal (terms: price_offerer_pays and/or price_offerer_receives; put what is exchanged in label/description).',
    ].join('\n'),
    director: 'A dangerous world of factions, feuds, debts, rivals, beasts and opportunities. Developments come from people\'s ambitions and grudges, '
      + 'from what the player did (fights are remembered, fame attracts challengers and patrons), and from the player\'s ambition: put chances and prices on the road to it.',
  },
  inspect(store, gameId) {
    const names = new Map(store.listCharacters(gameId).map((c) => [c.id, c.name]));
    return ['── ADVENTURE ──', ...advRepo.profiles(store, gameId).map((p) => `  ${names.get(p.characterId)}: ${condition(p)} · skills ${JSON.stringify(p.skills)} · fame ${p.fame}`),
      ...advRepo.items(store, gameId).map((i) => `  item ${i.name} (${i.kind}, q${i.quality} ×${i.quantity}) → ${names.get(i.ownerId)}`)].join('\n');
  },
};
