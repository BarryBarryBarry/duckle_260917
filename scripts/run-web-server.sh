#!/usr/bin/env bash
# Run the Duckle web editor natively (no Docker) so a browser on the LAN can
# open it at http://<ip>:<port>.
#
#   scripts/run-web-server.sh                      # 0.0.0.0:8080, ./workspace
#   PORT=9000 WORKSPACE=~/my-ws scripts/run-web-server.sh
#   DUCKLE_CONSOLE_TOKEN=<secret> scripts/run-web-server.sh
#
# Environment:
#   HOST                  bind address (default 0.0.0.0 = every interface)
#   PORT                  port (default 8080)
#   WORKSPACE             workspace folder (default ./workspace, seeded with
#                         the starter pipelines the first time)
#   DUCKLE_CONSOLE_TOKEN  sign-in token. Unset on a non-loopback HOST: one is
#                         generated and stored in .web-server/token so it
#                         survives restarts.
#   PROFILE               cargo profile for duckle-runner (default release-fast)
#   REBUILD=1             rebuild the frontend and runner even if present
#
# The first run builds the browser frontend (DUCKLE_WEB=1 -> frontend/dist-web),
# duckle-runner, and downloads the DuckDB CLI into .web-server/bin when it is not
# on PATH. Everything it creates is git-ignored.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8080}"
WORKSPACE="${WORKSPACE:-$ROOT/workspace}"
PROFILE="${PROFILE:-release-fast}"
DUCKDB_VERSION="${DUCKDB_VERSION:-1.5.5}"
STATE="$ROOT/.web-server"
DIST="$ROOT/frontend/dist-web"
RUNNER="$ROOT/target/$PROFILE/duckle-runner"
mkdir -p "$STATE/bin"

if [[ "${REBUILD:-0}" == 1 || ! -f "$DIST/index.html" ]]; then
  echo "==> Building web frontend"
  (cd frontend && { [[ -d node_modules ]] || npm ci || npm install; } && DUCKLE_WEB=1 npm run build)
fi

if [[ "${REBUILD:-0}" == 1 || ! -x "$RUNNER" ]]; then
  echo "==> Building duckle-runner ($PROFILE)"
  cargo build --profile "$PROFILE" -p duckle-runner
fi

# The engine shells out to the DuckDB CLI.
if [[ -n "${DUCKLE_DUCKDB_BIN:-}" && -x "$DUCKLE_DUCKDB_BIN" ]]; then
  DUCKDB="$DUCKLE_DUCKDB_BIN"
elif command -v duckdb >/dev/null 2>&1; then
  DUCKDB="$(command -v duckdb)"
else
  DUCKDB="$STATE/bin/duckdb"
  if [[ ! -x "$DUCKDB" ]]; then
    case "$(uname -s)-$(uname -m)" in
      Darwin-*) asset="duckdb_cli-osx-universal.zip" ;;
      Linux-x86_64) asset="duckdb_cli-linux-amd64.zip" ;;
      Linux-aarch64 | Linux-arm64) asset="duckdb_cli-linux-arm64.zip" ;;
      *) echo "No DuckDB CLI download for $(uname -sm); install duckdb or set DUCKLE_DUCKDB_BIN" >&2; exit 1 ;;
    esac
    echo "==> Downloading DuckDB CLI v$DUCKDB_VERSION"
    tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/duckdb.zip" \
      "https://github.com/duckdb/duckdb/releases/download/v$DUCKDB_VERSION/$asset"
    unzip -o -q "$tmp/duckdb.zip" -d "$STATE/bin"
    rm -rf "$tmp"
  fi
fi

if [[ ! -d "$WORKSPACE" ]]; then
  echo "==> Seeding starter workspace at $WORKSPACE"
  "$ROOT/scripts/seed-starter-workspace.sh" "$WORKSPACE"
fi

case "$HOST" in
  127.* | localhost | ::1) ;;
  *)
    if [[ -z "${DUCKLE_CONSOLE_TOKEN:-}" ]]; then
      if [[ ! -s "$STATE/token" ]]; then
        (umask 077 && openssl rand -hex 16 >"$STATE/token")
      fi
      DUCKLE_CONSOLE_TOKEN="$(cat "$STATE/token")"
    fi
    export DUCKLE_CONSOLE_TOKEN
    ;;
esac

lan_ips() {
  if [[ "$(uname -s)" == Darwin ]]; then
    ifconfig | awk '/inet / && $2 != "127.0.0.1" {print $2}'
  else
    hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^$' || true
  fi
}

echo
echo "Duckle web editor"
if [[ "$HOST" == 0.0.0.0 ]]; then
  for ip in $(lan_ips); do echo "  http://$ip:$PORT"; done
fi
echo "  http://127.0.0.1:$PORT"
if [[ -n "${DUCKLE_CONSOLE_TOKEN:-}" ]]; then
  echo "  sign-in token: $DUCKLE_CONSOLE_TOKEN"
fi
echo

exec "$RUNNER" web --host "$HOST" --port "$PORT" \
  --dist "$DIST" --workspace "$WORKSPACE" --duckdb "$DUCKDB"
