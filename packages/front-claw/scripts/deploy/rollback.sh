#!/usr/bin/env bash
# shellcheck source=scripts/deploy/common.sh
source "$(dirname "$0")/common.sh"
previous=$(state_field previous)
current=$(state_field current)
echo "plan: switch image to front-dot:$previous; stop old; confirm no consumer; start new; health check; swap current and previous sha"
(( apply )) || exit 0
require_server_config
export FRONT_DOT_SHA="$previous"
stop_consumer
if ! start_consumer; then
  echo 'rollback health failed; restoring current image; state unchanged' >&2
  export FRONT_DOT_SHA="$current"
  stop_consumer
  start_consumer
  exit 1
fi
write_state "$previous" "$current"
