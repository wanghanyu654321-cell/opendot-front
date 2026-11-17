#!/usr/bin/env bash
# shellcheck disable=SC2034
# Variables are consumed by the entry point that sources this library.
set -euo pipefail

require_node() {
  local version major
  if ! command -v node >/dev/null 2>&1 || ! version=$(node --version 2>/dev/null); then
    echo '需要 Node 22+；请先安装或升级宿主 Node，再运行部署脚本' >&2; exit 2
  fi
  version=${version#v}
  major=${version%%.*}
  if [[ ! "$major" =~ ^[0-9]{1,3}$ ]] || (( 10#$major < 22 )); then
    echo '需要 Node 22+；请先安装或升级宿主 Node，再运行部署脚本' >&2; exit 2
  fi
}
require_node

apply=0
allow_dirty=0
allow_non_main=0
DEPLOY_DIR=${DEPLOY_DIR:-/opt/front-dot}
for argument in "$@"; do
  case "$argument" in
    --apply) apply=1 ;;
    --allow-dirty) allow_dirty=1 ;;
    --allow-non-main) allow_non_main=1 ;;
    *) echo 'unknown argument' >&2; exit 2 ;;
  esac
done
if (( apply )); then echo 'apply: planned actions follow'; else echo 'dry-run: no changes'; fi

require_server_config() {
  : "${CORE_ENV_FILE:?core env file required}" "${ADMIN_ENV_FILE:?management env file required}" "${DEPLOY_DIR:?deployment directory required}"
  local file
  for file in "$CORE_ENV_FILE" "$ADMIN_ENV_FILE"; do
    [[ "$file" = /* ]] || { echo 'env file must be an absolute path' >&2; exit 2; }
    test -f "$file" && test "$(stat -c '%a' "$file")" = 600 || { echo 'env file must have mode 600' >&2; exit 2; }
    case "$(realpath -m "$file")" in "$(git rev-parse --show-toplevel)"/*) echo 'env file must be outside repository' >&2; exit 2 ;; esac
  done
  [[ "$(realpath -m "$CORE_ENV_FILE")" != "$(realpath -m "$ADMIN_ENV_FILE")" ]] || { echo 'core and management env files must be separate' >&2; exit 2; }
  export CORE_ENV_FILE ADMIN_ENV_FILE
  case "$(realpath -m "$DEPLOY_DIR")" in "$(git rev-parse --show-toplevel)"/*) echo 'state directory must be outside repository' >&2; exit 2 ;; esac
}
compose() {
  docker compose --env-file "$ADMIN_ENV_FILE" -p front-dot -f deploy/compose.json "$@"
}
stop_consumer() {
  echo 'stop old: gracefully stop core'
  compose stop core
  echo 'confirm no consumer: container stopped and PG lease released or expired'
  local running
  running=$(compose ps --status running -q core)
  [[ -z "$running" ]] || { echo 'consumer still running' >&2; return 1; }
  compose run --rm --no-deps -T admin verify-consumer
}
start_consumer() {
  echo 'start new: one long connection core'
  compose up -d --no-build --wait --wait-timeout 90 core
}
valid_sha() { [[ "$1" =~ ^[a-f0-9]{40}$ ]]; }
state_field() {
  local value
  if ! value=$(node --input-type=module - "$DEPLOY_DIR/state.json" "$1" <<'NODE'
import { readFileSync } from 'node:fs';
try {
  const state = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const value = state?.[process.argv[3]];
  if (!/^[a-f0-9]{40}$/.test(value ?? '')) throw Error();
  process.stdout.write(value);
} catch { process.exitCode = 2; }
NODE
  ); then
    echo 'rollback state unavailable: state.json must contain valid current and previous commit SHAs; restore reviewed state before retrying' >&2
    return 2
  fi
  printf '%s' "$value"
}

write_state() {
  mkdir -p "$DEPLOY_DIR"
  chmod 700 "$DEPLOY_DIR"
  node --input-type=module - "$DEPLOY_DIR/state.json" "$1" "$2" <<'NODE'
import { writeFileSync, renameSync } from 'node:fs';
const file = process.argv[2];
writeFileSync(file + '.new', JSON.stringify({ current: process.argv[3], previous: process.argv[4] }) + '\n', { mode: 0o600 });
renameSync(file + '.new', file);
NODE
}
