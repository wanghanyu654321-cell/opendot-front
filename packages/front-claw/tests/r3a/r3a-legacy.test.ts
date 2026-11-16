// R3a（第 3 项）：旧统一入口启动开关，默认关闭。关闭时拒绝启动（抛 LegacyEntryDisabled）；手动打开时写告警。
// OpenDot 装配（employeeLoop:true）根本不进旧路径，不需要这个开关。
import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { bootFrontClaw } from '../../src/role-eval/front-claw-boot.js';
import { FRONT_CLAW_LEGACY_ENTRY, LEGACY_ENTRY_ALERT, LegacyEntryDisabled, createWecomBotHandler, legacyEntryAllowed } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { MemoryPerformanceStore } from '../../src/role-eval/performance-store.js';
import { REGISTRY } from '../r3/r3-write-paths.test.js';

const silent = () => {};
function make(extra: Parameters<typeof createWecomBotHandler>[0] extends infer T ? Partial<T> : never = {}) {
  const store = new MemoryPerformanceStore();
  return createWecomBotHandler({
    mode: 'isolated-synthetic', store, now: () => new Date('2026-11-12T02:00:00Z'),
    resolve: id => store.getPersonByMember(id), send: async () => 'sent',
    model: { complete: async () => ({ type: 'chat', text: 'x' }) }, onLegacyWarn: silent, ...extra,
  });
}

it('R3a-L1：默认关闭——不带开关构造旧入口抛 LegacyEntryDisabled，零启动；env 非 1 也不开', () => {
  expect(legacyEntryAllowed({})).toBe(false);
  expect(legacyEntryAllowed({ env: {} })).toBe(false);
  expect(legacyEntryAllowed({ env: { [FRONT_CLAW_LEGACY_ENTRY]: '0' } })).toBe(false);
  expect(legacyEntryAllowed({ legacyEntry: false, env: { [FRONT_CLAW_LEGACY_ENTRY]: '1' } })).toBe(false);
  expect(() => make()).toThrow(LegacyEntryDisabled);
  expect(() => make({ env: { [FRONT_CLAW_LEGACY_ENTRY]: '0' } })).toThrow(LegacyEntryDisabled);
});

it('R3a-L2：手动打开（options 或 env=1）→ 能启动并写告警；显式 false 盖过 env', () => {
  const warned: unknown[] = [];
  const a = make({ legacyEntry: true, onLegacyWarn: info => warned.push(info) });
  expect(a.employeeLoop).toBe(false);
  expect(warned).toEqual([{ alert: LEGACY_ENTRY_ALERT, message: expect.stringMatching(/manually enabled/) }]);
  const warned2: unknown[] = [];
  const b = make({ env: { [FRONT_CLAW_LEGACY_ENTRY]: '1' }, onLegacyWarn: info => warned2.push(info) });
  expect(b.employeeLoop).toBe(false);
  expect(warned2[0]).toMatchObject({ alert: LEGACY_ENTRY_ALERT });
  expect(() => make({ legacyEntry: false, env: { [FRONT_CLAW_LEGACY_ENTRY]: '1' } })).toThrow(LegacyEntryDisabled);
});

it('R3a-L3：employeeLoop 装配（OpenDot）不需要开关、不告警；handleMessage 走员工入口，旧路径不可达', async () => {
  const warned: unknown[] = [];
  const h = make({ employeeLoop: true, onLegacyWarn: info => warned.push(info) });
  expect(h.employeeLoop).toBe(true);
  expect(warned).toEqual([]);
  // 源码静态：handleMessage 在员工入口开启时直接 return employeeLoop(input)，其后才是旧路径。
  const src = readFileSync(new URL('../../src/role-eval/wecom-bot-unified-handler.ts', import.meta.url), 'utf8');
  const start = src.indexOf('async handleMessage(input: EmployeeMessage)');
  const body = src.slice(start, start + 800);
  expect(body).toMatch(/if \(employeeLoop\) return employeeLoop\(input\);/);
  expect(body.indexOf('if (employeeLoop) return employeeLoop(input);')).toBeLessThan(body.indexOf('handleUnified'));
});

it('R3a-L4：bootFrontClaw 未开员工入口且未开开关 → 拒绝启动；开了开关则告警', async () => {
  const send = async () => 'sent' as const;
  const model = { complete: async () => ({ type: 'chat' as const, text: 'x' }) };
  await expect(bootFrontClaw({ env: {}, send, model })).rejects.toBeInstanceOf(LegacyEntryDisabled);
  const warned: unknown[] = [];
  const on = await bootFrontClaw({ env: { [FRONT_CLAW_LEGACY_ENTRY]: '1' }, send, model, onLegacyWarn: info => warned.push(info) });
  expect(on.handler.employeeLoop).toBe(false);
  expect(warned[0]).toMatchObject({ alert: LEGACY_ENTRY_ALERT });
  await on.close();
});

it('R3a-L5：写路径清单里旧入口类条目注明「开关默认关闭」', () => {
  const legacy = Object.entries(REGISTRY).filter(([, v]) => v.kind === 'admin_or_legacy' && /旧/.test(v.note));
  expect(legacy.length).toBeGreaterThanOrEqual(6);
  for (const [name, v] of legacy) expect(v.note, name).toMatch(/开关默认关闭/);
});
