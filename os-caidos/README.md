# Os Caídos

Um livro escrito a quatro mãos: o autor decide o que acontece; a IA escreve as cenas em detalhes, como num livro, e mantém a continuidade.

## Como usar

1. Abra esta pasta com o seu assistente de IA (Claude Code: `claude` dentro da pasta; Codex, Cursor e outros também leem o `AGENTS.md`).
2. Comece cada sessão com: **"Leia o projeto e vamos continuar o livro."**
3. Descreva a cena: o que acontece, como deve parecer, o ambiente, quem está nela.
4. Peça ajustes ("mais silêncio", "o Kokabiel não diria isso ainda") até ficar bom.
5. Diga **"aprovado"**: a cena entra no capítulo, e as notas e os personagens são atualizados.

Dica: comece uma conversa nova a cada sessão de escrita. Tudo o que importa está nos arquivos, e assim a conversa fica leve.

## Estrutura

| Arquivo | O que guarda |
|---|---|
| `AGENTS.md` | As regras de trabalho da IA (como ler, escrever, revisar e atualizar). `CLAUDE.md` aponta para ele. |
| `biblia.md` | A bíblia da história: leis do mundo, o mestre, os caídos, o tom e a voz, e as verdades ocultas. |
| `notas.md` | A continuidade: o que aconteceu em cada capítulo, fios abertos, fatos a não esquecer. |
| `personagens/` | Um arquivo por personagem: essência, o que sabe, passado, sua jornada na história, relações, falas. |
| `lugares.md` | Os lugares de Roma já usados e como foram descritos. |
| `capitulos/` | O texto aprovado: `01.md`, `02.md`… |

Marcas usadas nos arquivos:
- **[AUTOR]**: só o autor sabe; nunca revelar ao leitor sem pedido.
- **[LEITOR SABE — cap. N]**: já revelado ao leitor, no capítulo N.
