import type { Store } from '../db/store.ts';
import type { WorldSeed } from '../domain/world.ts';
import type { TurnResponse } from '../domain/types.ts';
import type { Trace } from '../engine/trace.ts';
import { bibleText } from '../engine/worldSeed.ts';
import { formatStatusLine, packFor } from './inspect.ts';

// A playtest log: everything needed to understand how a game went and what to fix — what the player typed,
// what they saw, what the engine decided, which model outputs were rejected and why, and how long each step took.
// Written as Markdown so it can be read by a person (or pushed to the repo for review).

const block = (s: string) => ['```', s.trim(), '```'].join('\n');

export function exportPlaytest(store: Store, gameId: string, opts: { full?: boolean } = {}): string {
  const game = store.getGame(gameId)!;
  const seed = store.getWorldSeed<WorldSeed>(gameId);
  const pack = packFor(store, gameId);
  const turns = store.listTurns(gameId);
  const out: string[] = [
    `# Playtest — ${game.title}`,
    `Game \`${game.id}\` · pack \`${game.packId}\` · ${turns.length} turns (${turns.filter((t) => t.status === 'committed').length} committed, ${turns.filter((t) => t.status === 'failed').length} failed) · now ${game.gameTime}`,
    '',
    '## World',
    seed ? block(bibleText(seed)) : '(no world seed)',
    '',
    '## People',
    ...store.listCharacters(gameId).map((c) => `- ${c.name}${c.isPlayer ? ' (player)' : ''} — ${c.role}${c.status && c.status !== 'alive' ? ` — **${c.status}**` : ''} (${c.origin})`),
    '',
    '## Turns',
  ];
  const totals = new Map<string, { calls: number; ms: number; rejected: number }>();
  for (const t of turns) {
    const r = t.response as TurnResponse | null;
    const tr = t.trace as Trace | null;
    out.push('', `### ${t.seq}. [${t.status}] ${tr?.gameTimeBefore ?? ''} → ${r?.gameTime ?? ''}`, '', `**Player:** ${t.playerInput}`, '');
    if (r?.text) out.push('**Shown:**', block(r.text + (r.suggestions?.length ? `\n\n💡 ${r.suggestions.join(' · ')}` : '')));
    if (r?.error) out.push(`**Error:** ${r.error}`);
    if (tr) {
      const flags = [
        tr.interpretation?.actions.length ? `actions: ${tr.interpretation.actions.map((a) => JSON.stringify(a)).join(' ')}` : null,
        tr.resolution && tr.resolution.kind !== 'none' ? `target: ${tr.resolution.kind}${tr.resolution.name ? ` "${tr.resolution.name}"` : ''}` : null,
        r?.beat ? `beat: ${r.beat}` : null,
        tr.beatFailed ? `beat FAILED: ${tr.beatFailed}` : null,
        tr.beatOfferDropped ? `beat offer dropped: ${tr.beatOfferDropped}` : null,
        tr.narratorFailed ? `narrator FAILED: ${tr.narratorFailed}` : null,
        tr.economy?.actionErrors.length ? `action errors: ${tr.economy.actionErrors.join('; ')}` : null,
        tr.world?.director?.ran ? `director: accepted ${tr.world.director.accepted.join(', ') || 'nothing'}${tr.world.director.rejected.length ? `; rejected ${tr.world.director.rejected.map((x) => `${x.item} (${x.reason})`).join('; ')}` : ''}` : null,
      ].filter(Boolean);
      if (flags.length) out.push(...flags.map((f) => `- ${f}`));
      const calls = tr.llmCalls.map((c) => {
        const tot = totals.get(c.task) ?? { calls: 0, ms: 0, rejected: 0 };
        tot.calls++; tot.ms += c.ms ?? 0; if (c.problems.length) tot.rejected++;
        totals.set(c.task, tot);
        return `${c.task}${c.attempt > 1 ? `#${c.attempt}` : ''}${c.ms ? ` ${(c.ms / 1000).toFixed(1)}s` : ''}${c.problems.length ? ` ✗ ${c.problems.join('; ')}` : ''}`;
      });
      if (calls.length) out.push(`- model calls: ${calls.join(' · ')}`);
      if (opts.full) {
        for (const c of tr.llmCalls) out.push('', `<details><summary>${c.task} #${c.attempt}</summary>`, '', '**Prompt:**', block(c.user), '**Output:**', block(c.rawText ?? '(none)'), '</details>');
      }
    }
  }
  out.push('', '## Model calls', '| task | calls | rejected | avg time |', '|---|---|---|---|',
    ...[...totals.entries()].map(([k, v]) => `| ${k} | ${v.calls} | ${v.rejected} | ${v.calls && v.ms ? `${(v.ms / v.calls / 1000).toFixed(1)}s` : '-'} |`));
  out.push('', '## State now', block(formatStatusLine(store, gameId, pack)), pack.inspect ? block(pack.inspect(store, gameId)) : '');
  return out.join('\n');
}
