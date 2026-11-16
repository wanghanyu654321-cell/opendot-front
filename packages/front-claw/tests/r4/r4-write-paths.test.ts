/** R4（R3A-06）：静态检查大小写不敏感，并能处理空白与模板字符串。 */
import { expect, it } from 'vitest';
import { collectWriteSql, REGISTRY } from '../r3/r3-write-paths.test.js';

const sample = `
export function createPostgresPerformanceStore() {
  async function saveDraft() {
    await query(\`INSERT INTO front_claw_perf.performance_drafts (draft_id) VALUES ($1)\`);
  }
  async function auditUnregisteredWrite() {
    await query('insert into front_claw_perf.performance_config (key, value) values ($1, $2)');
  }
  async function auditMixedCase() {
    await query(\`
      Update front_claw_perf.performance_entries
      SET amount = 1
    \`);
  }
}
`;

it('R4-W1：小写、混合大小写、跨行模板字符串的未登记写 SQL 都被抓住', () => {
  const found = collectWriteSql(sample);
  const methods = found.map(f => f.method).sort();
  expect(methods).toContain('auditUnregisteredWrite');
  expect(methods).toContain('auditMixedCase');
  expect(methods).toContain('saveDraft');
  const unregistered = found.filter(f => !REGISTRY[f.method] && f.method !== 'fencedWrite');
  expect(unregistered.map(f => f.method).sort()).toEqual(['auditMixedCase', 'auditUnregisteredWrite']);
});

it('R4-W2：大小写混合的 INSERT/UPDATE/DELETE 都算写 SQL', () => {
  const found = collectWriteSql(`
  async function weird() {
    await query("Insert Into front_claw_perf.performance_config values (1)");
    await query('DELETE  FROM front_claw_perf.performance_drafts');
  }
`);
  expect(found.map(f => f.method)).toEqual(['weird', 'weird']);
});
