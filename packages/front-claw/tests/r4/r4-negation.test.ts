/** R4（R3A-04）：否定/未成交/模糊金额不得出可确认草稿。泛化规则。 */
import { describe, expect, it } from 'vitest';
import { extractReport } from '../../src/role-eval/report-extract.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';

describe('模糊金额', () => {
  for (const text of ['王姐今天六百多，先给我报', '李姐大概八百来块记上', '周姐 600 多先报', '吴姐将近七百，算我今天的']) {
    it(`「${text}」问准确金额，不出可确认草稿`, async () => {
      const extracted = extractReport(text);
      expect(extracted.status, JSON.stringify(extracted)).not.toBe('complete');
      const w = await worldM05();
      const reply = await w.call('m-zhao', text);
      expect(reply).not.toMatch(/还没入账|回复「对」/);
      expect(reply).not.toMatch(/600元|800元|700元/);
      expect(reply).toMatch(/准确|确切|问清|多少|不确定|左右|大约/);
      expect((await w.base.listDrafts()).filter(d => d.status === 'pending')).toHaveLength(0);
    });
  }
});

describe('未成交与明说不办理', () => {
  it('未成交（嫌贵最后没做）不出可确认报单草稿', async () => {
    const w = await worldM05();
    const reply = await w.call('m-zhao', '钱姐嫌520太贵，最后没做，我白忙活了');
    expect(reply).not.toMatch(/还没入账|回复「对」/);
    expect(reply).not.toContain('520元');
    expect((await w.base.listDrafts()).filter(d => d.status === 'pending' && d.kind === 'report')).toHaveLength(0);
  });
  it('明说不用登记、只是告知取消，不出可确认预约草稿', async () => {
    const w = await worldM05();
    const reply = await w.call('m-zhao', '孙阿姨又把明天16点的护理约取消了，烦死；我就说说，不用登记或改单');
    expect(reply).not.toMatch(/还没登记|回复「对」/);
    expect((await w.base.listDrafts()).filter(d => d.status === 'pending' && d.kind === 'appointment')).toHaveLength(0);
  });
});
