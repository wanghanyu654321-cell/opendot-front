/**
 * R8 产品路径：D122–D127 端到端。自编句子，不取留出集。
 */
import { describe, expect, it } from 'vitest';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { parseAddNewChoice } from '../../src/role-eval/ledger-commands.js';

async function draftsAndEntries(w: Awaited<ReturnType<typeof worldM05>>) {
  const snap = await w.snapshot();
  return { drafts: snap.drafts.filter((d: { status: string }) => d.status !== 'void'), entries: snap.entries };
}

describe('R8 端到端：快通道、否定、非今天、小数、新增、预约', () => {
  it('D125：X姐 + 1.2万 / 3千 直出待确认草稿，金额正确', async () => {
    const w = await worldM05();
    const wan = await w.call('m-zhao', '钱姐：1.2万（小赵）');
    expect(wan).toMatch(/还没入账/);
    expect(wan).toMatch(/12000|1\.2万|12,000/);
    const qian = await w.call('m-zhao', '取消');
    expect(qian).toBeTruthy();
    const r = await w.call('m-zhao', '周老师：3千（小王）');
    expect(r).toMatch(/还没入账/);
    expect(r).toMatch(/3000/);
  });

  it('D125：多行「来姐」「多哥」下一行称呼不被当成约数，两笔都出草稿', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '钱姐：680（小赵）\n来姐：980（小王）');
    expect(r).toMatch(/还没入账/);
    expect(r).toMatch(/680/);
    expect(r).toMatch(/980/);
    expect(r).not.toMatch(/金额不确定/);
    // 金额在行尾、无括号：与门①锁定形态一致，seal 不得把下一行称呼当约数。
    await w.call('m-zhao', '取消');
    const tail = await w.call('m-zhao', '周老师 680\n来姐 980');
    expect(tail).toMatch(/还没入账/);
    expect(tail).toMatch(/680/);
    expect(tail).toMatch(/980/);
    expect(tail).not.toMatch(/金额不确定/);
  });

  // D164/D165/D166：报数标签已收录，但紧贴客户没有分隔仍先问；全角数字与行尾表情照常收。
  it('R18 / D158：紧贴前缀「报个数」先问零草稿；表内「报个单 」＋全角数字＋行尾表情出草稿', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '报个数钱姐６８０元😊');
    expect(r).not.toMatch(/还没入账/);
    expect((await w.base.listDrafts({ status: 'pending' })).length).toBe(0);
    const ok = await w.call('m-zhao', '报个单 钱姐６８０元😊');
    expect(ok).toMatch(/还没入账/);
    expect(ok).toMatch(/680/);
    expect(ok).not.toMatch(/金额不确定/);
  });

  it('D123：没做 / 退卡 追问零写入；不错 / 不用找 出草稿并带备注', async () => {
    const w = await worldM05();
    const before = JSON.stringify(await w.snapshot());
    const ask = await w.call('m-zhao', '周老师：680（小赵）最后没做');
    expect(ask).toMatch(/没有写入|没成交|否定|取消/);
    expect(ask).not.toMatch(/还没入账，回「对」|还没入账，回对/);
    expect(JSON.stringify(await w.snapshot())).toBe(before);
    const ask2 = await w.call('m-zhao', '钱姐：880（小王）退卡');
    expect(ask2).toMatch(/没有写入|否定|取消|退卡/);
    expect(ask2).not.toMatch(/还没入账，回「对」/);
    const ok = await w.call('m-zhao', '周老师：680（小赵）不错');
    expect(ok).toMatch(/还没入账/);
    expect(ok).toMatch(/不错/);
  });

  it('D124：昨天/前天的标准行回只能报今天的单，不出草稿；不是补报、今天的不误拒', async () => {
    const w = await worldM05();
    const before = JSON.stringify(await w.snapshot());
    const y = await w.call('m-zhao', '昨天周老师：680（小赵）');
    expect(y).toMatch(/只能报今天的单/);
    expect(y).not.toMatch(/还没入账/);
    const q = await w.call('m-zhao', '前天钱姐：880（小王）');
    expect(q).toMatch(/只能报今天的单/);
    expect(JSON.stringify(await w.snapshot())).toBe(before);
    const ok = await w.call('m-zhao', '不是补报，周老师：760（小赵）');
    expect(ok).toMatch(/还没入账/);
    expect(ok).not.toMatch(/只能报今天的单/);
    await w.call('m-zhao', '取消');
    const ok2 = await w.call('m-zhao', '今天的钱姐：880（小王）');
    // D165/D139：剥完固定前缀仍含时间残片，不再宽松视为姓＋称谓。
    expect(ok2).not.toMatch(/还没入账/);
    await w.call('m-zhao', '取消');
    const ok3 = await w.call('m-zhao', '不是补昨天，赵哥：690（小赵）');
    expect(ok3).toMatch(/还没入账/);
    expect(ok3).not.toMatch(/只能报今天的单/);
  });

  it('D122：标准行 1.8 / 0.33 追问是不是万；680.5 按元收', async () => {
    const w = await worldM05();
    const a = await w.call('m-zhao', '周老师：1.8（小赵）');
    expect(a).toMatch(/是 1\.8 万吗/);
    expect(a).toMatch(/没有写入/);
    expect(a).not.toMatch(/还没入账/);
    const b = await w.call('m-zhao', '钱姐：0.33（小王）');
    expect(b).toMatch(/是 0\.33 万吗/);
    const c = await w.call('m-zhao', '周老师：680.5（小赵）');
    expect(c).toMatch(/还没入账/);
    expect(c).toMatch(/680\.5/);
  });

  it('D126：二选一后「那就再记一笔吧」视为新增', async () => {
    const w = await worldM05();
    const first = await w.call('m-zhao', '林姐：900（小赵）');
    expect(first).toMatch(/还没入账/);
    const conf = await w.call('m-zhao', '对');
    expect(conf).toMatch(/已入账/);
    const again = await w.call('m-zhao', '林姐：680（小赵）');
    expect(again).toMatch(/今天已经有|已有/);
    expect(parseAddNewChoice('那就再记一笔吧')).toBe(true);
    const add = await w.call('m-zhao', '那就再记一笔吧');
    expect(add).toMatch(/还没入账|新增|新的一笔|另一/);
    const { drafts } = await draftsAndEntries(w);
    expect(drafts.length).toBeGreaterThan(0);
  });

  it('D127：「今天客人来吗」不被预约抢走；标准「预约 名字 时间」仍可走预约', async () => {
    const w = await worldM05();
    const q = await w.call('m-zhao', '今天客人来吗');
    expect(q).not.toMatch(/预约要说清几点|请问是哪位客人|几点/);
    // 桩下应追问，不登记
    expect(q).toMatch(/没太明白|没有写入|没有登记/);
    const ap = await w.call('m-zhao', '预约 周老师 15:00');
    expect(ap).toMatch(/周老师|15:00|预约|还没|登记/);
    expect(ap).not.toMatch(/今天客人来吗/);
  });
});
