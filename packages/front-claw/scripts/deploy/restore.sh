#!/usr/bin/env bash
# shellcheck source=scripts/deploy/common.sh
source "$(dirname "$0")/common.sh"
echo 'plan: create a new restore database; pg_restore --exit-on-error; compare every table count and checksum before cutover; retain source database'
(( apply )) || exit 0
require_server_config
: "${BACKUP_FILE:?archive required}" "${RESTORE_DB:?new database name required}"
[[ "$RESTORE_DB" =~ ^restore_[a-z0-9_]+$ && ${#RESTORE_DB} -le 63 ]] || { echo 'new restore database name required' >&2; exit 2; }
test -f "$BACKUP_FILE" || exit 2
export FRONT_DOT_SHA
FRONT_DOT_SHA=$(state_field current)
compose exec -T pg createdb -U postgres "$RESTORE_DB"
compose exec -T pg pg_restore -U postgres --exit-on-error -d "$RESTORE_DB" < "$BACKUP_FILE"
echo 'restore_complete: isolated new database; checksum verification and explicit cutover still required'
