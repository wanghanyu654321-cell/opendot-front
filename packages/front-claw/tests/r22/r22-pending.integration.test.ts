/** 审查方运行：同一请求实际经过入口、循环与真实 PG；本轮仅编译，不连接数据库。 */
import { freshDatabase, openLatest, useCluster } from '../migration/pg-harness-m08.js';
import { pendingContract } from './pending-contract.js';
useCluster();
pendingContract('R22 PG', async () => openLatest(await freshDatabase()));
