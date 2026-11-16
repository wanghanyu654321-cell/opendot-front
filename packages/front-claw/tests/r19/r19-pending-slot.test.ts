import { expect, it } from 'vitest';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { evaluateConfirmableReportDraft } from '../../src/role-eval/confirmable-draft-gate.js';
import { advancePendingSlot } from '../../src/role-eval/pending-slot.js';
import { DRAFT_EXPIRED_REREPORT } from '../../src/role-eval/employee-loop.js';
import type { Draft } from '../../src/role-eval/performance-store.js';
import type { ConsumerWrites } from '../../src/role-eval/consumer-writes.js';

it('挂起位在异步读取前保留私有草稿快照，不接受读取器迟到修改身份和客户', async () => {
  const w = await worldM05();
  await w.call('m-zhao', '郗姨：1437（小赵）');
  const drafts = await w.base.listDrafts({ status: 'pending' });
  const original = structuredClone(drafts[0]!);
  const writes: ConsumerWrites = {
    createDraft: async () => { throw Error('不应建草稿'); },
    rewriteDraft: async () => { throw Error('应使用条件迁移'); },
    compareAndSetPendingAsk: async () => true, putOperationRecord: async () => { throw Error('没有追问'); },
    transitionPending: async (expected, next) => {
      expect(expected).toEqual(original);
      expect(next.reporterPersonId).toBe(original.reporterPersonId);
      return true;
    },
  };
  const admission = { gate: evaluateConfirmableReportDraft({ text: '逯姨：1873', today: '2026-11-12', employeeNames: new Set() }), next: 'draft' as const };
  const result = await advancePendingSlot({ drafts, admission, askKey: 'synthetic-slot', text: '逯霁：1873（小赵）',
    readAsk: async () => {
      drafts[0]!.reporterPersonId = 'changed-person';
      if (drafts[0]!.payload.type === 'report') drafts[0]!.payload.added[0]!.customer = '訾姨';
      return '';
    }, writes, now: () => new Date('2026-11-12T03:00:00Z'), active: () => true, expiredReply: DRAFT_EXPIRED_REREPORT });
  expect(result.blocked).toBe(false);
  expect(result.reminder).toBe('上一笔「郗姨 1437元」没有确认，已作废，需要的话请重新报。');
  expect(result.drafts[0]!.reporterPersonId).toBe(original.reporterPersonId);
});

it('挂起迁移向写入器传独立只读副本，修改入参和迟到修改不能改变私有结果', async () => {
  const w = await worldM05();
  await w.call('m-zhao', '郗姨：1437（小赵）');
  const drafts = await w.base.listDrafts({ status: 'pending' });
  let retained: Draft | undefined;
  const writes: ConsumerWrites = {
    createDraft: async () => { throw Error('不应建草稿'); },
    rewriteDraft: async () => { throw Error('应使用条件迁移'); },
    compareAndSetPendingAsk: async () => true, putOperationRecord: async () => { throw Error('没有追问'); },
    transitionPending: async (expected, next) => {
      expect(Object.isFrozen(expected)).toBe(true);
      expect(Object.isFrozen(next.payload)).toBe(true);
      expect(Reflect.set(expected, 'reporterPersonId', 'changed-person')).toBe(false);
      retained = next;
      return true;
    },
  };
  const admission = { gate: evaluateConfirmableReportDraft({ text: '逯姨：1873', today: '2026-11-12', employeeNames: new Set() }), next: 'draft' as const };
  const result = await advancePendingSlot({ drafts, admission, askKey: 'synthetic-slot', text: '逯姨：1873', readAsk: async () => '',
    writes, now: () => new Date('2026-11-12T03:00:00Z'), active: () => true, expiredReply: DRAFT_EXPIRED_REREPORT });
  expect(retained).toBeDefined();
  expect(retained).not.toBe(result.drafts[0]);
  expect(Reflect.set(retained!, 'status', 'confirmed')).toBe(false);
  expect(result.drafts[0]!.status).toBe('void');
  expect(result.drafts[0]!.reporterPersonId).toBe('p-zhao');
  expect(drafts[0]!.status).toBe('pending');
});
