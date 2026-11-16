/**
 * R10 D136：评测摘要单列「标准格式报单因备注不在白名单被追问」。
 * 自编条目，不打开留出集。
 */
import { describe, expect, it } from 'vitest';
import { evaluateCorpus, formatSummary } from '../r7/gate-eval.js';
import type { CorpusItem } from '../r7/gate-eval.js';

describe('D136 标准行备注非白名单追问指标', () => {
  it('摘要和返回对象都有条数、比例；白名单出草稿不计，非白名单追问计入', async () => {
    const items: CorpusItem[] = [
      { id: 'R10M1', text: '周老师：680（小赵）不错', sender_name: '小赵' },
      { id: 'R10M2', text: '钱姐：880（小王）不错但没做', sender_name: '小赵' },
      { id: 'R10M3', text: '今天天气如何', sender_name: '小赵' },
      { id: 'R10M4', text: '周老师：440（小赵）谢啦', sender_name: '小赵' },
      { id: 'R10M5', text: '钱姐：680（小赵）算我的', sender_name: '小赵' },
    ];
    const out = await evaluateCorpus(items);
    expect(out.remark_whitelist_ask).toBeDefined();
    // 谢啦、算我的剥完没有剩下的备注，不计入分母和分子；天气不是标准行。
    expect(out.remark_whitelist_ask.of).toBe(2);
    expect(out.remark_whitelist_ask.n).toBe(1);
    expect(out.remark_whitelist_ask.ids).toEqual(['R10M2']);
    const metric = out.remark_whitelist_ask as typeof out.remark_whitelist_ask & { threshold: number; exceed: boolean; distribution: { by_category: Record<string, number>; uncategorized: string[] } };
    expect(metric.threshold).toBe(0.05);
    expect(metric.exceed).toBe(true);
    expect(metric.distribution.by_category.praise).toBe(1);
    const row1 = out.rows.find(r => r.id === 'R10M1');
    const row2 = out.rows.find(r => r.id === 'R10M2');
    expect(row1!.outcome).toBe('draft');
    expect(row2!.outcome).toBe('clarify');
    const text = formatSummary(out);
    expect(text).toMatch(/标准行备注非白名单追问/);
    expect(text).toMatch(/1\s*\/\s*2/);
    expect(text).toMatch(/门槛\s*≤\s*5%/);
    expect(text).toMatch(/超过5%/);
  }, 60_000);
});
