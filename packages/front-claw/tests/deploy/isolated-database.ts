import type pg from 'pg';
import { setTimeout as delay } from 'node:timers/promises';

/** Call only after all test owners have closed their pools, including failed startup paths. */
export async function dropIdleDatabase(control: pg.Pool, database: string, timeoutMs = 5000): Promise<void> {
  if (!/^synthetic_[a-z0-9_]+$/.test(database)) throw Error('isolated_database_required');
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const { rows } = await control.query<{ count: string }>('SELECT count(*) AS count FROM pg_stat_activity WHERE datname=$1', [database]);
    if (Number(rows[0]?.count) === 0) break;
    if (performance.now() >= deadline) throw Error('database_connections_remain');
    await delay(25);
  }
  await control.query(`DROP DATABASE "${database}"`);
}
