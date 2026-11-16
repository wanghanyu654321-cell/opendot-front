import { afterEach, describe, expect, it } from 'vitest';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { seedHistoricalCustomers } from '../r13/historical-seed.js';
import { evaluateConfirmableReportDraft, textLevelImpurity } from '../../src/role-eval/confirmable-draft-gate.js';
import { NOT_A_CUSTOMER_NAME_ASK, setCustomerNamePolicyModeForTest } from '../../src/role-eval/customer-name-policy.js';

const DAY = '2026-11-12';
const base = { today: DAY, employeeNames: new Set(['小赵']), knownCustomerNames: new Set(['邴岚']) };
afterEach(() => setCustomerNamePolicyModeForTest(null));

describe('R18b 第三轮：未知客户位的姓名结构', () => {
  for (const prefix of ['递阅', '咦呀', '哈呀', '噢']) {
    for (const employee of ['', '（小赵）']) it(`表外前导加未知姓名只作通用追问 ${prefix}/${employee}`, async () => {
      const customer = `${prefix}昝砚`;
      const text = `${customer}：1879.43${employee}`;
      for (const mode of ['A', 'B', 'C'] as const) {
        setCustomerNamePolicyModeForTest(mode);
        expect(evaluateConfirmableReportDraft({ ...base, text }))
          .toEqual({ ok: false, reason: `customer:${customer}` });
        // 即便调用方传入肯定过的名字，也不能绕过客户位结构。
        expect(evaluateConfirmableReportDraft({ ...base, text, confirmedNewNames: [customer] }).ok).toBe(false);
      }
      setCustomerNamePolicyModeForTest('C');
      const w = await worldM05();
      const before = (await w.base.listEntries()).length;
      expect(await w.call('m-zhao', text)).toBe(NOT_A_CUSTOMER_NAME_ASK);
      for (const followup of ['是', '对']) {
        expect(await w.call('m-zhao', followup)).not.toMatch(/是新客户|还没入账|已入账/);
      }
      expect(await w.base.listDrafts()).toHaveLength(0);
      expect(await w.base.listEntries()).toHaveLength(before);
    });
  }

  for (const customer of ['昝砚', '宓知棠', '皇甫霁', '万俟映岚', '哈凝', '哈知棠', '小岫']) {
    for (const employee of ['', '（小赵）']) it(`合法二三四字姓名和昵称仍只问新客户 ${customer}/${employee}`, async () => {
      setCustomerNamePolicyModeForTest('C');
      const text = `${customer}：1879.43${employee}`;
      expect(evaluateConfirmableReportDraft({ ...base, text }))
        .toEqual({ ok: false, reason: 'new-customer', newCustomerNames: [customer] });
      const w = await worldM05();
      expect(await w.call('m-zhao', text)).toBe(`Front Claw：是新客户「${customer}」吗？`);
      expect(await w.base.listDrafts()).toHaveLength(0);
      expect(await w.call('m-zhao', '是')).toContain(`客户：${customer}`);
      expect(await w.base.listDrafts({ status: 'pending' })).toHaveLength(1);
    });
  }

  for (const customer of ['昝知砚安', '小岫']) {
    for (const employee of ['', '（小赵）']) it(`本店已知名字保留原名单通道 ${customer}/${employee}`, async () => {
      setCustomerNamePolicyModeForTest('C');
      const w = await worldM05();
      const owner = (await w.base.listPeople()).find(p => p.memberId === 'm-zhao')!;
      await seedHistoricalCustomers(w.base, { storeId: 's-b', owner, names: [customer], amountCents: 217963 });
      expect(await w.call('m-zhao', `${customer}：1879.43${employee}`)).toContain(`客户：${customer}`);
      expect(await w.base.listDrafts({ status: 'pending' })).toHaveLength(1);
    });
  }
  for (const customer of ['昝婶', '万俟婶']) {
    for (const employee of ['', '（小赵）']) it(`姓加称谓保留快通道 ${customer}/${employee}`, async () => {
      const w = await worldM05();
      expect(await w.call('m-zhao', `${customer}：1879.43${employee}`)).toContain(`客户：${customer}`);
    });
  }
});

describe('R18b 第三轮：D152 原文前缀检查必须独立生效', () => {
  for (const prefix of ['开单', '早']) {
    for (const employee of ['', '（小赵）']) it(`固定前缀紧贴未知名字整条先问 ${prefix}/${employee}`, async () => {
      const text = `${prefix}昝砚：1879.43${employee}`;
      expect(textLevelImpurity(text, DAY)).toBe('invalid-format');
      expect(evaluateConfirmableReportDraft({ ...base, text })).toEqual({ ok: false, reason: 'invalid-format' });
      const w = await worldM05();
      const before = (await w.base.listEntries()).length;
      expect(await w.call('m-zhao', text)).not.toMatch(/是新客户|还没入账|回复「对」/);
      expect(await w.base.listDrafts()).toHaveLength(0);
      expect(await w.base.listEntries()).toHaveLength(before);
    });
    for (const employee of ['', '（小赵）']) it(`原文紧贴前缀不被调用方干净条目掩盖 ${prefix}/${employee}`, () => {
      // 关闭 hasUnstrippedReportPrefix 后，此调用会误入 new-customer；不靠后续姓名结构兜底。
      expect(evaluateConfirmableReportDraft({ ...base, text: `${prefix}昝砚：1879.43${employee}`, entries: [{
        customer: '昝砚', employeeName: employee ? '小赵' : '', self: !employee,
      }] })).toEqual({ ok: false, reason: 'invalid-format' });
    });
    for (const employee of ['', '（小赵）']) it(`固定前缀有分隔时先剥再问新客户 ${prefix}/${employee}`, () => {
      setCustomerNamePolicyModeForTest('C');
      expect(evaluateConfirmableReportDraft({ ...base, text: `${prefix}：昝砚：1879.43${employee}` }))
        .toEqual({ ok: false, reason: 'new-customer', newCustomerNames: ['昝砚'] });
    });
  }
});
