import { expect, it, vi } from 'vitest';
import type pg from 'pg';
import { dropIdleDatabase } from './isolated-database.js';

it('waits until every backend has disconnected before dropping an isolated database', async () => {
  const query = vi.fn().mockResolvedValueOnce({ rows: [{ count: '2' }] })
    .mockResolvedValueOnce({ rows: [{ count: '1' }] }).mockResolvedValueOnce({ rows: [{ count: '0' }] })
    .mockResolvedValueOnce({ rows: [] });
  await dropIdleDatabase({ query } as unknown as pg.Pool, 'synthetic_cleanup');
  expect(query.mock.calls.slice(0, 3)).toEqual(Array.from({ length: 3 }, () => [
    'SELECT count(*) AS count FROM pg_stat_activity WHERE datname=$1', ['synthetic_cleanup'],
  ]));
  expect(query.mock.calls[3]).toEqual(['DROP DATABASE "synthetic_cleanup"']);
});

it('times out without dropping the database when a backend remains connected', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ count: '1' }] });
  await expect(dropIdleDatabase({ query } as unknown as pg.Pool, 'synthetic_cleanup', 0)).rejects.toThrow('database_connections_remain');
  expect(query).toHaveBeenCalledOnce();
  expect(query.mock.calls[0]![0]).not.toContain('DROP');
});
