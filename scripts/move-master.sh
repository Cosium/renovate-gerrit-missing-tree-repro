#!/usr/bin/env bash
# Submits a commit to master from a separate clone, so that Renovate's own
# clone does not get the new tip. Run by Renovate as a post-upgrade task.
set -euo pipefail

clone=$(mktemp -d)
trap 'rm -rf "$clone"' EXIT

git clone --quiet "$MOVE_MASTER_URL" "$clone"
cd "$clone"
echo "Moved while Renovate was running: $(date -u +%FT%TZ)" >> CHANGELOG.md
git add CHANGELOG.md
git -c user.name=Administrator -c user.email=admin@example.com \
  commit --quiet -m "Update changelog while Renovate runs"
git push --quiet origin HEAD:refs/heads/master
echo "master moved to $(git rev-parse HEAD)"
