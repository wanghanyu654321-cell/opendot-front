/**
 * R17 / D152：单闸。四类自编句子各不少于 15 条，全部先问、零可确认草稿。
 * 不取留出集原句。
 */
import { describe, expect, it } from 'vitest';
import { mayCreateConfirmableReportDraft, isCleanCustomerMorphology, isExactHonorificName } from '../../src/role-eval/confirmable-draft-gate.js';
import { formatMaybeReportAsk, GENERIC_MODEL_ASK, guessCustomerNameFromText } from '../../src/role-eval/model-path-ask.js';
import { NOT_A_CUSTOMER_NAME_ASK } from '../../src/role-eval/customer-name-policy.js';
import { tryStandardReport, isAcceptableCustomerLabel } from '../../src/role-eval/standard-line.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';

const DAY = '2026-11-12';
const EMPLOYEES = new Set(['小赵', '小王', '小林', '苏晓禾']);

const ASK = /没有写入任何账目|说不清|没太明白|不像在报客户名|请把要报的客户|行尾备注|没看清/;

/** 未见过的否定补报说法（自编，与 r15 用词不同）。 */
const UNSEEN_MAKEUP: string[] = [
  '别当成补登了，周姐：640（小赵）',
  '勿算后补单，钱老师 710',
  '并非在漏记，许姨：830',
  '不属于补上来的，孙姐 550（小王）',
  '没有当成漏报，周老师：910',
  '不要当作补记哦，钱姐：760',
  '非那种后补记录，许姨 680（小赵）',
  '不算是在补单，周姐：520',
  '别看成漏登了，钱姨：770',
  '并非昨日那种漏报，许老师 890',
  '勿当以前漏的，孙姐：610（小赵）',
  '没有在做补登，周老师 740',
  '不属于昨天漏的那种，钱姐：800',
  '别按补单来记，许姨：690（小王）',
  '并非事后补上，周姐 730',
  '不要当成漏记那类，孙老师：850',
];

/** 客户位残片（自编）。 */
const LEFTOVER: string[] = [
  '后补许姨：720（小赵）',
  '那个周老师：880',
  '这个钱姐 680（小王）',
  '并非补录孙姐：560',
  '漏报许姨：710（小赵）',
  '补登周老师 900',
  '随便钱姐：640（小赵）',
  '什么许姨：770',
  '这些周老师 810（小王）',
  '那些钱姐：530',
  '别当漏报孙姐：660（小赵）',
  '不是补的那个许姨：720',
  '后补的周老师：880（小赵）',
  '补报钱姐 690',
  '那个什么许姨：750（小王）',
  '嗯嗯周老师：820',
];

/** 括号里放非名字词（角色、身份、时间、动作）。 */
const PAREN_NON_NAME: string[] = [
  '许姨：720（店长）',
  '周老师：880（员工）',
  '钱姐：680（今天）',
  '孙姐：560（上午）',
  '许姨：710（报名）',
  '周老师：900（登记）',
  '钱姐：640（经理）',
  '孙姐：770（老板）',
  '许姨：810（操作）',
  '周老师：530（代报）',
  '钱姐：660（同事）',
  '孙姐：720（本人）',
  '许姨：880（角色）',
  '周老师：690（身份）',
  '钱姐：750（下班）',
  '孙姐：820（晚上）',
];

/** 复合请求：报单 + 进度/查询/认不出的后半句（改账、预约、宣传按 D149 仍是草稿＋没办，不在此类）。 */
const COMPOUND: string[] = [
  '许姨：720（小赵），再看下我本月做了多少',
  '周老师 880，顺便问我今天几单',
  '钱姐：680（小王），另外查下本人进度',
  '孙姐560，帮我列一下我入账',
  '许姨：710报一下，再给我本周汇总',
  '周老师：900（小赵）。然后看看我这个月几单',
  '钱姐：640（小王），另外跟我讲下我排第几',
  '孙姐：770，再说说我今天完成没',
  '许姨：810（小赵）顺带查小王这个月',
  '周老师：530报我的，再查本店排名',
  '钱姐：660（小王）；同时查下我本月入账',
  '孙姐：720（小赵），顺便算下还差几单',
  '许姨 880，再帮我问下完成度',
  '周老师：690（小赵），另外帮我看看进度',
  '钱姐：750，先记着再查我业绩',
  '孙姐：820（小王），请帮我查一下业绩',
];

const PURE: string[] = [
  '许姨：720（小赵）',
  '周老师：880（小王）',
  '钱姐 680（小赵）',
  '李小雪：760（小王）',
];

async function assertAskNoDraft(lines: string[], label: string) {
  const failed: string[] = [];
  for (const line of lines) {
    const w = await worldM05();
    const r = await w.call('m-zhao', line);
    const drafts = (await w.base.listDrafts({ status: 'pending' })).length;
    const drafted = /还没入账/.test(r) || drafts > 0;
    const asked = ASK.test(r);
    if (drafted || !asked) {
      failed.push(`${label} 「${line}」 drafted=${drafted} asked=${asked} drafts=${drafts} reply=${r.slice(0, 180)}`);
    }
  }
  expect(failed, failed.join('\n')).toEqual([]);
}

describe('R17 单闸与纯标准行正向白名单', () => {
  it('恰好姓＋称谓、2–4 字干净名字可过闸；残片和括号非名字不能', () => {
    expect(isExactHonorificName('许姨')).toBe(true);
    expect(isExactHonorificName('周老师')).toBe(true);
    expect(isExactHonorificName('后补许姨')).toBe(false);
    expect(isExactHonorificName('今天的钱姐')).toBe(false);
    expect(isCleanCustomerMorphology('李小雪')).toBe(true);
    expect(isCleanCustomerMorphology('后补许姨')).toBe(false);
    expect(isCleanCustomerMorphology('那个周老师')).toBe(false);
    expect(isAcceptableCustomerLabel('后补许姨')).toBe(false);
    expect(mayCreateConfirmableReportDraft({ text: '许姨：720（小赵）', today: DAY, employeeNames: EMPLOYEES })).toBe(true);
    expect(mayCreateConfirmableReportDraft({ text: '后补许姨：720（小赵）', today: DAY, employeeNames: EMPLOYEES })).toBe(false);
    expect(mayCreateConfirmableReportDraft({ text: '许姨：720（店长）', today: DAY, employeeNames: EMPLOYEES })).toBe(false);
    expect(mayCreateConfirmableReportDraft({ text: '许姨：720（小赵），再查下我进度', today: DAY, employeeNames: EMPLOYEES })).toBe(false);
    expect(mayCreateConfirmableReportDraft({ text: '许姨：720（今天）', today: DAY, employeeNames: EMPLOYEES })).toBe(false);
    // 离线桩即使声称 live 也不该由调用方打开；函数本身在 liveModelAllowsDraft 为 true 时才放行（仅线上）。
    expect(mayCreateConfirmableReportDraft({ text: '乱七八糟', today: DAY, employeeNames: EMPLOYEES, liveModelAllowsDraft: false })).toBe(false);
  });

  it(`未见过否定补报 ${UNSEEN_MAKEUP.length} 条先问、零可确认草稿`, async () => {
    expect(UNSEEN_MAKEUP.length).toBeGreaterThanOrEqual(15);
    await assertAskNoDraft(UNSEEN_MAKEUP, 'makeup');
  });

  it(`客户位残片 ${LEFTOVER.length} 条先问、零可确认草稿，客户行不得带残片`, async () => {
    expect(LEFTOVER.length).toBeGreaterThanOrEqual(15);
    await assertAskNoDraft(LEFTOVER, 'leftover');
  });

  it(`括号非名字 ${PAREN_NON_NAME.length} 条先问、零可确认草稿`, async () => {
    expect(PAREN_NON_NAME.length).toBeGreaterThanOrEqual(15);
    await assertAskNoDraft(PAREN_NON_NAME, 'paren');
  });

  it(`复合请求 ${COMPOUND.length} 条整句先问、不单独出报单草稿`, async () => {
    expect(COMPOUND.length).toBeGreaterThanOrEqual(15);
    await assertAskNoDraft(COMPOUND, 'compound');
  });

  it('纯标准行仍出草稿，不退化', async () => {
    for (const line of PURE) {
      const w = await worldM05();
      let r = await w.call('m-zhao', line);
      // D165/D139：括号全名首报先确认客户；每张草稿仍须经过单闸。
      if (r.includes('是新客户')) r = await w.call('m-zhao', '是');
      expect(r, line).toMatch(/还没入账/);
      expect((await w.base.listDrafts({ status: 'pending' })).length, line).toBe(1);
      await w.call('m-zhao', '取消');
    }
  });

  it('D148：名字不在本店已确认名单时，具体追问不得写进该名字；通用追问', () => {
    const text = '并非后补，赵美丽：720';
    const guessed = guessCustomerNameFromText(text);
    expect(guessed).toBe('赵美丽');
    const ask = formatMaybeReportAsk(text, new Set());
    expect(ask).toBe(GENERIC_MODEL_ASK);
    expect(ask).not.toContain('赵美丽');
    expect(ask).not.toMatch(/还没入账/);
    const withRoster = formatMaybeReportAsk(text, new Set(['赵美丽']));
    // 金额确定且名单有，才可具体问；仍无草稿。
    expect(withRoster).toMatch(/是不是要报客户「赵美丽」/);
    expect(withRoster).toMatch(/没有写入任何账目/);
  });

  it('入口：不在名单的名字不能出现在客户行，也不出可确认草稿', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '并非后补，赵美丽：720（小赵）');
    expect(r).not.toMatch(/还没入账/);
    expect(r).not.toMatch(/客户：赵美丽/);
    expect(r).toMatch(ASK);
    expect((await w.base.listDrafts({ status: 'pending' })).length).toBe(0);
  });

  it('D153：非名字不问「是新客户吗」，用通用追问', () => {
    expect(NOT_A_CUSTOMER_NAME_ASK).not.toMatch(/是新客户/);
    expect(NOT_A_CUSTOMER_NAME_ASK).toMatch(/没有写入任何账目/);
  });

  it('入口：非名字（今天一共）不问是新客户、不出草稿', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '今天一共：3000（小赵）');
    expect(r).not.toMatch(/是新客户/);
    expect(r).not.toMatch(/还没入账/);
    expect(r).toMatch(/没有写入|不像在报客户名|说不清|请把要报/);
  });
});
