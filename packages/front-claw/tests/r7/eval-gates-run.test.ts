/**
 * 评测脚本的 vitest 入口。仅在 FC_EVAL_RUNNING=1 且给出语料路径时执行；普通 npm test 跳过。
 */
import { it } from 'vitest';
import { runEvalCli } from './gate-eval.js';

const active = process.env.FC_EVAL_RUNNING === '1' && !!process.env.FC_EVAL_CORPUS;

it.skipIf(!active)('R7 评测入口（由 scripts/eval-gates.sh 调用）', async () => {
  const argv = [process.env.FC_EVAL_CORPUS!];
  if (process.env.FC_EVAL_OUT) argv.push('--out', process.env.FC_EVAL_OUT);
  if (process.env.FC_EVAL_CONFIG) argv.push('--config', process.env.FC_EVAL_CONFIG);
  // mode / timeout 已由 shell 写入 FC_MODEL_*，loadModelRuntimeConfig 会读。
  const result = await runEvalCli(argv);
  console.log('---FC-EVAL-SUMMARY---');
  console.log(result.summary);
  if (result.outPath) console.log(`结果已写 ${result.outPath}`);
  console.log('---FC-EVAL-END---');
  if (result.code !== 0) {
    throw new Error(result.summary);
  }
}, 900_000);
