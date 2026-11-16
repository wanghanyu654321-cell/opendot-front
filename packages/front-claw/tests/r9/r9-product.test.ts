/**
 * R9 端到端：D130 白名单出草稿、非白名单追问；D131 二选一边界；D129 来店陈述。
 * 自编句子（李小雪、丽、王姐、美丽、王丽、周老师），不取留出集。
 */
import { describe, expect, it } from 'vitest';
import { seedHistoricalCustomers } from '../r13/historical-seed.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { parseAppointmentRequest, askConfirmTodayReply } from '../../src/role-eval/appointments.js';

async function snapOf(w: Awaited<ReturnType<typeof worldM05>>) {
  const snap = await w.snapshot();
  return { drafts: snap.drafts.filter((d: { status: string }) => d.status !== 'void'), entries: snap.entries };
}

describe('D130 入口：白名单才出草稿，其余桩下追问零写入', () => {
  it('不错、老客微信、水光 出草稿并带备注', async () => {
    const w = await worldM05();
    const a = await w.call('m-zhao', '周老师：680（小赵）不错');
    expect(a).toMatch(/还没入账/);
    expect(a).toMatch(/不错/);
    await w.call('m-zhao', '取消');
    const b = await w.call('m-zhao', '钱姐：880（小王）老客微信');
    expect(b).toMatch(/还没入账/);
    expect(b).toMatch(/老客|微信/);
    await w.call('m-zhao', '取消');
    const c = await w.call('m-zhao', '赵哥：690（小赵）水光');
    expect(c).toMatch(/还没入账/);
    expect(c).toMatch(/水光/);
  });

  it('「不错但没做」以及「最后没做」不放行，追问且零写入', async () => {
    const w = await worldM05();
    const before = JSON.stringify(await w.snapshot());
    const mixed = await w.call('m-zhao', '周老师：680（小赵）不错但没做');
    expect(mixed).toMatch(/需要确认|没有写入/);
    expect(mixed).toMatch(/不错但没做/);
    expect(mixed).not.toMatch(/还没入账，回「对」/);
    expect(JSON.stringify(await w.snapshot())).toBe(before);
    const no = await w.call('m-zhao', '钱姐：880（小王）最后没做');
    expect(no).toMatch(/需要确认|没有写入/);
    expect(no).not.toMatch(/还没入账，回「对」/);
    expect(JSON.stringify(await w.snapshot())).toBe(before);
  });
});

describe('D131 端到端：前缀命中与单字不误伤', () => {
  it('已有名字也不能放宽带前缀残片的客户位', async () => {
    const w = await worldM05();
    const first = await w.call('m-zhao', '李小雪：680（小赵）');
    // D165/D139：括号未知客户也先确认名字，再确认入账。
    expect(first).toContain('是新客户');
    expect(await w.call('m-zhao', '是')).toMatch(/还没入账/);
    const conf = await w.call('m-zhao', '对');
    expect(conf).toMatch(/已入账/);
    const { entries } = await snapOf(w);
    expect(entries.some((e: { customerName?: string | null; status: string }) => e.customerName === '李小雪' && e.status === 'confirmed')).toBe(true);

    const again = await w.call('m-zhao', '客户李小雪：880（小赵）');
    // D165/D147：残片客户位整条先问，不发可转为报单的选择草稿。
    expect(again).toMatch(/没有写入/);
    expect(await w.base.listDrafts({ status: 'pending' })).toHaveLength(0);
    expect(again).not.toMatch(/还没入账，回「对」/);
    await w.call('m-zhao', '取消');

    const prefix = await w.call('m-zhao', '这次是李小雪：990（小赵）');
    // D165：表外前缀先问，即使包含已有客户名。
    expect(prefix).toMatch(/没有写入/);
    expect(await w.base.listDrafts({ status: 'pending' })).toHaveLength(0);
    expect(prefix).not.toMatch(/还没入账，回「对」/);
  });

  it('已有「丽」或「王姐」时，「美丽」「王丽」不触发二选一，各自出新草稿', async () => {
    const w = await worldM05();
    const a = await w.call('m-zhao', '丽：200（小赵）');
    // D165/D147：单字残片不再因员工括号放宽；D131 的单字历史匹配改用合成历史账验证。
    expect(a).not.toMatch(/还没入账/);
    const owner = (await w.base.listPeople()).find(p => p.memberId === 'm-zhao')!;
    await seedHistoricalCustomers(w.base, { storeId: owner.storeId, owner, names: ['丽', '美丽', '王丽'] });
    const b = await w.call('m-zhao', '王姐：880（小王）');
    expect(b).toMatch(/还没入账/);
    expect(await w.call('m-zhao', '对')).toMatch(/已入账/);

    const mei = await w.call('m-zhao', '美丽：260（小赵）');
    expect(mei).toMatch(/还没入账/);
    expect(mei).not.toMatch(/今天已经有|已有「丽」|已有「王姐」/);
    await w.call('m-zhao', '取消');

    const wangli = await w.call('m-zhao', '王丽：330（小王）');
    expect(wangli).toMatch(/还没入账/);
    expect(wangli).not.toMatch(/今天已经有|已有「王姐」|已有「丽」/);
  });
});

describe('D129：今天+称呼+来店、无时间无项目，先问要不要记预约', () => {
  const NOW = new Date('2026-11-12T02:00:00Z');
  const TZ = 'Asia/Singapore';

  it('「今天周老师来店」先问「要记成周老师今天的预约吗？大概几点？」；带明确时间照常预约', () => {
    const ask = parseAppointmentRequest('今天周老师来店', NOW, TZ);
    expect(ask).toMatchObject({ kind: 'ask_confirm_today', customer: '周老师' });
    expect(askConfirmTodayReply('周老师')).toMatch(/要记成周老师今天的预约吗？大概几点？/);
    const timed = parseAppointmentRequest('今天周老师下午3点来店', NOW, TZ);
    expect(timed?.kind).toBe('request');
    if (timed?.kind === 'request') {
      expect(timed.item.customer).toBe('周老师');
      expect(timed.item.time).toBe('15:00');
      expect(timed.item.date).toBe('2026-11-12');
    }
  });

  it('不伤 M05「明天有客人要来」：仍是要说清几点，不是要记成今天', () => {
    const r = parseAppointmentRequest('明天有客人要来', NOW, TZ);
    expect(r?.kind).toBe('needs_time');
    expect(r?.kind).not.toBe('ask_confirm_today');
  });

  it('端到端：今天周老师来店追问零写入；明天有客人要来仍问几点', async () => {
    const w = await worldM05();
    const before = JSON.stringify(await w.snapshot());
    const r = await w.call('m-zhao', '今天周老师来店');
    expect(r).toMatch(/要记成周老师今天的预约吗？大概几点？/);
    expect(r).toMatch(/没有写入|没有登记/);
    expect(JSON.stringify(await w.snapshot())).toBe(before);
    const m05 = await w.call('m-zhao', '明天有客人要来');
    expect(m05).toMatch(/要说清几点/);
    expect(m05).not.toMatch(/要记成/);
    expect(JSON.stringify(await w.snapshot())).toBe(before);
  });
});
