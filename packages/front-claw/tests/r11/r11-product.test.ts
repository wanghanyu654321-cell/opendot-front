/**
 * R11 端到端：D135 定稿、残余备注过 D130、紧贴归属、报单+改账、否定补报、无名预约。
 * 自编句子（钱姐、周老师、孙姨、吴哥），不取留出集。
 */
import { describe, expect, it } from 'vitest';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { parseAppointmentRequest } from '../../src/role-eval/appointments.js';

describe('D135 定稿：整段客套出草稿；混合句按备注追问', () => {
  it('「好的」「收到」整段客套出草稿；「谢谢，不过没做」「不错谢谢」追问零写入', async () => {
    const w = await worldM05();
    const a = await w.call('m-zhao', '周老师：680（小赵）好的');
    expect(a).toMatch(/还没入账/);
    expect(a).not.toMatch(/行尾备注/);
    await w.call('m-zhao', '取消');
    const b = await w.call('m-zhao', '钱姐：880（小王）收到');
    expect(b).toMatch(/还没入账/);
    await w.call('m-zhao', '取消');
    const before = JSON.stringify(await w.snapshot());
    const c = await w.call('m-zhao', '周老师：680（小赵）谢谢，不过没做');
    expect(c).toMatch(/需要确认|没有写入|行尾备注/);
    expect(c).toMatch(/不过没做/);
    expect(c).not.toMatch(/还没入账，回「对」/);
    expect(JSON.stringify(await w.snapshot())).toBe(before);
    const d = await w.call('m-zhao', '钱姐：760（小赵）不错谢谢');
    expect(d).toMatch(/需要确认|没有写入|行尾备注/);
    expect(d).not.toMatch(/还没入账，回「对」/);
    expect(JSON.stringify(await w.snapshot())).toBe(before);
  });
});

describe('R10-01 残余备注必须过 D130，不管 clauseKind 判成什么', () => {
  it('「帮写个朋友圈文案」会被分句判成宣传，但仍追问、不出草稿', async () => {
    const w = await worldM05();
    const before = JSON.stringify(await w.snapshot());
    const r = await w.call('m-zhao', '周老师：680（小赵）帮写个朋友圈文案');
    expect(r).toMatch(/需要确认|没有写入|行尾备注/);
    expect(r).toMatch(/帮写个朋友圈|朋友圈文案/);
    expect(r).not.toMatch(/还没入账，回「对」/);
    expect(JSON.stringify(await w.snapshot())).toBe(before);
  });

  it('「查一下库存汇总」同样追问零写入（变异：去掉残余白名单检查时本例必须失败）', async () => {
    const w = await worldM05();
    const before = JSON.stringify(await w.snapshot());
    const r = await w.call('m-zhao', '钱姐：880（小王）查一下库存汇总');
    expect(r).toMatch(/需要确认|没有写入|行尾备注/);
    expect(r).toMatch(/库存/);
    expect(r).not.toMatch(/还没入账，回「对」/);
    expect(JSON.stringify(await w.snapshot())).toBe(before);
  });
});

describe('D137 无括号紧贴归属：我=报单人，名字核对本店', () => {
  it('「钱姐680算我的」「孙姨1280记我名下」出自己的草稿', async () => {
    const w = await worldM05();
    const a = await w.call('m-zhao', '钱姐680算我的');
    expect(a).toMatch(/还没入账/);
    expect(a).toMatch(/680/);
    expect(a).not.toMatch(/行尾备注|确认这笔记给谁/);
    await w.call('m-zhao', '取消');
    const b = await w.call('m-zhao', '孙姨1280记我名下');
    expect(b).toMatch(/还没入账/);
    expect(b).toMatch(/1280/);
  });

  it('「周老师880报小王的」「钱姐680帮小王报」记给小王、出代报草稿', async () => {
    const w = await worldM05();
    const a = await w.call('m-zhao', '周老师880报小王的');
    expect(a).toMatch(/还没入账/);
    expect(a).toMatch(/880/);
    expect(a).toMatch(/小王|代报/);
    expect(a).not.toMatch(/行尾备注|确认这笔记给谁/);
    await w.call('m-zhao', '取消');
    const b = await w.call('m-zhao', '钱姐680帮小王报');
    expect(b).toMatch(/还没入账/);
    expect(b).toMatch(/小王|代报/);
  });

  it('括号是自己又说报小王的：追问零写入；他店名字不放行', async () => {
    const w = await worldM05();
    const before = JSON.stringify(await w.snapshot());
    const clash = await w.call('m-zhao', '钱姐：680（小赵）报小王的');
    expect(clash).toMatch(/冲突|确认这笔记给谁/);
    expect(clash).toMatch(/没有写入/);
    expect(clash).not.toMatch(/还没入账，回「对」/);
    expect(JSON.stringify(await w.snapshot())).toBe(before);
    const unknown = await w.call('m-zhao', '钱姐680报小美的');
    expect(unknown).not.toMatch(/还没入账，回「对」/);
    expect(JSON.stringify(await w.snapshot())).toBe(before);
  });
});

describe('R10-05 → R18 / D157：报单和改账同时出现，整句先问', () => {
  it('逗号后「把刚才那笔改成」：整句先问，不出报单草稿、不出改账草稿', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '钱姐：680（小赵），把刚才那笔改成880');
    expect(r).not.toMatch(/还没入账|还没改账/);
    expect(r).toMatch(/没有写入/);
    expect((await w.base.listDrafts({ status: 'pending' })).length).toBe(0);
  });

  it('句号+然后、分号+同时、无标点紧贴改账：同样整句先问、零草稿', async () => {
    const w = await worldM05();
    for (const t of ['周老师：760（小赵）。然后把上一笔改成1280', '钱姐：440（小王）；同时把刚才那笔改成880', '孙姨：990（小赵）把刚才那笔改成1280']) {
      const r = await w.call('m-zhao', t);
      expect(r, t).not.toMatch(/还没入账|还没改账/);
      expect(r, t).toMatch(/没有写入/);
      expect((await w.base.listDrafts({ status: 'pending' })).length, t).toBe(0);
    }
  });

  it('「顺带查我自己的进度」按 D144 归模型路径，离线先问不出草稿', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '钱姐：680（小赵），顺带查我自己的进度');
    expect(r).not.toMatch(/还没入账/);
    expect(r).toMatch(/没有写入任何账目|行尾备注|说不清|没太明白/);
    expect((await w.base.listDrafts({ status: 'pending' })).length).toBe(0);
  });
});

describe('R10-06 不是在补昨天的今天报单出草稿；元整按元收', () => {
  it('「不是在补昨天」多种写法：今天的报单出草稿，不被 D124 拒', async () => {
    const w = await worldM05();
    const phrases = [
      '周老师：680（小赵）不是在补昨天',
      '不是在补前天，钱姐：880（小王）',
      '孙姨：760（小赵）不是在补上周的',
      '不是在补报昨天，吴哥：440（小赵）',
    ];
    for (const line of phrases) {
      const r = await w.call('m-zhao', line);
      expect(r, line).toMatch(/还没入账/);
      expect(r, line).not.toMatch(/只能报今天的单/);
      await w.call('m-zhao', '取消');
    }
  });

  it('「680元整」「880块整」「1280整」按元出草稿', async () => {
    const w = await worldM05();
    const a = await w.call('m-zhao', '钱姐：680元整（小赵）');
    expect(a).toMatch(/还没入账/);
    expect(a).toMatch(/680/);
    await w.call('m-zhao', '取消');
    const b = await w.call('m-zhao', '周老师：880块整（小王）');
    expect(b).toMatch(/还没入账/);
    expect(b).toMatch(/880/);
    await w.call('m-zhao', '取消');
    const c = await w.call('m-zhao', '孙姨：1280整（小赵）');
    expect(c).toMatch(/还没入账/);
    expect(c).toMatch(/1280/);
    await w.call('m-zhao', '取消');
    const d = await w.call('m-zhao', '钱姐680元整算我的');
    expect(d).toMatch(/还没入账/);
    expect(d).toMatch(/680/);
  });
});

describe('R10-07 没有明确客户名的预约追问名字', () => {
  it('「预约明天3点过来」追问客人称呼，不把「过来」当名字', async () => {
    const w = await worldM05();
    const before = JSON.stringify(await w.snapshot());
    const r = await w.call('m-zhao', '帮我预约明天下午3点过来');
    expect(r).toMatch(/哪位客人|客人称呼|叫什么|名字/);
    expect(r).not.toMatch(/过来/);
    expect(r).not.toMatch(/还没登记，回「对」/);
    expect(JSON.stringify(await w.snapshot())).toBe(before);
    const parsed = parseAppointmentRequest('帮我预约明天下午3点过来', new Date('2026-11-12T02:00:00Z'), 'Asia/Singapore');
    if (parsed && parsed.kind === 'request') {
      expect(parsed.item.customerNamed).toBe(false);
    }
  });

  it('写了周老师仍可预约', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '预约明天下午3点周老师护理');
    expect(r).toMatch(/还没登记|周老师/);
    expect(r).not.toMatch(/请问是哪位客人/);
  });
});
