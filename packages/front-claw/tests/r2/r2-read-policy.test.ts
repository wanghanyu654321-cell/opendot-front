// R2：事务外读策略（预检）时，改策略恰好落在“两次读之间” → 不得误判为“策略落后于高水位”而误拒（PG 竞态复跑时发现）。
import { expect, it } from 'vitest';
import { ACCESS_POLICY_HIGH_WATER_KEY, ACCESS_POLICY_KEY, decideAccess, readPolicy } from '../../src/role-eval/access-policy.js';
import { basePeople, policy } from '../role-eval/access-fixture-m03.js';

it('第一次读之后、第二次读之前策略从 v1 提到 v2（同一事务同时提升高水位）→ 读到的组合不过时，照常放行', async () => {
  const rows: Record<string, string> = { [ACCESS_POLICY_KEY]: JSON.stringify(policy(1)), [ACCESS_POLICY_HIGH_WATER_KEY]: '1' };
  let reads = 0;
  const store = { async getConfig(key: string) {
    const value = rows[key] ?? null;
    if (++reads === 1) { rows[ACCESS_POLICY_KEY] = JSON.stringify(policy(2)); rows[ACCESS_POLICY_HIGH_WATER_KEY] = '2'; }
    return value;
  } };
  const raw = await readPolicy(store);
  expect(decideAccess(raw, basePeople.find(p => p.personId === 'p-zhao')!, 'report_self', 's-b')).toMatchObject({ allowed: true });
});
