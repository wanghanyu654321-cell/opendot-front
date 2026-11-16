/**
 * R8：评测第四道门输出、超时默认 8000。只用自编样例，不打开留出集，不调真模型。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_TIMEOUT_MS, loadModelRuntimeConfig } from '../../src/role-eval/model-classify.js';
import { evaluateCorpus, formatSummary, loadCorpus } from '../r7/gate-eval.js';
import { resolve } from 'node:path';

const SAMPLE = resolve(__dirname, '../r7/fixtures/r7-eval-sample.jsonl');

describe('D127/D128 超时默认与第四道门', () => {
  it('默认超时 8000，评测未传 --timeout-ms 时读同一常量', () => {
    expect(DEFAULT_MODEL_TIMEOUT_MS).toBe(8000);
    expect(loadModelRuntimeConfig().timeoutMs).toBe(DEFAULT_MODEL_TIMEOUT_MS);
  });

  it('自编样例输出快通道与模型分类各自的 p95，并标注待正式实测', async () => {
    const { items, sha256 } = loadCorpus(SAMPLE);
    const out = await evaluateCorpus(items);
    expect(out.model.timeoutMs).toBe(DEFAULT_MODEL_TIMEOUT_MS);
    expect(out.gate4_fast).toBeDefined();
    expect(out.gate4_fast.threshold_ms).toBe(1000);
    expect(out.gate4_fast.note).toMatch(/待正式实测/);
    expect(out.gate4_model.threshold_ms).toBe(5000);
    expect(out.gate4_model.note).toMatch(/待正式实测/);
    expect(out.gate4_fast.n + out.gate4_model.n).toBe(out.total);
    const text = formatSummary({ ...out, corpus: SAMPLE, sha256 });
    expect(text).toMatch(/门④ 快通道/);
    expect(text).toMatch(/门④ 模型分类/);
    expect(text).toMatch(/待正式实测/);
  });
});
