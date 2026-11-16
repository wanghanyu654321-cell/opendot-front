import { spawn } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';
import { startFrontClawHook } from '../../integrations/opendot-front-claw/opendot-src/front-claw-hook.js';
import { fakeHost } from '../opendot/fixture-m07.js';

/** 跑子进程“OpenDot main”替身 ms 毫秒后强制结束，返回输出行。 */
function runHost(module: string, ms: number, budget = '100'): Promise<string[]> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.resolve('tests/r3/fixtures/fake-opendot-main.mjs'), path.resolve('integrations/opendot-front-claw/opendot-src/front-claw-hook.ts'), path.resolve(module), budget], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += String(chunk); });
    const kill = setTimeout(() => child.kill('SIGKILL'), ms);
    child.on('exit', () => { clearTimeout(kill); resolve(out.split('\n').filter(Boolean)); });
  });
}

it('R3-H1（真实钩子 + 合成模块，同进程）：模块顶层异步卡住 → 钩子立即返回、宿主计时器照常运行；超时标 unavailable 并告警', async () => {
  const host = fakeHost();
  const t0 = performance.now();
  const handle = await startFrontClawHook(host.host.logger, { FRONT_CLAW_OPENDOT_ADAPTER: '1', FRONT_CLAW_OPENDOT_START_TIMEOUT_MS: '50', FRONT_CLAW_OPENDOT_MODULE: path.resolve('tests/r3/fixtures/async-hang-module.mjs') });
  const returnedMs = performance.now() - t0;
  expect(handle.state()).toBe('loading');
  let ticks = 0; const beat = setInterval(() => { ticks += 1; }, 5);
  expect(await handle.ready()).toBeNull();
  clearInterval(beat);
  console.info(JSON.stringify({ returnedMs, ticks, state: handle.state() }));
  expect(returnedMs).toBeLessThan(50);
  expect(ticks).toBeGreaterThan(2);
  expect(handle.state()).toBe('unavailable');
  expect(host.logs.filter(l => l.level === 'warn').map(l => l.fields)).toEqual([expect.objectContaining({ alert: 'front_claw_unavailable', stage: 'import', budgetMs: 50 })]);
  await handle.close();
});

it('R3-H2（子进程，异步卡住）：宿主先完成启动、心跳持续，超时后 Front Claw 标 unavailable 并告警', async () => {
  const lines = await runHost('tests/r3/fixtures/async-hang-module.mjs', 1_200);
  console.info(JSON.stringify({ lines: lines.slice(0, 12), total: lines.length }));
  expect(lines[0]).toBe('OPENDOT_STARTED');
  expect(lines.some(l => /^WARN front_claw_unavailable import /.test(l))).toBe(true);
  expect(lines).toContain('STATE unavailable');
  expect(lines.filter(l => l.startsWith('TICK')).length).toBeGreaterThan(10);
}, 10_000);

it('R3-H3（子进程，同步死循环 = 已知剩余 P2）：宿主启动完成后，模块初始化占死事件循环——心跳停止、超时告警也不会触发', async () => {
  const lines = await runHost('tests/r3/fixtures/sync-spin-module.mjs', 1_200);
  console.info(JSON.stringify({ lines, total: lines.length }));
  // 证明的是“会卡死”，不是“已隔离”：OpenDot 的启动语句先跑完，但之后同进程什么都不再运行。
  expect(lines[0]).toBe('OPENDOT_STARTED');
  expect(lines.filter(l => l.startsWith('TICK')).length).toBeLessThanOrEqual(1);
  expect(lines.some(l => l.startsWith('WARN'))).toBe(false);
  expect(lines.some(l => l.startsWith('STATE'))).toBe(false);
}, 10_000);
