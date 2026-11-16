import { expect, it, vi, afterEach } from 'vitest';
import { startStandalone } from '../../src/standalone/main.js';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MemoryPerformanceStore } from '../../src/role-eval/performance-store.js';
import { createMemoryBindingStore } from '../../src/role-eval/directory-store.js';
import { createModelClassifier, loadModelRuntimeConfig } from '../../src/role-eval/model-classify.js';
import { createOfflineChannel } from '../../src/standalone/offline.js';
import { seedSynthetic } from '../../src/standalone/synthetic.js';

const channelEnvironments = vi.hoisted(() => [] as Readonly<Record<string, string | undefined>>[]);
vi.mock('../../src/opendot/wecom-channel.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/opendot/wecom-channel.js')>(),
  wecomChannelFromEnv: (env: Readonly<Record<string, string | undefined>>) => { channelEnvironments.push(env); return createOfflineChannel(); },
}));

vi.mock('pg', () => ({ default: { Pool: class { constructor() { throw Error('unexpected_database_open'); } } } }));
vi.mock('node:http', () => ({ createServer: (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
  const server = Object.assign(new EventEmitter(), {
    requestTimeout: 0, headersTimeout: 0,
    listen(_port: number, host: string, callback: () => void) { server.host = host; callback(); },
    host: '', address() { return { address: server.host }; },
    close(callback: () => void) { callback(); },
    request(method: string, url: string) {
      const response = { statusCode: 200, setHeader() {}, end(_body: string) { return response; }, writeHead(status: number) { response.statusCode = status; return response; } };
      handler({ method, url } as IncomingMessage, response as unknown as ServerResponse);
      return response.statusCode;
    },
  });
  return server;
} }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('rejects missing long connection credentials before opening resources without exposing secrets', async () => {
  for (const credentials of [{ FRONT_CLAW_WECOM_BOT_ID: 'unique-bot-marker' }, { FRONT_CLAW_WECOM_BOT_SECRET: 'unique-secret-marker' }]) {
    await expect(startStandalone({ FRONT_DOT_CHANNEL: 'wecom', ...credentials })).rejects.toMatchObject({ message: 'wecom_credential_unavailable' });
  }
});
it('serves only loopback health in production with message injection disabled', async () => {
  const store = new MemoryPerformanceStore();
  const env = { FRONT_DOT_CHANNEL: 'wecom', FRONT_CLAW_WECOM_BOT_ID: 'unique-bot-marker', FRONT_CLAW_WECOM_BOT_SECRET: 'unique-secret-marker', FRONT_CLAW_DATABASE_URL: 'postgresql://pg/front_dot', FRONT_DOT_BIND: '0.0.0.0', FRONT_DOT_PORT: '0' };
  const runtime = await startStandalone(env, {
    open: async () => ({ store, bindings: createMemoryBindingStore(), driver: 'memory', async close() {} }),
    timers: false,
  });
  try {
    const captured = channelEnvironments.at(-1)!;
    expect(Object.isFrozen(captured)).toBe(true);
    env.FRONT_CLAW_WECOM_BOT_SECRET = 'changed';
    expect(captured.FRONT_CLAW_WECOM_BOT_SECRET).toBe('unique-secret-marker');
    const server = runtime.server as unknown as { address(): { address: string }; request(method: string, path: string): number };
    expect(server.address().address).toBe('127.0.0.1');
    expect(server.request('GET', '/health')).toBe(200);
    expect(server.request('POST', '/message')).toBe(404);
  } finally { await runtime.close(); }
});
it('keeps offline startup independent of all model and channel credentials', async () => {
  const env = new Proxy({ FRONT_DOT_CHANNEL: 'offline', AUDIT_PG_ALLOW: 'isolated-synthetic', FRONT_CLAW_DATABASE_URL: 'postgresql://localhost/synthetic', FRONT_DOT_PORT: '0' }, {
    get(target, key) {
      if (/WECOM|FC_MODEL/.test(String(key))) throw Error('credential_read');
      return Reflect.get(target, key);
    },
  });
  const store = new MemoryPerformanceStore();
  const runtime = await startStandalone(env, { open: async () => ({ store, bindings: createMemoryBindingStore(), driver: 'memory', async close() {} }), timers: false });
  await runtime.close();
});

it('uses the existing model configuration with a captured credential and the request signal', async () => {
  const env = { FC_MODEL_MODE: 'live', FC_MODEL_ENDPOINT: 'http://model.invalid/classify', FC_MODEL_TIMEOUT_MS: '125', MODEL_TEST_KEY: 'synthetic-key' };
  const config = loadModelRuntimeConfig({ apiKeyEnv: 'MODEL_TEST_KEY', model: 'synthetic-model' }, env);
  const classifier = createModelClassifier(config, env);
  env.MODEL_TEST_KEY = 'changed';
  const fakeFetch = vi.fn(async (_url: string, options: RequestInit) => {
    expect(options.headers).toMatchObject({ authorization: 'Bearer synthetic-key' });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    return { ok: true, json: async () => ({ intent: 'unknown' }) };
  });
  vi.stubGlobal('fetch', fakeFetch);
  expect(config.timeoutMs).toBe(125);
  await expect(classifier({ text: 'synthetic', signal: new AbortController().signal })).resolves.toEqual({ intent: 'unknown' });
  expect(fakeFetch).toHaveBeenCalledOnce();
});

it('runs compatible model responses through production assembly, the shared pending slot and confirmation gate', async () => {
  const store = new MemoryPerformanceStore(), bindings = createMemoryBindingStore();
  await seedSynthetic({ store, bindings });
  const channel = createOfflineChannel();
  let kind = 'valid';
  const fakeFetch = vi.fn(async () => {
    if (kind === 'timeout') return new Promise<Response>(() => {});
    if (kind === 'rate-limit') return new Response('', { status: 429 });
    if (kind === 'error') throw Error('private-model-error');
    const output = kind === 'invalid' ? '{broken' : kind === 'empty' ? ''
      : JSON.stringify({ intent: 'report', object: 'performance', action: 'report', slots: { amountText: kind === 'invented' ? '999元' : '560元' }, confidence: 1, uncertain: false });
    return new Response(JSON.stringify({ choices: [{ message: { content: output } }] }));
  });
  vi.stubGlobal('fetch', fakeFetch);
  const runtime = await startStandalone({ FRONT_DOT_CHANNEL: 'wecom', FRONT_CLAW_DATABASE_URL: 'postgresql://pg/synthetic',
    FRONT_CLAW_WECOM_BOT_ID: 'synthetic-bot', FRONT_CLAW_WECOM_BOT_SECRET: 'fake-channel-secret',
    FC_MODEL_MODE: 'live', FC_MODEL_BASE_URL: 'https://model.invalid/v1', FC_MODEL_API_KEY: 'fake-model-secret', FC_MODEL_NAME: 'fake-model', FC_MODEL_TIMEOUT_MS: '60' }, {
    open: async () => ({ store, bindings, driver: 'memory', async close() {} }), channel: () => channel, timers: false,
    now: () => new Date('2026-11-12T02:00:00Z'),
  });
  const say = async (text: string, messageId: string) => {
    channel.inject({ botId: 'synthetic-bot', corpId: 'synthetic-corp', memberId: 'synthetic-member', reqId: messageId, messageId, text });
    await runtime.service.idle();
  };
  try {
    await say('请帮我整理这项 560元', 'compatible-valid');
    const pending = (await store.listDrafts()).find(draft => draft.status === 'pending')!;
    expect(pending.payload.employeeContext?.pendingSequence).toMatch(/^\d+$/);
    for (kind of ['invalid', 'empty', 'timeout', 'rate-limit', 'error', 'invented']) {
      await say('请帮我整理这项 560元', 'compatible-' + kind);
      expect((await store.listDrafts()).filter(draft => draft.status === 'pending').map(draft => draft.draftId)).toEqual([pending.draftId]);
      expect(await store.listEntries()).toHaveLength(0);
    }
    const calls = fakeFetch.mock.calls.length;
    await say('12号测试店\n380（小赵）', 'compatible-fast');
    expect(fakeFetch).toHaveBeenCalledTimes(calls);
    expect((await store.listDrafts()).filter(draft => draft.status === 'pending')).toHaveLength(1);
    expect(await store.listEntries()).toHaveLength(0);
    await say('对', 'compatible-confirm');
    expect((await store.listEntries()).map(entry => entry.amount)).toEqual([38000]);
  } finally { await runtime.close(); }
});
