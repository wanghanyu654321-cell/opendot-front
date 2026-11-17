#!/usr/bin/env bash
# shellcheck source=scripts/deploy/common.sh
source "$(dirname "$0")/common.sh"
retention=${BACKUP_RETENTION_DAYS:-14}
[[ "$retention" =~ ^[1-9][0-9]*$ ]] || { echo 'positive retention days required' >&2; exit 2; }
echo "plan: pg_dump -Fc to <backup-dir>; verify archive listing; retain $retention days; remove expired matching backup files only"
(( apply )) || exit 0
require_server_config
: "${BACKUP_DIR:?external backup directory required}"
case "$(realpath -m "$BACKUP_DIR")" in "$(git rev-parse --show-toplevel)"/*) echo 'backup directory must be outside repository' >&2; exit 2 ;; esac
export FRONT_DOT_SHA
FRONT_DOT_SHA=$(state_field current)
umask 077
mkdir -p "$BACKUP_DIR"
archive="$BACKUP_DIR/ledger-$(date -u +%Y%m%dT%H%M%SZ).dump"
compose exec -T pg pg_dump -U postgres -d front_dot -Fc > "$archive.partial"
compose exec -T pg pg_restore --list < "$archive.partial" > /dev/null
mv "$archive.partial" "$archive"
node --input-type=module - "$BACKUP_DIR" "$retention" <<'NODE'
import { readdirSync, lstatSync, unlinkSync } from 'node:fs';
import path from 'node:path';
const directory = process.argv[2], cutoff = Date.now() - Number(process.argv[3]) * 86400000;
for (const name of readdirSync(directory)) {
  if (!/^ledger-\d{8}T\d{6}Z\.dump$/.test(name)) continue;
  const file = path.join(directory, name), info = lstatSync(file);
  if (info.isFile() && info.mtimeMs < cutoff) unlinkSync(file);
}
NODE
echo 'backup_complete'
