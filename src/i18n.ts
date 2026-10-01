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
    deadline: 'deadline', gm: 'Game master', gmThinking: 'the game master is thinking',
    roll: 'Roll', pressEnter: 'press Enter to roll the d20', you: 'you', vs: 'vs', margin: 'margin', hidden: 'you can\'t tell how it went — you may have been seen',
    outcomes: { success: 'SUCCESS', partial: 'PARTIAL', failure: 'FAILURE' }, critical: 'natural 20!', fumble: 'natural 1…', diceOn: 'dice on', diceOff: 'dice off (results shown directly)',
    terms: {} as Record<string, string>,
    ended: (channel: string) => `[The ${channel === 'phone' ? 'call' : channel === 'message' ? 'chat' : 'conversation'} has ended.]`,
  },
  pt: {
    ideas: 'Ideias', worldMoving: 'o mundo está se movendo', settingScene: 'o narrador está preparando a cena', typeAhead: 'você pode continuar digitando',
    comingUp: 'Em breve:', whatDoYouDo: 'O que você faz?', with: 'com', texting: 'trocando mensagens com', onPhone: 'no telefone com',
    promises: (n: number, overdue: number) => `${n} promessa${n > 1 ? 's' : ''}${overdue ? ` (${overdue} atrasada${overdue > 1 ? 's' : ''}!)` : ''}`,
    gameFooter: (id: string) => `(jogo ${id} — /quit para sair; tudo é salvo a cada turno)`,
    hintsOn: 'ideias de próximos passos ligadas', hintsOff: 'ideias de próximos passos desligadas', failed: 'Algo deu errado ao resolver isso — nada foi salvo. Tente de novo.',
    deadline: 'prazo final', gm: 'Mestre do jogo', gmThinking: 'o mestre do jogo está pensando',
    roll: 'Rolagem', pressEnter: 'pressione Enter para rolar o d20', you: 'você', vs: 'contra', margin: 'margem', hidden: 'você não sabe como foi — alguém pode ter visto',
    outcomes: { success: 'SUCESSO', partial: 'PARCIAL', failure: 'FALHA' }, critical: '20 natural!', fumble: '1 natural…', diceOn: 'dados ligados', diceOff: 'dados desligados (resultados direto)',
    terms: {
      combat: 'combate', stealth: 'furtividade', athletics: 'atletismo', survival: 'sobrevivência', perception: 'percepção', persuasion: 'persuasão', deception: 'enganação',
      lore: 'conhecimento', arcana: 'arcanismo', performance: 'atuação', strength: 'força', agility: 'agilidade', wits: 'astúcia', presence: 'presença',
      'heavy attack': 'ataque pesado', 'quick attack': 'ataque rápido', guard: 'guarda', feint: 'finta', grapple: 'agarrão', 'use of the ground': 'uso do terreno',
      against: 'contra', 'break away from the fight': 'escapar da luta', remembers: 'se lembra de', 'a grudge': 'rancor', 'a debt': 'uma dívida', 'good terms': 'em bons termos', how: 'como',
      difficulty: 'dificuldade', fate: 'destino', 'the upper hand': 'vantagem', tactics: 'tática', 'bare hands': 'mãos nuas', 'no armour': 'sem armadura', wounds: 'ferimentos', tired: 'cansaço',
    } as Record<string, string>,
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
