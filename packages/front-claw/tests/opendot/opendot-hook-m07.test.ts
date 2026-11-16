import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { operationIdFor } from '../../src/opendot/adapter.js';
import { manualClock, memoryWorld, offlineChannels, opIdOf } from './fixture-m07.js';

const OPENDOT = process.env.OPENDOT_SRC?.trim() ?? '';
const PATCH = path.resolve('integrations/opendot-front-claw/opendot-hook.patch');
const haveOpenDot = OPENDOT !== '' && existsSync(path.join(OPENDOT, 'src/index.ts'));
let dir = '';
type Hook = typeof import('../../integrations/opendot-front-claw/opendot-src/front-claw-hook.js');
let hook: Hook;

function logger() {
  const logs: { level: string; fields: Record<string, unknown>; message?: string | undefined }[] = [];
  return { logs, logger: { info: (fields: Record<string, unknown>, message?: string) => { logs.push({ level: 'info', fields, message }); }, warn: (fields: Record<string, unknown>, message?: string) => { logs.push({ level: 'warn', fields, message }); } } };
}

describe.skipIf(!haveOpenDot)('M07 OpenDot 挂点：只在临时副本上打补丁并真实导入', () => {
  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'fc-m07-od-'));
    mkdirSync(path.join(dir, 'src'));
    copyFileSync(path.join(OPENDOT, 'src/index.ts'), path.join(dir, 'src/index.ts'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['apply', '--check', PATCH], { cwd: dir });
    execFileSync('git', ['apply', PATCH], { cwd: dir });
    hook = await import(path.join(dir, 'src/front-claw-hook.ts')) as Hook;
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); delete (globalThis as Record<string, unknown>).__frontClawM07Deps; });

  it('补丁只动 index.ts 三处（import、启动、Phase 1 关停）并新增一个文件；钩子只 import node 内置', () => {
    const before = readFileSync(path.join(OPENDOT, 'src/index.ts'), 'utf8').split('\n');
    const after = readFileSync(path.join(dir, 'src/index.ts'), 'utf8').split('\n');
    expect(after.length - before.length).toBe(1 + 2 + 3);
    const text = after.join('\n');
    const imp = text.indexOf("import { startFrontClawHook } from './front-claw-hook.js';");
    const start = text.indexOf('const frontClaw = await startFrontClawHook(logger);');
    const handoffs = text.indexOf('startBotHandoffService(');
    const phase1 = text.indexOf('Promise.allSettled', start);
    const close = text.indexOf('frontClaw\n        .close()', start);
    expect(imp).toBeGreaterThan(0); expect(start).toBeGreaterThan(handoffs); expect(handoffs).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(phase1); expect(phase1).toBeGreaterThan(start);
    const src = readFileSync(path.join(dir, 'src/front-claw-hook.ts'), 'utf8');
    expect([...src.matchAll(/from '([^']+)'/g)].map(m => m[1])).toEqual(['node:path', 'node:url']);
    // 补丁里的挂点文件与仓库里的 opendot-src 版本逐字节一致。
    expect(src).toBe(readFileSync('integrations/opendot-front-claw/opendot-src/front-claw-hook.ts', 'utf8'));
    // 源副本未被改动。
    expect(existsSync(path.join(OPENDOT, 'src/front-claw-hook.ts'))).toBe(false);
  });
  it('默认关：不加载任何模块、不记日志、close 是空操作', async () => {
    for (const env of [{}, { FRONT_CLAW_OPENDOT_ADAPTER: '0', FRONT_CLAW_OPENDOT_MODULE: '/nope.js' }]) {
      const l = logger();
      const service = await hook.startFrontClawHook(l.logger, env);
      expect(service.state()).toBe('off'); expect(await service.ready()).toBeNull();
      await service.close();
      expect(l.logs).toEqual([]);
    }
  });
  it('开了但模块路径相对 / 不存在 / 没导出入口 / 入口抛错：只记 warn，OpenDot 继续', async () => {
    const cases = [
      { FRONT_CLAW_OPENDOT_MODULE: 'dist/opendot/index.js' },
      { FRONT_CLAW_OPENDOT_MODULE: path.join(dir, 'missing.js') },
      { FRONT_CLAW_OPENDOT_MODULE: path.resolve('src/opendot/host-contract.ts') },
      // 真入口，但没配 PG（FRONT_CLAW_DATABASE_URL）：要求 PG 的启动在连接前就拒绝。
      { FRONT_CLAW_OPENDOT_MODULE: path.resolve('src/opendot/index.ts') },
    ];
    for (const extra of cases) {
      const l = logger();
      const service = await hook.startFrontClawHook(l.logger, { FRONT_CLAW_OPENDOT_ADAPTER: '1', ...extra });
      // R3：钩子立即返回、后台加载；结果出来后标 unavailable 并带 alert 告警。
      expect(await service.ready()).toBeNull(); expect(service.state()).toBe('unavailable');
      expect(l.logs.find(x => x.level === 'warn')?.fields).toMatchObject({ alert: 'front_claw_unavailable' });
      await expect(service.close()).resolves.toBeUndefined();
      expect(l.logs.filter(x => x.level === 'warn')).toHaveLength(1);
    }
  });
  it('全链：OpenDot 钩子 → 外部入口模块 → 适配器 → handler → 存储 → 回复；close 走 Phase 1 形状', async () => {
    const world = await memoryWorld();
    const channels = offlineChannels();
    (globalThis as Record<string, unknown>).__frontClawM07Deps = { open: world.open, channel: channels.factory, now: manualClock().now, timers: false };
    const l = logger();
    const service = await hook.startFrontClawHook(l.logger, { FRONT_CLAW_OPENDOT_ADAPTER: '1', FRONT_CLAW_OPENDOT_MODULE: path.resolve('tests/opendot/hook-entry-m07.ts') });
    const adapter = (await service.ready()) as unknown as { state(): string; idle(): Promise<void>; result(id: string): Promise<{ state: string; ledgerSettled?: boolean }> };
    expect(adapter.state()).toBe('active');
    channels.send('m-zhao', '12号测试B店\n560（小赵）', 'hk-1'); await adapter.idle();
    channels.send('m-zhao', '对', 'hk-2'); await adapter.idle();
    expect(channels.replies().at(-1)).toContain('已入账');
    expect(await adapter.result(operationIdFor(opIdOf('m-zhao', 'hk-2')))).toMatchObject({ state: 'completed', ledgerSettled: true });
    const settled = await Promise.allSettled([service.close().catch(() => undefined)]);
    expect(settled[0]!.status).toBe('fulfilled');
    expect(adapter.state()).toBe('closed'); expect(service.state()).toBe('closed');
    expect(world.closes).toHaveBeenCalledTimes(1);
    expect(l.logs.filter(x => x.level === 'warn'), JSON.stringify(l.logs)).toEqual([]);
    vi.restoreAllMocks();
  });
});
