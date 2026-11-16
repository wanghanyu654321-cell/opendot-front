/** R18 / D155（自然句归模型路径）、D157（复合句整句先问）。离线桩一律先问、零可确认草稿。句子均为自编。 */
import { describe, expect, it } from 'vitest';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';

async function asksOnly(text: string) {
  const w = await worldM05();
  const before = JSON.stringify(await w.snapshot());
  const r = await w.call('m-zhao', text);
  expect(r, text).not.toMatch(/还没入账|还没改账|还没登记/);
  expect(r, text).toMatch(/没有写入/);
  expect(JSON.stringify(await w.snapshot()), text).toBe(before);
}

describe('R18 / D155 自然句报单离线先问', () => {
  for (const t of [
    '今儿给阮姐做了个疗程，她刷了730，记我这', '帮我记一下：阮姐260、甄姐410', '刚收了甄姐五百四，是我的单',
    '这边两单：阮姐 300块，甄姐 520块', '甄姐那单我做的，合计六百二',
  ]) it(t, () => asksOnly(t));
});

describe('R18 / D157 复合句整句先问（进度、改账、预约、宣传、复述都一样）', () => {
  for (const t of [
    '阮姐：730（小赵），顺手把上午那笔改成830', '阮姐：730（小赵），另外帮约下周二上午做护理', '阮姐：730（小赵），再写段店庆朋友圈文案',
    '阮姐：730（小赵），帮小赵登记下', '阮姐：730（小赵）；再看看我本旬做了多少', '阮姐：730（小赵）然后把甄姐那笔改成410',
  ]) it(t, () => asksOnly(t));
});

describe('纯标准行与分号连写的标准行照常出草稿（不退化）', () => {
  it('单行纯标准行', async () => {
    const w = await worldM05();
    expect(await w.call('m-zhao', '阮姐：730（小赵）')).toMatch(/还没入账/);
  });
  it('分号连写、每段都是完整单笔标准行 → 仍算标准清单（R18 解释，REPORT 列为待确认）', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '阮姐 260（小赵）；甄姐 410（小王）');
    expect(r).toMatch(/还没入账/);
    expect(r).toContain('260'); expect(r).toContain('410');
  });
});
