---
name: worktree
description: Work on another gliphish branch in parallel, in its own git worktree - create or join one per branch, move this conversation to where its branch is checked out, merge the default branch into it, take its branch back from the main checkout, list them, or remove one. Use when asked to work in a worktree or on several branches at once.
argument-hint: <branch> [base] | here <branch> | update <branch> | take <branch> | list | remove <branch> | help
---

# Parallel branches (gliphish)

One branch = one persistent worktree under `.claude/worktrees/<branch>` (`/` becomes `-`) = its
conversations. A conversation belongs to the worktree it entered with this skill, for good, and
follows its branch: while the Worktree Hub view has put the branch on the main checkout
("current"), development happens in the main checkout and the worktree is only a backup (what
still lands there is brought back to current automatically, and it gets current's work back when
the branch leaves current); once the branch is back in its worktree, the conversation works in
the worktree. A branch is checked out in exactly one place at a time; a detached worktree must
not commit.

Arguments: `$ARGUMENTS`

## `help` (also when there is no argument)

Print this table as-is, in French, and nothing else: no tool call, no extra advice.

| Commande | Effet |
|---|---|
| `/worktree <branche> [base]` | Rejoint le worktree de la branche s'il existe, sinon le crée dans `.claude/worktrees/<branche>` (le `/` devient `-`) : branche locale, puis `origin/<branche>`, sinon nouvelle branche créée depuis `main` à jour (`origin/main` après un fetch, sans suivi), ou depuis `base` si tu la donnes. current ne change jamais de branche. Si current tient la branche, le worktree est créé détaché sur son dernier commit. La conversation est rattachée à ce worktree, sauf si elle travaille déjà dans un autre worktree : elle y reste, et tu ouvres la conversation du nouveau avec "+" dans Worktree Hub. |
| `/worktree here <branche>` | Amène cette conversation là où la branche est extraite en ce moment : current ou son worktree. Worktree Hub le pré-remplit quand une conversation n'est plus au même endroit que sa branche. |
| `/worktree update <branche>` | Merge de la branche par défaut dans la branche, là où elle est extraite, résolution des conflits et vérifications comprises. Worktree Hub le pré-remplit via "Mettre à jour". |
| `/worktree take <branche>` | Reprend la branche à current : le reste du worktree passe sur current, current revient sur sa branche par défaut (son travail garé est restauré), le worktree retrouve la branche avec tout le travail non committé. |
| `/worktree list` | Liste les worktrees et indique celui de cette session avec sa branche. |
| `/worktree remove <branche>` | Supprime le worktree, garde la branche. Refuse s'il reste du travail non commité. |
| `/worktree help` | Affiche cette aide. |

Rappels : un onglet Claude par branche ; `npm ci` dans `frontend/` du worktree avant tout check
front ; la vue Worktree Hub de VSCodium échange une branche avec current ("Aller") et remet
current sur main ("Aller sur main"). Tant que current est sur la branche d'un worktree, on
développe sur current : le worktree n'est qu'une sauvegarde, ce qui y arrive encore est rapatrié
tout seul sur current, et il récupère le travail de current quand tu changes de branche.

## `<branch> [base]` - join or create

1. Run `"$(git rev-parse --show-toplevel)/.claude/scripts/worktree.sh" <branch> [base]`. The
   last output line is `joined <path>` (worktree already there) or `created <path>`. A new branch
   starts from the fetched default branch unless `base` is given; the script never switches the
   main checkout. When the main checkout holds the branch, the worktree is created detached at
   the branch tip.
2. If `pwd` is inside another worktree under `.claude/worktrees/`, this conversation already
   works for that other branch: do not move it. Report the new worktree and tell me to open its
   conversation with "+" in Worktree Hub, then stop.
3. Otherwise call `EnterWorktree` with that `path`: this call is what binds the conversation to
   the worktree in Worktree Hub.
4. If the main checkout holds the branch, continue with `here <branch>` so the conversation works
   where the branch is.
5. Report joined/created, branch, base (the script's `new branch ... from ...` line) and path in
   one line. `frontend/node_modules` is not copied: run `npm ci` in `frontend/` before any
   frontend check.

## `here <branch>`

1. Run `"$(git rev-parse --show-toplevel)/.claude/scripts/worktree.sh" where <branch>`: the output
   is the directory where the branch is checked out now (or its worktree when it is checked out
   nowhere).
2. If that directory is under `.claude/worktrees/`, call `EnterWorktree` with it as `path`.
   Otherwise it is the main checkout: run `cd "<directory>"` as a Bash call of its own, which
   moves this session's working directory there.
3. Report the new working directory and its branch in one line.

## `update <branch>`

This command is my explicit request to create the merge commit it describes.

1. Run `here <branch>` first, so the merge happens where the branch is checked out.
2. `git fetch origin`, then `git merge --no-edit origin/<default branch>` (default branch from
   `git symbolic-ref --short refs/remotes/origin/HEAD`, else `main`). Uncommitted work blocking
   the merge: stop and report it, never stash or discard it on your own.
3. On conflicts, resolve each file keeping the intent of both sides; when the intent of a side
   is unclear, stop and ask me instead of guessing. Then `git add` the resolved files and
   `git commit --no-edit`.
4. Run the checks of the areas the merge touched (`go build ./...` and the tests of the changed Go
   packages, `/frontend-check` for `frontend/`), and fix only what the merge broke.
5. Never push. The commit uses my git identity and git's default merge message, with no trailer
   and no mention of Claude.
6. Report in three lines: merged commit, conflicts resolved, checks run.

## `take <branch>`

Run `"$(git rev-parse --show-toplevel)/.claude/scripts/worktree.sh" take <branch>`: the rest of the
worktree's work is applied to the main checkout, the main checkout switches to its default branch
and restores the work parked there by Worktree Hub, then the worktree checks `<branch>` out again
with all the work uncommitted. Git refuses when uncommitted work conflicts: report it, never force.

## `list`

`git worktree list`, then say which entry is this session's working directory (`pwd`) and its
branch; a worktree without a branch is detached.

## `remove <branch>`

1. If this session is inside that worktree, call `ExitWorktree` with `action: "keep"` first.
2. `git worktree remove "<main checkout>/.claude/worktrees/<branch, / replaced by ->"`. Git
   refuses when there is uncommitted or untracked work: report it, never retry with `--force`
   unless I ask.
3. Keep the branch. Delete it only if I ask, with `git branch -d` (refuses when unmerged).
