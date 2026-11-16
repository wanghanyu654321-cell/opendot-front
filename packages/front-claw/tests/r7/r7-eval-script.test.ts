/**
 * R7 评测脚本：用自编小样例验证三道门输出与延迟分位数。不打开任何留出集，不调真模型。
 * 本文件不断言门③达标。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateCorpus, loadCorpus, percentile, runEvalCli, formatSummary } from './gate-eval.js';
import { loadModelRuntimeConfig, createModelClassifier, isModelStub, stubModelClassifier } from '../../src/role-eval/model-classify.js';

// R18b：自编样例与桩配置只读当前 worktree，不访问其他 checkout。
const SAMPLE = resolve(__dirname, 'fixtures/r7-eval-sample.jsonl');
const STUB_CFG = resolve(__dirname, 'fixtures/r7-model-stub.json');

describe('R7 评测脚本（自编样例）', () => {
  it('配置默认是桩，读文件可改超时，不改代码即可切换', () => {
    const def = loadModelRuntimeConfig();
    expect(def.mode).toBe('stub');
    expect(isModelStub(createModelClassifier(def))).toBe(true);
    expect(isModelStub(stubModelClassifier)).toBe(true);
    const fromFile = loadModelRuntimeConfig(STUB_CFG);
    expect(fromFile).toMatchObject({ mode: 'stub', timeoutMs: 2500 });
  });

  it('百分位计算正确', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8, 5);
    expect(percentile([], 0.5)).toBeNull();
  });

  it('自编样例：输出三道门数字、每条结果和 p50/p95；门①通过、门②不执行；不断言门③达标', async () => {
    const { items, sha256 } = loadCorpus(SAMPLE);
    expect(items).toHaveLength(8);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    const out = await evaluateCorpus(items, { modelConfig: STUB_CFG });
    expect(out.total).toBe(8);
    expect(out.model.mode).toBe('stub');
    // D165/D139：未知括号客户首报独立计数，从纯标准行门①分母排除。
    expect(out.gate1_draft.of).toBe(1);
    expect(out.gate1_draft.n).toBe(1);
    expect(out.gate1_amount_correct.n).toBe(1);
    expect(out.gate2_executed.of).toBe(3);
    expect(out.gate2_executed.n).toBe(0);
    expect(out.gate3_direct.of).toBe(2);
    // 桩路径上门③不达标是预期，只记录数字，不断言 ≥90%。
    expect(out.gate3_note).toMatch(/待正式实测/);
    expect(out.latency_ms.n).toBe(8);
    expect(out.latency_ms.p50).toBeGreaterThan(0);
    expect(out.latency_ms.p95).toBeGreaterThanOrEqual(out.latency_ms.p50!);
    const byId = Object.fromEntries(out.rows.map(r => [r.id, r]));
    // D165/D139：S001 原样保留样例标注，首报追问由汇总从门①分母排除。
    expect(byId.S001).toMatchObject({ outcome: 'clarify', in_gate1: true });
    expect(byId.S002).toMatchObject({ outcome: 'draft', amount_ok: true });
    expect(byId.S002!.draftYuan).toContain(3300);
    expect(byId.S003!.outcome).toBe('clarify');
    expect(byId.S004!.outcome).toBe('clarify');
    expect(byId.S005!.outcome).toBe('clarify');
    expect(byId.S008!.outcome).toBe('deny');
    for (const r of out.rows) {
      expect(r.latency_ms, r.id).toBeGreaterThan(0);
      expect(r.reply, r.id).toBeTruthy();
    }
    const text = formatSummary({ ...out, corpus: SAMPLE, sha256 });
    expect(text).toMatch(/门①/);
    expect(text).toMatch(/门②/);
    expect(text).toMatch(/门③/);
    expect(text).toMatch(/p50=/);
    expect(text).toMatch(/p95=/);
  }, 180_000);

  it('runEvalCli 把结果写到指定文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r7-eval-'));
    const outPath = join(dir, 'out.json');
    const result = await runEvalCli(['--corpus', SAMPLE, '--out', outPath, '--config', STUB_CFG, '--model', 'stub']);
    expect(result.code).toBe(0);
    expect(result.summary).toMatch(/门①/);
    expect(result.summary).toMatch(/p95=/);
    const saved = JSON.parse(readFileSync(outPath, 'utf8'));
    // D165/D139：相同首报排除口径。
    expect(saved.gate1_draft.n).toBe(1);
    expect(saved.gate2_executed.n).toBe(0);
    expect(saved.latency_ms.p50).toBeGreaterThan(0);
    expect(saved.rows).toHaveLength(8);
  }, 180_000);

  it('live 未配 endpoint 时拒绝静默回退', async () => {
    const prev = process.env.FC_MODEL_MODE;
    const prevEp = process.env.FC_MODEL_ENDPOINT;
    delete process.env.FC_MODEL_ENDPOINT;
    process.env.FC_MODEL_MODE = 'live';
    try {
      const dir = mkdtempSync(join(tmpdir(), 'r7-eval-'));
      const cfg = join(dir, 'live.json');
      writeFileSync(cfg, JSON.stringify({ model: { mode: 'live', timeoutMs: 1000 } }));
      const result = await runEvalCli(['--corpus', SAMPLE, '--config', cfg, '--model', 'live']);
      expect(result.code).toBe(2);
      expect(result.summary).toMatch(/endpoint/);
    } finally {
      if (prev === undefined) delete process.env.FC_MODEL_MODE; else process.env.FC_MODEL_MODE = prev;
      if (prevEp === undefined) delete process.env.FC_MODEL_ENDPOINT; else process.env.FC_MODEL_ENDPOINT = prevEp;
    }
  });
});
