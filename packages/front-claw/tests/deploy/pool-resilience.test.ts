import { afterEach, expect, it, vi } from 'vitest';
import { openRuntimeDatabase } from '../../src/standalone/database.js';
import { runAdmin } from '../../src/standalone/admin.js';

const { pools } = vi.hoisted(() => ({ pools: [] as {
  emit(event: string, error: Error): boolean;
  options: { max: number };
  end: ReturnType<typeof vi.fn>;
}[] }));
vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: { Pool: class extends EventEmitter {
    constructor(readonly options: { max: number }) { super(); pools.push(this); }
    query = vi.fn(async (sql: string) => ({ rows: sql.includes('to_regclass') ? [{ ledger: 'schema_migrations' }]
      : sql.includes('max(version)') ? [{ version: 11 }] : [] }));
    end = vi.fn(async () => {});
  } } };
});

afterEach(() => { vi.restoreAllMocks(); pools.length = 0; });

it.each(['core', 'admin'])('handles idle pool failures in the %s entry without exiting or exposing error details', async entry => {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw Error('unexpected_process_exit'); });
  const exitCode = process.exitCode;
  const secret = 'fake-password-marker postgresql://synthetic:fake-password@db.invalid/synthetic private-message-marker';
  const url = 'postgresql://synthetic:fake-password@db.invalid/synthetic';
  const runtime = entry === 'core' ? await openRuntimeDatabase(url) : undefined;
  if (entry === 'admin') await runAdmin('verify-consumer', { DATABASE_ADMIN_URL: url });
  try {
    const pool = pools[0]!;
    expect(pool.options.max).toBe(entry === 'core' ? 4 : 1);
    expect(() => pool.emit('error', Object.assign(Error(secret), { code: '57P01', detail: secret }))).not.toThrow();
    expect(() => pool.emit('error', Object.assign(Error(secret), { code: secret }))).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(exitCode);
    const lines = stderr.mock.calls.map(call => String(call[0]));
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.endsWith('\n')).toBe(true);
    expect(lines.map(line => JSON.parse(line))).toEqual([
      { level: 'warn', event: 'database_pool_error', errorCategory: 'database', errorCode: '57P01' },
      { level: 'warn', event: 'database_pool_error', errorCategory: 'runtime', errorCode: 'unclassified' },
    ]);
    expect(lines.join('')).not.toMatch(/fake-password|postgresql:\/\/|db\.invalid|private-message-marker/);
  } finally { await runtime?.close(); }
  expect(pools[0]!.end).toHaveBeenCalledOnce();
});
