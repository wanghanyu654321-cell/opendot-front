#!/usr/bin/env bash
# shellcheck source=scripts/deploy/common.sh
source "$(dirname "$0")/common.sh"
branch=$(git branch --show-current)
sha=$(git rev-parse HEAD)
valid_sha "$sha" || exit 2
if [[ "$branch" != main ]] && (( ! allow_non_main )); then echo 'main required; explicit --allow-non-main overrides' >&2; exit 2; fi
dirty=$(git status --porcelain)
if [[ -n "$dirty" ]] && (( ! allow_dirty )); then echo 'clean tree required; explicit --allow-dirty overrides' >&2; exit 2; fi
echo "image front-dot:$sha"
echo 'plan: static check; build image; start PG; migrate schema and provision accounts; stop old; confirm no consumer; start new; health check; save current and previous sha'
(( apply )) || exit 0
require_server_config
export FRONT_DOT_SHA="$sha"
node scripts/deploy/validate-compose.mjs
compose config --quiet
previous=''
prior_current=''
if [[ -f "$DEPLOY_DIR/state.json" ]]; then
  prior_current=$(state_field current)
  previous="$prior_current"
  if [[ "$prior_current" = "$sha" ]]; then
    previous=$(state_field previous) || previous=''
  fi
fi
compose build core
compose up -d --wait pg
echo 'migrate schema and provision accounts: management identity; no synthetic records'
compose run --rm --no-deps -T admin migrate
stop_consumer
if ! start_consumer; then
  echo 'health failed; attempting previous sha; deployment state not advanced' >&2
  if valid_sha "$prior_current"; then
    stop_consumer
    export FRONT_DOT_SHA="$prior_current"
    start_consumer
  else
    compose stop core
  fi
  exit 1
fi
write_state "$sha" "$previous"
