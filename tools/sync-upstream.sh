#!/usr/bin/env bash
# Rebase this fork's patch commits (bootstrap + Zernio) onto the latest
# upstream Postiz, run the Zernio tests, and optionally push.
#
#   tools/sync-upstream.sh            # rebase + test, no push
#   tools/sync-upstream.sh --push     # ... then push --force-with-lease to origin/main
#
# main is kept as "upstream/main + a few patch commits", so after a rebase
# origin/main has to be force-pushed (with lease, so nobody's work is lost).
set -euo pipefail

BRANCH="${BRANCH:-main}"
UPSTREAM_REF="${UPSTREAM_REF:-upstream/main}"
PUSH=false
[[ "${1:-}" == "--push" ]] && PUSH=true

cd "$(git rev-parse --show-toplevel)"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean, commit or stash first." >&2
  exit 1
fi

git remote get-url upstream >/dev/null 2>&1 ||
  git remote add upstream https://github.com/gitroomhq/postiz-app.git

git fetch upstream --tags
git fetch origin
git checkout "$BRANCH"

BEFORE="$(git rev-parse HEAD)"
BACKUP="backup/${BRANCH}-$(date +%Y%m%d-%H%M%S)"
git branch "$BACKUP" "$BEFORE"
echo "Backup of the current ${BRANCH}: ${BACKUP}"

echo "Patch commits on top of ${UPSTREAM_REF}:"
git log --oneline "$(git merge-base HEAD "$UPSTREAM_REF")..HEAD"

if ! git rebase "$UPSTREAM_REF"; then
  echo
  echo "Rebase conflict. Resolve the files, then 'git add <file>' and"
  echo "'git rebase --continue' (or 'git rebase --abort' to go back)."
  echo "Likely spots: integration.manager.ts, all.providers.settings.ts,"
  echo "show.all.providers.tsx, continue-provider/list.tsx, .dockerignore"
  exit 1
fi

pnpm install --frozen-lockfile
pnpm exec jest -c libraries/nestjs-libraries/src/integrations/zernio/jest.config.js

if $PUSH; then
  git push --force-with-lease="${BRANCH}:origin/${BRANCH}" origin "$BRANCH"
  echo "Pushed. Rebuild with: docker compose build postiz && docker compose up -d"
else
  echo "Rebased locally. Check with 'docker compose build postiz && docker compose up -d',"
  echo "then push with: git push --force-with-lease origin ${BRANCH}"
fi
