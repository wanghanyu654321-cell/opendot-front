/**
 * R9 D132：评测种子改为标准行，种入失败写入摘要与输出行。
 * 自编条目，不打开留出集。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluateCorpus, formatSummary } from '../r7/gate-eval.js';
import type { CorpusItem } from '../r7/gate-eval.js';

describe('D132 评测种子用标准行，失败进入摘要', () => {
  it('源码种子文本是「客户：金额（员工）」而不是「客户 金额」', () => {
    const src = readFileSync(resolve(__dirname, '../r7/gate-eval.ts'), 'utf8');
    expect(src).toMatch(/\$\{e\.customer\}：\$\{e\.amount\}（\$\{owner\.displayName\}）/);
    expect(src).toMatch(/\$\{e\.customer\}：\$\{e\.amount\}（\$\{reporter\.displayName\}）/);
    expect(src).not.toMatch(/\$\{e\.customer\} \$\{e\.amount\}`/);
    expect(src).toMatch(/种入失败/);
  });

  it('已有客户种子能种上；带客户位残片先问；摘要含种入失败字段', async () => {
    const items: CorpusItem[] = [
      {
        id: 'R9SEED1',
        text: '客户李小雪：990（小赵）',
        expect: '该澄清',
        sender_name: '小赵',
        context: { entries: [{ customer: '李小雪', amount: 680, reporter: '小赵' }] },
      },
    ];
    const out = await evaluateCorpus(items);
    expect(out.seed_fail.n).toBe(0);
    expect(out.seed_fail.ids).toEqual([]);
    const row = out.rows[0]!;
    expect(row.seed_failed).toBe(false);
    // D165/D147：客户位带表外残留先问，不发能转成可确认草稿的二选一。
    expect(row.choiceDraft).toBe(false);
    expect(row.outcome).toBe('clarify');
    const text = formatSummary(out);
    expect(text).toMatch(/种入失败\s+0 条/);
  }, 60_000);
});
