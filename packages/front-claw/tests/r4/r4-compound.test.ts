/** R4（R3A-03）：复合句未办部分必须明说；不同动作不串用客户。泛化规则，不取盲测原句当规则。 */
import { expect, it } from 'vitest';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';

// R18 / D157：复合请求只要整句不是纯标准行（后半句是进度、改账、预约还是宣传都一样），离线整句先问，不单独出报单草稿。
// 原 R4 口径（出报单清单＋明说后半句没办）是 D130 b / D149 旧目标，留到接真模型后由模型路径恢复。
const compound = [
  '周女士440（小王），再帮做一张开业宣传海报',
  '冯姐350今天我的单，另外登记明天15点吴姐护理预约',
  '先查我自己的进度，再帮我报孙姐420',
];
for (const text of compound) it(`R18 / D157 复合整句先问、零草稿、不串客户：${text}`, async () => {
  const w = await worldM05();
  const before = JSON.stringify(await w.snapshot());
  const reply = await w.call('m-zhao', text);
  expect(reply).not.toMatch(/还没入账|还没登记|还没改账/);
  expect(reply).not.toMatch(/顾客 冯姐/);
  expect(reply).toMatch(/没有写入/);
  expect(JSON.stringify(await w.snapshot())).toBe(before);
});
