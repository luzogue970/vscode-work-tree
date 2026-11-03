#!/usr/bin/env bash
# Usage: worktree.sh <branch> [base] | take <branch> | where <branch> - last line is "joined|created|taken <path>" or the path.
set -euo pipefail

root="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"

holder_of() {
  git -C "$root" worktree list --porcelain | awk -v ref="branch refs/heads/$1" '/^worktree /{path=substr($0,10)} $0==ref{print path; exit}'
}

default_branch() {
  local ref
  ref="$(git -C "$root" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)"
  echo "${ref#origin/}"
}

restore_park() {
  local sha ref
  sha="$(git -C "$root" stash list --format='%H %gs' | awk -v tag=": worktree-hub:park:$1" 'substr($0, length($0) - length(tag) + 1) == tag {print $1; exit}')"
  [ -n "$sha" ] || return 0
  git -C "$root" stash apply -q --index "$sha"
  ref="$(git -C "$root" stash list --format='%gd %H' | awk -v sha="$sha" '$2 == sha {print $1; exit}')"
  [ -z "$ref" ] || git -C "$root" stash drop -q "$ref"
}

if [ "${1:-}" = where ]; then
  branch="${2:?usage: worktree.sh where <branch>}"
  dir="$root/.claude/worktrees/${branch//\//-}"
  holder="$(holder_of "$branch")"
  if [ -n "$holder" ]; then
    echo "$holder"
  elif [ -d "$dir" ]; then
    echo "$dir"
  else
    echo "error: $branch is checked out nowhere and has no worktree" >&2
    exit 1
  fi
  exit 0
fi

if [ "${1:-}" = take ]; then
  branch="${2:?usage: worktree.sh take <branch>}"
  dir="$root/.claude/worktrees/${branch//\//-}"
  if [ "$(holder_of "$branch")" = "$root" ]; then
    git -C "$dir" add -A
    if ! git -C "$dir" diff --cached --quiet; then
      if ! git -C "$dir" diff --cached --binary | git -C "$root" apply --index; then
        git -C "$dir" reset -q
        echo "error: the worktree changes conflict with current, nothing was moved" >&2
        exit 1
      fi
      git -C "$dir" commit -q --no-verify -m wip -m "Worktree-Hub-Snapshot: sync"
    fi
    git -C "$root" add -A
    git -C "$root" diff --cached --quiet || git -C "$root" commit -q --no-verify -m wip -m "Worktree-Hub-Snapshot: current"
    default="$(default_branch)"
    git -C "$root" switch "$default"
    git -C "$root" ls-files --others --exclude-standard -z | while IFS= read -r -d '' file; do
      mkdir -p "$dir/$(dirname "$file")"
      mv "$root/$file" "$dir/$file"
      [ "$(dirname "$file")" = . ] || (cd "$root" && rmdir -p --ignore-fail-on-non-empty "$(dirname "$file")")
    done
    restore_park "$default"
  fi
  git -C "$dir" switch "$branch"
  while git -C "$dir" log -1 --format=%B | grep -q '^Worktree-Hub-Snapshot:'; do
    git -C "$dir" reset -q HEAD~1
  done
  echo "taken $dir"
  exit 0
fi

branch="${1:?usage: worktree.sh <branch> [base] | take <branch> | where <branch>}"
base="${2:-}"
dir="$root/.claude/worktrees/${branch//\//-}"
holder="$(holder_of "$branch")"

if [ -n "$holder" ] && [ "$holder" != "$root" ]; then
  echo "joined $holder"
  exit 0
fi

if [ -e "$dir" ]; then
  echo "joined $dir"
  exit 0
fi

if [ "$holder" = "$root" ]; then
  git -C "$root" worktree add --detach "$dir" "$branch"
elif git -C "$root" show-ref --verify --quiet "refs/heads/$branch"; then
  git -C "$root" worktree add "$dir" "$branch"
elif git -C "$root" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
  git -C "$root" worktree add --track -b "$branch" "$dir" "origin/$branch"
else
  if [ -z "$base" ]; then
    base="$(default_branch)"
    GIT_TERMINAL_PROMPT=0 timeout 20 git -C "$root" fetch -q origin "$base" 2>/dev/null || echo "warning: could not fetch origin/$base, using its last fetched state" >&2
    git -C "$root" show-ref --verify --quiet "refs/remotes/origin/$base" && base="origin/$base"
  fi
  git -C "$root" worktree add --no-track -b "$branch" "$dir" "$base"
  echo "new branch $branch from $base ($(git -C "$root" log -1 --format='%h %s' "$base"))" >&2
fi

# .worktreeinclude entries are copied as literal paths: globs are not expanded here.
while IFS= read -r path; do
  [[ -z "$path" || "$path" == \#* || ! -e "$root/$path" ]] && continue
  (cd "$root" && cp -a --parents "${path%/}" "$dir/")
done <"$root/.worktreeinclude"

echo "created $dir"
