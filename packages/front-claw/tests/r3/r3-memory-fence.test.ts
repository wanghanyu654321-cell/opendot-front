// R3（A-P1-1）：内存 store 的统一写入口与 PG 同一判定——租约 owner/epoch 不符或已过期 → 抛 FencedWriteRejected，什么都不写。
// （其余 R3 用例跑在「PG 形状 store + MemorySql」上；这条直接覆盖 MemoryPerformanceStore，变异 R3-M2 由它抓。）
import { expect, it } from 'vitest';
import { FencedWriteRejected, MemoryPerformanceStore, type Draft } from '../../src/role-eval/performance-store.js';

const KEY = 'front-claw-opendot-consumer';
const T0 = Date.parse('2026-11-12T03:00:00Z');
const draft = (status: Draft['status']): Draft => ({
  draftId: 'd-1', reporterPersonId: 'p-1', storeId: 's-b', businessDay: '2026-11-12', expiresAt: '2026-11-12T14:00:00Z', kind: 'report',
  payload: { type: 'report', added: [], missing: [], skipped: 0 } as unknown as Draft['payload'],
  status, reminder: 'none', voidNotice: 'none', createdAt: '2026-11-12T03:00:00Z', closedAt: null,
} as Draft);

it('R3-S3：内存 store——旧持有者 A（epoch 1）在 B（epoch 2）接管后：新建/覆盖草稿、改 pending、写操作记录都被拒，零写入；B 照常写', async () => {
  const store = new MemoryPerformanceStore();
  await store.setConfig(KEY, JSON.stringify({ owner: 'B', token: 'tb', until: T0 + 60_000, epoch: 2 }));
  const a = { key: KEY, owner: 'A', epoch: 1, nowMs: () => T0 };
  const b = { key: KEY, owner: 'B', epoch: 2, nowMs: () => T0 };
  await expect(store.saveDraft(draft('pending'), { ifAbsent: true, fence: a })).rejects.toBeInstanceOf(FencedWriteRejected);
  expect(await store.listDrafts({})).toEqual([]);
  await store.saveDraft(draft('pending'), { ifAbsent: true, fence: b });
  const saved = (await store.getDraft('d-1'))!;
  await expect(store.saveDraft({ ...saved, status: 'void' }, { ifAbsent: false, fence: a })).rejects.toBeInstanceOf(FencedWriteRejected);
  await expect(store.transitionPendingDraft(saved, { ...saved, status: 'void', closedAt: '2026-11-12T03:01:00Z' }, a)).rejects.toBeInstanceOf(FencedWriteRejected);
  expect((await store.getDraft('d-1'))!.status).toBe('pending');
  await expect(store.setConfig('front-claw-op:x', '{}', a)).rejects.toBeInstanceOf(FencedWriteRejected);
  expect(await store.getConfig('front-claw-op:x')).toBeNull();
  // 租约过期：连 B 也写不进
  const late = { ...b, nowMs: () => T0 + 120_000 };
  await expect(store.transitionPendingDraft(saved, { ...saved, status: 'void', closedAt: '2026-11-12T03:01:00Z' }, late)).rejects.toBeInstanceOf(FencedWriteRejected);
  expect(await store.transitionPendingDraft(saved, { ...saved, status: 'void', closedAt: '2026-11-12T03:01:00Z' }, b)).toBe(true);
});
