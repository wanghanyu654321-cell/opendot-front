import { beforeEach, expect, it, vi } from 'vitest';
import { MemorySql } from './sql-fixture.js';
import { openPerformanceStore } from '../../src/role-eval/performance-open.js';
import { bootFrontClaw } from '../../src/role-eval/front-claw-boot.js';

const state = vi.hoisted(() => ({ fail: false, ends: 0, releases: 0, sql: undefined as unknown as MemorySql }));
vi.mock('../../src/role-eval/pg-pool.js', () => ({ loadPgPool: async () => class {
  async query(sql: string, params?: unknown[]) {
    if (state.fail) throw Object.assign(Error('合成故障'), { code: 'ECONNREFUSED' });
    return state.sql.query(sql, params);
  }
  async connect() { return { query: this.query.bind(this), release: () => { state.releases++; } }; }
  async end() { state.ends++; }
} }));
beforeEach(() => { state.sql = new MemorySql(); state.fail = false; state.ends = 0; state.releases = 0; });
const env = { FRONT_CLAW_DATABASE_URL: 'postgres://fake:fake@127.0.0.1/fake' };

it('M01 未配置 PG 或 PG 打开失败均拒绝，不退回内存', async () => {
  const base = { employeeLoop: true, send: async () => 'sent' as const, model: { complete: async () => ({ type: 'chat' as const, text: '合成' }) } };
  await expect(bootFrontClaw({ ...base, env: {} })).rejects.toThrow('FRONT_CLAW_DATABASE_UNAVAILABLE_URL');
  state.fail = true;
  await expect(bootFrontClaw({ ...base, env })).rejects.toThrow('FRONT_CLAW_DATABASE_UNAVAILABLE_ECONNREFUSED');
  expect(state.ends).toBe(1);
});

it('r7 关闭共享一次 pool.end；新开 store 仍能查同库账目', async () => {
  const opened = await openPerformanceStore(env, { requirePostgres: true });
  await opened.store.setConfig('synthetic', '保留');
  await Promise.all([opened.close(), opened.close()]);
  await opened.close(); expect(state.ends).toBe(1);
  const reopened = await openPerformanceStore(env, { requirePostgres: true });
  expect(await reopened.store.getConfig('synthetic')).toBe('保留');
  await reopened.close(); expect(state.ends).toBe(2);
});

it('boot 创建后重复关闭也只结束一个池', async () => {
  const booted = await bootFrontClaw({ env, employeeLoop: true, send: async () => 'sent', model: { complete: async () => ({ type: 'chat', text: '合成' }) } });
  expect(booted.driver).toBe('postgres'); expect(booted.handler.employeeLoop).toBe(true);
  booted.startMaintenance();
  await Promise.all([booted.close(), booted.close()]); expect(state.ends).toBe(1);
});
