import { MemoryPerformanceStore } from '../../src/role-eval/performance-store.js';
import { pendingContract } from './pending-contract.js';
pendingContract('R23 内存', async () => ({ store: new MemoryPerformanceStore(), close: async () => {} }));
