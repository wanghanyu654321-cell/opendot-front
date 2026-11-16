import { expect, it, vi } from 'vitest';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { advancePendingSlot, type PendingReportAdmission } from '../../src/role-eval/pending-slot.js';
import { evaluateConfirmableReportDraft } from '../../src/role-eval/confirmable-draft-gate.js';
import { DRAFT_EXPIRED_REREPORT } from '../../src/role-eval/employee-loop.js';

it('R20：读取器修改准入入参及迟到修改，不能把拒绝结论换成替换权限', async () => {
  const w = await worldM05();
  await w.call('m-zhao', '訾姨：3917（小赵）');
  const drafts = await w.base.listDrafts({ status: 'pending' });
  const denied = evaluateConfirmableReportDraft({ text: '整单：2869', today: '2026-11-12', employeeNames: new Set() });
  expect(denied.ok).toBe(false);
  const admission: PendingReportAdmission = { gate: denied, next: 'draft' };
  const write = vi.fn(async () => {});
  const result = await advancePendingSlot({ drafts, admission, askKey: 'r20-admission', text: '整单：2869',
    readAsk: async () => {
      admission.gate = evaluateConfirmableReportDraft({ text: '逯姨：2869', today: '2026-11-12', employeeNames: new Set() });
      return '';
    }, writes: { transitionPending: async () => { await write(); return true; }, createDraft: write, rewriteDraft: write, compareAndSetPendingAsk: async () => true, putOperationRecord: write },
    now: () => new Date('2026-11-12T03:00:00Z'), active: () => true, expiredReply: DRAFT_EXPIRED_REREPORT });
  admission.next = 'new-customer-ask';
  expect(write).not.toHaveBeenCalled();
  expect(result.reminder).toBe('');
  expect(result.drafts).toEqual(drafts);
});
