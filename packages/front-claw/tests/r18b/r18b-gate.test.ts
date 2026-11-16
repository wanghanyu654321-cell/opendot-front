import { describe, expect, it, vi } from 'vitest';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { seedHistoricalCustomers } from '../r13/historical-seed.js';
import { collectKnownCustomerNames } from '../../src/role-eval/store-customer-roster.js';
import { evaluateConfirmableReportDraft, isCleanCustomerMorphology, textLevelImpurity } from '../../src/role-eval/confirmable-draft-gate.js';
import * as amountGuard from '../../src/role-eval/amount-guard.js';
import { tryStandardReport } from '../../src/role-eval/standard-line.js';
import { ALREADY_CONFIRMED_TEXT } from '../../src/role-eval/employee-loop.js';

const DAY = '2026-11-12';
const mark = 'employee-loop:d160-last-confirm:p-zhao:session-m-zhao';
type World = Awaited<ReturnType<typeof worldM05>>;
async function known(w: World, names = ['郗茵', '逯澄']) {
  const owner = (await w.base.listPeople()).find(p => p.memberId === 'm-zhao')!;
  await seedHistoricalCustomers(w.base, { storeId: 's-b', owner, names, amountCents: 19317 });
}
async function noDraft(w: World, text: string) {
  const before = (await w.base.listEntries()).length;
  const reply = await w.call('m-zhao', text);
  expect(reply).not.toMatch(/还没入账|回复「对」/);
  expect(await w.base.listDrafts({ status: 'pending' })).toHaveLength(0);
  expect(await w.base.listEntries()).toHaveLength(before);
  return reply;
}

describe('R18b 1/5：D165 客户三档与 D163 括号、空白', () => {
  for (const name of ['整单', '整单姐', '储值卡', '那个郗姨', '郗', '本周目标', '郗 茵', '郗【茵】', '郗[茵]', '郗😊茵']) {
    for (const employee of ['', '（小赵）']) it(`拒收客户位 ${name} / ${employee}`, async () => {
      const w = await worldM05();
      const reply = await noDraft(w, `${name}：937${employee}`);
      expect(reply).not.toContain('是新客户');
    });
  }
  it('括号未知名字只点名问；回是再过闸，确认入账后才进名单', async () => {
    const w = await worldM05();
    expect(await noDraft(w, '郗茵：937（赵赵）')).toBe('Front Claw：是新客户「郗茵」吗？');
    expect(await w.call('m-zhao', '是')).toContain('还没入账');
    expect((await collectKnownCustomerNames(w.base, 's-b')).has('郗茵')).toBe(false);
    expect(await w.call('m-zhao', '对')).toContain('已入账');
    expect((await collectKnownCustomerNames(w.base, 's-b')).has('郗茵')).toBe(true);
  });
  for (const employee of ['', '（小赵）']) it(`本店已确认历史客户出草稿 ${employee}`, async () => {
    const w = await worldM05(); await known(w);
    expect(await w.call('m-zhao', `郗茵：937${employee}`)).toContain('客户：郗茵');
    expect(await w.base.listDrafts({ status: 'pending' })).toHaveLength(1);
  });
  for (const employee of ['', '（小赵）']) it(`姓加称谓保持正向 ${employee}`, async () => {
    const w = await worldM05();
    expect(await w.call('m-zhao', `郗姨：937${employee}`)).toContain('还没入账');
  });
  it('闸本身拒收带空白客户位，不可靠移除空白取得正向名字', () => {
    expect(evaluateConfirmableReportDraft({ text: '郗 茵：937', today: DAY, employeeNames: new Set(), entries: [{ customer: '郗 茵', self: true }] }).ok).toBe(false);
  });
});

describe('R18b 2：短距离否定补报结构，不扩固定表', () => {
  for (const neg of ['不', '没', '别', '非', '不是', '不算', '不用', '无需']) {
    for (const tail of ['补报', '补记', '补单', '补录', '补上', '补登', '昨天']) it(`${neg}＋短距＋${tail}`, async () => {
      const text = `郗姨：937（小赵），${neg}按遗漏的${tail}`;
      expect(textLevelImpurity(text, DAY)).toBe('unseen-makeup');
      await noDraft(await worldM05(), text);
    });
  }
  for (const tail of ['不错', '不用找', '补水']) it(`良性行尾 ${tail}`, async () => {
    const w = await worldM05();
    const text = `郗姨：937（小赵） ${tail}`;
    expect(textLevelImpurity(text, DAY)).toBeNull();
    expect(await w.call('m-zhao', text)).toContain('还没入账');
  });
});

describe('R18b 3：D161 分号逐段、整条原子草稿', () => {
  for (const separator of ['；', ';']) it(`完整标准清单保留段序 ${separator}`, async () => {
    const w = await worldM05(); await known(w);
    const before = (await w.base.listEntries()).length;
    expect(await w.call('m-zhao', `郗茵：937（小赵）${separator}逯澄：1203.47（小赵）`)).toContain('还没入账');
    const draft = (await w.base.listDrafts({ status: 'pending' }))[0]!;
    expect(await w.call('m-zhao', '全部确认')).toContain('已入账');
    const rows = (await w.base.listEntries()).filter(e => e.sourceDraftId === draft.draftId).sort((a,b) => a.sourceOrdinal! - b.sourceOrdinal!);
    expect(rows.map(e => [e.sourceOrdinal, e.customerName, e.amount])).toEqual([[0, '郗茵', 93700], [1, '逯澄', 120347]]);
    expect(await w.base.listEntries()).toHaveLength(before + 2);
  });
  for (const bad of ['整单：1203（小赵）', '逯澄：12.37（小赵）', '逯澄：1203（夜班）', '再查一下进度', '郗【茵】：1203（小赵）', '逯澄：1203（小赵）没做']) it(`任一段不过，零半张清单 ${bad}`, async () => {
    const w = await worldM05(); await known(w);
    await noDraft(w, `郗茵：937（小赵）；${bad}`);
  });
  it('未知客户段先问，全清单回是后才出草稿', async () => {
    const w = await worldM05();
    const reply = await noDraft(w, '郗姨：937（小赵）；逯澄：1203（小赵）');
    expect(reply).toBe('Front Claw：是新客户「逯澄」吗？');
    expect(await w.call('m-zhao', '是')).toContain('还没入账');
    const draft = (await w.base.listDrafts({ status: 'pending' }))[0]!;
    expect(draft.payload.type === 'report' && draft.payload.added.map(e => e.customer)).toEqual(['郗姨', '逯澄']);
  });
  for (const employee of ['小林', '郜祺']) it(`跨店或查无此人员工仍拒绝 ${employee}`, async () => {
    const w = await worldM05();
    const reply = await noDraft(w, `郗姨：937（小赵）；逯姨：1203（${employee}）`);
    expect(reply).toMatch(/不能|不允许|不在|无权/);
  });
});

describe('R18b 4：D162 标记窗口与新草稿优先', () => {
  it('标记残留时仍确认新草稿，确认路径不读取标记', async () => {
    const w = await worldM05();
    await w.call('m-zhao', '郗姨：937（小赵）');
    const old = (await w.base.listDrafts({ status: 'pending' }))[0]!;
    expect(await w.call('m-zhao', '对')).toContain('已入账');
    expect(await w.call('m-zhao', '对')).toBe(ALREADY_CONFIRMED_TEXT);
    expect(await w.call('m-zhao', '逯姨：1203（小赵）')).toContain('还没入账');
    await w.base.setConfig(mark, old.draftId);
    const read = vi.spyOn(w.store, 'getConfig');
    expect(await w.call('m-zhao', '对')).toContain('已入账');
    expect(read.mock.calls.filter(([key]) => key === mark)).toHaveLength(0);
    expect((await w.base.listEntries()).filter(e => e.customerName === '逯姨')).toHaveLength(1);
  });
  it('原草稿 expiresAt 到期后按没有待确认草稿处理，清标记且不再重复确认', async () => {
    let at = Date.parse('2026-11-12T02:00:00Z');
    const w = await worldM05({ now: () => new Date(at) });
    await w.call('m-zhao', '郗姨：937（小赵）');
    const draft = (await w.base.listDrafts({ status: 'pending' }))[0]!;
    expect(await w.call('m-zhao', '对')).toContain('已入账');
    at = Date.parse(draft.expiresAt) - 1;
    expect(await w.call('m-zhao', '对')).toBe(ALREADY_CONFIRMED_TEXT);
    const before = (await w.base.listEntries()).length;
    at++;
    expect(await w.call('m-zhao', '对')).not.toBe(ALREADY_CONFIRMED_TEXT);
    expect(await w.base.getConfig(mark)).toBe('');
    expect(await w.base.listEntries()).toHaveLength(before);
  });
});

describe('R18b 6/7：D164/D165 前缀与抬头', () => {
  for (const label of ['报数', '报个数', '今日报数', '今天报数']) {
    for (const sep of ['：', '，', ' ', '\n']) it(`固定标签和分隔 ${label}/${JSON.stringify(sep)}`, async () => {
      const w = await worldM05(); await known(w);
      expect(await w.call('m-zhao', `${label}${sep}郗茵：937（小赵）`)).toContain('客户：郗茵');
      expect(await w.base.listDrafts({ status: 'pending' })).toHaveLength(1);
    });
    it(`括号标签 ${label}`, async () => {
      const w = await worldM05();
      expect(await w.call('m-zhao', `【${label}】郗姨：937（小赵）`)).toContain('客户：郗姨');
    });
  }
  for (const head of ['【2026-11-12】', '【11月12日】', '【测试B店】']) it(`同行抬头 ${head}`, async () => {
    const w = await worldM05();
    expect(await w.call('m-zhao', `${head}郗姨：937（小赵）`)).toContain('客户：郗姨');
    expect(await w.base.listDrafts({ status: 'pending' })).toHaveLength(1);
  });
  for (const prefix of ['报数', '报个数', '今日报数', '今天报数', '报单', '早', '报个账', '报但', '累死了', '哈喽']) {
    for (const emp of ['', '（小赵）']) it(`紧贴前缀不猜 ${prefix}/${emp}`, async () => {
      const w = await worldM05(); await known(w);
      const reply = await noDraft(w, `${prefix}郗茵：937${emp}`);
      expect(reply).not.toContain('是新客户');
    });
  }
  for (const prefix of ['报个账，', '报但：', '累死了，', '哈喽 ', '【心情很好】', '【郗姨】']) {
    for (const emp of ['', '（小赵）']) it(`表外或装饰括号先问 ${prefix}/${emp}`, async () => {
      const w = await worldM05();
      await noDraft(w, `${prefix}郗姨：937${emp}`);
    });
  }
  it('跨店抬头仍拒绝', async () => {
    const w = await worldM05();
    expect(await noDraft(w, '【测试A店】郗姨：937（小赵）')).toMatch(/不能|不允许|不在|无权/);
  });
});

describe('R18b 8：D166 表情只剥独立行尾', () => {
  for (const emoji of ['😊', '👍🏽', '❤️', '👨‍👩‍👧‍👦']) {
    for (const emp of ['', '（小赵）']) it(`独立行尾 ${emoji}/${emp}`, async () => {
      const w = await worldM05();
      expect(await w.call('m-zhao', `郗姨：937${emp} ${emoji}`)).toContain('客户：郗姨');
      expect(await w.base.listDrafts({ status: 'pending' })).toHaveLength(1);
    });
  }
  for (const text of ['郗😊姨：937（小赵）', '郗姨：9😊37（小赵）', '郗姨：937😊元（小赵）']) it(`中间表情先问 ${text}`, async () => {
    await noDraft(await worldM05(), text);
  });
});


describe('R18b 组合与拒绝边界补充', () => {
  it('D165：作废账和外店账都不能让括号客户跳过新客追问', async () => {
    for (const kind of ['voided', 'other-store']) {
      const w = await worldM05();
      const owner = (await w.base.listPeople()).find(p => p.memberId === (kind === 'other-store' ? 'm-lin' : 'm-zhao'))!;
      const [entry] = await seedHistoricalCustomers(w.base, { storeId: owner.storeId, owner, names: ['郗茵'], amountCents: 19317 });
      if (kind === 'voided') await w.base.reviseEntry(entry!.entryId, { status: 'voided' }, { editorPersonId: owner.personId, revisionId: 'r18b-void', reason: '合成作废测试', createdAt: '2026-11-12T01:00:00Z' });
      expect(await noDraft(w, '郗茵：937（小赵）')).toBe('Front Claw：是新客户「郗茵」吗？');
    }
  });
  it('D161/D159：分号段员工姓加店长唯一匹配仍能入账', async () => {
    const w = await worldM05();
    expect(await w.call('m-zhao', '郗姨：937（苏店长）；逯姨：1203（小赵）')).toContain('还没入账');
    expect(await w.call('m-zhao', '对')).toContain('已入账');
    const rows = (await w.base.listEntries()).filter(e => ['郗姨', '逯姨'].includes(e.customerName ?? ''));
    expect(rows.map(e => [e.sourceOrdinal, e.ownerPersonId])).toEqual([[0, 'p-wang-yj'], [1, 'p-zhao']]);
  });
  it('D161：第一段小额小数也不因第二段合法而过金额关', async () => {
    await noDraft(await worldM05(), '郗姨：19.73（小赵）；逯姨：1203（小赵）');
  });
  it('D164/D165：抬头后的固定前缀仍先剥再判客户', async () => {
    const w = await worldM05({ now: () => new Date('2028-04-17T02:00:00Z') });
    expect(await w.call('m-zhao', '【2028年4月17日 测试B店】报数：郜婶：1483（小赵）')).toContain('客户：郜婶');
  });
  it('D166：表情后还有正文时不能把表情当行尾客套', async () => {
    await noDraft(await worldM05(), '郗姨：937（小赵） 😊 微信');
  });
  for (const head of ['大家好！', '晚上好～']) it(`D165：表外分隔不扩充 ${head}`, async () => {
    await noDraft(await worldM05(), `${head}郗姨：937（小赵）`);
  });
});


it('D164：月日抬头按请求营业日校验闰年', async () => {
  const w = await worldM05({ now: () => new Date('2028-02-29T02:00:00Z') });
  expect(await w.call('m-zhao', '【2月29日】郗姨：937（小赵）')).toContain('客户：郗姨');
});

it('D161/D164：任一分号段声明异店抬头仍按跨店拒绝', async () => {
  const w = await worldM05();
  const reply = await noDraft(w, '【测试B店】郗姨：937（小赵）；【霁岚店】逯姨：1203（小赵）');
  expect(reply).toMatch(/不能|不允许|不在|无权/);
});


it('D158/D165：整段由固定寒暄组成且有合法分隔时保留快通道', async () => {
  const w = await worldM05();
  expect(await w.call('m-zhao', '老板好店长好，郗姨：937（小赵）')).toContain('客户：郗姨');
});

describe('R18b 第二轮：单闸的有效拒收点', () => {
  for (const customer of ['郜　岑', '郜【岑】', '郜[岑]', ' 郜岑', '郜岑 ']) {
    for (const employee of ['', '（小赵）']) it(`D163 在名单归一之前拒收 ${JSON.stringify(customer)}/${employee}`, () => {
      const verdict = evaluateConfirmableReportDraft({
        text: `${customer}：1483${employee}`, today: DAY,
        employeeNames: new Set(['小赵']), knownCustomerNames: new Set(['郜岑']),
        entries: [{ customer, employeeName: employee ? '小赵' : '', self: !employee }],
      });
      expect(verdict).toEqual({ ok: false, reason: `customer:${customer}` });
      expect(isCleanCustomerMorphology(customer)).toBe(false);
    });
  }

  it('D161 分段金额先收口：外形标准但小额裸小数必须整条先问', async () => {
    const first = '郜婶：1483（小赵）';
    const second = '缑姨：27.61（小赵）';
    // 结构读取不替金额作决定；D122 由下方 standard-line amount-guard 独立收口。
    for (const part of [first, second]) expect(tryStandardReport(part, DAY, { amountContext: 'free' }).status).toBe('complete');
    expect(amountGuard.guardUtteranceAmounts(first, 'standard-line').ok).toBe(true);
    expect(amountGuard.guardUtteranceAmounts(second, 'standard-line')).toMatchObject({ ok: false, issue: 'ask_wan' });
    const text = `${first}；${second}`;
    const verdict = evaluateConfirmableReportDraft({ text, today: DAY, employeeNames: new Set(['小赵']) });
    expect(verdict.ok).toBe(false);
    expect(verdict).toEqual({ ok: false, reason: 'segment-amount' });
    await noDraft(await worldM05(), text);
  });

  for (const bad of ['缑　姨：1867（小赵）', '郜岑：1867（小赵）', '递呈缑姨：1867（小赵）']) {
    it(`D161 在单闸逐段执行 D163、三档、前缀判定 ${bad}`, async () => {
      const first = '郜婶：1483（小赵）';
      const text = `${first}；${bad}`;
      // 不替换金额校验结果：观察本次单闸调用里的逐段执行。
      const checked = vi.spyOn(amountGuard, 'guardUtteranceAmounts');
      try {
        expect(evaluateConfirmableReportDraft({ text, today: DAY, employeeNames: new Set(['小赵']) }).ok).toBe(false);
        expect(checked.mock.calls.map(([raw, context]) => [raw, context]))
          .toEqual([[first, 'standard-line'], [bad, 'standard-line']]);
      } finally { checked.mockRestore(); }
      await noDraft(await worldM05(), text);
    });
  }

  for (const customer of ['缑　姨', '郜岑', '递呈缑姨']) it(`D161 逐段从原文复核客户位，调用方干净条目不能替换 ${customer}`, () => {
    const verdict = evaluateConfirmableReportDraft({
      text: `郜婶：1483（小赵）；${customer}：1867（小赵）`, today: DAY, employeeNames: new Set(['小赵']),
      entries: [{ customer: '郜婶', employeeName: '小赵' }, { customer: '缑姨', employeeName: '小赵' }],
    });
    expect(verdict).toEqual(customer === '郜岑'
      ? { ok: false, reason: 'new-customer', newCustomerNames: ['郜岑'] }
      : { ok: false, reason: `customer:${customer.normalize('NFKC')}` });
  });

  it('D161 调用方条目不能清掉分段原文里的第二个请求', () => {
    const verdict = evaluateConfirmableReportDraft({
      text: '郜婶：1483（小赵）；缑姨：1867（小赵），再查我本月进度', today: DAY, employeeNames: new Set(['小赵']),
      entries: [{ customer: '郜婶', employeeName: '小赵' }, { customer: '缑姨', employeeName: '小赵', compound: null }],
    });
    expect(verdict.ok).toBe(false);
  });

  it('D161 单闸实际校验全部分段，全过才按段序生成 source_ordinal', async () => {
    const parts = ['郜婶：1483（小赵）', '缑姨：1867.43（小赵）'];
    const text = parts.join(';');
    const std = tryStandardReport(text, DAY);
    expect(std.status).toBe('complete');
    const checked = vi.spyOn(amountGuard, 'guardUtteranceAmounts');
    try {
      const w = await worldM05();
      expect(await w.call('m-zhao', text)).toContain('还没入账');
      // 这次宿主请求实际经过单闸的两个分段校验，再用同一草稿确认入账验证段序。
      expect(checked.mock.calls.filter(([raw]) => parts.includes(raw)).map(([raw, context]) => [raw, context]))
        .toEqual(parts.map(raw => [raw, 'standard-line']));
      const draft = (await w.base.listDrafts({ status: 'pending' }))[0]!;
      expect(await w.call('m-zhao', '全部确认')).toContain('已入账');
      const rows = (await w.base.listEntries()).filter(e => e.sourceDraftId === draft.draftId);
      expect(rows.map(e => [e.sourceOrdinal, e.customerName, e.amount]))
        .toEqual([[0, '郜婶', 148300], [1, '缑姨', 186743]]);
    } finally { checked.mockRestore(); }
  });
});

describe('R18b 第二轮：表外前导残片按结构先问', () => {
  for (const prefix of ['递呈', '结送', '困倦透了', '晨间问候']) {
    for (const employee of ['', '（小赵）']) {
      for (const customer of ['郜婶', '郗茵']) it(`表外前导 ${prefix}/${customer}/${employee}`, async () => {
        const w = await worldM05(); await known(w);
        const reply = await noDraft(w, `${prefix}${customer}：1483${employee}`);
        expect(reply).not.toContain('是新客户');
      });
    }
  }
  for (const employee of ['', '（小赵）']) it(`单个多余前导字不冒充复姓 ${employee}`, async () => {
    const w = await worldM05();
    const reply = await noDraft(w, `递郜婶：1483${employee}`);
    expect(reply).not.toContain('是新客户');
  });
  it('真实复姓加称谓仍出干净客户位', async () => {
    const w = await worldM05();
    expect(await w.call('m-zhao', '公冶婶：1867（小赵）')).toContain('客户：公冶婶');
  });
  it('开放名字整体已知时不按后缀误判；合法姓加已知名字仍走 D139', () => {
    const base = { today: DAY, employeeNames: new Set(['小赵']), knownCustomerNames: new Set(['郗茵', '郜郗茵']) };
    expect(evaluateConfirmableReportDraft({ ...base, text: '郜郗茵：1483（小赵）' }).ok).toBe(true);
    expect(evaluateConfirmableReportDraft({ ...base, text: '公冶郗茵：1483（小赵）' }))
      .toEqual({ ok: false, reason: 'new-customer', newCustomerNames: ['公冶郗茵'] });
  });
});
