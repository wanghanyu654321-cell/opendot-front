import path from 'node:path';
import { expect, it } from 'vitest';
import { startFrontClawHook } from '../../integrations/opendot-front-claw/opendot-src/front-claw-hook.js';
import { fakeHost } from '../opendot/fixture-m07.js';
// R3：由 助手B 的缺陷特征断言（"import 在超时之外"）改为安全断言：模块顶层异步初始化一直 pending 时，
// 钩子立即返回、超时后标 unavailable 并告警；迟到的模块随后被关闭。修前失败（钩子一直不返回），修后通过。
it('AUDIT regression safe (R3): module import/initialisation is inside the startup budget', async () => {
  let release!: () => void; const g = globalThis as { __auditImportGate?: Promise<void>; __auditImportReached?: () => void };
  const reached = new Promise<void>(r => { g.__auditImportReached = r; });
  g.__auditImportGate = new Promise<void>(r => { release = r; });
  const host = fakeHost();
  let returned = false;
  const starting = startFrontClawHook(host.host.logger, { FRONT_CLAW_OPENDOT_ADAPTER: '1', FRONT_CLAW_OPENDOT_START_TIMEOUT_MS: '10', FRONT_CLAW_OPENDOT_MODULE: path.resolve('tests/audit/audit-r2a-import-fixture.test.ts') }).then(s => { returned = true; return s; });
  try {
    await reached;
    await new Promise(r => setTimeout(r, 60));
    console.info(JSON.stringify({ budgetMs: 10, observedAfterMs: 60, returned }));
    expect(returned).toBe(true);
    const handle = await starting;
    expect(await handle.ready()).toBeNull();
    expect(handle.state()).toBe('unavailable');
    expect(host.logs.some(l => l.level === 'warn' && l.fields.alert === 'front_claw_unavailable' && l.fields.stage === 'import')).toBe(true);
  } finally { release(); await (await starting).close(); delete g.__auditImportGate; delete g.__auditImportReached; }
});
