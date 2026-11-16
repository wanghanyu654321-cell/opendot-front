import { expect, it, vi } from 'vitest';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createDatabasePool } from '../../src/standalone/database.js';
import { dropIdleDatabase } from './isolated-database.js';

const approved = process.env.AUDIT_PG_ALLOW === 'isolated-synthetic' && !!process.env.AUDIT_PG_URL;
it.skipIf(!approved).each([['core', 4], ['admin', 1]] as const)('recovers the %s pool after an idle backend is terminated with a sanitized diagnostic', async (_entry, max) => {
  const target = new URL(process.env.AUDIT_PG_URL!);
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(target.hostname);
  expect(['postgres:', 'postgresql:']).toContain(target.protocol);
  const database = 'synthetic_pool_' + randomUUID().replaceAll('-', '');
  const control = createDatabasePool(target.href, 1);
  let pool: pg.Pool | undefined;
  let created = false;
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw Error('unexpected_process_exit'); });
  const exitCode = process.exitCode;
  try {
    await control.query(`CREATE DATABASE "${database}"`); created = true;
    target.pathname = '/' + database;
    pool = createDatabasePool(target.href, max);
    const first = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = first.rows[0]!.pid;
    expect(pool.idleCount).toBe(1);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onError: ((error: Error) => void) | undefined;
    const failed = new Promise<Error | undefined>(resolve => {
      onError = resolve;
      pool!.once('error', onError);
      timeout = setTimeout(() => resolve(undefined), 5000);
    });
    try {
      const terminated = await control.query('SELECT pg_terminate_backend($1) AS terminated', [pid]);
      expect(terminated.rows[0].terminated).toBe(true);
      expect(await failed).toMatchObject({ code: '57P01' });
    } finally {
      clearTimeout(timeout);
      if (onError) pool.off('error', onError);
    }
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(exitCode);
    const lines = stderr.mock.calls.map(call => String(call[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0]!)).toEqual({ level: 'warn', event: 'database_pool_error', errorCategory: 'database', errorCode: '57P01' });
    expect(lines[0]).not.toContain(target.href);
    const next = await pool.query<{ pid: number; value: number }>('SELECT pg_backend_pid() AS pid, 1::integer AS value');
    expect(next.rows[0]!.value).toBe(1);
    expect(next.rows[0]!.pid).not.toBe(pid);
  } finally {
    try { await pool?.end(); }
    finally {
      try { if (created) await dropIdleDatabase(control, database); }
      finally {
        try { await control.end(); }
        finally { stderr.mockRestore(); exit.mockRestore(); }
      }
    }
  }
}, 30_000);
