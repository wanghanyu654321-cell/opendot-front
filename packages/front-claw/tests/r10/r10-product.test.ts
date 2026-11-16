/**
 * R10 端到端：归属核对、复合两件都办、客套出草稿。自编句子，不取留出集。
 */
import { describe, expect, it } from 'vitest';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';

describe('D133 归属与括号核对：一致或互补出草稿，冲突追问', () => {
  it('「算我的」且括号是自己：出草稿；括号是别人：追问零写入', async () => {
    const w = await worldM05();
    const ok = await w.call('m-zhao', '钱姐：680（小赵）算我的');
    expect(ok).toMatch(/还没入账/);
    expect(ok).toMatch(/680/);
    expect(ok).not.toMatch(/行尾备注/);
    await w.call('m-zhao', '取消');
    const before = JSON.stringify(await w.snapshot());
    const clash = await w.call('m-zhao', '钱姐：880（小王）算我的');
    expect(clash).toMatch(/冲突|确认这笔记给谁/);
    expect(clash).toMatch(/没有写入/);
    expect(clash).not.toMatch(/还没入账，回「对」/);
    expect(JSON.stringify(await w.snapshot())).toBe(before);
  });

  it('「这单不是我的」且括号是同事：互补，出代报草稿', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '周老师：1280（小王）这单不是我的哈');
    expect(r).toMatch(/还没入账/);
    expect(r).toMatch(/1280/);
    expect(r).toMatch(/小王|代报/);
    expect(r).not.toMatch(/行尾备注/);
  });

  it('「帮他报」配括号同事出草稿；「报我今天的」记给自己出草稿', async () => {
    const w = await worldM05();
    // D165/D139：未知全名先确认客户，归属语法仍照常核对。
    expect(await w.call('m-zhao', '李小雪：760（小王）帮他报一下')).toContain('是新客户');
    const a = await w.call('m-zhao', '是');
    expect(a).toMatch(/还没入账/);
    expect(a).not.toMatch(/行尾备注/);
    await w.call('m-zhao', '取消');
    const b = await w.call('m-zhao', '周老师：680（小赵）报我今天的');
    expect(b).toMatch(/还没入账/);
    expect(b).not.toMatch(/行尾备注|需要确认这笔记给谁/);
  });
});

describe('D134 复合请求：报单＋本人进度两件都办；其它组合明说没办', () => {
  it('「记我今天的，再查下我本月进度」按 D144 归模型路径，离线先问不出草稿', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '钱姐：680（小赵）记我今天的，再查下我本月进度');
    expect(r).not.toMatch(/还没入账/);
    expect(r).toMatch(/没有写入任何账目|行尾备注|说不清|没太明白/);
    expect((await w.base.listDrafts({ status: 'pending' })).length).toBe(0);
  });

  it('「顺便查我自己的进度」按 D144 归模型路径，离线先问不出草稿', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '周老师：880（小赵）算我的；顺便查我自己的进度');
    expect(r).not.toMatch(/还没入账/);
    expect(r).toMatch(/没有写入任何账目|行尾备注|说不清|没太明白/);
    expect((await w.base.listDrafts({ status: 'pending' })).length).toBe(0);
  });


  // R18 / D157：复合句（报单＋预约、报单＋宣传）离线整句先问，不单独出报单草稿，也不登记预约；不因后半句「明天」被 D81 拒。
  it('R18 / D157：报单＋明天的预约 → 整句先问、零写入，不回「只能报今天的单」', async () => {
    const w = await worldM05();
    const before = JSON.stringify(await w.snapshot());
    const r = await w.call('m-zhao', '钱姐：680（小赵）报我今天的，另外登记明天15点周老师护理预约');
    expect(r).not.toMatch(/还没入账|还没登记/);
    expect(r).not.toMatch(/只能报今天的单/);
    expect(r).toMatch(/没有写入/);
    expect(r).not.toMatch(/顾客 钱姐/);
    expect(JSON.stringify(await w.snapshot())).toBe(before);
  });
  it('R18 / D157：报单后再写海报 → 整句先问、零草稿', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '钱姐：440（小王），另外帮做一张开业宣传海报');
    expect(r).not.toMatch(/还没入账/);
    expect(r).toMatch(/没有写入/);
    expect((await w.base.listDrafts({ status: 'pending' })).length).toBe(0);
  });
});

describe('D135 行尾致谢剥掉后出草稿；非白名单备注仍追问', () => {
  it('「谢啦」「辛苦了」出草稿且不把客套当备注拦下', async () => {
    const w = await worldM05();
    const a = await w.call('m-zhao', '周老师：680（小赵）谢啦');
    expect(a).toMatch(/还没入账/);
    expect(a).toMatch(/680/);
    expect(a).not.toMatch(/行尾备注「谢啦」/);
    await w.call('m-zhao', '取消');
    const b = await w.call('m-zhao', '钱姐：0.3万（小王）辛苦了');
    expect(b).toMatch(/还没入账/);
    expect(b).toMatch(/3000/);
  });

  it('「不错但没做」仍追问零写入（不靠扩白名单）', async () => {
    const w = await worldM05();
    const before = JSON.stringify(await w.snapshot());
    const r = await w.call('m-zhao', '周老师：680（小赵）不错但没做');
    expect(r).toMatch(/需要确认|没有写入/);
    expect(r).toMatch(/不错但没做/);
    expect(r).not.toMatch(/还没入账，回「对」/);
    expect(JSON.stringify(await w.snapshot())).toBe(before);
  });
});
