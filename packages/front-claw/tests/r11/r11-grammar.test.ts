/**
 * R11 语法层：D135 整段客套、D137 紧贴归属、不是在补昨天、元整/块整/整、
 * 无名预约不拿动词当名字、残余备注必须过 D130。自编句子，不取留出集。
 */
import { describe, expect, it, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  interpretStandardTail, classifyStandardRemark, tryStandardReport, parseStandardLine,
  hasUnnegatedNonToday, remainingRemarkAfterPeel, ownershipConflictDetail,
} from '../../src/role-eval/standard-line.js';
import { loadRemarkCourtesyConfig, stripTrailingCourtesy } from '../../src/role-eval/remark-courtesy.js';
import { isWhitelistedRemark } from '../../src/role-eval/remark-whitelist.js';
import { clauseKind, compoundHead, compoundTail, maskNegatedPastDay } from '../../src/role-eval/scope-refusal.js';
import { parsePureMoney } from '../../src/role-eval/amounts.js';
import { guardAmountTerm, guardUtteranceAmounts } from '../../src/role-eval/amount-guard.js';
import { parseAppointmentRequest } from '../../src/role-eval/appointments.js';

const DAY = '2026-11-12';
const NOW = new Date('2026-11-12T02:00:00Z');
const TZ = 'Asia/Singapore';

afterEach(() => {
  loadRemarkCourtesyConfig();
});

describe('D135 只有整段都是客套才剥；词表是产品定稿那八个', () => {
  it('谢啦/谢谢/谢了/辛苦了/麻烦了/麻烦你了/好的/收到：整段剥空', () => {
    for (const w of ['谢啦', '谢谢', '谢了', '辛苦了', '麻烦了', '麻烦你了', '好的', '收到']) {
      expect(stripTrailingCourtesy(w).rest, w).toBe('');
      expect(stripTrailingCourtesy(w).courtesy, w).toBeTruthy();
    }
    expect(stripTrailingCourtesy('好的，收到').rest).toBe('');
    expect(stripTrailingCourtesy('谢谢谢啦').rest).toBe('');
  });

  it('「谢谢，不过没做」「不错谢谢」整段不是客套，一处都不剥', () => {
    const a = stripTrailingCourtesy('谢谢，不过没做');
    expect(a.courtesy).toBeNull();
    expect(a.rest).toMatch(/谢谢/);
    expect(a.rest).toMatch(/不过没做/);
    expect(classifyStandardRemark(a.rest)).toBe('model');
    expect(isWhitelistedRemark(a.rest)).toBe(false);
    expect(stripTrailingCourtesy('不错谢谢').rest).toBe('不错谢谢');
    expect(classifyStandardRemark('不错谢谢')).toBe('model');
  });

  it('不在定稿词表里的「多谢」「感谢」不剥', () => {
    expect(stripTrailingCourtesy('多谢').rest).toBe('多谢');
    expect(stripTrailingCourtesy('感谢').rest).toBe('感谢');
    const dir = mkdtempSync(join(tmpdir(), 'r11-c-'));
    const path = join(dir, 'c.json');
    writeFileSync(path, JSON.stringify({ courtesy: ['费心了'] }));
    loadRemarkCourtesyConfig(path);
    expect(stripTrailingCourtesy('费心了').rest).toBe('');
    expect(stripTrailingCourtesy('谢啦').rest).toBe('谢啦');
    loadRemarkCourtesyConfig();
  });
});

describe('R10-01 残余备注不论 clauseKind 都必须过 D130', () => {
  it('帮写朋友圈、查库存、给前台说明：分句会判成店务，但备注仍是 model', () => {
    for (const note of ['帮写个朋友圈文案', '查一下库存汇总', '给前台写个说明', '谢谢，不过没做']) {
      const t = interpretStandardTail(note);
      expect(t.remark, note).toBe(note.normalize('NFKC'));
      // 即使 clauseKind 认出店务，也不能把备注掏空
      const k = clauseKind(note);
      if (k) expect(k).not.toBe('report');
      expect(classifyStandardRemark(t.remark), note).toBe('model');
      const parsed = parseStandardLine(`周老师：680（小赵）${note}`);
      expect(parsed.status, note).toBe('ok');
      if (parsed.status === 'ok') {
        expect(parsed.entries[0]!.note, note).toBe(note.normalize('NFKC'));
        expect(classifyStandardRemark(parsed.entries[0]!.note!)).toBe('model');
      }
    }
  });

  it('确定的归属/复合才剥；剥不干净的一律留下给 D130', () => {
    expect(interpretStandardTail('算我的').remark).toBe('');
    expect(interpretStandardTail('算我的').ownership).toBe('self');
    // 「不算我的哈」不是确定的「算我的」（左边是「不」），整段留给 D130
    const neg = interpretStandardTail('不算我的哈');
    expect(neg.ownership).toBeNull();
    expect(neg.remark).toMatch(/不算我的/);
    expect(classifyStandardRemark(neg.remark)).toBe('model');
  });
});

describe('D137 金额后紧贴归属、无括号从归属取员工', () => {
  const selfCases = [
    '钱姐680算我的',
    '钱姐：680算我的',
    '孙姨1280记我名下',
    '周老师880报我的',
    '钱姐760登我名下',
    '周老师680算我今天的',
    '钱姐880记我的',
    '吴哥990报我名下',
    '孙姨440登我的',
    '钱姐 680 算我的',
    '周老师：1280记我名下',
  ];
  it.each(selfCases)('记给自己：%s', (line) => {
    const p = parseStandardLine(line);
    expect(p.status, line).toBe('ok');
    if (p.status === 'ok') {
      const e = p.entries[0]!;
      expect(e.ownership, line).toBe('self');
      expect(e.self, line).toBe(true);
      expect(e.note, line).toBe('');
      expect(e.amount, line).toBeGreaterThan(0);
    }
  });

  const otherCases: [string, string][] = [
    ['周老师1280报小王的', '小王'],
    ['钱姐680帮小王报', '小王'],
    ['周老师880替小王记', '小王'],
    ['钱姐760记小王名下', '小王'],
    ['周老师990帮小王报一下', '小王'],
    ['钱姐680报小王名下', '小王'],
    ['周老师：880报小王的', '小王'],
    ['钱姐880帮小王登', '小王'],
    ['周老师1280替小王报', '小王'],
    ['钱姐440算小王的', '小王'],
    ['孙姨760登小王的', '小王'],
    ['吴哥880帮小王记', '小王'],
  ];
  it.each(otherCases)('从归属取员工：%s → %s', (line, who) => {
    const p = parseStandardLine(line);
    expect(p.status, line).toBe('ok');
    if (p.status === 'ok') {
      const e = p.entries[0]!;
      expect(e.ownership, line).toBe('other');
      expect(e.employeeName, line).toBe(who);
      expect(e.attributedName, line).toBe(who);
      expect(e.self, line).toBeFalsy();
      expect(e.note, line).toBe('');
    }
  });

  it('括号小赵又说报小王的：冲突', () => {
    const p = parseStandardLine('钱姐：680（小赵）报小王的');
    expect(p.status).toBe('ok');
    if (p.status === 'ok') {
      const e = p.entries[0]!;
      expect(e.employeeName).toBe('小赵');
      expect(e.attributedName).toBe('小王');
      const clash = ownershipConflictDetail({
        ownership: e.ownership ?? null,
        ...(e.ownershipText ? { ownershipText: e.ownershipText } : {}),
        ...(e.attributedName ? { attributedName: e.attributedName } : {}),
        employeeName: '小赵', employeeIsReporter: true, hasExplicitEmployee: true,
      });
      expect(clash).toMatch(/冲突|确认这笔记给谁/);
    }
  });
});

describe('R10-06 「不是（在）补（报）（昨天/前天/上周的）」和金额「整」', () => {
  const masks = [
    '不是在补昨天', '不是在补前天', '不是在补上周的', '不是补昨天', '不是补报昨天',
    '不是在补报昨天', '不是在补报前天的', '不是补上周的', '不是在补上周的单',
    '并非在补昨天', '不是在补昨儿', '不是在补昨日的', '不是在补报上周的',
  ];
  it.each(masks)('否定补报里的日期不触发 D124：%s', (phrase) => {
    const line = `${phrase}，周老师：680（小赵）`;
    expect(maskNegatedPastDay(phrase.replace(/\s+/g, '')), phrase).not.toMatch(/昨天|昨儿|昨日|前天|上周/);
    expect(hasUnnegatedNonToday(line, DAY), phrase).toBe(false);
    const r = tryStandardReport(`周老师：680（小赵）${phrase}`, DAY);
    expect(r.status, phrase).toBe('complete');
  });

  it('报单本身是昨天的仍拒；否定补报不影响', () => {
    expect(hasUnnegatedNonToday('昨天周老师：680（小赵）', DAY)).toBe(true);
    expect(hasUnnegatedNonToday('不是在补昨天，周老师：680（小赵）', DAY)).toBe(false);
  });

  const yuans: [string, number][] = [
    ['680元整', 68000],
    ['680块整', 68000],
    ['680整', 68000],
    ['1280元整', 128000],
    ['880块整', 88000],
    ['760整', 76000],
    ['六百八十元整', 68000],
    ['一千整', 100000],
    ['0.3万整', 300000],
    ['990元整', 99000],
    ['440块整', 44000],
    ['三百整', 30000],
  ];
  it.each(yuans)('「%s」按元收下 = %i 分', (text, cents) => {
    const p = parsePureMoney(text);
    expect(p.ok, text).toBe(true);
    if (p.ok) expect(p.amount, text).toBe(cents);
    const g = guardAmountTerm(text, 'standard-line');
    expect(g.ok, `guard ${text}`).toBe(true);
    if (g.ok) expect(g.cents, text).toBe(cents);
  });

  it('标准行和 amount-guard 整句都认 元整/块整/整', () => {
    const lines = [
      '钱姐：680元整（小赵）',
      '周老师：880块整（小王）',
      '钱姐：1280整（小赵）',
      '周老师680元整算我的',
      '孙姨：760元整（小赵）',
      '吴哥：440块整（小王）',
      '钱姐：990整（小赵）',
      '周老师：三百元整（小王）',
    ];
    for (const line of lines) {
      const r = tryStandardReport(line, DAY);
      expect(r.status, line).toBe('complete');
      const g = guardUtteranceAmounts(line, 'standard-line');
      expect(g.ok, `utterance ${line}`).toBe(true);
    }
    // 约数仍追问
    expect(parsePureMoney('680元整出头').ok).toBe(false);
    const hedge = tryStandardReport('钱姐：680元整（小赵）出头', DAY);
    expect(hedge.status === 'ask' || (hedge.status === 'complete' && hedge.report.entries[0]!.note.includes('出头'))).toBe(true);
  });
});

describe('R10-05 复合连接词与报单+改账拆开', () => {
  it('顺带、然后、同时、句号后再接第二条请求能拆开', () => {
    const samples = [
      '钱姐：680（小赵），顺带查我自己的进度',
      '钱姐：680（小赵）。然后把上一笔改成880',
      '钱姐：680（小赵）；同时把刚才那笔改成880',
      '钱姐：680（小赵），把刚才那笔改成880',
      '钱姐：680（小赵）把刚才那笔改成880',
    ];
    for (const s of samples) {
      const tail = compoundTail(s);
      expect(tail, s).toBeTruthy();
      expect(compoundHead(s), s).toMatch(/680/);
      expect(compoundHead(s), s).not.toMatch(/改成880|查我自己/);
    }
    const r = tryStandardReport('钱姐：680（小赵），把刚才那笔改成880', DAY);
    expect(r.status).toBe('complete');
    if (r.status === 'complete') {
      expect(r.report.entries[0]!.amount).toBe(68000);
      expect(r.report.entries[0]!.note).toBe('');
      expect(r.report.entries[0]!.compound).toMatch(/改成/);
    }
  });
});

describe('R10-07 无名预约不拿动词或时间词当名字', () => {
  const unnamed = [
    '帮我预约明天下午3点过来',
    '预约明天15点开始',
    '预约明天3点来做',
    '帮我约一下明天下午三点到店',
    '预约后天10点来店',
    '给我预约明天15点过来做',
    '预约明天3点登记',
  ];
  it.each(unnamed)('没有称呼则 unnamed：%s', (text) => {
    const r = parseAppointmentRequest(text, NOW, TZ);
    expect(r, text).toBeTruthy();
    if (r && r.kind === 'request') {
      expect(r.item.customerNamed, text).toBe(false);
      expect(r.item.customer, text).not.toMatch(/过来|开始|来做|到店|来店|登记|明天|下午/);
    }
  });

  it('明确称呼仍收下：周老师、钱姐、张三', () => {
    const a = parseAppointmentRequest('预约明天下午3点周老师护理', NOW, TZ);
    expect(a && a.kind === 'request' && a.item.customerNamed && a.item.customer).toMatch(/周老师/);
    const b = parseAppointmentRequest('预约明天15点张三', NOW, TZ);
    expect(b && b.kind === 'request' && b.item.customer).toBe('张三');
  });
});

describe('D136 remainingRemarkAfterPeel：剥完没有剩下的不计', () => {
  it('算我的、谢啦、无备注 → 空；不错但没做、谢谢不过没做 → 有残留', () => {
    expect(remainingRemarkAfterPeel('周老师：680（小赵）算我的')).toBe('');
    expect(remainingRemarkAfterPeel('钱姐：880（小王）谢啦')).toBe('');
    expect(remainingRemarkAfterPeel('周老师：680（小赵）')).toBe('');
    expect(remainingRemarkAfterPeel('周老师：680（小赵）不错')).toBe('不错');
    expect(remainingRemarkAfterPeel('钱姐：880（小王）不错但没做')).toBe('不错但没做');
    expect(remainingRemarkAfterPeel('周老师：680（小赵）谢谢，不过没做')).toMatch(/不过没做/);
  });
});
