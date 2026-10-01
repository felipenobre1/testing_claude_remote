// Interface text for the terminal around the story (status bar, prompts, labels). The engine itself stays English;
// everything the models write is already in the player's language.

export type UiLang = 'en' | 'pt';
export const uiLang = (language?: string | null): UiLang => (/portugu|^pt(-br)?$|brasil|brazil/i.test((language ?? '').trim()) ? 'pt' : 'en');
/** Short language codes on the command line ("pt", "pt-BR") → the full name the models are given. */
export const languageName = (language: string) => (/^pt(-br)?$/i.test(language.trim()) ? 'Brazilian Portuguese' : /^en(-\w+)?$/i.test(language.trim()) ? 'English' : language.trim());

export const UI = {
  en: {
    ideas: 'Ideas', worldMoving: 'the world is moving', settingScene: 'the narrator is setting the scene', typeAhead: 'you can type ahead',
    comingUp: 'Coming up:', whatDoYouDo: 'What do you do?', with: 'with', texting: 'texting', onPhone: 'on the phone with',
    promises: (n: number, overdue: number) => `${n} promise${n > 1 ? 's' : ''}${overdue ? ` (${overdue} overdue!)` : ''}`,
    gameFooter: (id: string) => `(game ${id} — /quit to leave; everything is saved after each turn)`,
    hintsOn: 'next-move ideas on', hintsOff: 'next-move ideas off', failed: 'Something went wrong while resolving that — nothing was saved. Try again.',
    ended: (channel: string) => `[The ${channel === 'phone' ? 'call' : channel === 'message' ? 'chat' : 'conversation'} has ended.]`,
  },
  pt: {
    ideas: 'Ideias', worldMoving: 'o mundo está se movendo', settingScene: 'o narrador está preparando a cena', typeAhead: 'você pode continuar digitando',
    comingUp: 'Em breve:', whatDoYouDo: 'O que você faz?', with: 'com', texting: 'trocando mensagens com', onPhone: 'no telefone com',
    promises: (n: number, overdue: number) => `${n} promessa${n > 1 ? 's' : ''}${overdue ? ` (${overdue} atrasada${overdue > 1 ? 's' : ''}!)` : ''}`,
    gameFooter: (id: string) => `(jogo ${id} — /quit para sair; tudo é salvo a cada turno)`,
    hintsOn: 'ideias de próximos passos ligadas', hintsOff: 'ideias de próximos passos desligadas', failed: 'Algo deu errado ao resolver isso — nada foi salvo. Tente de novo.',
    ended: (channel: string) => (channel === 'phone' ? '[A ligação terminou.]' : channel === 'message' ? '[A conversa por mensagens terminou.]' : '[A conversa terminou.]'),
  },
} as const;

/** "Thu 11 Mar, 05:40" / "qui., 11 de mar., 05:40" — works for any year, including invented calendars mapped to dates. */
export function shortDate(gameTime: string, lang: UiLang): string {
  const d = new Date(`${gameTime}:00Z`);
  const date = d.toLocaleDateString(lang === 'pt' ? 'pt-BR' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${date}, ${gameTime.slice(11, 16)}`;
}

/** Full date for headers, e.g. "quinta-feira, 11 de março de 94, 05:40". */
export function longDate(gameTime: string, lang: UiLang): string {
  const d = new Date(`${gameTime}:00Z`);
  const date = d.toLocaleDateString(lang === 'pt' ? 'pt-BR' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `${date}, ${gameTime.slice(11, 16)}`;
}
