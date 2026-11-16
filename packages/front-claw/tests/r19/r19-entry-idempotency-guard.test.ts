import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { offlineBotSdk } from '../fixtures/offline-bot-sdk.js';
import { ManagerStore } from '../../src/role-eval/manager-store.js';
import { WorkbenchAccessStore } from '../../src/role-eval/workbench-access.js';
import { createWecomBotAssembly, type WecomBotAssemblyOutcome } from '../../src/role-eval/wecom-bot-assembly.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { createStoreBusinessPort } from '../../src/role-eval/front-claw-boot.js';
import { newCustomerAskKey } from '../../src/role-eval/customer-name-policy.js';

it('R19 入口幂等护栏：同一请求经过 SDK 替身、全局指纹、店务入口和内存 SQL；跨路由同号冲突零准备零写入', async () => {
  const w = await worldM05();
  const ledger = new ManagerStore(':memory:');
  const grants = new WorkbenchAccessStore(':memory:');
  grants.change('synthetic-admin', { accountId: 'a-zhao', storeId: 's-b', roles: ['marketing'], active: true, expectedVersion: 0, requestKey: 'r19-grant' });
  const handler = createWecomBotHandler({
    mode: 'isolated-synthetic', employeeLoop: true, accessPolicy: true, store: w.store,
    now: () => new Date('2026-11-12T02:00:00Z'), resolve: id => w.base.getPersonByMember(id),
    send: async () => 'sent', model: { complete: async () => ({ type: 'chat', text: '离线桩' }) },
  });
  const port = createStoreBusinessPort(w.store, handler);
  const remember = vi.spyOn(port, 'remember');
  const offline = offlineBotSdk();
  const outcomes: WecomBotAssemblyOutcome[] = [];
  const app = createWecomBotAssembly({
    mode: 'isolated-synthetic', botId: 'r19-bot', corpId: 'r19-corp', client: offline.client,
    identity: {
      tenantId: 'r19-tenant', stores: [{ id: 's-b' }], roles: ['marketing', 'manager'], store: grants,
      readBinding: async () => ({ botId: 'r19-bot', corpId: 'r19-corp', memberId: 'm-zhao', accountId: 'a-zhao', version: 1, active: true }),
      readNative: async id => ({ user: { id, role: 'member', status: 'active', must_change_password: false }, workspaceJid: 'web:r19-home' }),
    },
    businesses: [{ scope: { tenant: 'r19-tenant', store: 's-b', workspace: 'web:r19-home' }, ledger,
      employees: [{ accountId: 'a-zhao', employeeId: 'p-zhao', employeeName: '小赵', storeName: '测试B店' }] }],
    sender: { sdk: offline.sdk, fileSdk: offline.fileSdk }, storeAssistant: port,
    onOutcome: outcome => { outcomes.push(outcome); },
  });
  try {
    offline.authenticate();
    const send = async (id: string, content: string) => {
      offline.frame({ cmd: 'aibot_msg_callback', headers: { req_id: `r19-req-${id}` }, body: {
        msgid: id, aibotid: 'r19-bot', msgtype: 'text', chattype: 'single',
        from: { userid: 'm-zhao', corpid: 'r19-corp' }, text: { content },
      } });
      await app.idle();
    };
    // src/role-eval/AGENTS.md 要求：新增会写状态的文本路由须先经原全局指纹预留。
    // D175：先问路由保留挂起项；已准入的新报单会替换它，两条路由都必须受指纹保护。
    // 先预留查询号，再挂追问，验证冲突不会作废它。
    await send('reserved', '我的进度');
    await send('question', '郗蘅：1437（小赵）');
    expect(JSON.stringify(offline.sent.at(-1))).toContain('是新客户「郗蘅」吗？');
    const session = createHash('sha256').update(JSON.stringify(['r19-corp', 'r19-bot', 'm-zhao', 'a-zhao', 'web:r19-home', 's-b'])).digest('hex');
    const key = newCustomerAskKey('p-zhao', session);
    const saved = await w.base.getConfig(key);
    expect(saved).toBeTruthy();
    const prepared = remember.mock.calls.length;
    const before = await w.snapshot(); w.reset();
    await send('reserved', '累计：1873（小赵）');
    expect(outcomes.at(-1)?.state).toBe('rejected');
    expect(remember.mock.calls.length).toBe(prepared);
    expect(w.spy.reads).toHaveLength(0);
    expect(await w.snapshot()).toEqual(before);
    expect(await w.base.getConfig(key)).toBe(saved);
    await send('reserved', '逯姨：2869（小赵）');
    expect(outcomes.at(-1)?.state).toBe('rejected');
    expect(remember.mock.calls.length).toBe(prepared);
    expect(w.spy.reads).toHaveLength(0);
    expect(await w.base.getConfig(key)).toBe(saved);
    await send('fresh-summary', '累计：1873（小赵）');
    // D175：新请求的通用先问正常回复，仍保留原追问。
    expect(JSON.stringify(offline.sent.at(-1))).not.toContain('上一条');
    expect(await w.base.getConfig(key)).toBe(saved);
    expect(await w.snapshot()).toEqual(before);
  } finally {
    app.close(); ledger.close(); grants.close();
  }
});
