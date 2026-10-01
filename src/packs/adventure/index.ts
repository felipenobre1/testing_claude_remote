import { z } from 'zod';
import type { Character } from '../../domain/types.ts';
import { STARTING_RECOLLECTIONS, type WorldPlanner } from '../../engine/planner.ts';
import { newId } from '../../engine/util.ts';
import type { Store } from '../../db/store.ts';
import { dealOfferKind } from '../deal.ts';
import type { GamePack, PackAction } from '../types.ts';
import { KINGKILLER_WORLD } from './world.ts';
import {
  ADVENTURE_MIGRATIONS, AdventureState, advRepo, ATTRIBUTES, DEFAULT_ATTRIBUTES, fameLabel, fameLabelIn, MAX_LEVEL, MOVES, practiceFor, SKILL_ATTR, SKILLS, xpForNext,
  type Combatant, type Encounter, type FoeIntent, type Injury, type Move, type Item, type Profile, type Skill,
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

type PlayerIntent = Encounter['playerIntent'];
/** Is the attacker hitting with fists, a club or a training weapon (bruises) rather than a blade (cuts)? */
const BLUNT = /\b(fist|fists|punch|kick|knee|elbow|bare|unarmed|brawl|cudgel|club|staff|stick|flat of|training|wooden|sparring|punho|soco|chute|joelh|cotovel|mãos|desarmad|bastão|porrete|treino|madeira)/i;

// ============================================================================
// Fights last several exchanges. Each player message is one exchange: the player's move (from what they described)
// against the opponent's move (chosen by their fighting style), a counter-table, momentum, stamina and a d20.
// ============================================================================

const MOVE_LABEL: Record<Move, string> = { strong: 'heavy attack', quick: 'quick attack', defend: 'guard', feint: 'feint', grapple: 'grapple', ground: 'use of the ground' };
/** How good the player's move is against the opponent's (rock–paper–scissors with nuance). */
const MATCHUP: Record<Move, Record<Move, number>> = {
  strong: { strong: 0, quick: -1, defend: -2, feint: 1, grapple: 1, ground: 0 },
  quick: { strong: 1, quick: 0, defend: -1, feint: 0, grapple: -1, ground: 0 },
  defend: { strong: 2, quick: 1, defend: 0, feint: -2, grapple: -1, ground: -1 },
  feint: { strong: -1, quick: 0, defend: 2, feint: 0, grapple: -2, ground: 0 },
  grapple: { strong: -1, quick: 1, defend: 1, feint: 2, grapple: 0, ground: 0 },
  ground: { strong: 1, quick: 1, defend: 1, feint: 0, grapple: 1, ground: 0 },
};
/** What an opponent's winning move looks like. */
const FOE_HIT: Record<Move, string> = { strong: 'lands a heavy blow', quick: 'gets a quick strike in', defend: 'blocks and counters', feint: 'fakes you out and strikes',
  grapple: 'gets hold of you and throws you', ground: 'uses the ground against you' };
const STAMINA_COST: Record<Move, number> = { strong: 15, quick: 8, defend: -10, feint: 6, grapple: 12, ground: 6 };
const HIT: Record<Move, [number, number]> = { strong: [12, 22], quick: [7, 13], defend: [6, 11], feint: [5, 9], grapple: [5, 9], ground: [8, 14] };
const STYLE_MOVES: Record<Combatant['style'], [Move, number][]> = {
  aggressive: [['strong', 0.35], ['quick', 0.35], ['feint', 0.1], ['defend', 0.1], ['grapple', 0.1]],
  defensive: [['defend', 0.45], ['quick', 0.25], ['feint', 0.15], ['strong', 0.15]],
  tricky: [['feint', 0.35], ['quick', 0.25], ['defend', 0.2], ['grapple', 0.2]],
  brute: [['strong', 0.5], ['grapple', 0.3], ['quick', 0.2]],
};

function foeMove(api: WorldPlanner, c: Combatant, label: string): Move {
  const table = c.stamina < 25 ? [['defend', 0.6], ...STYLE_MOVES[c.style].map(([m, w]) => [m, w * 0.4])] as [Move, number][] : STYLE_MOVES[c.style];
  let r = api.random(label) * table.reduce((n, [, w]) => n + w, 0);
  for (const [m, w] of table) { if ((r -= w) <= 0) return m; }
  return table[0]![0];
}
const foeCondition = (c: Combatant) => {
  const h = c.health / c.maxHealth;
  return `${h > 0.8 ? 'steady' : h > 0.55 ? 'hurt' : h > 0.3 ? 'badly hurt' : 'barely standing'}${c.stamina < 30 ? ', breathing hard' : ''}`;
};
const foeCombat = (api: WorldPlanner, c: Combatant) => {
  if (!c.characterId) return c.threat * 1.3;
  const p = profile(api, c.characterId);
  return skillLevel(p, 'combat') + attrBonus(p, 'combat') + 1.5;
};

const BARE = 'bare hands';
/** What the player fights with: what they named, bare hands, or (attacked unawares) the best weapon they carry. */
const weaponOf = (api: WorldPlanner, e: Encounter) =>
  e.weaponName === BARE ? undefined : e.weaponName ? st(api).findItem(api.ctx.player.id, e.weaponName) : st(api).best(api.ctx.player.id, 'weapon');

/** The player's fighting strength right now, with its parts (for the visible roll). */
function playerPower(api: WorldPlanner, e: Encounter): { total: number; parts: [string, number][] } {
  const me = api.ctx.player.id;
  const p = profile(api, me);
  const weapon = weaponOf(api, e);
  const armor = st(api).best(me, 'armor');
  const parts: [string, number][] = [
    ['combat', skillLevel(p, 'combat')], ['strength', attrBonus(p, 'combat')],
    [weapon?.kind === 'weapon' ? weapon.name : 'bare hands', weapon?.kind === 'weapon' ? 1 + weapon.quality : 0],
    [armor?.name ?? 'no armour', armor ? 0.5 + armor.quality * 0.5 : 0],
    ['wounds', -(p.health < 25 ? 2 : p.health < 50 ? 1 : 0)],
    ['tired', -(e.playerStamina < 10 ? 2 : e.playerStamina < 30 ? 1 : 0)],
  ];
  return { total: parts.reduce((n, [, v]) => n + v, 0), parts };
}

function newCombatant(api: WorldPlanner, o: { named?: Character; name: string; threat: number; intent: FoeIntent; style: Combatant['style']; blunt: boolean; protects?: string | null }): Combatant {
  const threat = clamp(Math.round(o.threat), 1, 5);
  const prof = o.named ? profile(api, o.named.id, { skills: { combat: { level: threat, practice: 0 } } }) : null;
  const maxHealth = prof ? prof.maxHealth : 30 + threat * 15;
  return { characterId: o.named?.id ?? null, name: o.named?.name ?? o.name, threat, health: prof ? prof.health : maxHealth, maxHealth, stamina: 100, advantage: 0,
    style: o.style, intent: o.intent, blunt: o.blunt, status: 'fighting', protects: o.protects ?? null };
}

function startEncounter(api: WorldPlanner, e: Omit<Encounter, 'exchanges' | 'playerStamina' | 'playerAdvantage' | 'location' | 'startedGameTime' | 'lastTurnId'>): Encounter {
  const enc: Encounter = { ...e, exchanges: 0, playerStamina: 100, playerAdvantage: 0, location: api.ctx.location, startedGameTime: api.ctx.gameTime, lastTurnId: null };
  st(api).setEncounter(enc);
  api.results.push(`⚔ A fight begins — ${enc.opponents.map((o) => `${o.name}${o.protects ? ` (protecting ${o.protects})` : ''}`).join(', ')}${enc.kind === 'spar' ? ' (sparring)' : ''}.`);
  return enc;
}

/** One exchange. Returns nothing; pushes result lines, witnessed lines and events; ends the fight when it is decided. */
function exchange(api: WorldPlanner, e: Encounter, m: { move: Move | 'disengage' | 'yield'; targetName: string | null; how: string; cleverness: number }) {
  const me = api.ctx.player.id;
  const player = profile(api, me);
  e.exchanges++;
  e.lastTurnId = api.ctx.turnId;
  const spar = e.kind === 'spar';
  const fighting = () => e.opponents.filter((o) => o.status === 'fighting');
  const label = `ex${e.exchanges}:${api.ctx.turnId}`;
  const lethalFoe = () => fighting().some((o) => o.intent === 'kill');
  const dmg = (range: [number, number], k: string) => Math.max(1, Math.round((range[0] + api.random(`${label}:${k}`) * (range[1] - range[0])) / (spar ? 3 : 1)));
  const armorCut = () => { const a = st(api).best(me, 'armor'); return a ? 1 + a.quality * 2 : 0; };
  const lines: string[] = [];

  if (m.move === 'yield') { endEncounter(api, e, 'yielded'); return; }
  if (m.move === 'disengage') {
    const hardest = Math.max(...fighting().map((o) => o.threat));
    const { outcome, detail } = check(api, player, 'athletics', hardest * 0.8, `${label}:flee`);
    if (outcome !== 'failure') { api.results.push(`🏃 You break away.${detail}`); endEncounter(api, e, 'fled'); return; }
    lines.push(`🏃 You try to break away and can't.${detail}`);
    m = { ...m, move: 'defend', cleverness: -1 };
  }
  const move = m.move as Move;
  const target = (m.targetName && fighting().find((o) => o.name.toLowerCase().includes(m.targetName!.toLowerCase()))) || fighting()[0]!;
  const theirMove = foeMove(api, target, `${label}:foe`);
  const power = playerPower(api, e);
  const matchup = MATCHUP[move][theirMove];
  const clever = clamp(Math.round(m.cleverness), -1, 2);
  const die = d20(api, `${label}:d20`);
  const theirs = foeCombat(api, target) + target.advantage - (target.stamina < 25 ? 1 : 0);
  const margin = power.total + matchup + e.playerAdvantage + clever - theirs + ((die - 1) / 19) * 10 - 5;
  const detail = ` [you ${n1(power.total)} (${power.parts.filter(([k, v]) => v !== 0 || k === 'combat' || k === BARE).map(([k, v]) => `${k} ${k === 'combat' ? v : signed(v)}`).join(', ')})`
    + `${matchup ? ` ${MOVE_LABEL[move]} vs ${MOVE_LABEL[theirMove]} ${signed(matchup)}` : ''}${e.playerAdvantage ? ` advantage ${signed(e.playerAdvantage)}` : ''}${clever ? ` tactics ${signed(clever)}` : ''}`
    + ` vs ${target.name} ${n1(theirs)} · d20 ${die} → ${signed(margin)}]`;
  e.playerStamina = clamp(e.playerStamina - STAMINA_COST[move], 0, 100);
  target.stamina = clamp(target.stamina - STAMINA_COST[theirMove], 0, 100);

  const weapon = weaponOf(api, e);
  const playerBlunt = spar || !weapon || weapon.kind !== 'weapon' || BLUNT.test(weapon.name);
  const hitFoe = (full: boolean) => {
    const amount = dmg(HIT[move], 'you') + (weapon?.kind === 'weapon' && !spar ? weapon.quality * 2 : 0);
    const n = full ? amount : Math.ceil(amount / 2);
    target.health = Math.max(0, target.health - n);
    if (target.characterId) { const p = profile(api, target.characterId); hurt(api, p, n, `${label}:foe`, false, playerBlunt); st(api).touch(p, api.ctx.now); }
    return `${full ? 'clean hit' : 'glancing hit'} on ${target.name} (−${n})`;
  };
  const hitPlayer = (attackerMove: Move, attacker: Combatant, full: boolean, k: string) => {
    const amount = Math.max(1, dmg(HIT[attackerMove], k) - armorCut());
    const n = full ? amount : Math.ceil(amount / 2);
    const wound = hurt(api, player, n, `${label}:${k}`, attacker.intent === 'kill' && !spar, spar || attacker.blunt);
    return `${attacker.name} ${FOE_HIT[attackerMove]}${full ? '' : ' (a glancing blow)'} — ${wound} (−${n}; ${player.health}/${player.maxHealth})`;
  };

  let what: string;
  if (move === 'defend' && theirMove === 'defend') what = 'you circle each other; both catch your breath';
  else if (margin >= 3) { what = hitFoe(true); e.playerAdvantage = Math.min(3, e.playerAdvantage + 1); target.advantage = 0; }
  else if (margin >= 0.5) { what = hitFoe(false); e.playerAdvantage = Math.min(3, e.playerAdvantage + (move === 'feint' || move === 'grapple' ? 1 : 0)); target.advantage = 0; }
  else if (margin > -0.5) what = 'neither of you gets through';
  else if (margin > -3) { what = hitPlayer(theirMove, target, false, 'them'); target.advantage = Math.min(3, target.advantage + 1); e.playerAdvantage = 0; }
  else { what = hitPlayer(theirMove, target, true, 'them'); target.advantage = Math.min(3, target.advantage + 1); e.playerAdvantage = 0; }
  if (theirMove === 'defend' && margin < 0.5) what += ` (${target.name} holds guard)`;
  lines.push(`⚔ Exchange ${e.exchanges} · your ${MOVE_LABEL[move]} vs ${target.name}'s ${MOVE_LABEL[theirMove]}: ${what}.${detail}`);

  // Everyone else still fighting takes a swing while the player is busy with the target.
  for (const o of fighting().filter((x) => x !== target)) {
    const oMove = foeMove(api, o, `${label}:${o.name}`);
    if (oMove === 'defend') continue;
    const d = d20(api, `${label}:${o.name}:d20`);
    const m2 = foeCombat(api, o) + o.advantage + ((d - 1) / 19) * 10 - 5 - (power.total * 0.6 + (move === 'defend' ? 2 : 0));
    if (m2 >= 2) lines.push(`   ${hitPlayer(oMove, o, m2 >= 5, o.name)} [d20 ${d} → ${signed(m2)}]`);
  }

  // Who is still standing?
  if (target.health <= 0) {
    if (target.intent !== 'spar' && e.playerIntent === 'kill' && !spar) {
      target.status = 'dead';
      if (target.characterId) { const p = profile(api, target.characterId); p.health = 0; api.setCharacterStatus(target.characterId, 'dead'); }
    } else target.status = 'down';
  } else if (!spar && target.intent !== 'kill' && target.health < target.maxHealth * 0.3 && api.random(`${label}:yield`) < 0.6) {
    target.status = 'yielded';
  }
  if (target.status !== 'fighting' && target.protects && e.target && !fighting().some((o) => o.protects) && !e.opponents.some((o) => o.name === e.target)) {
    // The guards are down: the one they protected is next.
    const named = api.findCharacter(e.target);
    if (named?.status !== 'dead') {
      e.opponents.push(newCombatant(api, { named, name: named?.name ?? e.target, threat: 2, intent: 'kill', style: 'defensive', blunt: false }));
      lines.push(`   Nothing stands between you and ${named?.name ?? e.target} now.`);
    }
  }
  st(api).touch(player, api.ctx.now);
  const status = `   You ❤ ${player.health}/${player.maxHealth} · 💨 ${e.playerStamina}${e.playerAdvantage ? ` · ▲${e.playerAdvantage}` : ''} | `
    + e.opponents.map((o) => `${o.name}: ${o.status === 'fighting' ? foeCondition(o) : o.status}`).join(' · ');
  api.results.push(...lines, status);
  api.witnessed.push(`${api.ctx.player.name} and ${target.name} fight (exchange ${e.exchanges}): ${what}.`);

  if (player.health === 0) { endEncounter(api, e, 'player_dead'); return; }
  // They stop when they have what they wanted: humbled or driven off at half health, hurt at a third; only a killer goes on.
  const enough = Math.min(...fighting().map((o) => ({ kill: 0, hurt: 0.3, humiliate: 0.5, drive_off: 0.5, spar: 0.6 }[o.intent])));
  if (!spar && fighting().length && !lethalFoe() && player.health <= player.maxHealth * Math.max(0.15, enough)) { endEncounter(api, e, 'beaten'); return; }
  if (spar && (e.exchanges >= 3 || player.health <= player.maxHealth * 0.6)) { endEncounter(api, e, 'spar_done'); return; }
  if (!fighting().length) { endEncounter(api, e, 'won'); return; }
  st(api).setEncounter(e);
}

type EndReason = 'won' | 'beaten' | 'fled' | 'yielded' | 'player_dead' | 'spar_done';

/** The fight is decided: XP, fame, deeds, and what the world will make of it. */
function endEncounter(api: WorldPlanner, e: Encounter, reason: EndReason) {
  const me = api.ctx.player.id;
  const player = profile(api, me);
  const spar = e.kind === 'spar';
  const top = Math.max(...e.opponents.map((o) => o.threat));
  const names = e.opponents.map((o) => `${o.name} ${o.status === 'fighting' ? 'still standing' : o.status}`).join(', ');
  const summary = {
    won: `you win — ${names}`, beaten: `you are beaten — at their mercy (${names})`, fled: 'you get away', yielded: `you yield (${names})`,
    player_dead: `☠ ${api.ctx.player.name} is dead`, spar_done: `the sparring is over (${names})`,
  }[reason];
  const xpBase = top * (spar ? 0.5 : 1) * { won: 15, beaten: 5, fled: 3, yielded: 3, player_dead: 0, spar_done: 8 }[reason] + e.exchanges * 2;
  const xp = reason === 'player_dead' ? '' : gainXp(api, player, xpBase, `encounter:${e.startedGameTime}`);
  let fame = '';
  const who = e.opponents.map((o) => o.name).join(' and ');
  if (!spar && e.witnessed && reason === 'won') {
    const gain = top >= 4 || e.opponents.some((o) => o.characterId) ? 2 : 1;
    player.fame += gain;
    addDeed(player, `${e.opponents.some((o) => o.status === 'dead') ? 'killed' : 'beat'} ${who} in front of witnesses`);
    fame = ` · fame +${gain} (${fameLabel(player.fame)})`;
  } else if (!spar && e.witnessed && (reason === 'beaten' || reason === 'player_dead')) {
    addDeed(player, reason === 'player_dead' ? `was killed by ${who}` : `was beaten by ${who} in front of witnesses`);
  }
  st(api).touch(player, api.ctx.now);
  st(api).setEncounter(null);
  api.results.push(`⚔ The fight is over: ${summary}.${fame}${xp}`);
  const observers = [me, ...e.opponents.flatMap((o) => (o.characterId ? [o.characterId] : [])), ...(api.ctx.interaction?.participantIds ?? [])];
  api.event('fight', `${api.ctx.player.name} fought ${who}: ${summary}.`, observers,
    [{ characterId: me, role: 'actor' }, ...e.opponents.flatMap((o) => (o.characterId ? [{ characterId: o.characterId, role: 'actor' as const }] : []))], reason === 'player_dead' ? 5 : 4);

  // What the player did will come back to them — sooner and harder the worse it was, the more important the victim, the more who saw it.
  if (spar || e.aggressor !== 'player' || reason === 'player_dead') return;
  const where = e.location;
  const seen = e.witnessed ? ' in front of witnesses' : '';
  const guards = e.opponents.find((o) => o.protects);
  const killedNamed = e.opponents.find((o) => o.status === 'dead' && o.characterId);
  const victim = (o: Combatant) => { const c = o.characterId ? api.ctx.characters.find((x) => x.id === o.characterId) : undefined; return c ? `${c.name} (${c.role})` : o.name; };
  const guardNames = [...new Set(e.opponents.filter((o) => o.protects).map((o) => o.name.replace(/ \d+$/, '')))].join(', ');
  if (guards && reason !== 'won') api.consequence(`${api.ctx.player.name} attacked ${guards.protects} and was stopped by ${guardNames}${seen} at ${where}${reason === 'beaten' ? `; ${api.ctx.player.name} is at their mercy` : ''}.`, 10);
  else if (killedNamed) api.consequence(`${api.ctx.player.name} killed ${victim(killedNamed)}${seen} at ${where}.`, e.witnessed ? 60 + api.random('conseq') * 120 : 12 * 60 + api.random('conseq') * 36 * 60);
  else if (e.opponents.some((o) => o.status === 'dead') && e.witnessed) api.consequence(`${api.ctx.player.name} killed ${who}${seen} at ${where}.`, 3 * 60 + api.random('conseq') * 6 * 60);
  else if (reason === 'won' && e.opponents.some((o) => o.characterId)) api.consequence(`${api.ctx.player.name} beat ${e.opponents.filter((o) => o.characterId).map(victim).join(' and ')}${seen} at ${where}.`, 24 * 60 + api.random('conseq') * 48 * 60);
}

const MOVE_DOC = 'strong (a heavy blow), quick (a fast strike or combination), defend (guard, parry, block, dodge — recovers breath), feint (a fake to open them up), grapple (seize, trip, throw, pin), ground (use the terrain: sand in the eyes, a table, a wall, a thrown cloak), disengage (break away / flee), yield (give up)';
const moveSchema = z.enum([...MOVES, 'disengage', 'yield']);

/** The fight in progress, if it is still here and now (a fight left behind — another place, an hour later — is over). */
function activeEncounter(api: WorldPlanner): Encounter | null {
  const e = st(api).encounter;
  if (!e) return null;
  const minutes = (Date.parse(`${api.ctx.gameTime}:00Z`) - Date.parse(`${e.startedGameTime}:00Z`)) / 60000;
  if (e.location !== api.ctx.location || minutes > 60) { st(api).setEncounter(null); return null; }
  return e;
}
const STYLE = z.enum(['aggressive', 'defensive', 'tricky', 'brute']);
const moveFields = {
  move: moveSchema,
  how: z.string().max(200), // the player's move in a few words, as they described it
  cleverness: z.number(), // −1 (reckless, ignores the situation) … 0 (plain) … 2 (genuinely clever use of what is known and what is here)
};

const actions: PackAction[] = [
  {
    name: 'fight',
    schema: z.strictObject({
      action: z.literal('fight'),
      opponent: z.string().min(2).max(120), // a known person's exact name, or a description ("dock thug")
      count: z.number(), // how many of them (1 for a known person)
      threat: z.number(), // 1–5, how dangerous each opponent is
      style: STYLE,
      intent: z.enum(['kill', 'subdue', 'drive_off', 'defend', 'duel', 'spar']),
      weaponName: z.string().max(80).nullable(),
      witnessed: z.boolean(), // others see it (fame)
      guards: z.strictObject({ who: z.string().min(2).max(120), count: z.number(), threat: z.number() }).nullable(), // who protects the target here, if anyone
      ...moveFields,
    }),
    doc: `fight: the player STARTS a fight (attacks, accepts a challenge, a sparring bout). Fights last several exchanges: this is the first; later ones are combat_move. opponent = exact name of a known person or a short description of one of them; count = how many; threat 1 (weak) … 5 (deadly) — honest; style = how they fight (aggressive/defensive/tricky/brute); intent (spar for agreed practice: bruises, not wounds); weaponName from what the player carries, or null for bare hands. guards: if the target is protected HERE (a lord with guards, a merchant with bodyguards), who, how many and how dangerous — the player must get through them first; null if the target is alone. move = the player's opening move: ${MOVE_DOC}. how = their move in a few words; cleverness −1…2 (2 only for genuinely clever use of the situation). The game decides every exchange — never narrate who wins.`,
    handle: (api, a) => {
      const current = activeEncounter(api);
      if (current) { exchange(api, current, { move: a.move as Move, targetName: String(a.opponent), how: String(a.how), cleverness: Number(a.cleverness) }); return null; }
      const known = api.findCharacter(String(a.opponent));
      const named: Character | undefined = known && known.id !== api.ctx.player.id ? known : undefined;
      if (named?.status === 'dead') return api.reject(a, `${named.name} is already dead.`), null;
      const playerIntent = a.intent as PlayerIntent;
      const threat = clamp(Math.round(Number(a.threat)), 1, 5);
      // Whoever you try to kill fights for their life; a duel with a deadly opponent is to the death.
      const foeIntent: FoeIntent = playerIntent === 'spar' ? 'spar' : playerIntent === 'kill' || (playerIntent === 'duel' && threat >= 4) ? 'kill' : 'hurt';
      const guards = a.guards as { who: string; count: number; threat: number } | null;
      const group = (name: string, n: number, t: number, intent: FoeIntent, protects: string | null) =>
        Array.from({ length: clamp(Math.round(n), 1, 4) }, (_, i) => newCombatant(api, { name: n > 1 ? `${name} ${i + 1}` : name, threat: t, intent, style: a.style as Combatant['style'], blunt: BLUNT.test(name), protects }));
      const target = named?.name ?? String(a.opponent);
      const opponents = guards
        ? group(guards.who, guards.count, clamp(Math.round(Number(guards.threat)), 1, 5), playerIntent === 'kill' ? 'kill' : 'hurt', target)
        : named ? [newCombatant(api, { named, name: named.name, threat, intent: foeIntent, style: a.style as Combatant['style'], blunt: playerIntent === 'spar' })]
          : group(String(a.opponent), Number(a.count), threat, foeIntent, null);
      const e = startEncounter(api, { kind: playerIntent === 'spar' ? 'spar' : 'fight', aggressor: 'player', playerIntent, target: guards ? target : null,
        witnessed: Boolean(a.witnessed), weaponName: (a.weaponName as string | null) ?? BARE, opponents });
      exchange(api, e, { move: a.move as Move, targetName: null, how: String(a.how), cleverness: Number(a.cleverness) });
      return null;
    },
  },
  {
    name: 'combat_move',
    schema: z.strictObject({ action: z.literal('combat_move'), target: z.string().max(120).nullable(), weaponName: z.string().max(80).nullable(), ...moveFields }),
    doc: `combat_move: while a fight is on (see "Fight in progress" in the briefing), EVERY player message is one exchange. move: ${MOVE_DOC}. Talking mid-fight is defend (or yield/disengage if that is what they mean); target = which opponent (exact name from the briefing) or null; weaponName only if they switch weapons now ("bare hands" if they drop it), else null. how = their move in a few words; cleverness −1…2.`,
    handle: (api, a) => {
      const e = activeEncounter(api);
      if (!e) return api.reject(a, 'There is no fight going on.'), null;
      if (a.weaponName) e.weaponName = String(a.weaponName);
      exchange(api, e, { move: a.move as Move, targetName: (a.target as string | null) ?? null, how: String(a.how), cleverness: Number(a.cleverness) });
      return null;
    },
  },
  {
    name: 'attempt',
    schema: z.strictObject({
      action: z.literal('attempt'), feat: z.string().min(3).max(200), skill: z.enum(SKILLS), difficulty: z.number(),
      risk: z.enum(['none', 'injury', 'caught', 'loss']),
    }),
    doc: `attempt: a risky feat whose outcome is uncertain — climbing, sneaking or hiding (stealth, risk caught), picking a lock, tracking, spotting something hidden (perception), surviving a storm, recalling lore, working a sympathetic binding or any magic (arcana), playing, singing or acting before an audience (performance). skill one of ${SKILLS.join('/')}; difficulty 1 (easy) … 5 (near impossible) — honest; risk = what failure costs. The game decides success.`,
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
  const e = activeEncounter(api);
  const fight = e ? [`Fight in progress (${e.kind}, exchange ${e.exchanges}; every player message is a combat_move until it ends): you — breath ${e.playerStamina}/100${e.playerAdvantage ? `, the upper hand ${e.playerAdvantage}` : ''}; `
    + e.opponents.map((o) => `${o.name} — ${o.status === 'fighting' ? `${foeCondition(o)}, fights ${o.style}ly, means to ${o.intent.replace('_', ' ')}${o.protects ? `, protecting ${o.protects}` : ''}` : o.status}`).join('; ')] : [];
  return [...fight, `Condition: ${condition(p)}`, `Attributes (1–5), level and skills (0–5): ${skills}`, `Carrying: ${gear || 'nothing of note'}`, `Reputation: ${fameLabel(p.fame)}${p.deeds.length ? ` — people talk about how ${api.ctx.player.name} ${p.deeds.join('; ')}` : ''}`];
}

const SHEET_PT: Record<string, string> = {
  strength: 'força', agility: 'agilidade', wits: 'astúcia', presence: 'presença', combat: 'combate', stealth: 'furtividade', athletics: 'atletismo',
  survival: 'sobrevivência', perception: 'percepção', persuasion: 'persuasão', deception: 'enganação', lore: 'conhecimento',
  arcana: 'arcanismo', performance: 'atuação',
};

/** The past the player has written so far, and how many costly recollections are left. */
function pastLines(store: Store, playerId: string, level: number, pt: boolean): string[] {
  const k = store.listKnowledgeOf(playerId).filter((x) => x.source === 'recollection' || x.source === 'recollection+');
  const left = STARTING_RECOLLECTIONS + level - 1 - k.filter((x) => x.source === 'recollection+').length;
  return [
    `${pt ? 'LEMBRANÇAS' : 'RECOLLECTIONS'}  ${left} ${pt ? 'restante(s) — treino ou alguém do passado custa 1; detalhes são livres' : 'left — a training or someone from the past costs 1; details are free'}`,
    ...k.slice(-8).map((x) => `  🕯 ${x.topic.startsWith('contact: ') ? `${x.topic.slice(9)} — ${x.belief}` : x.belief}`),
  ];
}

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
    ...pastLines(store, me.id, p.level, pt),
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
    template: KINGKILLER_WORLD, // quick start: `npm start -- new --quick --pack adventure`
  },
  npcAttack(api, attackerId, attack) {
    const named = api.ctx.characters.find((c) => c.id === attackerId);
    if (!named || named.status === 'dead') return;
    const threat = clamp(Math.round(attack.threat), 1, 5);
    const blunt = BLUNT.test(attack.how);
    const style: Combatant['style'] = attack.intent === 'kill' ? 'aggressive' : attack.intent === 'humiliate' ? 'tricky' : 'brute';
    // Others acting for them (guards, crew, hired men) fight as a group; otherwise they strike themselves.
    const newcomer = attack.by
      ? newCombatant(api, { name: `${attack.by} (for ${named.name})`, threat, intent: attack.intent, style, blunt })
      : newCombatant(api, { named, name: named.name, threat, intent: attack.intent, style, blunt });
    const current = activeEncounter(api);
    if (current) {
      // They join the fight already going on — or, already in it, press the attack while the player talks.
      if (!current.opponents.some((o) => o.name === newcomer.name && o.status === 'fighting')) {
        current.opponents.push(newcomer);
        api.results.push(`⚔ ${newcomer.name} joins the fight.`);
      }
      if (current.lastTurnId !== api.ctx.turnId) exchange(api, current, { move: 'defend', targetName: newcomer.name, how: 'answering the attack', cleverness: 0 });
      else st(api).setEncounter(current);
      return;
    }
    const e = startEncounter(api, { kind: 'fight', aggressor: 'npc', playerIntent: 'defend', target: null,
      witnessed: true, weaponName: null, opponents: [newcomer] });
    // They strike first: the player is caught on the back foot for the opening exchange.
    exchange(api, e, { move: 'defend', targetName: null, how: 'caught by surprise', cleverness: -1 });
  },
  holdsScene: (api) => Boolean(activeEncounter(api)),
  recollection: {
    skills: SKILLS,
    // A memory can teach the basics (up to 2), never mastery: beyond that a skill grows only by training and use.
    train(api, skill) {
      const p = profile(api, api.ctx.player.id);
      const level = skillLevel(p, skill);
      if (level >= 2) return { ok: false, reason: `a memory can teach the basics, not more — ${skill} is already ${level}. It grows by training and use.` };
      p.skills[skill] = { level: level + 1, practice: 0 };
      st(api).touch(p, api.ctx.now);
      return { ok: true, line: `${skill} ${level} → ${level + 1}` };
    },
    earned: (api) => profile(api, api.ctx.player.id).level - 1,
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
  offerKinds: [dealOfferKind],
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
    return [`❤ ${p.health}/${p.maxHealth}`, `${lang === 'pt' ? 'nível' : 'level'} ${p.level}`, `★ ${fameLabelIn(p.fame, lang)}`];
  },
  prompts: {
    interpretActions: [
      '  Adventure actions (the game decides outcomes — never narrate who wins or whether a feat works):',
      ...actions.map((a) => `  - ${a.doc}`),
      '  Fights are exchange by exchange: start one with fight; while "Fight in progress" is in the briefing, each player message is exactly one combat_move (minutesElapsed 1) and nothing else combat-related. '
        + 'Read the move from what the player describes (a wild swing is strong, "I watch for an opening" is defend, "I kick the brazier at him" is ground). Reward real tactics with cleverness, never mere flowery words.',
      '  Offer kinds for make_offer: deal (terms: price_offerer_pays / price_offerer_receives on acceptance, price_offerer_pays_later / price_offerer_receives_later when it is done; put what is exchanged in label/description).',
    ].join('\n'),
    rules: [
      '- The character has four attributes (strength, agility, wits, presence; 1–5) and ten skills (0–5): combat, stealth, athletics, survival, perception, persuasion, deception, lore, arcana (magic, sympathy, artifice, naming), performance (music, song, acting). Each skill leans on an attribute. /sheet shows them.',
      '- Uncertain acts are rolled: skill + attribute bonus ((attribute − 2) × 0.5) − difficulty (1–5) − the other person\'s perception when someone resists + a d20 (1 → −3 … 20 → +5). A margin of +1.5 or more is a success, −1 or more a partial success, below that a failure. The bracket after a result shows the roll (/rolls hides it).',
      '- For stealth and theft the margin is hidden: you can be seen without knowing it, and witnesses may report you or take revenge later.',
      '- Fights go exchange by exchange: each message is one move (heavy attack, quick attack, guard, feint, grapple, using the ground, breaking away, yielding). Moves counter each other; breath, the upper hand, wounds, weapons, armour, clever tactics and a d20 decide each exchange. People stop once they have what they wanted; someone fighting to kill does not — the character can die.',
      '- Health is 70 + strength × 10, +5 per level. Wounds are light, serious or critical; rest heals, serious wounds need a healer.',
      '- Experience is rolled from what was done (fights, feats, lies, persuasion, theft). Each level (100 × level XP) gives a point: /spend <skill> costs 1, /spend <attribute> costs 3. Training also improves a skill through practice.',
      '- Fame grows with deeds done in front of others; people hear what is said about the character and see their wounds.',
      '- Money is real: prices, deals and promises are kept in a ledger; what someone owes is recorded.',
      '- Recollections: the player writes the character\'s past while playing ("I remember…"). Details are free; a remembered training (+1 to a skill, never above 2) or an old acquaintance (an ordinary person who comes with a complication: a grudge, a debt, or good terms) costs one of the recollections — 3 at the start, +1 per level (/sheet shows how many are left). The past must fit what is already true, and it never gives items, money, titles, powers or the world\'s secrets.',
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
