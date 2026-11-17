import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { startFrontClawOpenDotService, operationIdFor, wecomChannelFromEnv, type AdapterDeps } from '../opendot/index.js';
import { openRuntimeDatabase } from './database.js';
import { createOfflineChannel, standaloneOptions } from './offline.js';
import { createSyntheticModel } from './synthetic-model.js';
import { loadModelRuntimeConfig } from '../role-eval/model-classify.js';
import { standaloneModelClassifier } from './compatible-model.js';
import { createStandaloneLogger } from './diagnostics.js';

export async function startStandalone(env: Readonly<Record<string, string | undefined>>, deps: AdapterDeps = {}) {
  try { return await assembleStandalone(env, deps); }
  catch (error) { createStandaloneLogger().warn({ event: 'standalone_start_failed', error }); throw error; }
}

async function assembleStandalone(env: Readonly<Record<string, string | undefined>>, deps: AdapterDeps) {
  const offline = env.FRONT_DOT_CHANNEL !== 'wecom';
  // Offline configuration must never inspect channel/model credentials, including optional files.
  const options = offline ? { ...standaloneOptions(env), channelEnv: undefined } : productionOptions(env);
  let channel = createOfflineChannel();
  const runtimeEnv = offline
    ? Object.freeze({ FRONT_CLAW_OPENDOT_ADAPTER: '1', FRONT_CLAW_NOTIFY_DISPATCH: '0' })
    : Object.freeze({ ...options.channelEnv, FRONT_CLAW_OPENDOT_ADAPTER: '1', FRONT_CLAW_NOTIFY_DISPATCH: env.FRONT_CLAW_NOTIFY_DISPATCH ?? '0',
      FRONT_CLAW_OPENDOT_CAPABILITIES: env.FRONT_CLAW_OPENDOT_CAPABILITIES, FRONT_CLAW_MEM0: env.FRONT_CLAW_MEM0 });
  const modelConfig = offline ? undefined : loadModelRuntimeConfig(null, env);
  const modelClassify = offline ? createSyntheticModel() : standaloneModelClassifier(env);
  const service = await startFrontClawOpenDotService({
    env: runtimeEnv,
    logger: createStandaloneLogger(),
  }, { open: () => openRuntimeDatabase(options.databaseUrl),
    channel: offline ? () => (channel = createOfflineChannel()) : () => wecomChannelFromEnv(options.channelEnv!),
    modelClassify, modelClassifyTimeoutMs: offline ? 100 : modelConfig!.timeoutMs,
    ...(offline ? { now: () => new Date('2026-11-12T02:00:00Z'), owner: 'synthetic-consumer' } : {}),
    ...deps });
  const requests = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/health') {
      response.statusCode = service.state() === 'active' ? 200 : 503;
      response.end(JSON.stringify({ state: service.state() })); return;
    }
    if (!offline || request.method !== 'POST' || request.url !== '/message') { response.writeHead(404).end('{}'); return; }
    let body = '', tooLarge = false;
    request.on('data', (part: Buffer) => { body += part.toString(); if (body.length > 8192) { tooLarge = true; request.destroy(); } });
    request.on('end', () => {
      if (tooLarge) return;
      const work = (async () => {
        if (response.destroyed || request.aborted) return;
        let operationId: string | undefined;
        const cancel = () => { if (!response.writableEnded && operationId) void service.cancel(operationId); };
        response.once('close', cancel);
        try {
          const input = JSON.parse(body) as Record<string, unknown>;
          if (typeof input.text !== 'string' || typeof input.messageId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(input.messageId)) throw Error('invalid_message');
          const event = Object.freeze({ botId: 'synthetic-bot', corpId: 'synthetic-corp', memberId: 'synthetic-member',
            reqId: input.messageId, messageId: input.messageId, text: input.text });
          operationId = operationIdFor(event);
          const before = channel.repliesFor(event.messageId).length;
          channel.inject(event); await service.idle(operationId);
          response.end(JSON.stringify({ report: await service.result(operationIdFor(event)), replies: channel.repliesFor(event.messageId).slice(before) }));
        } catch { response.writeHead(400).end('{"error":"message_failed"}'); }
        finally { response.off('close', cancel); }
      })().catch(() => { if (!response.writableEnded) response.writeHead(500).end('{}'); }).finally(() => { requests.delete(work); });
      requests.add(work);
    });
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(env.FRONT_DOT_PORT ?? '8080'), offline ? env.FRONT_DOT_BIND ?? '127.0.0.1' : '127.0.0.1', resolve);
    });
  } catch (error) { await service.close(); throw error; }
  let closing: Promise<void> | undefined;
  return { service, server, close: () => closing ??= (async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.allSettled([...requests]); await service.close();
  })() };
}

function productionOptions(env: Readonly<Record<string, string | undefined>>) {
  const botId = env.FRONT_CLAW_WECOM_BOT_ID?.trim();
  const secret = env.FRONT_CLAW_WECOM_BOT_SECRET?.trim();
  if (!botId || !secret) throw Error('wecom_credential_unavailable');
  const databaseUrl = env.FRONT_CLAW_DATABASE_URL ?? '';
  // Only the local deployment database is supported by this standalone assembly.
  const url = new URL(databaseUrl);
  if (!['localhost', '127.0.0.1', '[::1]', 'pg'].includes(url.hostname) || !['postgres:', 'postgresql:'].includes(url.protocol)) throw Error('local_database_required');
  return Object.freeze({ databaseUrl, channelEnv: Object.freeze({ FRONT_CLAW_WECOM_BOT_ID: botId, FRONT_CLAW_WECOM_BOT_SECRET: secret }) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startStandalone(process.env).then(runtime => {
    const shutdown = () => { void runtime.close().then(() => process.exit(0), () => process.exit(1)); };
    process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
    createStandaloneLogger().info({ state: 'ready' });
  }).catch(() => { process.exitCode = 1; });
}
