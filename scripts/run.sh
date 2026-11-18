#!/usr/bin/env bash
# Reproduces "remote unpack failed: error Missing tree" on a Renovate push to
# Gerrit, from a clean Gerrit.
#
# Usage:
#   scripts/run.sh released                 # renovate/renovate Docker image
#   scripts/run.sh source <renovate-clone>  # Renovate run from source (pnpm start)
set -euo pipefail

cd "$(dirname "$0")/.."
repro_dir=$PWD
mode=${1:?usage: $0 released | source <renovate-clone>}
case $mode in
  released) label=released ;;
  source)
    renovate_clone=$(realpath "${2:?usage: $0 source <renovate-clone>}")
    label=source-$(git -C "$renovate_clone" rev-parse --short HEAD)
    ;;
  *)
    echo "unknown mode: $mode" >&2
    exit 2
    ;;
esac
gerrit_port=${GERRIT_PORT:-8080}
gerrit=http://localhost:$gerrit_port
admin=(-u admin:secret)
project=missing-tree-demo

log() { printf '\n==> %s\n' "$*"; }

gerrit_api() {
  # Gerrit prefixes JSON responses with )]}' to prevent XSSI.
  curl -sf "${admin[@]}" "$@" | sed 1d
}

renovate() {
  local run=$1
  local name=$label-run$run
  log "Renovate run $run ($label), log: logs/$name.log"
  rm -f "logs/$name.log" "logs/$name-packet.log"
  case $mode in
    released)
      GERRIT_PORT=$gerrit_port LOG_NAME=$name docker compose run --rm --no-deps \
        -e REPRO_RUN="$run" \
        -e RENOVATE_GERRIT_PASSWORD="$renovate_password" \
        -e REPRO_GIT_TRACE_PACKET="/repro/logs/$name-packet.log" \
        renovate >/dev/null
      ;;
    source)
      (
        cd "$renovate_clone"
        REPRO_RUN=$run \
          RENOVATE_CONFIG_FILE="$repro_dir/config.js" \
          RENOVATE_GERRIT_PASSWORD="$renovate_password" \
          GERRIT_URL="$gerrit/" \
          LOG_LEVEL=info \
          LOG_FILE="$repro_dir/logs/$name.log" \
          LOG_FILE_LEVEL=debug \
          REPRO_GIT_TRACE_PACKET="$repro_dir/logs/$name-packet.log" \
          RENOVATE_BASE_DIR="$work/renovate-run$run" \
          pnpm --silent start >/dev/null
      )
      ;;
  esac
}

open_changes() {
  log "Open changes of renovate"
  gerrit_api "$gerrit/a/changes/?q=owner:renovate+status:open+project:$project" |
    jq -r '.[] | "  \(._number) \(.subject)"'
}

move_master() {
  MOVE_MASTER_URL="http://admin:secret@localhost:$gerrit_port/a/$project" \
    bash scripts/move-master.sh
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

log "Starting a clean Gerrit on $gerrit"
docker compose down -v --remove-orphans >/dev/null 2>&1
GERRIT_PORT=$gerrit_port docker compose up -d --wait gerrit
mkdir -p logs
chmod 777 logs

log "Creating user renovate (not an administrator)"
renovate_password=$(head -c 18 /dev/urandom | base64)
jq -n --arg password "$renovate_password" \
  '{name: "Renovate", email: "renovate@example.org", http_password: $password}' |
  gerrit_api -X PUT -H 'Content-Type: application/json' -d @- \
    "$gerrit/a/accounts/renovate" >/dev/null

log "Creating project $project with an outdated package.json (commit A)"
gerrit_api -X PUT -H 'Content-Type: application/json' \
  -d '{"branches": ["master"], "create_empty_commit": true}' \
  "$gerrit/a/projects/$project" >/dev/null
# Lets the administrator move master directly, standing for submitted changes.
administrators=$(gerrit_api "$gerrit/a/groups/Administrators" | jq -r .id)
jq -n --arg group "$administrators" \
  '{add: {"refs/heads/*": {permissions: {push: {rules: {($group): {action: "ALLOW"}}}}}}}' |
  gerrit_api -X POST -H 'Content-Type: application/json' -d @- \
    "$gerrit/a/projects/$project/access" >/dev/null
seed=$work/seed
git clone --quiet "http://admin:secret@localhost:$gerrit_port/a/$project" "$seed"
cp -r project/. "$seed"
git -C "$seed" add -A
git -C "$seed" -c user.name=Administrator -c user.email=admin@example.com \
  commit --quiet -m "Add the demo project"
git -C "$seed" push --quiet origin HEAD:refs/heads/master
git -C "$seed" log -1 --format='commit A %H, root tree %T'

log "renovate's read access to refs/meta/config (Gerrit checks pushed objects' reachability without it)"
gerrit_api "$gerrit/a/projects/$project/check.access?account=renovate&ref=refs/meta/config&perm=read" |
  jq -c '{status, message}'

renovate 1
open_changes

log "Advancing master by two commits (B)"
move_master
move_master

renovate 2
open_changes

log "Outcome of run 2 per branch (logs/$label-run2.log)"
jq -rR --arg pattern '^(Commit prepared, push deferred|PR created|Pull request creation error|Reached (branch|PR) limit)' '
  fromjson? | select(.msg | test($pattern)) |
  "  \(.branch): \(.msg)" +
    (((.err.message // "") | capture("(?<error>remote unpack failed: [^\n]*)") | " (\(.error))") // "")' \
  "logs/$label-run2.log"
