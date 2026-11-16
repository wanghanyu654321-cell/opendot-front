import { writeFile } from 'node:fs/promises';
import os from 'node:os';

export const notice = '合成数据，不代表线上';
const skippedGates = '未复跑（需授权语料）';
const phases = ['initialize', 'permissions', 'model-flow', 'flow', 'replay', 'backup', 'restore', 'restored-progress'];
const coreCommands = ['node dist/standalone/main.js',
  'docker compose -p <project> -f deploy/compose.e2e.json up -d --wait --wait-timeout 90 core'];
const commands = new Set([
  ...phases.flatMap(phase => [`node scripts/e2e/steps.mjs ${phase}`,
    `docker compose -p <project> -f deploy/compose.e2e.json run --rm --no-deps -T driver ${phase}`]),
  ...coreCommands.flatMap(command => [command, `SIGTERM <core>; ${command}`, `${command} (restored database)`]),
  'PG_BIN/<tools> initialize temporary PG17 at <tmp>',
  'docker compose -f deploy/compose.e2e.json build core; up pg',
  'stop core before database snapshot',
  'authorized operator: scripts/eval-gates.sh --corpus <授权语料> --out <仓库外路径>',
  'stop core; pg_ctl stop; remove <tmp>',
  'docker compose down --volumes (disposable project only)',
]);
const steps = new Set(['prepare', ...phases, 'start-core', 'restart-core', 'quiesce', 'start-restored-core', 'gates', 'cleanup']);

/** Fail closed: only portable command templates and selected result fields may be saved. */
export function assertRedactedRecord(document, { username = os.userInfo().username, hostname = os.hostname() } = {}) {
  const fail = () => { throw Object.assign(Error('RECORD_NOT_REDACTED'), { code: 'RECORD_NOT_REDACTED' }); };
  if (document?.notice !== notice) fail();
  const identities = [username, hostname].filter(Boolean).map(value => value.toLowerCase());
  function checkText(value) {
    if (/(?:^|[\s"'=:(])(?:\/|[a-z]:[\\/]|\\\\)|[a-z][a-z0-9+.-]*:\/\/|\b(?:\d{1,3}\.){3}\d{1,3}\b/i.test(value)) fail();
    const tokens = value.toLowerCase().split(/[^a-z0-9_.-]+/);
    if (identities.some(identity => tokens.includes(identity))) fail();
  }
  function visit(value, key = '') {
    checkText(key);
    if (typeof value === 'string') {
      checkText(value);
      const valid = key === 'notice' ? value === notice
        : key === 'backend' ? ['local', 'compose'].includes(value)
        : key === 'step' ? steps.has(value)
        : key === 'command' ? commands.has(value)
        : key === 'status' ? ['passed', 'failed'].includes(value)
        : ['gates', 'state'].includes(key) ? value === skippedGates
        : key === 'format' ? value === 'custom'
        : key === 'sha256' ? /^[a-f0-9]{64}$/.test(value)
        : key === 'error' ? /^[A-Z0-9_]{1,48}$/.test(value)
        : key === 'assertion' ? /^[a-z0-9_]{1,80}$/.test(value)
        : false;
      if (!valid) fail();
    } else if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value < 0) fail();
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
    } else if (value && typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) fail();
        visit(item, name);
      }
    } else if (typeof value !== 'boolean') fail();
  }
  visit(document);
}

export async function writeRecord(file, document) {
  const serialized = JSON.stringify(document, null, 2) + '\n';
  assertRedactedRecord(JSON.parse(serialized));
  await writeFile(file, serialized, { mode: 0o600 });
}
