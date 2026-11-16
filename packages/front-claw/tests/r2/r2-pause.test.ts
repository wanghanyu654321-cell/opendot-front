// R2-6：暂停点只在测试进程可装；未装时同步返回 undefined（生产无操作）；生产代码从不安装。
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { updateAccessPolicy } from '../../src/role-eval/access-policy.js';
import { ACCESS_DENIED } from '../../src/role-eval/employee-loop.js';
import { gate, installPausePoints, pausePoint, pausePointsInstalled } from '../../src/role-eval/pause-points.js';
import { NOW } from '../role-eval/access-fixture-m03.js';
import { membersM05, policyM05, worldM05 } from '../role-eval/appointment-fixture-m05.js';

let uninstall: (() => void) | null = null;
afterEach(() => { uninstall?.(); uninstall = null; });

describe('R2 暂停点', () => {
  it('未安装：同步返回 undefined，不产生 Promise', () => {
    expect(pausePointsInstalled()).toBe(false);
    for (const name of ['commit-gate:before-commit', 'send-gate:before-begin', 'notify:before-mark'] as const) expect(pausePoint(name, 'x')).toBeUndefined();
  });
  it('非测试进程或 NODE_ENV=production → 安装抛错', () => {
    const saved = { VITEST: process.env.VITEST, NODE_ENV: process.env.NODE_ENV };
    try {
      delete process.env.VITEST;
      expect(() => installPausePoints({})).toThrow('pause_points_test_only');
      process.env.VITEST = 'true'; process.env.NODE_ENV = 'production';
      expect(() => installPausePoints({})).toThrow('pause_points_test_only');
    } finally {
      if (saved.VITEST === undefined) delete process.env.VITEST; else process.env.VITEST = saved.VITEST;
      if (saved.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.NODE_ENV;
    }
    expect(pausePointsInstalled()).toBe(false);
  });
  it('src/ 里只有 pause-points.ts 自己提到 installPausePoints', () => {
    const files = readdirSync(new URL('../../src/', import.meta.url), { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.ts'));
    const users = files.filter(f => readFileSync(new URL(`../../src/${f}`, import.meta.url), 'utf8').includes('installPausePoints'));
    expect(users.map(f => f.replace(/\\/g, '/'))).toEqual(['role-eval/pause-points.ts']);
  });
  it('内存库确定性竞态：确认停在提交前 → 另一处撤权 → 放行后被提交门拒绝，零入账、草稿退回待确认', async () => {
    const w = await worldM05();
    expect(await w.call('m-zhao', '张姐 680（小王）')).toContain('还没入账');
    const before = (await w.base.listEntries()).length;
    const g = gate();
    uninstall = installPausePoints({ 'commit-gate:before-commit': g.hook });
    const confirming = w.call('m-zhao', '对');
    await g.reached;
    const members = membersM05(); members['p-zhao'] = { ...members['p-zhao']!, status: 'suspended' };
    const bumped = await updateAccessPolicy(w.base, { expectedVersion: 1, next: policyM05(2, members), actor: 'test-admin', reason: 'r2-race', at: NOW.toISOString() });
    expect(bumped.ok).toBe(true);
    g.release();
    expect(await confirming).toBe(ACCESS_DENIED);
    expect(await w.base.listEntries()).toHaveLength(before);
    expect((await w.base.listDrafts({ kind: 'report' })).map(d => d.status)).toEqual(['pending']);
  });
});
