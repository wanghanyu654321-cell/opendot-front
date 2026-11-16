import type { OpenedPerformanceStore } from '../role-eval/performance-open.js';
import type { Person } from '../role-eval/performance-store.js';
import { seedIdentity } from './seed.js';
import { CAPABILITIES } from '../role-eval/access-policy.js';

/** Called only by the disposable database initializer, never by the service. */
export async function seedSynthetic(db: Pick<OpenedPerformanceStore, 'store' | 'bindings'>) {
  const person: Person = { personId: 'synthetic-person', accountId: 'synthetic-account', memberId: 'synthetic-member', displayName: '小赵',
    storeId: 'synthetic-store', storeName: '测试店', tier: 'employee', roles: [], active: true };
  await seedIdentity(db, { person, binding: { botId: 'synthetic-bot', corpId: 'synthetic-corp', memberId: person.memberId, accountId: person.accountId, version: 1, active: true },
    actor: 'synthetic-admin', at: '2026-11-12T02:00:00Z' }, { enterprise: [...CAPABILITIES], roles: { employee: ['report_self', 'progress_self'], manager: [], owner: [] } });
}
