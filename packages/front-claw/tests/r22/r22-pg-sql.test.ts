/** SQL 替身用于离线验证 PG 语句条件；不代表真实 PG 事务/锁通过。 */
import { createPostgresPerformanceStore, migratePerformance } from '../../src/role-eval/performance-postgres.js';
import { applyMemoryR5, MemorySql } from '../role-eval/sql-fixture.js';
import { pendingContract } from './pending-contract.js';
pendingContract('R22 PG SQL 替身', async () => {
  const sql = new MemorySql(); await migratePerformance(sql); await applyMemoryR5(sql);
  return { store: createPostgresPerformanceStore(sql), close: async () => {} };
});
