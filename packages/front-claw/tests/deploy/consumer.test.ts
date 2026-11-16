import { expect, it, vi } from 'vitest';
import { runAdmin } from '../../src/standalone/admin.js';
import type { SqlClient } from '../../src/role-eval/performance-postgres.js';

it.each([
  ['active', { owner: 'consumer', token: 'token', until: Date.now() + 60_000, epoch: 1 }, false],
  ['recently expired', { owner: 'consumer', token: 'token', until: Date.now() - 1000, epoch: 1 }, false],
  ['expired beyond grace', { owner: 'consumer', token: 'token', until: Date.now() - 60_000, epoch: 1 }, true],
  ['released', { owner: null, token: null, until: 0, epoch: 1 }, true],
  ['corrupt', { owner: 'consumer' }, false],
])('verifies consumer absence with a grace period for %s leases', async (_label, lease, absent) => {
  const client = { query: vi.fn(async () => ({ rows: [{ value: JSON.stringify(lease) }] })) } as unknown as SqlClient;
  const close = vi.fn(async () => {});
  const result = runAdmin('verify-consumer', { DATABASE_ADMIN_URL: 'postgresql://pg/synthetic' }, { open: async () => ({ client, close }), migrate: vi.fn() });
  if (absent) await expect(result).resolves.toEqual({ consumerAbsent: true });
  else await expect(result).rejects.toThrow('consumer_lease_not_released');
  expect(close).toHaveBeenCalledOnce();
  expect(client.query).toHaveBeenCalledOnce();
});
