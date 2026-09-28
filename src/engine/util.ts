import { randomUUID } from 'node:crypto';

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

// Game time is stored as local wall-clock time in the game's timezone ('YYYY-MM-DDTHH:MM').
// Arithmetic treats it as a naive clock (DST transitions are ignored in M1).

export function addMinutes(gameTime: string, minutes: number): string {
  const d = new Date(`${gameTime}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().slice(0, 16);
}

export function formatGameTime(gameTime: string): string {
  const d = new Date(`${gameTime}:00Z`);
  const date = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `${date}, ${gameTime.slice(11, 16)}`;
}

/** 09:00 on the first day of the month after `gameTime` — when monthly bills and income land. */
export function firstOfNextMonth(gameTime: string): string {
  const d = new Date(`${gameTime.slice(0, 7)}-01T09:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 16);
}

/** The next Monday 08:00 strictly after `gameTime` — the start of a new game week. */
export function nextWeekStart(gameTime: string): string {
  const d = new Date(`${gameTime.slice(0, 10)}T08:00:00Z`);
  const dow = d.getUTCDay(); // 0 = Sunday
  d.setUTCDate(d.getUTCDate() + ((8 - dow) % 7 || 7));
  const t = d.toISOString().slice(0, 16);
  // Monday before 08:00 → the same day's 08:00 is next.
  const today = `${gameTime.slice(0, 10)}T08:00`;
  return new Date(`${today}:00Z`).getUTCDay() === 1 && today > gameTime ? today : t;
}

// ---- lightweight relevance signals (no embeddings in M1) ----

const STOPWORDS = new Set(
  ('the and for you your with that this have has had was were are but not what about just like its it\'s ' +
    'from they them she her him his our out get got can will would could should there their then than ' +
    'che per con non una uno gli del della sono come anche mi ti ci si').split(' '),
);

export function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= 3 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

export function overlap(a: Set<string>, text: string): number {
  let n = 0;
  for (const w of keywords(text)) if (a.has(w)) n++;
  return n;
}

export const truncate = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
