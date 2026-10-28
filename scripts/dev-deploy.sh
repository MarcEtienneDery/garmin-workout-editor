#!/usr/bin/env bash
# Deploy the dev stack: a fresh copy of the live database + the code in SOURCE_DIR, built into its own image.
#
#   scripts/dev-deploy.sh [--keep-logins] [SOURCE_DIR]   deploy (SOURCE_DIR defaults to the checkout this script is in)
#   scripts/dev-deploy.sh down                            stop the dev stack (the copy stays until the next deploy)
#
# Every deploy: stop dev, snapshot the live database (sqlite online backup; live is only read), build, import the web
# passwords of the old .env.<profile> files into the copy, scrub the copy, start. Dev edits are thrown away by design.
#
# The copy is scrubbed so dev cannot act on the real accounts: the Garmin and Renpho logins and the Garmin tokens are
# removed (dev behaves like a profile without Garmin) and the Renpho auto-fetch/auto-upload switches are turned off.
# --keep-logins keeps the logins: then an upload from dev changes the REAL Garmin account.
#
# Overrides (environment): LIVE_DB, LIVE_WEB_ENV, LIVE_CONFIG, DEV_DIR (default ~/garmin-dev, outside ~/docker so the backup skips it),
# DEV_WEB_PORT (8798), DEV_MCP_PORT (8797), DEV_WEB_BIND (unset: all interfaces, so the LAN reaches the editor),
# DEV_MCP_BIND (127.0.0.1: the MCP server is for a tunnel hostname, like live's).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
COMPOSE_FILE="$HERE/../docker-compose.dev.yml"

LIVE_DB=${LIVE_DB:-$HOME/docker/garmin-mcp/data/garmin.db}
LIVE_WEB_ENV=${LIVE_WEB_ENV:-$HOME/docker/garmin-mcp/web.env}
LIVE_CONFIG=${LIVE_CONFIG:-$HOME/docker/garmin-mcp/config}   # the old .env.<profile> files, read once for their web passwords
export DEV_DIR=${DEV_DIR:-$HOME/garmin-dev}
export DEV_WEB_PORT=${DEV_WEB_PORT:-8798}
export DEV_MCP_PORT=${DEV_MCP_PORT:-8797}

keep_logins=0
action=deploy
src=""
for arg in "$@"; do
  case "$arg" in
    --keep-logins) keep_logins=1 ;;
    down) action=down ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) src=$arg ;;
  esac
done
export DEV_SRC=$(cd "${src:-$HERE/..}" && pwd)

data="$DEV_DIR/data"
run_env="$DEV_DIR/run.env"
dc() { docker compose -f "$COMPOSE_FILE" --env-file "$run_env" "$@"; }

if [[ $action == down ]]; then
  [[ -f $run_env ]] || { echo "no dev stack here ($DEV_DIR)"; exit 0; }
  dc down --remove-orphans
  exit 0
fi

# Never write next to the live database.
mkdir -p "$data"
if [[ $(realpath "$data") == "$(realpath "$(dirname "$LIVE_DB")")" ]]; then
  echo "DEV_DIR must not be the live data directory" >&2; exit 1
fi
[[ -f $LIVE_DB ]] || { echo "live database not found: $LIVE_DB" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "sqlite3 is required" >&2; exit 1; }

# Dev has its own tokens, made once so the sign-in and the connector URL stay the same across deploys.
umask 077
tokens="$DEV_DIR/tokens.env"
if [[ ! -f $tokens ]]; then
  { echo "MCP_AUTH_TOKEN=$(openssl rand -hex 32)"; echo "WEB_AUTH_TOKEN=$(openssl rand -hex 16)"; } > "$tokens"
fi
# The Food view's AI box needs the same Claude login as live (renewed there, picked up here on the next deploy).
{
  cat "$tokens"
  [[ -f $LIVE_WEB_ENV ]] && grep -E '^(FOOD_AI_[A-Z_]*|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=' "$LIVE_WEB_ENV" || true
} > "$run_env"

echo "==> stopping dev"
dc down --remove-orphans

echo "==> copying the live database"
db="$data/garmin.db"
new="$db.new"
rm -f "$new"
sqlite3 -readonly "$LIVE_DB" ".timeout 10000" ".backup '$new'"
[[ $(sqlite3 "$new" "pragma integrity_check") == ok ]] || { echo "the copy failed its integrity check" >&2; rm -f "$new"; exit 1; }
mv -f "$new" "$db"
rm -f "$db-wal" "$db-shm"

echo "==> building the image from $DEV_SRC"
dc build

# The old .env.<profile> files hold the web sign-in passwords that a database made before the profiles table does not have.
# Bring them into the copy (the config is mounted read-only, live is not touched); the logins are scrubbed just after.
if [[ -d $LIVE_CONFIG ]]; then
  echo "==> importing the profiles of $LIVE_CONFIG into the copy"
  docker run --rm --user "$(id -u):$(id -g)" -v "$data:/data" -v "$LIVE_CONFIG:/config:ro" \
    --entrypoint node garmin-workout-editor-mcp:dev dist/storeCli.js import-env /config
fi

has_table() { [[ $(sqlite3 "$db" "select count(*) from sqlite_master where type='table' and name='$1'") == 1 ]]; }
if has_table renpho_settings; then
  sqlite3 "$db" "update renpho_settings set fetch_enabled = 0, push_enabled = 0"
fi
if (( keep_logins )); then
  echo "==> keeping the Garmin and Renpho logins: dev can change the real Garmin account"
else
  for table in credentials garmin_tokens; do
    if has_table "$table"; then sqlite3 "$db" "delete from $table"; fi
  done
fi

echo "==> starting dev"
dc up -d

for _ in $(seq 1 30); do
  web=$(docker inspect -f '{{.State.Health.Status}}' garmin-dev-web 2>/dev/null || true)
  mcp=$(docker inspect -f '{{.State.Health.Status}}' garmin-dev-mcp 2>/dev/null || true)
  [[ $web == healthy && $mcp == healthy ]] && break
  sleep 2
done
echo "garmin-dev-web: ${web:-?}, garmin-dev-mcp: ${mcp:-?}"
echo "plan editor:  http://$(hostname -I | awk '{print $1}'):$DEV_WEB_PORT on the LAN   (any user name + WEB_AUTH_TOKEN from $tokens)"
echo "MCP:          http://127.0.0.1:$DEV_MCP_PORT/mcp/<MCP_AUTH_TOKEN from $tokens>"
[[ $web == healthy && $mcp == healthy ]]
