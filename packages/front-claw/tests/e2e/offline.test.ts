import { expect, it } from 'vitest';
import { createOfflineChannel, standaloneOptions } from '../../src/standalone/offline.js';
import { seedSynthetic } from '../../src/standalone/synthetic.js';
import { MemoryPerformanceStore } from '../../src/role-eval/performance-store.js';
import { createMemoryBindingStore } from '../../src/role-eval/directory-store.js';
import { startFrontClawOpenDotService } from '../../src/opendot/index.js';

it('selects offline mode without reading channel credentials and fixes the startup options', () => {
  const env = new Proxy({ FRONT_DOT_CHANNEL: 'offline', AUDIT_PG_ALLOW: 'isolated-synthetic', FRONT_CLAW_DATABASE_URL: 'postgresql://localhost/synthetic' }, {
    get(target, key) {
      if (String(key).includes('WECOM')) throw Error('credential_read');
      return Reflect.get(target, key);
    },
  });
  const options = standaloneOptions(env);
  env.FRONT_DOT_CHANNEL = 'changed';
  expect(options.channel).toBe('offline');
  expect(Object.isFrozen(options)).toBe(true);
});

it('rejects unapproved mode and remote PG before opening resources', () => {
  expect(() => standaloneOptions({ FRONT_DOT_CHANNEL: 'wecom' })).toThrow();
  expect(() => standaloneOptions({ FRONT_DOT_CHANNEL: 'offline', AUDIT_PG_ALLOW: 'isolated-synthetic', FRONT_CLAW_DATABASE_URL: 'postgresql://remote/db' })).toThrow();
});

it('copies inbound messages and refuses proactive delivery', async () => {
  const channel = createOfflineChannel();
  let received = '';
  channel.open(event => { received = event.text; });
  const event = { botId: 'synthetic-bot', corpId: 'synthetic-corp', memberId: 'synthetic-member', messageId: 'one', reqId: 'one', text: '对' };
  channel.inject(event);
  event.text = 'changed';
  expect(received).toBe('对');
  const scope = { signal: new AbortController().signal, deadline: performance.now() + 1000 };
  expect(await channel.reply(event, 'draft', scope)).toBe('accepted');
  expect((await channel.notify('member', 'notice', scope, async () => {})).state).toBe('blocked');
  await channel.close();
  expect(() => channel.inject(event)).toThrow();
});

it('runs the exact synthetic report, confirmation, progress and replay inputs through a fresh adapter instance', async () => {
  const store = new MemoryPerformanceStore();
  const bindings = createMemoryBindingStore();
  await seedSynthetic({ store, bindings });
  const start = async () => {
    const channel = createOfflineChannel();
    const service = await startFrontClawOpenDotService({ env: { FRONT_CLAW_OPENDOT_ADAPTER: '1' }, logger: { info() {}, warn() {} } }, {
      open: async () => ({ store, bindings, driver: 'memory', async close() {} }),
      channel: () => channel, now: () => new Date('2026-11-12T02:00:00Z'), owner: 'synthetic-consumer', timers: false,
    });
    const say = async (text: string, messageId: string) => {
      channel.inject({ botId: 'synthetic-bot', corpId: 'synthetic-corp', memberId: 'synthetic-member', reqId: messageId, messageId, text });
      await service.idle(); return channel.replies.at(-1) ?? '';
    };
    return { service, say };
  };
  const first = await start();
  try {
    expect(await first.say('12号测试店\n560（小赵）', 'synthetic-report')).toContain('560');
    expect(await store.listEntries()).toHaveLength(0);
    expect((await store.listDrafts()).filter(draft => draft.status === 'pending')).toHaveLength(1);
    expect(await first.say('对', 'synthetic-confirm')).toContain('已入账');
    expect(await first.say('我本月业绩', 'synthetic-progress')).toContain('560');
  } finally { await first.service.close(); }
  const second = await start();
  try {
    await second.say('12号测试店\n560（小赵）', 'synthetic-report');
    await second.say('对', 'synthetic-confirm');
    expect(await store.listEntries()).toHaveLength(1);
    expect(await second.say('我本月业绩', 'synthetic-progress-after-restart')).toContain('560');
  } finally { await second.service.close(); }
});
