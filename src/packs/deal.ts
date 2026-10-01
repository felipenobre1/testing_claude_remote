import type { OfferKindDef } from './types.ts';

const cents = (x: number | undefined) => Math.round((x ?? 0) * 100);

/**
 * A generic agreement any pack can use: something is done or exchanged (described in the offer) and money may change hands —
 * now, on acceptance, and/or later, when the work is done (recorded as a promise the payer owes).
 */
export const dealOfferKind: OfferKindDef = {
  kind: 'deal',
  summary: 'an agreement: service, protection, a job, a trade — money may change hands now and/or when it is done',
  terms: [
    { key: 'price_offerer_pays', description: 'money the offerer pays the recipient on acceptance', required: false },
    { key: 'price_offerer_receives', description: 'money the recipient pays the offerer on acceptance', required: false },
    { key: 'price_offerer_pays_later', description: 'money the offerer will pay the recipient when the agreed thing is done (a promise)', required: false },
    { key: 'price_offerer_receives_later', description: 'money the recipient will pay the offerer when the agreed thing is done (a promise)', required: false },
  ],
  validateTerms: (t) => (Object.values(t).some((v) => v < 0) ? 'prices cannot be negative' : null),
  resolveSubject: () => ({ subjectRef: null }),
  describe: (api, o) => {
    const t = o.terms;
    const parts = [
      t.price_offerer_pays ? `${api.money(cents(t.price_offerer_pays))} now` : '', t.price_offerer_pays_later ? `${api.money(cents(t.price_offerer_pays_later))} when done` : '',
    ].filter(Boolean);
    const theirs = [
      t.price_offerer_receives ? `${api.money(cents(t.price_offerer_receives))} now` : '', t.price_offerer_receives_later ? `${api.money(cents(t.price_offerer_receives_later))} when done` : '',
    ].filter(Boolean);
    return `${o.label ?? o.description}${parts.length ? ` for ${parts.join(' + ')}` : theirs.length ? ` at ${theirs.join(' + ')}` : ''}`;
  },
  execute: (api, o) => {
    const t = o.terms;
    const what = o.label ?? o.description;
    const from = o.fromCharacterId, to = o.toCharacterId;
    const pays = cents(t.price_offerer_pays), gets = cents(t.price_offerer_receives);
    if (!api.payBetween(from, to, pays, what, 'deal') || !api.payBetween(to, from, gets, what, 'deal')) return;
    // What was paid is part of the result, so the story can never contradict the ledger.
    const paid = [pays ? `${api.name(from)} paid ${api.name(to)} ${api.money(pays)}` : '', gets ? `${api.name(to)} paid ${api.name(from)} ${api.money(gets)}` : ''].filter(Boolean);
    const line = `✓ Deal: ${what}${paid.length ? ` — ${paid.join('; ')}` : ' — no money changed hands yet'}`;
    api.results.push(line);
    api.witnessed.push(line); // both sides saw it: what the NPC says must match the ledger
    if (t.price_offerer_pays_later) api.addObligation(from, to, `the rest of the payment for: ${what}`, t.price_offerer_pays_later, 2, null);
    if (t.price_offerer_receives_later) api.addObligation(to, from, `the rest of the payment for: ${what}`, t.price_offerer_receives_later, 2, null);
  },
};
