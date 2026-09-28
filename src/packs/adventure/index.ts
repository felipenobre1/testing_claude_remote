import { z } from 'zod';
import type { Character } from '../../domain/types.ts';
import type { WorldPlanner } from '../../engine/planner.ts';
import { newId } from '../../engine/util.ts';
import type { Store } from '../../db/store.ts';
import type { GamePack, PackAction } from '../types.ts';
import { ADVENTURE_WORLD } from './world.ts';
import {
  ADVENTURE_MIGRATIONS, AdventureState, advRepo, ATTRIBUTES, DEFAULT_ATTRIBUTES, fameLabel, fameLabelIn, MAX_LEVEL, practiceFor, SKILL_ATTR, SKILLS, xpForNext,
  type Injury, type Item, type Profile, type Skill,
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
/** Wounds someone. Only a lethal fight (someone means to kill) can bring health to 0 — and at 0 they die. */
function hurt(api: WorldPlanner, p: Profile, amount: number, label: string, lethal = false, blunt = false): string | null {
  if (amount <= 0) return null;
  const severity: Injury['severity'] = amount >= 35 ? 'critical' : amount >= 18 ? 'serious' : 'light';
  const part = BODY[Math.min(BODY.length - 1, Math.floor(api.random(`${label}:body`) * BODY.length))]!;
  // Fists, clubs and training blows bruise and crack; blades cut.
  const text = blunt
    ? (severity === 'critical' ? `a crushing blow to the ${part}` : severity === 'serious' ? `a heavy blow to the ${part}` : `a bruise on the ${part}`)
    : (severity === 'critical' ? `a grievous wound to the ${part}` : severity === 'serious' ? `a deep wound to the ${part}` : `a cut to the ${part}`);
  p.health = Math.max(lethal ? 0 : 1, p.health - amount);
  p.injuries = [...p.injuries, { text, severity }].slice(-6);
  if (p.health === 0) api.setCharacterStatus(p.characterId, 'dead');
  return text;
}
function condition(p: Profile): string {
  const ratio = p.health / p.maxHealth;
  const state = ratio > 0.85 ? 'fit' : ratio > 0.6 ? 'hurt' : ratio > 0.35 ? 'badly hurt' : ratio > 0.1 ? 'in terrible shape' : 'barely alive';
  return `${state} (${p.health}/${p.maxHealth})${p.injuries.length ? ` — ${p.injuries.map((i) => i.text).join(', ')}` : ''}`;
}
function addDeed(p: Profile, deed: string) { p.deeds = [...p.deeds, deed].slice(-4); }

/** The attribute behind a skill shifts every check: 2 is average (±0), 5 is +1.5, 1 is −0.5. */
function attrBonus(p: Profile, skill: string): number {
  const attr = SKILL_ATTR[skill as Skill];
  return attr ? ((p.attributes[attr] ?? 2) - 2) * 0.5 : 0;
}

type CheckOutcome = 'success' | 'partial' | 'failure';
const n1 = (x: number) => (Math.round(x * 10) / 10).toString();
const signed = (x: number) => `${x >= 0 ? '+' : '−'}${n1(Math.abs(x))}`;
/** A seeded d20 (1–20). */
function d20(api: WorldPlanner, label: string): number { return Math.min(20, Math.floor(api.random(label) * 20) + 1); }

/**
 * One uncertain act: skill + attribute bonus − difficulty (− the other side's skill) + d20 (1 → −3 … 20 → +5).
 * `detail` shows the player what went into the roll. For acts where a hidden witness is possible, the margin is not shown.
 */
function check(api: WorldPlanner, p: Profile, skill: string, difficulty: number, label: string, opposed = 0, opposedLabel = 'resistance', showMargin = true)
  : { outcome: CheckOutcome; margin: number; detail: string } {
  const die = d20(api, `check:${label}`);
  const bonus = attrBonus(p, skill);
  const margin = skillLevel(p, skill) + bonus - difficulty - opposed + ((die - 1) / 19) * 8 - 3;
  const attr = SKILL_ATTR[skill as Skill];
  const detail = ` [${skill} ${skillLevel(p, skill)}${attr && bonus ? ` ${attr} ${signed(bonus)}` : ''} − difficulty ${n1(difficulty)}${opposed ? ` − ${opposedLabel} ${n1(opposed)}` : ''} · d20 ${die}${showMargin ? ` → ${signed(margin)}` : ''}]`;
  return { outcome: margin >= 1.5 ? 'success' : margin >= -1 ? 'partial' : 'failure', margin, detail };
}

/** Maximum health comes from the body: 70 + strength × 10, +5 per level after the first. */
export const maxHealthFor = (p: Pick<Profile, 'attributes' | 'level'>) => 70 + (p.attributes.strength ?? 2) * 10 + (p.level - 1) * 5;

/** Experience: rolled from what was done (base ±25%); levels give points to spend on the sheet and a little more health. */
function gainXp(api: WorldPlanner, p: Profile, base: number, label: string): string {
  if (base <= 0 || p.characterId !== api.ctx.player.id) return '';
  const amount = Math.max(1, Math.round(base * (0.75 + api.random(`xp:${label}`) * 0.5)));
  p.xp += amount;
  let ups = 0;
  while (p.xp >= xpForNext(p.level)) { p.xp -= xpForNext(p.level); p.level++; p.points++; p.maxHealth = maxHealthFor(p); p.health += 5; ups++; }
  return ` · ✨ +${amount} XP${ups ? ` · ⬆ LEVEL ${p.level}! +${ups} point${ups > 1 ? 's' : ''} to spend (/sheet, /spend <skill or attribute>)` : ''}`;
}

const OUTCOMES = ['decisive', 'win_hurt', 'stalemate', 'lose', 'crushing'] as const;
type PlayerIntent = 'kill' | 'subdue' | 'drive_off' | 'defend' | 'duel' | 'spar';
type FoeIntent = 'kill' | 'hurt' | 'humiliate' | 'drive_off' | 'spar';
/** Is the attacker hitting with fists, a club or a training weapon (bruises) rather than a blade (cuts)? */
const BLUNT = /\b(fist|fists|punch|kick|knee|elbow|bare|unarmed|brawl|cudgel|club|staff|stick|flat of|training|wooden|sparring|punho|soco|chute|joelh|cotovel|mãos|desarmad|bastão|porrete|treino|madeira)/i;

/**
 * One fight, whoever started it. Outcome from the player's side: skill + weapon + armour − wounds vs the opponent,
 * plus a bounded seeded roll. The player can die only if the opponent fights to kill.
 */
type FightResult = { error: string } | { outcome: (typeof OUTCOMES)[number]; playerDied: boolean };

function resolveFight(api: WorldPlanner, f: {
  opponent: string; named?: Character; threat: number; playerIntent: PlayerIntent; foeIntent: FoeIntent;
  weaponName: string | null; witnessed: boolean; aggressor: 'player' | 'npc'; guarding?: string; foeBlunt?: boolean;
}): FightResult {
  const me = api.ctx.player.id;
  const player = profile(api, me);
  const { named } = f;
  const foe = named ? profile(api, named.id, { skills: { combat: { level: f.threat, practice: 0 } } }) : null;
  const weapon = f.weaponName ? st(api).findItem(me, f.weaponName) : f.aggressor === 'npc' ? st(api).best(me, 'weapon') : undefined;
  if (f.weaponName && !weapon) return { error: `You don't have "${f.weaponName}".` };
  const armor = st(api).best(me, 'armor');
  const parts: [string, number][] = [
    ['combat', skillLevel(player, 'combat')], ['strength', attrBonus(player, 'combat')],
    [weapon?.kind === 'weapon' ? weapon.name : 'bare hands', weapon?.kind === 'weapon' ? 1 + weapon.quality : 0],
    [armor?.name ?? 'no armour', armor ? 0.5 + armor.quality * 0.5 : 0],
    ['wounds', -(player.health < 25 ? 2 : player.health < 50 ? 1 : 0)], ['caught first', f.aggressor === 'npc' ? -0.5 : 0],
  ];
  const mine = parts.reduce((n, [, v]) => n + v, 0);
  const theirs = foe ? skillLevel(foe, 'combat') + attrBonus(foe, 'combat') + 1.5 - (foe.health < 40 ? 1 : 0) : f.threat * 1.3;
  const die = d20(api, `fight:${f.opponent}`);
  const margin = mine - theirs + ((die - 1) / 19) * 10 - 5; // d20: 1 → −5 … 20 → +5
  const rollDetail = ` [you ${n1(mine)} (${parts.filter(([k, v]) => v !== 0 || k === 'combat').map(([k, v]) => `${k} ${k === 'combat' ? v : signed(v)}`).join(', ')}) vs ${named?.name ?? f.opponent} ${n1(theirs)} · d20 ${die} → ${signed(margin)}]`;
  const outcome: (typeof OUTCOMES)[number] = margin >= 4 ? 'decisive' : margin >= 1 ? 'win_hurt' : margin >= -1.5 ? 'stalemate' : margin >= -5 ? 'lose' : 'crushing';
  const dmg = (lo: number, hi: number, k: string) => Math.round(lo + api.random(`fight:${f.opponent}:${k}`) * (hi - lo));
  const lethal = f.foeIntent === 'kill';
  // Sparring is practice: bruises, never wounds that need a surgeon, nobody dies, nothing to answer for.
  const spar = f.playerIntent === 'spar' || f.foeIntent === 'spar';
  const taken = spar
    ? { decisive: dmg(0, 2, 'p'), win_hurt: dmg(2, 6, 'p'), stalemate: dmg(3, 7, 'p'), lose: dmg(5, 10, 'p'), crushing: dmg(8, 14, 'p') }[outcome]
    : { decisive: dmg(0, 6, 'p'), win_hurt: dmg(8, 22, 'p'), stalemate: dmg(8, 20, 'p'), lose: dmg(20, 38, 'p'), crushing: lethal ? dmg(60, 110, 'p') : dmg(40, 70, 'p') }[outcome];
  const foeBlunt = spar || Boolean(f.foeBlunt) || BLUNT.test(f.opponent);
  const playerBlunt = spar || !weapon || weapon.kind !== 'weapon' || BLUNT.test(weapon.name);
  const wound = hurt(api, player, taken, `fight:${f.opponent}:p`, lethal, foeBlunt);
  const who = named?.name ?? f.opponent;
  const playerDied = player.health === 0;
  const foeLine = (() => {
    if (playerDied) return `${who} kills you`;
    if (spar) {
      if (foe && outcome !== 'decisive') hurt(api, foe, dmg(2, 8, 'f'), `fight:${f.opponent}:f`, false, true);
      return { decisive: `you get the better of ${who} — clean`, win_hurt: `you take the round from ${who}`, stalemate: 'an even round', lose: `${who} takes the round`, crushing: `${who} puts you on the ground` }[outcome];
    }
    if (outcome === 'decisive' || outcome === 'win_hurt') {
      if (f.playerIntent === 'kill') {
        if (named) { if (foe) foe.health = 0; api.setCharacterStatus(named.id, 'dead'); }
        return named ? `${who} is dead` : `${who}: killed`;
      }
      if (foe) hurt(api, foe, dmg(15, 35, 'f'), `fight:${f.opponent}:f`, false, playerBlunt);
      return f.playerIntent === 'subdue' ? `${who} is beaten and at your mercy` : f.playerIntent === 'drive_off' || f.playerIntent === 'defend' ? `${who} is beaten back` : `${who} yields`;
    }
    if (outcome === 'stalemate') { if (foe) hurt(api, foe, dmg(8, 20, 'f'), `fight:${f.opponent}:f`, false, playerBlunt); return 'neither of you can finish it; you break apart'; }
    if (outcome === 'lose') return f.foeIntent === 'humiliate' ? `${who} humiliates you` : `${who} gets the better of you`;
    return `${who} beats you down completely — you are at their mercy`;
  })();
  const label = playerDied ? 'death' : spar ? 'sparring' : { decisive: 'decisive victory', win_hurt: 'victory, but it cost you', stalemate: 'stalemate', lose: 'defeat', crushing: 'crushing defeat' }[outcome];
  const xp = playerDied ? '' : gainXp(api, player, f.threat * (spar ? 0.5 : 1) * { decisive: 15, win_hurt: 12, stalemate: 6, lose: 4, crushing: 3 }[outcome], `fight:${f.opponent}`);
  let fame = '';
  if (!spar && !playerDied && f.witnessed && (outcome === 'decisive' || outcome === 'win_hurt')) {
    const gain = f.threat >= 4 || named ? 2 : 1;
    player.fame += gain;
    addDeed(player, `${f.playerIntent === 'kill' ? 'killed' : 'beat'} ${who} in front of witnesses`);
    fame = ` · fame +${gain} (${fameLabel(player.fame)})`;
  } else if (!spar && f.witnessed && (outcome === 'lose' || outcome === 'crushing')) {
    addDeed(player, playerDied ? `was killed by ${who}` : `was beaten by ${who} in front of witnesses`);
  }
  st(api).touch(player, api.ctx.now);
  if (foe) st(api).touch(foe, api.ctx.now);
  const head = f.aggressor === 'npc' ? `⚔ ${who} attack${/\b(guards|men|crew|they)\b|s$/i.test(who) ? '' : 's'} you${lethal ? ' to kill' : ''}` : `⚔ Fight — ${who}`;
  const line = playerDied
    ? `${head}: ${who} kills you. You took ${wound}. ☠ ${api.ctx.player.name} is dead.${rollDetail}`
    : `${head}: ${label}. ${foeLine[0]!.toUpperCase()}${foeLine.slice(1)}.${wound ? ` You took ${wound} (−${taken}; ${player.health}/${player.maxHealth}).` : ' You are unhurt.'}${fame}${xp}${rollDetail}`;
  api.results.push(line);
  api.witnessed.push(`${f.aggressor === 'npc' ? `${who} attacked ${api.ctx.player.name} (${f.foeIntent})` : `${api.ctx.player.name} fought ${who} (${f.playerIntent}${weapon ? `, with ${weapon.name}` : ', bare-handed'})`}: ${label}; ${foeLine}${wound ? `; ${api.ctx.player.name} took ${wound}` : ''}.`);
  const observers = [me, ...(named ? [named.id] : []), ...(api.ctx.interaction?.participantIds ?? [])];
  api.event('fight', `${f.aggressor === 'npc' ? `${who} attacked ${api.ctx.player.name}` : `${api.ctx.player.name} fought ${who}`}: ${label}; ${foeLine}.`, observers,
    [{ characterId: me, role: 'actor' }, ...(named ? [{ characterId: named.id, role: 'actor' as const }] : [])], playerDied ? 5 : 4);

  // What the player did will come back to them — sooner and harder the worse it was, the more important the victim, the more who saw it.
  if (!spar && f.aggressor === 'player' && !playerDied && (outcome !== 'stalemate' || f.guarding)) {
    const where = api.ctx.location;
    const seen = f.witnessed ? ' in front of witnesses' : '';
    const won = outcome === 'decisive' || outcome === 'win_hurt';
    const victim = named ? `${named.name} (${named.role})` : who;
    if (f.guarding && !won) api.consequence(`${api.ctx.player.name} attacked ${f.guarding} and was stopped by ${who}${seen} at ${where}${outcome === 'stalemate' ? '' : `; ${api.ctx.player.name} is at their mercy`}.`, 10);
    else if (won && f.playerIntent === 'kill' && named) api.consequence(`${api.ctx.player.name} killed ${victim}${seen} at ${where}.`, f.witnessed ? 60 + api.random('conseq') * 120 : 12 * 60 + api.random('conseq') * 36 * 60);
    else if (won && f.playerIntent === 'kill') { if (f.witnessed) api.consequence(`${api.ctx.player.name} killed ${victim}${seen} at ${where}.`, 3 * 60 + api.random('conseq') * 6 * 60); }
    else if (won && named) api.consequence(`${api.ctx.player.name} beat ${victim}${seen} at ${where}.`, 24 * 60 + api.random('conseq') * 48 * 60);
  }
  return { outcome, playerDied };
}

const actions: PackAction[] = [
  {
    name: 'fight',
    schema: z.strictObject({
      action: z.literal('fight'),
      opponent: z.string().min(2).max(120), // a known person's exact name, or a description ("two dock thugs")
      threat: z.number(), // 1–5, how dangerous the opponent is (ignored for known people with a record)
      intent: z.enum(['kill', 'subdue', 'drive_off', 'defend', 'duel', 'spar']),
      weaponName: z.string().max(80).nullable(),
      witnessed: z.boolean(), // others see it (fame)
      guards: z.strictObject({ who: z.string().min(2).max(120), threat: z.number() }).nullable(), // who protects the target here, if anyone
    }),
    doc: 'fight: the player fights now (attacks, defends, duels). opponent = exact name of a known person or a short description; threat 1 (weak) … 5 (deadly) — honest; intent; weaponName from what they carry, or null for bare hands. Use intent spar for agreed practice bouts and training rounds (bruises, not wounds; one fight action per exchange the player makes). guards: if the target is protected HERE (a lord with his guard, a merchant with bodyguards, a crowded barracks), who protects them and how dangerous they are (1–5) — the player must get through them first; null if the target is alone. The game decides the outcome — never narrate who wins.',
    handle: (api, a) => {
      const known = api.findCharacter(String(a.opponent));
      const named: Character | undefined = known && known.id !== api.ctx.player.id ? known : undefined;
      if (named?.status === 'dead') return api.reject(a, `${named.name} is already dead.`), null;
      const intent = a.intent as PlayerIntent;
      const threat = clamp(Math.round(Number(a.threat)), 1, 5);
      // Whoever you try to kill fights for their life; a duel with a deadly opponent is to the death.
      const foeIntent: FoeIntent = intent === 'spar' ? 'spar' : intent === 'kill' || (intent === 'duel' && threat >= 4) ? 'kill' : 'hurt';
      const weaponName = (a.weaponName as string | null) ?? null;
      const guards = a.guards as { who: string; threat: number } | null;
      if (guards) {
        // The guards stand in the way: only a decisive win against them gets the player to the target.
        const target = named?.name ?? String(a.opponent);
        const r = resolveFight(api, { opponent: guards.who, threat: clamp(Math.round(Number(guards.threat)), 1, 5), playerIntent: intent === 'kill' ? 'kill' : 'subdue',
          foeIntent: intent === 'kill' ? 'kill' : 'hurt', weaponName, witnessed: true, aggressor: 'player', guarding: target });
        if ('error' in r) return api.reject(a, r.error), null;
        if (r.playerDied || r.outcome !== 'decisive') {
          if (!r.playerDied) api.results.push(`You never reach ${target}.`);
          return null;
        }
      }
      const r = resolveFight(api, { opponent: String(a.opponent), named, threat, playerIntent: intent, foeIntent, weaponName, witnessed: Boolean(a.witnessed), aggressor: 'player' });
      if ('error' in r) return api.reject(a, r.error), null;
      return null;
    },
  },
  {
    name: 'attempt',
    schema: z.strictObject({
      action: z.literal('attempt'), feat: z.string().min(3).max(200), skill: z.enum(SKILLS), difficulty: z.number(),
      risk: z.enum(['none', 'injury', 'caught', 'loss']),
    }),
    doc: `attempt: a risky feat whose outcome is uncertain — climbing, sneaking or hiding (stealth, risk caught), picking a lock, tracking, spotting something hidden (perception), surviving a storm, recalling lore. skill one of ${SKILLS.join('/')}; difficulty 1 (easy) … 5 (near impossible) — honest; risk = what failure costs. The game decides success.`,
    handle: (api, a) => {
      const me = api.ctx.player.id;
      const p = profile(api, me);
      const diff = clamp(Math.round(Number(a.difficulty)), 1, 5);
      const { outcome, detail } = check(api, p, String(a.skill), diff, `attempt:${a.feat}`, 0, '', a.risk !== 'caught');
      let cost = '';
      if (outcome !== 'success' && a.risk === 'injury') {
        const amount = outcome === 'failure' ? 15 + Math.round(api.random(`attempt:${a.feat}:d`) * 15) : 5 + Math.round(api.random(`attempt:${a.feat}:d`) * 8);
        cost = ` You took ${hurt(api, p, amount, `attempt:${a.feat}`)} (−${amount}; ${p.health}/${p.maxHealth}).`;
      } else if (outcome === 'failure' && a.risk === 'caught') {
        cost = ' You were seen.';
        api.consequence(`${api.ctx.player.name} was caught trying to ${a.feat} at ${api.ctx.location}.`, 5 + api.random(`attempt:${a.feat}:c`) * 40);
      } else if (outcome === 'partial' && a.risk === 'caught') {
        // It looked clean. It wasn't: someone saw, and the player doesn't know.
        api.consequence(`Someone saw ${api.ctx.player.name} ${a.feat} at ${api.ctx.location} — ${api.ctx.player.name} does not know they were seen.`, 2 * 60 + api.random(`attempt:${a.feat}:c`) * 22 * 60);
      } else if (outcome === 'failure' && a.risk === 'loss') {
        cost = ' It cost you something.';
      }
      const xp = gainXp(api, p, diff * { success: 8, partial: 4, failure: 2 }[outcome], `attempt:${a.feat}`);
      st(api).touch(p, api.ctx.now);
      const shown = outcome === 'partial' && a.risk === 'caught' ? 'success' : outcome; // a hidden witness is not shown
      const label = { success: 'success', partial: 'partly — it works, but not cleanly', failure: 'failure' }[shown];
      api.results.push(`🎲 ${a.feat}: ${label}.${cost}${xp}${detail}`);
      api.witnessed.push(`${api.ctx.player.name} tried to ${a.feat}: ${label}.`);
      api.event('feat', `${api.ctx.player.name} tried to ${a.feat}: ${outcome}.`, [me, ...(api.ctx.interaction?.participantIds ?? [])], [{ characterId: me, role: 'actor' }], 2);
      return null;
    },
  },
  {
    name: 'steal',
    schema: z.strictObject({
      action: z.literal('steal'), what: z.string().min(2).max(120), from: z.string().min(2).max(120), value: z.number(),
      kind: z.enum(['money', 'weapon', 'armor', 'gear', 'valuable']), quality: z.number(), difficulty: z.number(),
    }),
    doc: 'steal: the player tries to take something that is not theirs now (a purse, a blade, a ledger). from = exact name of a known person, or the place/owner; value = honest worth in money (for money: the amount); kind; quality 0–3 for items; difficulty 1–5 (watchfulness, guards, light, crowd). The game decides — the player may be caught, or seen without knowing it.',
    handle: (api, a) => {
      const me = api.ctx.player.id;
      const p = profile(api, me);
      const victim = api.findCharacter(String(a.from));
      const named = victim && victim.id !== me ? victim : undefined;
      if (named?.status === 'dead') return api.reject(a, `${named.name} is dead — that is looting, not theft.`), null;
      const diff = clamp(Math.round(Number(a.difficulty)), 1, 5);
      const watcher = named ? skillLevel(profile(api, named.id), 'perception') * 0.5 : 0;
      const { outcome, detail } = check(api, p, 'stealth', diff, `steal:${a.what}`, watcher, `${named?.name ?? 'their'} perception`, false);
      const who = named?.name ?? String(a.from);
      const xp = gainXp(api, p, diff * { success: 10, partial: 6, failure: 2 }[outcome], `steal:${a.what}`);
      st(api).touch(p, api.ctx.now);
      if (outcome === 'failure') {
        api.results.push(`✋ Caught trying to steal ${a.what} from ${who}.${xp}${detail}`);
        api.witnessed.push(`${api.ctx.player.name} tried to steal ${a.what} from ${who} and was caught in the act.`);
        api.event('crime', `${api.ctx.player.name} was caught trying to steal ${a.what} from ${who}.`, [me, ...(named ? [named.id] : []), ...(api.ctx.interaction?.participantIds ?? [])], [{ characterId: me, role: 'actor' }], 4);
        if (!named || !api.inConversation(named.id)) api.consequence(`${api.ctx.player.name} was caught stealing ${a.what} from ${who} at ${api.ctx.location}.`, 5 + api.random(`steal:${a.what}:c`) * 30);
        return null;
      }
      const cents = Math.max(0, Math.round(Number(a.value) * 100));
      if (a.kind === 'money') {
        if (named) api.payBetween(named.id, me, cents, `stolen: ${a.what}`, 'theft'); else api.move(null, api.ensureAccount('character', me), cents, `stolen: ${a.what}`, 'theft');
      } else {
        st(api).addItem({ id: newId('item'), gameId: api.ctx.gameId, ownerId: me, name: String(a.what), kind: a.kind as Item['kind'],
          quality: clamp(Math.round(Number(a.quality)), 0, 3), quantity: 1, createdAt: api.ctx.now });
      }
      // Success is clean. A partial success looks the same to the player — but someone saw.
      api.results.push(`🤏 You take ${a.what} from ${who} and slip away${a.kind === 'money' && cents ? ` (+${api.money(cents)})` : ''}.${xp}${detail}`);
      api.event('crime', `${api.ctx.player.name} stole ${a.what} from ${who}${outcome === 'partial' ? ' — and was seen' : ''}.`, [me], [{ characterId: me, role: 'actor' }], 3);
      if (outcome === 'partial') {
        api.consequence(`${named ? named.name : 'Someone'} ${named ? 'noticed' : 'saw'} ${api.ctx.player.name} steal ${a.what} from ${who} at ${api.ctx.location}. ${api.ctx.player.name} thinks they got away clean.`, 60 + api.random(`steal:${a.what}:c`) * 36 * 60);
      }
      return null;
    },
  },
  {
    name: 'deceive',
    schema: z.strictObject({ action: z.literal('deceive'), target: z.string().min(2).max(80), claim: z.string().min(3).max(300), difficulty: z.number() }),
    doc: 'deceive: the player tries to make someone present believe something false — a lie, a bluff, a false promise, a disguise, a forged token. Use it whenever the player\'s words are meant to mislead: when they mark it ("(bluff)", "I lie:", "minto:", "blefo:" or similar in any language — the marker is not spoken aloud), or when what they claim contradicts what their character knows or could plausibly know (even if they don\'t say "I lie"). target = exact name; claim = what they are meant to believe; difficulty 1 (plausible) … 5 (absurd, or they have reason to know better). The game rolls it against the target\'s perception.',
    handle: (api, a) => {
      const me = api.ctx.player.id;
      const target = api.findCharacter(String(a.target));
      if (!target || target.id === me) return `deceive: unknown person "${a.target}"`;
      if (!api.inConversation(target.id)) return api.reject(a, `${target.name} isn't here to be deceived.`), null;
      const p = profile(api, me);
      const diff = clamp(Math.round(Number(a.difficulty)), 1, 5);
      const them = profile(api, target.id);
      const { outcome, detail } = check(api, p, 'deception', diff * 0.8, `deceive:${a.claim}`, skillLevel(them, 'perception') + attrBonus(them, 'perception'), `${target.name}'s perception`);
      const xp = gainXp(api, p, diff * { success: 8, partial: 4, failure: 2 }[outcome], `deceive:${a.claim}`);
      st(api).touch(p, api.ctx.now);
      const verdict = { success: `${target.name} believes you`, partial: `${target.name} has doubts but goes along — for now`, failure: `${target.name} sees through it` }[outcome];
      api.results.push(`🎭 Deception — "${a.claim}": ${verdict}.${xp}${detail}`);
      api.witnessed.push(outcome === 'success' ? `${api.ctx.player.name} told you: "${a.claim}". You BELIEVE it.`
        : outcome === 'partial' ? `${api.ctx.player.name} told you: "${a.claim}". You are not sure it is true, but you go along with it for now.`
        : `${api.ctx.player.name} told you: "${a.claim}". You can tell it is a lie.`);
      api.event('deception', `${api.ctx.player.name} tried to make ${target.name} believe: ${a.claim} (${outcome}).`, [me], [{ characterId: me, role: 'actor' }], 2);
      // Lies that work can still unravel later.
      if (outcome !== 'failure' && api.random(`deceive:${a.claim}:unravel`) < (outcome === 'partial' ? 0.6 : 0.3)) {
        api.consequence(`${target.name} finds out that ${api.ctx.player.name} lied to them: "${a.claim}".`, 24 * 60 + api.random(`deceive:${a.claim}:when`) * 5 * 24 * 60);
      }
      return null;
    },
  },
  {
    name: 'influence',
    schema: z.strictObject({
      action: z.literal('influence'), target: z.string().min(2).max(80), approach: z.enum(['persuade', 'intimidate', 'charm', 'bribe']),
      goal: z.string().min(3).max(200), difficulty: z.number(), bribe: z.number().nullable(),
    }),
    doc: 'influence: the player tries to move someone present — persuade (reasons), intimidate (fear), charm (warmth), bribe (money: bribe = amount). goal = what they want from them; difficulty 1–5 (how much it asks of them). The game rolls it; the person then acts on the result in their own way.',
    handle: (api, a) => {
      const me = api.ctx.player.id;
      const target = api.findCharacter(String(a.target));
      if (!target || target.id === me) return `influence: unknown person "${a.target}"`;
      if (!api.inConversation(target.id)) return api.reject(a, `${target.name} isn't here.`), null;
      const p = profile(api, me);
      let bonus = 0;
      if (a.approach === 'bribe') {
        const cents = Math.round(Number(a.bribe ?? 0) * 100);
        if (cents <= 0) return 'influence: a bribe needs an amount';
        if (!api.payBetween(me, target.id, cents, `bribe to ${target.name}`, 'bribe')) return null;
        bonus = Math.min(2, cents / 5000);
      }
      if (a.approach === 'intimidate') bonus += attrBonus(p, 'combat') + Math.min(1.5, p.fame / 6);
      const diff = clamp(Math.round(Number(a.difficulty)), 1, 5);
      const them = profile(api, target.id);
      const { outcome, detail } = check(api, p, 'persuasion', diff - bonus, `influence:${a.goal}`, (skillLevel(them, 'perception') + attrBonus(them, 'perception')) * 0.5, `${target.name}'s perception`);
      const xp = gainXp(api, p, diff * { success: 8, partial: 4, failure: 2 }[outcome], `influence:${a.goal}`);
      st(api).touch(p, api.ctx.now);
      const verb = { persuade: 'persuaded', intimidate: 'frightened', charm: 'won over', bribe: 'bought' }[a.approach as 'persuade'];
      const verdict = { success: `${target.name} is ${verb}`, partial: `${target.name} wavers`, failure: `${target.name} is not moved${a.approach === 'intimidate' ? ' — and resents the threat' : ''}` }[outcome];
      const how = String(a.approach);
      api.results.push(`🗣 ${how[0]!.toUpperCase()}${how.slice(1)} ${target.name} (${a.goal}): ${verdict}.${xp}${detail}`);
      api.witnessed.push(`${api.ctx.player.name} tried to ${a.approach} you (${a.goal}): ${outcome === 'success' ? `it WORKED — you are ${verb}; act on it` : outcome === 'partial' ? 'you waver; you might give a little' : 'it did not work on you'}.`);
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
    name: 'get_treatment',
    schema: z.strictObject({ action: z.literal('get_treatment'), healer: z.string().max(120), skill: z.number(), hours: z.number() }),
    doc: 'get_treatment: a healer, surgeon or medic actually treats the player now (stitches, setting a bone, cleaning a wound). healer = who (exact name if known); skill 1 (a friend with a rag) … 5 (a master surgeon); hours spent. Payment is a separate pay/deal.',
    handle: (api, a) => {
      const p = profile(api, api.ctx.player.id);
      const skill = clamp(Math.round(Number(a.skill)), 1, 5);
      const before = p.health;
      // Treatment closes wounds: serious ones become light, light ones heal; health comes back with the healer's skill.
      const treated: string[] = [];
      p.injuries = p.injuries.flatMap((i) => {
        if (i.severity === 'light') { treated.push(i.text); return []; }
        if (skill >= 3 || i.severity === 'serious') { treated.push(i.text); return [{ ...i, severity: i.severity === 'critical' ? 'serious' as const : 'light' as const }]; }
        return [i];
      });
      p.health = Math.min(p.maxHealth, p.health + skill * 5 + Math.round(clamp(Number(a.hours), 0, 12) * 2));
      st(api).touch(p, api.ctx.now);
      api.results.push(`🩹 Treated by ${a.healer}: health ${before} → ${p.health}${treated.length ? ` · treated: ${treated.join(', ')}` : ''}${p.injuries.length ? ` · still healing: ${p.injuries.map((i) => `${i.text} (${i.severity})`).join(', ')}` : ''}`);
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
  const skills = `${ATTRIBUTES.map((x) => `${x} ${p.attributes[x] ?? 2}`).join(', ')} · level ${p.level} · ${SKILLS.map((s) => `${s} ${skillLevel(p, s)}`).join(', ')}`;
  const gear = st(api).itemsOf(me).map((i) => `${i.name} (${QUALITY[i.quality]} ${i.kind}${i.quantity > 1 ? ` ×${i.quantity}` : ''})`).join(', ');
  return [`Condition: ${condition(p)}`, `Attributes (1–5), level and skills (0–5): ${skills}`, `Carrying: ${gear || 'nothing of note'}`, `Reputation: ${fameLabel(p.fame)}${p.deeds.length ? ` — people talk about how ${api.ctx.player.name} ${p.deeds.join('; ')}` : ''}`];
}

const SHEET_PT: Record<string, string> = {
  strength: 'força', agility: 'agilidade', wits: 'astúcia', presence: 'presença', combat: 'combate', stealth: 'furtividade', athletics: 'atletismo',
  survival: 'sobrevivência', perception: 'percepção', persuasion: 'persuasão', deception: 'enganação', lore: 'conhecimento',
};

/** The character sheet (a read-only view of canonical state). */
export function characterSheet(store: Store, gameId: string, lang: 'en' | 'pt' = 'en'): string {
  const game = store.getGame(gameId)!;
  const me = store.getCharacter(game.playerCharacterId)!;
  const p = advRepo.profile(store, me.id);
  if (!p) return '(no character sheet)';
  const pt = lang === 'pt';
  const L = (k: string) => (pt ? SHEET_PT[k] ?? k : k);
  const bar = (n: number, max = 5) => '●'.repeat(n) + '○'.repeat(Math.max(0, max - n));
  const seed = store.getWorldSeed<{ player: { ambition: string | null } }>(gameId);
  const cash = store.getAccountOf(gameId, 'character', me.id)?.balanceCents ?? 0;
  const items = advRepo.items(store, gameId).filter((i) => i.ownerId === me.id);
  const sym = (store.getWorldSeed<{ player: { currency: { symbol: string } | null } }>(gameId)?.player.currency?.symbol) ?? '¤';
  const lines = [
    `══ ${me.name.toUpperCase()} — ${pt ? 'Nível' : 'Level'} ${p.level} · XP ${p.xp}/${xpForNext(p.level)}${p.points ? ` · ${p.points} ${pt ? 'ponto(s) para gastar' : `point${p.points > 1 ? 's' : ''} to spend`} (/spend)` : ''} ══`,
    `${pt ? 'Vida' : 'Health'} ${p.health}/${p.maxHealth}${p.injuries.length ? ` — ${p.injuries.map((i) => i.text).join(', ')}` : ''}`,
    '',
    `${pt ? 'ATRIBUTOS' : 'ATTRIBUTES'}  ${ATTRIBUTES.map((x) => `${L(x)} ${bar(p.attributes[x] ?? 2)}`).join('   ')}`,
    `${pt ? 'PERÍCIAS' : 'SKILLS'}`,
    ...SKILLS.map((s) => {
      const k = p.skills[s] ?? { level: 0, practice: 0 };
      return `  ${L(s).padEnd(14)} ${bar(k.level)}  ${k.practice ? `(${pt ? 'treino' : 'practice'} ${k.practice}/${practiceFor(k.level)})` : ''}`.trimEnd();
    }),
    '',
    `${pt ? 'EQUIPAMENTO' : 'GEAR'}  ${items.map((i) => `${i.name} (${QUALITY[i.quality]} ${i.kind}${i.quantity > 1 ? ` ×${i.quantity}` : ''})`).join(' · ') || '—'}`,
    `${pt ? 'DINHEIRO' : 'MONEY'}  ${sym}${(cash / 100).toFixed(2)}`,
    `${pt ? 'REPUTAÇÃO' : 'REPUTATION'}  ${fameLabelIn(p.fame, lang)} (${p.fame})${p.deeds.length ? ` — ${p.deeds.join('; ')}` : ''}`,
    ...(seed?.player.ambition ? [`${pt ? 'AMBIÇÃO' : 'AMBITION'}  ${seed.player.ambition}`] : []),
  ];
  return lines.join('\n');
}

/** Spends unspent points: a skill costs 1 (max 5), an attribute costs 3 (max 5). */
export function spendPoint(store: Store, gameId: string, what: string): string {
  const game = store.getGame(gameId)!;
  const p = advRepo.profile(store, game.playerCharacterId);
  if (!p) return '(no character sheet)';
  const key = Object.entries(SHEET_PT).find(([en, ptName]) => en === what.toLowerCase() || ptName === what.toLowerCase())?.[0] ?? what.toLowerCase();
  const isSkill = (SKILLS as readonly string[]).includes(key);
  const isAttr = (ATTRIBUTES as readonly string[]).includes(key);
  if (!isSkill && !isAttr) return `Spend on a skill (${SKILLS.join(', ')}) or an attribute (${ATTRIBUTES.join(', ')}).`;
  const cost = isSkill ? 1 : 3;
  if (p.points < cost) return `You have ${p.points} point${p.points === 1 ? '' : 's'}; ${key} costs ${cost}.`;
  if (isSkill) {
    const s = (p.skills[key] ??= { level: 0, practice: 0 });
    if (s.level >= MAX_LEVEL) return `${key} is already at ${MAX_LEVEL}.`;
    s.level++;
  } else {
    if ((p.attributes[key] ?? 2) >= 5) return `${key} is already at 5.`;
    p.attributes[key] = (p.attributes[key] ?? 2) + 1;
    if (key === 'strength') { const before = p.maxHealth; p.maxHealth = maxHealthFor(p); p.health += p.maxHealth - before; }
  }
  p.points -= cost;
  p.updatedAt = new Date().toISOString();
  advRepo.saveProfile(store, p);
  return `✓ ${key} → ${isSkill ? p.skills[key]!.level : p.attributes[key]} · ${p.points} point${p.points === 1 ? '' : 's'} left`;
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
      `Ask for the player's AMBITION (what they dream of becoming) and build their sheet in player.attributes: attributes ${ATTRIBUTES.join(', ')} (1–5, 2 is average), skills ${SKILLS.join(', ')} (0–5, most 0–2 at the start), plus fame (usually 0). Fit the sheet to the backstory.`,
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
        characterId: player.id, gameId, health: 70 + clamp(Math.round(attrs.strength ?? 2), 1, 5) * 10, maxHealth: 70 + clamp(Math.round(attrs.strength ?? 2), 1, 5) * 10,
        injuries: [], fame: Math.max(0, Math.round(attrs.fame ?? 0)), deeds: [],
        skills: Object.fromEntries(SKILLS.map((s) => [s, { level: clamp(Math.round(attrs[s] ?? 0), 0, MAX_LEVEL), practice: 0 }])),
        attributes: Object.fromEntries(ATTRIBUTES.map((x) => [x, clamp(Math.round(attrs[x] ?? DEFAULT_ATTRIBUTES[x]), 1, 5)])),
        xp: 0, level: 1, points: 0, createdAt: now, updatedAt: now,
      });
      for (const a of seed.player.assets.filter((x) => ['weapon', 'armor', 'gear', 'valuable'].includes(x.kind))) {
        const m = Object.fromEntries(a.metrics.map((x) => [x.key, x.value]));
        advRepo.insertItem(store, { id: newId('item'), gameId, ownerId: player.id, name: a.name, kind: a.kind as Item['kind'],
          quality: clamp(Math.round(m.quality ?? 1), 0, 3), quantity: Math.max(1, Math.round(m.quantity ?? 1)), createdAt: now });
      }
    },
    template: ADVENTURE_WORLD,
  },
  npcAttack(api, attackerId, attack) {
    const named = api.ctx.characters.find((c) => c.id === attackerId);
    if (!named || named.status === 'dead') return;
    const threat = clamp(Math.round(attack.threat), 1, 5);
    // Others acting for them (guards, crew, hired men) fight as an unnamed group; otherwise they strike themselves.
    const foeBlunt = BLUNT.test(attack.how);
    if (attack.by) resolveFight(api, { opponent: `${attack.by} (for ${named.name})`, threat, playerIntent: 'defend', foeIntent: attack.intent, weaponName: null, witnessed: true, aggressor: 'npc', foeBlunt });
    else resolveFight(api, { opponent: named.name, named, threat, playerIntent: 'defend', foeIntent: attack.intent, weaponName: null, witnessed: true, aggressor: 'npc', foeBlunt });
  },
  commands: {
    sheet: { help: 'your character sheet', run: (store, gameId, _args, lang) => characterSheet(store, gameId, lang) },
    spend: { help: 'spend a point: /spend <skill> (1 point) or /spend <attribute> (3 points)', run: (store, gameId, args) => spendPoint(store, gameId, args[0] ?? '') },
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
      const pays = Math.round((o.terms.price_offerer_pays ?? 0) * 100), gets = Math.round((o.terms.price_offerer_receives ?? 0) * 100);
      const ok = api.payBetween(o.fromCharacterId, o.toCharacterId, pays, o.label ?? 'deal', 'deal') && api.payBetween(o.toCharacterId, o.fromCharacterId, gets, o.label ?? 'deal', 'deal');
      if (ok) api.results.push(`✓ Deal: ${o.label ?? o.description}`);
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
