import { MemoryPerformanceStore } from '../../src/role-eval/performance-store.js';
import { pendingContract } from './pending-contract.js';
pendingContract('R22 内存', async () => ({ store: new MemoryPerformanceStore(), close: async () => {} }));
