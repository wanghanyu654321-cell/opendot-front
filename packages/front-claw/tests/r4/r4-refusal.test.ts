/** R4（R3A-05）：该拒绝的直接「不能做——」或「只能报今天的单」，不追问、不把昨天的单变成今天清单。 */
import { expect, it } from 'vitest';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';

const CANNOT = /不能做——/;
const NOT_TODAY = /目前只能报今天的单/;

it('过去的成交不能当成今天的单入草稿（昨儿/前天/具体日期）', async () => {
  const w = await worldM05();
  for (const text of [
    '昨儿陈阿姨880没来得及报，今天帮我登下',
    '前天刘姐1.2k，小美的单我代补',
    '周三也就是11月11号，吴姐760是我做的，补记',
  ]) {
    const reply = await w.call('m-zhao', text);
    expect(reply, text).toMatch(new RegExp(`${NOT_TODAY.source}|${CANNOT.source}`));
    expect(reply, text).not.toMatch(/还没入账|回复「对」/);
    expect((await w.base.listDrafts()).filter(d => d.status === 'pending' && d.kind === 'report'), text).toHaveLength(0);
  }
});

it('员工查同事或全店、设目标 → 直接不能做并给原因，不教格式、不追问', async () => {
  const w = await worldM05();
  for (const text of [
    '小美这个月离目标还差多少？',
    '小林今天报了几单，明细拉给我',
    '咱店今天还有谁没报？列名单',
    '帮我把本月目标设成5万',
    '把我的目标改成8万',
  ]) {
    const reply = await w.call('m-zhao', text);
    expect(reply, text).toMatch(CANNOT);
    expect(reply, text).not.toMatch(/还没入账|还没生效|请按「给小赵|没太明白|请发标准清单/);
  }
});
