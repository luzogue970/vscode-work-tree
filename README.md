# Worktree Hub

Extension VSCodium compagnon de Claude Code : une entrée "Worktree Hub" dans la barre d'activité,
avec les conversations Claude regroupées par worktree git. Un clic ouvre la conversation.

## Ce qu'elle lit

- `git worktree list --porcelain` dans le dossier ouvert.
- `git fetch --prune origin` en arrière-plan, à chaque actualisation et au plus toutes les 5 min
  sinon : une branche supprimée sur GitHub après sa PR, ou dont tous les commits sont déjà sur la
  branche par défaut (merge par rebase), part dans "Archivés", replié par défaut comme ses worktrees.
- Les transcripts `~/.claude/projects/<dossier>/*.jsonl` de chaque worktree : `cwd`, `gitBranch`,
  titre (`customTitle`, `aiTitle`, `lastPrompt`, premier message).
- Le clic appelle la commande interne `claude-vscode.editor.open` avec l'id de session. Non
  documentée : à revérifier après chaque mise à jour de l'extension Claude Code.

## Rebaser sur la branche par défaut

"Rebaser sur main" lance Claude Code sans interface (`claude -p`) là où la branche est extraite,
avec le binaire livré par l'extension Claude Code (`resources/native-binary/claude`, sinon `claude`
du PATH), en `--safe-mode --permission-mode auto`, `git push` interdit. Avant, le travail non
committé part en commits wip rebasés avec la branche ; après, ils sont défaits et le travail
retrouve son état (indexé, non indexé, non suivi). Claude résout les conflits ; si le rebase n'est
pas terminé à la fin (abandon, erreur, 30 min dépassées), `git rebase --abort` et tout revient à
l'état de départ, avec l'explication de Claude dans le message d'erreur. Chaque étape s'affiche
dans la vue ; la session, nommée "Rebase de <branche> sur <cible>", se reprend avec
`claude --resume` dans le dossier de la branche. Rien n'est poussé.

## Construire et installer (fish)

```fish
cd ~/Documents/mes-dev/worktree-hub
npm ci
npm run install:codium
```

La vue détecte le nouveau build en moins de 5 s et propose "Charger à chaud" : `out/extension.js`
reste un amorceur stable qui décharge l'implémentation (`out/impl.js` et ses modules) et recharge
celle du build installé, sans redémarrer les extensions, donc sans couper les conversations Claude
Code. Seul un build qui change `contributes` (commandes, vues, réglages) demande un vrai
redémarrage, proposé avec confirmation.

Une conversation qui vit dans un worktree ne se rouvre pas depuis la fenêtre du checkout principal
(Claude Code ouvre une conversation vide à la place) : la vue le dit et propose d'ouvrir une
fenêtre sur le worktree, où la conversation s'ouvre toute seule.

## Tests

`npm test` compile puis lance trois niveaux avec le runner de Node (`node --test`), sans dépendance :

- unitaires : lecture des transcripts (`test/claude.test.ts`) et des builds installés (`test/build.test.ts`) ;
- intégration : toutes les opérations git dans des dépôts jetables (`test/git.test.ts`) ;
- fonctionnels : l'extension activée contre une API `vscode` simulée (`test/stubs/vscode.ts`),
  messages du webview, transferts de branche, ouverture de conversations, rechargement à chaud
  (`test/impl.test.ts`, `test/host.test.ts`).

`npm run package` refuse d'empaqueter si un test échoue, et le hook `.githooks/pre-commit`
(activé par `npm install` via `prepare`) lance `npm test` avant chaque commit.

## Développer

- `npm run watch` dans un terminal, puis F5 : ouvre une fenêtre de développement sur gliphish
  avec l'extension chargée.
- `media/view.css` : toutes les couleurs et tailles sont des variables `--wt-*` en tête de
  fichier. `media/view.js` : rendu de la liste. Après modification, "Developer: Reload Webviews".
- `src/claude.ts` : lecture des transcripts. `src/git.ts` : worktrees. `src/view.ts` : vue.
- Historique git en Conventional Commits (`feat`, `fix`, `refactor`, `chore`), sujet en anglais.
