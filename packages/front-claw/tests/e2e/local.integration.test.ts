import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const approved = process.env.AUDIT_PG_ALLOW === 'isolated-synthetic';
it.skipIf(!approved)('runs migrations, least privilege, confirmation, replay after process restart and verified restore through the standalone core', async () => {
  // Always creates its own cluster. An optional audit URL must identify a loopback synthetic database;
  // it is never used to connect to a pre-existing service.
  if (process.env.AUDIT_PG_URL) {
    const target = new URL(process.env.AUDIT_PG_URL);
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(target.hostname);
  }
  // Backup clients resolve independently: explicit PG_DUMP / PG_RESTORE, then PG_BIN, then PATH.
  const output = await mkdtemp(path.join(os.tmpdir(), 'front-dot-records-'));
  try {
    const result = await promisify(execFile)(process.execPath, ['scripts/e2e/run.mjs', '--backend', 'local', '--out', output], {
      env: { ...process.env, PG_BIN: process.env.PG_BIN ?? process.env.FRONT_CLAW_PG_BIN, PG_DUMP: process.env.PG_DUMP, PG_RESTORE: process.env.PG_RESTORE }, timeout: 180_000,
    });
    expect(result.stdout).toContain('e2e_passed');
    expect(result.stdout).toContain('未复跑（需授权语料）');
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}, 190_000);
