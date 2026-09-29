# Worktree Hub

Extension VSCodium compagnon de Claude Code : une entrée "Worktree Hub" dans la barre d'activité,
avec les conversations Claude regroupées par worktree git. Un clic ouvre la conversation.

## Ce qu'elle lit

- `git worktree list --porcelain` dans le dossier ouvert.
- Les transcripts `~/.claude/projects/<dossier>/*.jsonl` de chaque worktree : `cwd`, `gitBranch`,
  titre (`customTitle`, `aiTitle`, `lastPrompt`, premier message).
- Le clic appelle la commande interne `claude-vscode.editor.open` avec l'id de session. Non
  documentée : à revérifier après chaque mise à jour de l'extension Claude Code.

## Construire et installer (fish)

```fish
cd ~/Documents/mes-dev/worktree-hub
npm ci
npm run install:codium
```

Puis "Developer: Restart Extension Host" dans VSCodium.

## Développer

- `npm run watch` dans un terminal, puis F5 : ouvre une fenêtre de développement sur gliphish
  avec l'extension chargée.
- `media/view.css` : toutes les couleurs et tailles sont des variables `--wt-*` en tête de
  fichier. `media/view.js` : rendu de la liste. Après modification, "Developer: Reload Webviews".
- `src/claude.ts` : lecture des transcripts. `src/git.ts` : worktrees. `src/view.ts` : vue.
- Historique git en Conventional Commits (`feat`, `fix`, `refactor`, `chore`), sujet en anglais.
